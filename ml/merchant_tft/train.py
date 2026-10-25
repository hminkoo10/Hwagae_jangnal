"""Reproducible CPU training on Dimigo cooperative store POS sales (first 70% of days).

The raw POS extract is private and never committed. Pass its folder with --data-dir
(sales_daily.csv, products.csv, weather_daily.csv, split.json).
"""

import argparse
from copy import deepcopy
import csv
from datetime import date, datetime, timedelta, timezone
import hashlib
from importlib.metadata import version
import json
import math
import os
from pathlib import Path
import time

import numpy as np
import torch

from .network import (
    ALL_REALS, CONFIG, ENCODER_DAYS, HORIZON, QUANTILES, REALS, build_model, features, scale_weather, tensors, week_deviation,
)
from .predict import MODEL_NAME, NOTE

ROOT = Path(__file__).resolve().parent
VERSION = "merchant-dimigo-store-v1"
SEED = 20261025
TRAIN_START, TRAIN_END = date(2025, 10, 1), date(2026, 7, 11)
# Time-ordered selection split inside the 70% training period. Training targets end
# before the validation targets start; validation is used for epoch/setting choice only.
VALID_START = date(2026, 5, 30)
BASE = ["sales", "dow_sin", "dow_cos", "relative_day"]
FEATURE_SETS = {
    "week_dev_rain": REALS,
    "absolute_weather": [*BASE, "temp_max", "temp_min", "rain_mm"],
    "rain_only": [*BASE, "rain_mm"],
    "no_weather": BASE,
}


