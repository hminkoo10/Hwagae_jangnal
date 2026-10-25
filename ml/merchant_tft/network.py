"""Fixed TFT architecture and deterministic, identity-free input features."""

from datetime import date, timedelta
import math

import numpy as np
import torch
from pytorch_forecasting import TemporalFusionTransformer
from pytorch_forecasting.data.encoders import TorchNormalizer
from pytorch_forecasting.metrics import QuantileLoss

ENCODER_DAYS = 56
HORIZON = 7
QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]
CALENDAR = ["dow_sin", "dow_cos", "year_sin", "year_cos", "relative_day"]
WEATHER = ["temp_max", "temp_min", "rain_mm"]
# Temperature relative to the mean of the same 7-day forecast. One school year of sales
# ties absolute temperature to season and vacations; within-week deviation does not.
WEEK_DEVIATION = ["temp_max_week_dev", "temp_min_week_dev"]
ALL_REALS = ["sales", *CALENDAR, *WEATHER, *WEEK_DEVIATION]
# Shipped feature set, chosen on the time-ordered validation window (see train.py).
REALS = ["sales", "dow_sin", "dow_cos", "relative_day", *WEEK_DEVIATION, "rain_mm"]
CONFIG = {
    "hidden_size": 16,
    "hidden_continuous_size": 8,
    "attention_head_size": 1,
    "lstm_layers": 1,
    "dropout": 0.1,
}


def build_model(reals=REALS, config=CONFIG):
    # This is the actual PyTorch Forecasting TFT, with variable selection,
    # LSTM encoder/decoder, gated residual networks and interpretable attention.
    # No categorical encoder, embedding, group statistics or absolute time_idx.
    calendar = [name for name in CALENDAR if name in reals]
    return TemporalFusionTransformer(
        **config,
        max_encoder_length=ENCODER_DAYS,
        output_size=len(QUANTILES),
        loss=QuantileLoss(quantiles=QUANTILES),
        logging_metrics=torch.nn.ModuleList(),
        output_transformer=TorchNormalizer(method="identity"),
        x_reals=list(reals),
        time_varying_reals_encoder=["sales", *calendar],
        time_varying_reals_decoder=[*calendar, *(name for name in [*WEATHER, *WEEK_DEVIATION] if name in reals)],
        log_interval=-1,
    )


def scale_weather(temp_max, temp_min, rain_mm):
    # Fixed physical scaling, not statistics fitted on the request or training data.
    return (np.asarray(temp_max) - 20) / 20, (np.asarray(temp_min) - 10) / 20, np.asarray(rain_mm) / 30


def week_deviation(temperature):
    """Deviation from the 7-day forecast mean along the last axis, fixed 10C scale."""
    temperature = np.asarray(temperature, dtype=np.float64)
    return (temperature - temperature.mean(axis=-1, keepdims=True)) / 10


def features(history, origin: date, forecast_weather, reals=REALS):
    """History-only scale; decoder weather never enters the encoder features."""
    history = np.asarray(history, dtype=np.float32)
    scale = max(float(history.mean()), 1.0)
    continuous = np.zeros((ENCODER_DAYS + HORIZON, len(ALL_REALS)), dtype=np.float32)
    continuous[:ENCODER_DAYS, 0] = history / scale
    for index in range(ENCODER_DAYS + HORIZON):
        relative = index - ENCODER_DAYS + 1
        day = origin + timedelta(days=relative)
        continuous[index, 1:6] = [
            math.sin(2 * math.pi * day.weekday() / 7),
            math.cos(2 * math.pi * day.weekday() / 7),
            math.sin(2 * math.pi * day.timetuple().tm_yday / 365.25),
            math.cos(2 * math.pi * day.timetuple().tm_yday / 365.25),
            relative / ENCODER_DAYS,
        ]
    for index, weather in enumerate(forecast_weather, ENCODER_DAYS):
        continuous[index, 6:9] = scale_weather(weather["temp_max"], weather["temp_min"], weather["rain_mm"])
    continuous[ENCODER_DAYS:, 9] = week_deviation([weather["temp_max"] for weather in forecast_weather])
    continuous[ENCODER_DAYS:, 10] = week_deviation([weather["temp_min"] for weather in forecast_weather])
    return continuous[:, [ALL_REALS.index(name) for name in reals]], scale


def tensors(continuous):
    values = torch.as_tensor(continuous, dtype=torch.float32)
    batch = values.shape[0]
    return {
        "encoder_cont": values[:, :ENCODER_DAYS],
        "decoder_cont": values[:, ENCODER_DAYS:],
        "encoder_cat": torch.empty(batch, ENCODER_DAYS, 0, dtype=torch.int64),
        "decoder_cat": torch.empty(batch, HORIZON, 0, dtype=torch.int64),
        "encoder_lengths": torch.full((batch,), ENCODER_DAYS, dtype=torch.int64),
        "decoder_lengths": torch.full((batch,), HORIZON, dtype=torch.int64),
        "target_scale": torch.tensor([[0.0, 1.0]]).repeat(batch, 1),
    }
