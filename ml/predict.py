"""Synchronous CPU inference. No training, downloads, or fitted-state updates."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass, field
from functools import lru_cache
import hashlib
import json
import os
from pathlib import Path
import threading

import numpy as np
import pandas as pd
import torch
from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
from pytorch_forecasting.data.encoders import NaNLabelEncoder
from pytorch_forecasting.metrics import MAE, MAPE, RMSE, SMAPE, QuantileLoss
from sklearn.utils.validation import check_is_fitted

from ml.preprocess import WEATHER_FEATURES, prepare_context


QUANTILES = [0.1, 0.25, 0.5, 0.75, 0.9]
_LOAD_LOCK = threading.Lock()


class FrozenGroupEncoder(NaNLabelEncoder):
    """PF 1.5 calls group-encoder fit even in from_parameters().

    Replace that vocabulary-extension hook with validation only. The saved
    classes, indices and all transform behavior remain unchanged. No base fit
    is called, and unknown groups cannot extend the checkpoint vocabulary.
    """

    def fit(self, y, overwrite=False):
        if overwrite or not hasattr(self, "classes_"):
            raise ValueError("inference cannot fit a categorical encoder")
        if any(value not in self.classes_ for value in y):
            raise ValueError("unseen group cannot extend the trained vocabulary")
        return self


def _frozen_parameters(saved: dict) -> dict:
    params = deepcopy(saved)
    for name, encoder in params["categorical_encoders"].items():
        if encoder is not None:
            check_is_fitted(encoder)
        if name.startswith("__group_id__"):
            frozen = FrozenGroupEncoder()
            frozen.__dict__.update(deepcopy(encoder.__dict__))
            params["categorical_encoders"][name] = frozen
    check_is_fitted(params["target_normalizer"])
    for scaler in params["scalers"].values():
        if scaler is not None:
            check_is_fitted(scaler)
    return params


class PersistenceCollator:
    """The original notebook's decoder weather rule, including missing flags."""

    def __init__(self, reals):
        self.indices = [reals.index(name) for name in WEATHER_FEATURES]

    def __call__(self, samples):
        x, y = TimeSeriesDataSet._collate_fn(samples)
        rows = torch.arange(len(x["encoder_lengths"]))
        for index in self.indices:
            last = x["encoder_cont"][rows, x["encoder_lengths"] - 1, index]
            x["decoder_cont"][:, :, index] = last[:, None]
        return x, y


@dataclass
class Runtime:
    model: TemporalFusionTransformer
    parameters: dict
    defaults: dict
    selected_series: pd.DataFrame
    version: str
    lock: threading.Lock = field(default_factory=threading.Lock)


@lru_cache(maxsize=1)
def _load_runtime(checkpoint_path: str, metadata_path: str, threads: int) -> Runtime:
    root = Path(metadata_path)
    manifest = json.loads((root / "manifest.json").read_text(encoding="utf-8"))
    checkpoint = Path(checkpoint_path)
    digest = hashlib.sha256(checkpoint.read_bytes()).hexdigest()
    if digest != manifest["checkpoint_sha256"]:
        raise ValueError("checkpoint SHA-256 differs from the validated artifact manifest")
    for filename, expected in manifest["metadata_sha256"].items():
        if hashlib.sha256((root / filename).read_bytes()).hexdigest() != expected:
            raise ValueError(f"metadata checksum mismatch: {filename}")
    # Only load the trusted, checksum-verified handoff. This is a Python pickle.
    saved = torch.load(checkpoint, map_location="cpu", weights_only=False)
    hparams = dict(saved["hyper_parameters"])
    if hparams["output_size"] != 5 or list(hparams["loss"].quantiles) != QUANTILES:
        raise ValueError("checkpoint must predict the five agreed quantiles")
    # load_from_checkpoint() restores __special_save__ TorchMetrics objects
    # whose _device remains cuda:0 even with map_location='cpu'. Reconstruct
    # the same architecture with fresh CPU metrics, then strictly load every
    # weight. Optimizer, trainer and GPU metric state are unnecessary here.
    hparams["loss"] = QuantileLoss(quantiles=QUANTILES)
    hparams["logging_metrics"] = torch.nn.ModuleList([SMAPE(), MAE(), RMSE(), MAPE()])
    torch.set_num_threads(threads)
    model = TemporalFusionTransformer(**hparams)
    model.load_state_dict(saved["state_dict"], strict=True)
    model.cpu().float().eval()
    parameters = saved["dataset_parameters"]
    model.dataset_parameters = deepcopy(parameters)
    _frozen_parameters(parameters)  # Fail at startup if any learned state is absent.
    defaults = json.loads((root / "weather_fill_defaults.json").read_text(encoding="utf-8"))
    selected = pd.read_csv(root / "selected_series.csv", dtype=str)
    return Runtime(model, parameters, defaults, selected, manifest["version"])