def read_csv(path):
    with path.open(encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def load(data_dir, closed_weight):
    """Product series between first and last sale; absent rows inside that span are zero."""
    days = (TRAIN_END - TRAIN_START).days + 1
    weather = np.full((days, 3), np.nan, dtype=np.float64)
    for row in read_csv(data_dir / "weather_daily.csv"):
        offset = (date.fromisoformat(row["date"]) - TRAIN_START).days
        if 0 <= offset < days:
            weather[offset] = [float(row["temp_max"]), float(row["temp_min"]), float(row["rain_mm"])]
    if np.isnan(weather).any():
        raise ValueError("weather must cover every training day")
    rows = {}
    for row in read_csv(data_dir / "sales_daily.csv"):
        day = date.fromisoformat(row["date"])
        if not TRAIN_START <= day <= TRAIN_END:
            raise ValueError("sales outside the 70% training period")
        rows.setdefault(row["product_id"], {})[day] = row
    products = []
    for product_id in sorted(rows):
        series = rows[product_id]
        first, last = min(series), max(series)
        length = (last - first).days + 1
        units, weight, open_day, stockout = (np.zeros(length) for _ in range(4))
        for offset in range(length):
            row = series.get(first + timedelta(days=offset))
            if row is None:
                weight[offset], open_day[offset] = 1.0, 1.0
                continue
            units[offset] = float(row["units_sold"])
            open_day[offset] = float(row["store_has_sales"] == "1")
            stockout[offset] = float(row["est_stock_open"] == "0" and units[offset] == 0)
            # store_has_sales and est_stock_open are loss weights only, never features.
            weight[offset] = 0.0 if stockout[offset] else (1.0 if open_day[offset] else closed_weight)
        products.append({"id": product_id, "start": (first - TRAIN_START).days, "units": units,
                         "weight": weight, "open": open_day, "stockout": stockout})
    return products, weather


class Windows:
    """All 56+7 day windows, assembled per batch with the same features as inference."""

    def __init__(self, products, weather, reals):
        self.reals = reals
        self.columns = [ALL_REALS.index(name) for name in reals]
        self.weather = weather
        self.units = np.concatenate([product["units"] for product in products]).astype(np.float32)
        self.weight = np.concatenate([product["weight"] for product in products]).astype(np.float32)
        self.open = np.concatenate([product["open"] for product in products]).astype(np.float32)
        self.stockout = np.concatenate([product["stockout"] for product in products]).astype(np.float32)
        self.offsets = offsets = np.cumsum([0] + [len(product["units"]) for product in products])
        calendar = []
        for offset in range(len(weather)):
            day = TRAIN_START + timedelta(days=offset)
            calendar.append([math.sin(2 * math.pi * day.weekday() / 7), math.cos(2 * math.pi * day.weekday() / 7),
                             math.sin(2 * math.pi * day.timetuple().tm_yday / 365.25),
                             math.cos(2 * math.pi * day.timetuple().tm_yday / 365.25)])
        self.calendar = np.asarray(calendar, dtype=np.float32)
        self.relative = (np.arange(ENCODER_DAYS + HORIZON, dtype=np.float32) - ENCODER_DAYS + 1) / ENCODER_DAYS
        flat, origin, product_index = [], [], []
        for index, product in enumerate(products):
            for local in range(ENCODER_DAYS - 1, len(product["units"]) - HORIZON):
                flat.append(offsets[index] + local)
                origin.append(product["start"] + local)
                product_index.append(index)
        self.flat, self.origin, self.product = np.asarray(flat), np.asarray(origin), np.asarray(product_index)

    def select(self, mask):
        subset = deepcopy(self.__dict__)
        subset["flat"], subset["origin"], subset["product"] = self.flat[mask], self.origin[mask], self.product[mask]
        result = Windows.__new__(Windows)
        result.__dict__.update(subset)
        return result

    def origin_dates(self):
        return [TRAIN_START + timedelta(days=int(value)) for value in self.origin]

    def target(self, name, indices):
        return getattr(self, name)[self.flat[indices, None] + np.arange(1, HORIZON + 1)]

    def history(self, indices, days=ENCODER_DAYS):
        return self.units[self.flat[indices, None] + np.arange(1 - days, 1)]

    def forecasts(self, indices, rng):
        """Realized reanalysis plus lead-dependent forecast error; the app supplies issued forecasts."""
        actual = self.weather[self.origin[indices, None] + np.arange(1, HORIZON + 1)]
        if rng is None:
            return actual
        lead = np.arange(1, HORIZON + 1)
        temperature_sd = 1.0 + 0.2 * lead
        high = actual[..., 0] + rng.normal(0, 1, actual.shape[:2]) * temperature_sd
        low = actual[..., 1] + rng.normal(0, 1, actual.shape[:2]) * temperature_sd
        rain = actual[..., 2] * np.exp(rng.normal(0, 0.5, actual.shape[:2])) + rng.normal(0, 1, actual.shape[:2]) * (0.5 + 0.3 * lead)
        return np.stack([np.maximum(high, low), np.minimum(high, low), np.maximum(rain, 0)], axis=-1)

    def batch(self, indices, rng):
        history = self.history(indices)
        scale = np.maximum(history.mean(axis=1), 1.0).astype(np.float32)
        values = np.zeros((len(indices), ENCODER_DAYS + HORIZON, len(ALL_REALS)), dtype=np.float32)
        values[:, :ENCODER_DAYS, 0] = history / scale[:, None]
        values[:, :, 1:5] = self.calendar[self.origin[indices, None] + np.arange(1 - ENCODER_DAYS, HORIZON + 1)]
        values[:, :, 5] = self.relative
        weather = self.forecasts(indices, rng)
        values[:, ENCODER_DAYS:, 6:9] = np.stack(scale_weather(weather[..., 0], weather[..., 1], weather[..., 2]), axis=-1)
        values[:, ENCODER_DAYS:, 9] = week_deviation(weather[..., 0])
        values[:, ENCODER_DAYS:, 10] = week_deviation(weather[..., 1])
        return values[:, :, self.columns], scale


def check_features(windows):
    """Training batches must equal the inference feature function exactly."""
    for index in (0, len(windows.flat) // 2, len(windows.flat) - 1):
        array, scale = windows.batch(np.asarray([index]), None)
        weather = windows.forecasts(np.asarray([index]), None)[0]
        expected, expected_scale = features(
            windows.history(np.asarray([index]))[0], windows.origin_dates()[index],
            [{"temp_max": row[0], "temp_min": row[1], "rain_mm": row[2]} for row in weather], windows.reals,
        )
        np.testing.assert_allclose(array[0], expected, rtol=0, atol=1e-6)
        assert abs(scale[0] - expected_scale) < 1e-6


def pinball(prediction, target, weight):
    error = target[:, :, None] - prediction
    quantiles = torch.tensor(QUANTILES, dtype=prediction.dtype, device=prediction.device)
    loss = torch.maximum(quantiles * error, (quantiles - 1) * error).mean(dim=-1)
    return (loss * weight).sum() / weight.sum().clamp_min(1e-6)


def percentile(values, quantile):
    # Same interpolation and rounding as apps/api/app/forecasting.py percentile().
    values = sorted(values)
    position = (len(values) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    return round(values[lower] + (values[upper] - values[lower]) * (position - lower), 2)


def weekday_baseline(windows, days):
    """API weekday baseline on the same windows: per-weekday P10/P50/P90 of the input days."""
    dates = windows.origin_dates()
    result = np.zeros((len(windows.flat), HORIZON, 3), dtype=np.float64)
    for index in range(len(windows.flat)):
        available = min(days, int(windows.flat[index] - windows.offsets[windows.product[index]]) + 1)
        start = windows.flat[index] - available + 1
        history = windows.units[start:windows.flat[index] + 1]
        weekdays = [(dates[index] - timedelta(days=available - 1 - offset)).weekday() for offset in range(available)]
        for step in range(HORIZON):
            weekday = (dates[index] + timedelta(days=step + 1)).weekday()
            values = [float(value) for value, day in zip(history, weekdays) if day == weekday]
            result[index, step] = [percentile(values, quantile) for quantile in (0.1, 0.5, 0.9)]
    return result


def unit_metrics(prediction, actual, mask, quantiles):
    prediction, actual = prediction[mask], actual[mask]
    error = actual[:, None] - prediction
    q = np.asarray(quantiles)
    loss = np.maximum(q * error, (q - 1) * error)
    lower, middle, upper = quantiles.index(0.1), quantiles.index(0.5), quantiles.index(0.9)
    metrics = {
        "rows": int(mask.sum()),
        "mae_units": float(np.mean(abs(prediction[:, middle] - actual))),
        "pinball_p10_p50_p90_units": float(loss[:, [lower, middle, upper]].mean()),
        "interval_p10_p90_coverage": float(np.mean((prediction[:, lower] <= actual) & (actual <= prediction[:, upper]))),
        "interval_p10_p90_width_units": float(np.mean(prediction[:, upper] - prediction[:, lower])),
    }
    if len(quantiles) == 5:
        metrics["pinball_5_quantile_units"] = float(loss.mean())
    return metrics


def predict_windows(model, windows, rng, batch_size=4096):
    outputs = []
    with torch.inference_mode():
        for offset in range(0, len(windows.flat), batch_size):
            indices = np.arange(offset, min(offset + batch_size, len(windows.flat)))
            array, scale = windows.batch(indices, rng)
            raw = model(tensors(array))["prediction"].numpy()
            outputs.append(np.sort(np.maximum(raw, 0.0), axis=-1) * scale[:, None, None])
    return np.concatenate(outputs)


def evaluate(model, windows, seed):
    """TFT and API weekday baselines on identical validation rows, in sold units."""
    prediction = predict_windows(model, windows, np.random.default_rng(seed)).reshape(-1, len(QUANTILES))
    actual = windows.target("units", np.arange(len(windows.flat))).reshape(-1)
    subsets = {
        "all_rows": np.ones_like(actual, dtype=bool),
        "excluding_estimated_stockout_zero": windows.target("stockout", np.arange(len(windows.flat))).reshape(-1) == 0,
        "store_open_days": windows.target("open", np.arange(len(windows.flat))).reshape(-1) == 1,
    }
    baselines = {days: weekday_baseline(windows, days).reshape(-1, 3) for days in (ENCODER_DAYS, 84)}
    return {
        name: {
            "tft": unit_metrics(prediction, actual, mask, QUANTILES),
            "api_weekday_baseline_same_56_days": unit_metrics(baselines[ENCODER_DAYS], actual, mask, [0.1, 0.5, 0.9]),
            "api_weekday_baseline_up_to_84_days": unit_metrics(baselines[84], actual, mask, [0.1, 0.5, 0.9]),
        }
        for name, mask in subsets.items()
    }


def smoke_context():
    # Synthetic fixture with a school-store weekday/weekend shape. Not POS data.
    origin = date(2026, 10, 24)
    dates = [(origin + timedelta(days=offset)).isoformat() for offset in range(1, 8)]
    def units(day):
        return [9, 11, 11, 9, 7, 2, 0][day.weekday()] + (day.day % 3)
    return {
        "schema_version": "1", "store_id": "any-merchant-smoke", "as_of": origin.isoformat(),
        "dates": dates, "products": [{"id": "my-food", "name": "직접 입력 상품"}],
        "sales": [{"product_id": "my-food", "date": (origin - timedelta(days=offset)).isoformat(),
                   "units_sold": units(origin - timedelta(days=offset))} for offset in range(55, -1, -1)],
        "weather": {"status": "ok", "mode": "live_forecast", "source": "synthetic smoke fixture",
                    "fetched_at": "2026-10-24T00:00:00+00:00",
                    "days": [{"date": day, "temp_max": 18.0, "temp_min": 9.0, "rain_mm": 0.0} for day in dates]},
    }


def sha256(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def on(device, inputs):
    return {name: value.to(device) for name, value in inputs.items()}


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--features", choices=sorted(FEATURE_SETS), default="week_dev_rain")
    parser.add_argument("--hidden-size", type=int, default=CONFIG["hidden_size"])
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--patience", type=int, default=8)
    parser.add_argument("--batch-size", type=int, default=256)
    parser.add_argument("--learning-rate", type=float, default=0.002)
    parser.add_argument("--closed-weight", type=float, default=0.25)
    parser.add_argument("--threads", type=int, default=8)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    args = parser.parse_args()
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        parser.error("output-dir must be new or empty; preserve existing trained artifacts")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    reals = FEATURE_SETS[args.features]
    config = {**CONFIG, "hidden_size": args.hidden_size, "hidden_continuous_size": max(8, args.hidden_size // 2)}
    shipped = reals == REALS and config == CONFIG
    torch.set_num_threads(args.threads)
    torch.manual_seed(SEED)
    if args.device == "cuda":
        # Training only; the shipped artifact runs and is re-evaluated on CPU float32.
        os.environ.setdefault("CUBLAS_WORKSPACE_CONFIG", ":4096:8")
        torch.backends.cudnn.benchmark = False
        torch.backends.cudnn.deterministic = True
        torch.use_deterministic_algorithms(True, warn_only=True)
        device_name = torch.cuda.get_device_name(0)
    else:
        torch.use_deterministic_algorithms(True)
        device_name = "CPU"
    device = torch.device(args.device)

    products, weather = load(args.data_dir, args.closed_weight)
    windows = Windows(products, weather, reals)
    check_features(windows)
    first_target = np.asarray([day + timedelta(days=1) for day in windows.origin_dates()])
    last_target = np.asarray([day + timedelta(days=HORIZON) for day in windows.origin_dates()])
    train = windows.select(last_target < VALID_START)
    valid = windows.select(first_target >= VALID_START)
    valid_x, valid_scale = valid.batch(np.arange(len(valid.flat)), np.random.default_rng(SEED + 1))
    valid_inputs = on(device, tensors(valid_x))
    valid_y = torch.from_numpy(valid.target("units", np.arange(len(valid.flat))) / valid_scale[:, None]).to(device)
    valid_w = torch.from_numpy(valid.target("weight", np.arange(len(valid.flat)))).to(device)

    model = build_model(reals, config).float().to(device)
    optimizer = torch.optim.Adam(model.parameters(), lr=args.learning_rate)
    best_loss, best_state, best_epoch, log = float("inf"), None, 0, []
    start = time.perf_counter()
    with torch.inference_mode():
        model.eval()
        initial = float(pinball(model(valid_inputs)["prediction"], valid_y, valid_w))
    generator = np.random.default_rng(SEED + 2)
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = generator.permutation(len(train.flat))
        losses = []
        for offset in range(0, len(order), args.batch_size):
            indices = order[offset:offset + args.batch_size]
            array, scale = train.batch(indices, generator)  # fresh forecast noise every epoch
            target = torch.from_numpy(train.target("units", indices) / scale[:, None]).to(device)
            weight = torch.from_numpy(train.target("weight", indices)).to(device)
            optimizer.zero_grad(set_to_none=True)
            loss = pinball(model(on(device, tensors(array)))["prediction"], target, weight)
            if not torch.isfinite(loss):
                raise RuntimeError("non-finite training loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            losses.append(float(loss.detach()))
        model.eval()
        with torch.inference_mode():
            validation_loss = float(pinball(model(valid_inputs)["prediction"], valid_y, valid_w))
        if validation_loss < best_loss:
            best_loss, best_epoch = validation_loss, epoch
            best_state = {name: value.detach().cpu().clone() for name, value in model.state_dict().items()}
        log.append({"epoch": epoch, "train_weighted_normalized_pinball": float(np.mean(losses)),
                    "validation_weighted_normalized_pinball": validation_loss})
        print(json.dumps({**log[-1], "elapsed_seconds": round(time.perf_counter() - start, 1)}), flush=True)
        if epoch - best_epoch >= args.patience:
            break
    elapsed = time.perf_counter() - start
    # Validation metrics are computed with the CPU float32 runtime the app uses.
    model = build_model(reals, config).cpu().float()
    model.load_state_dict(best_state, strict=True)
    model.eval()
    torch.set_num_threads(args.threads)
    metrics = evaluate(model, valid, SEED + 1)

    checkpoint = args.output_dir / "model.ckpt"
    torch.save(best_state, checkpoint)
    valid_dates = valid.origin_dates()
    train_dates = train.origin_dates()
    model_metadata = {"name": MODEL_NAME, "version": VERSION, "uses_weather": True,
                      "training_data": "dimigo_store", "note": NOTE}
    manifest = {
        "schema_version": "1", "version": VERSION, "model": model_metadata,
        "architecture": config, "architecture_class": "pytorch_forecasting.TemporalFusionTransformer",
        "features": reals, "quantiles": QUANTILES, "encoder_days": ENCODER_DAYS, "forecast_days": HORIZON,
        "checkpoint_sha256": sha256(checkpoint), "checkpoint_bytes": checkpoint.stat().st_size,
        "training": {
            "data": "dimigo_store",
            "source": "디미고사회적협동조합 매점 POS 판매 (원본 비공개, 저장소에 포함하지 않음)",
            "input_sha256": {name: sha256(args.data_dir / name) for name in ("sales_daily.csv", "products.csv", "weather_daily.csv", "split.json")},
            "raw_source_sha256": json.loads((args.data_dir / "split.json").read_text(encoding="utf-8"))["source_files"],
            "period": {"start": TRAIN_START.isoformat(), "end": TRAIN_END.isoformat(), "sales_days": 223,
                       "note": "70% of sales days; the later 30% (2026-07-12~2026-10-24) was not received or used"},
            "fit_targets": {"start": (min(train_dates) + timedelta(days=1)).isoformat(),
                            "end": (max(train_dates) + timedelta(days=HORIZON)).isoformat(), "windows": len(train.flat)},
            "validation_targets": {"start": (min(valid_dates) + timedelta(days=1)).isoformat(),
                                   "end": (max(valid_dates) + timedelta(days=HORIZON)).isoformat(), "windows": len(valid.flat),
                                   "use": "epoch and setting selection only; time-ordered, no shuffled dates"},
            "products": len(products), "products_with_windows": int(len(set(windows.product.tolist()))),
            "seed": SEED, "validation_noise_seed": SEED + 1, "epochs_max": args.epochs, "patience": args.patience,
            "epochs_run": len(log), "best_epoch": best_epoch, "batch_size": args.batch_size,
            "initial_validation_weighted_normalized_pinball": initial,
            "best_validation_weighted_normalized_pinball": best_loss,
            "elapsed_seconds": elapsed, "threads": args.threads,
            "device": device_name, "evaluation_device": "CPU", "precision": "float32", "optimizer": "Adam", "learning_rate": args.learning_rate,
            "loss_weights": {"store_has_sales_0": args.closed_weight, "est_stock_open_0_and_units_0": 0.0, "other": 1.0,
                             "note": "store_has_sales and est_stock_open are loss weights only, not model inputs"},
            "zero_rule": "days between a product's first and last sale without a sales row are real zeros; days outside that span are absent",
            "weather": "Open-Meteo reanalysis for Ansan Wa-dong; decoder gets reanalysis + lead-dependent forecast-error noise",
            "forecast_noise": "lead 1..7: temperature Gaussian sd 1.0+0.2*lead C; rain x lognormal(sd0.5) + Gaussian sd 0.5+0.3*lead mm, clipped at zero; fresh draw per epoch",
            "not_used": "store/product IDs, category, academic calendar, prices, stock, store_has_sales, est_stock_open as features",
            "feature_set": args.features,
        },
        "normalization": "history-only 56-day mean (minimum1); weather fixed physical scales; no fitted category/group/target encoders",
        "packages": {name: version(name) for name in ("torch", "pytorch-forecasting", "numpy")},
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_sha256": {filename: sha256(ROOT / filename) for filename in ("network.py", "train.py", "predict.py")},
        "validation": {"label": "70% period time-ordered validation; not the 30% holdout", "metrics": metrics},
    }
    write_json(args.output_dir / "manifest.json", manifest)
    write_json(args.output_dir / "training-log.json", log)
    write_json(args.output_dir / "smoke.json", smoke_context())
    print(json.dumps({"completed": True, "shipped_configuration": shipped, "best_epoch": best_epoch,
                      "validation": metrics["all_rows"]}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