def _runtime() -> Runtime:
    path = os.environ.get("TFT_CHECKPOINT_PATH")
    if not path:
        raise ValueError("set TFT_CHECKPOINT_PATH to the existing best TFT checkpoint")
    metadata = os.environ.get("TFT_METADATA_DIR", str(Path(__file__).parent / "metadata"))
    threads = int(os.environ.get("TFT_NUM_THREADS", "1"))
    if not 1 <= threads <= 64:
        raise ValueError("TFT_NUM_THREADS must be between 1 and 64")
    with _LOAD_LOCK:
        return _load_runtime(str(Path(path).resolve(strict=True)), str(Path(metadata).resolve(strict=True)), threads)


def predict_quantiles(context: dict) -> dict:
    """Offline verification output containing all five postprocessed quantiles.

    Use predict(), not this helper, as FORECAST_PROVIDER. The supplied historical
    weather must be available by the cutoff. The default persistence path keeps
    the original evaluation unchanged. Explicit provided_forecast scenarios use
    model_input.forecast_weather, outside the validated training distribution.
    """
    runtime = _runtime()
    with runtime.lock:
        frame, products = prepare_context(context, runtime.parameters, runtime.defaults, runtime.selected_series)
        by_item = {}
        if frame is not None:
            dataset = TimeSeriesDataSet.from_parameters(
                _frozen_parameters(runtime.parameters), frame,
                predict=True, stop_randomization=True,
            )
            loader = dataset.to_dataloader(
                train=False, batch_size=64, num_workers=0, pin_memory=False,
                collate_fn=(PersistenceCollator(dataset.reals)
                            if context["model_input"]["weather_strategy"] == "persistence"
                            else TimeSeriesDataSet._collate_fn),
            )
            with torch.inference_mode():
                for x, _ in loader:
                    raw = runtime.model(x)["prediction"].cpu().numpy()
                    if raw.shape[1:] != (7, 5) or not np.isfinite(raw).all():
                        raise ValueError("TFT returned invalid or non-finite quantiles")
                    # Same as the notebook: clip at zero then sort all five.
                    values = np.sort(np.maximum(raw, 0.0), axis=-1)
                    index = dataset.x_to_index(x)
                    for i, row in enumerate(index.itertuples(index=False)):
                        by_item[str(row.item_nbr)] = values[i]
        chronological = sorted(context["dates"])
        output = []
        for product in products:
            item = product.pop("model_item_nbr")
            if product["status"] == "ready":
                values = by_item[item]
                days = {day: values[i] for i, day in enumerate(chronological)}
                product["points"] = [
                    {"date": day, **{key: float(value) for key, value in zip(
                        ("p10", "p25", "p50", "p75", "p90"), days[day], strict=True)}}
                    for day in context["dates"]
                ]
            output.append(product)
        model = {"name": "TFT Walmart persistence", "version": runtime.version,
                 "uses_weather": True}
        if context["model_input"]["weather_strategy"] == "provided_forecast":
            model.update(
                name="Walmart TFT · 미국 날씨 시나리오",
                training_data="walmart", experimental=True, weather_strategy="provided_forecast",
                note=("Walmart 판매·과거 날씨로 학습한 기존 TFT에 별도로 조회한 날씨를 입력하는 실험입니다. "
                      "마지막 관측 날씨 유지 방식으로 학습·평가했으므로 기존 평가 지표를 적용하지 않습니다. "
                      "시연 지역은 원본 Walmart 매장의 실제 위치가 아니며, 날짜 이동 자료는 실제 현재 판매가 아닙니다. "
                      "예보에 관측 trace 표시가 없어 강수량 숫자를 사용하고 trace 특징은 0으로 가정합니다."),
            )
        return {"model": model, "products": output}


def predict(context: dict) -> dict:
    """Return only date/p10/p50/p90 per day, as required by the API boundary."""
    result = predict_quantiles(context)
    for product in result["products"]:
        product["points"] = [
            {key: point[key] for key in ("date", "p10", "p50", "p90")}
            for point in product["points"]
        ]
    return result
