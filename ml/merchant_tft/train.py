"""Reproducible CPU training on explicitly synthetic independent windows."""

import argparse
from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import time

import numpy as np
import torch

from .network import CONFIG, ENCODER_DAYS, HORIZON, QUANTILES, REALS, build_model, features, tensors
from .predict import NOTE

ROOT = Path(__file__).resolve().parent
VERSION = "merchant-synthetic-live-v1"
SEED = 20261024


def synthetic_windows(count, seed):
    rng = np.random.default_rng(seed)
    windows, targets, scales = [], [], []
    for _ in range(count):
        origin = date(2024, 1, 1) + timedelta(days=int(rng.integers(0, 1096)))
        level = float(np.exp(rng.uniform(np.log(8), np.log(500))))
        zero = rng.random() < 0.04
        days = [origin + timedelta(days=offset) for offset in range(-55, 8)]
        maximum = rng.uniform(0, 40, len(days))
        minimum = maximum - rng.uniform(4, 14, len(days))
        rain = np.where(rng.random(len(days)) < 0.65, 0, rng.uniform(0, 40, len(days)))
        weekly = np.asarray([1 + 0.12 * (day.weekday() >= 5) - 0.05 * np.sin(2 * np.pi * day.weekday() / 7) for day in days])
        # A deliberately invented shared response, not a discovered business fact.
        weather_effect = np.maximum(0.15, 1 + 0.022 * (maximum - 20) - 0.012 * rain)
        demand = level * weekly * weather_effect * rng.lognormal(-0.5 * 0.1**2, 0.1, len(days))
        sales = np.zeros(len(days), dtype=np.float32) if zero else rng.poisson(demand).astype(np.float32)
        # Forecast errors are generated at each synthetic origin. Decoder inputs
        # are noisy forecasts, not the realized weather used for the sales target.
        forecasts = []
        for index in range(56, 63):
            forecast_max = maximum[index] + rng.normal(0, 1.5)
            forecast_min = minimum[index] + rng.normal(0, 1.5)
            forecasts.append({
                "temp_max": float(max(forecast_max, forecast_min)),
                "temp_min": float(min(forecast_max, forecast_min)),
                "rain_mm": float(max(0, rain[index] + rng.normal(0, 2.0))),
            })
        array, scale = features(sales[:56], origin, forecasts)
        windows.append(array)
        targets.append(sales[56:] / scale)
        scales.append(scale)
    return np.stack(windows), np.stack(targets), np.asarray(scales, dtype=np.float32)


def pinball(prediction, target):
    error = target[:, :, None] - prediction
    quantiles = torch.tensor(QUANTILES, dtype=prediction.dtype)
    return torch.maximum(quantiles * error, (quantiles - 1) * error).mean()


def smoke_context():
    origin = date(2026, 10, 24)
    dates = [(origin + timedelta(days=offset)).isoformat() for offset in range(1, 8)]
    return {
        "schema_version": "1", "store_id": "any-merchant-smoke", "as_of": origin.isoformat(),
        "dates": dates, "products": [{"id": "my-food", "name": "직접 입력 상품"}],
        "sales": [{"product_id": "my-food", "date": (origin - timedelta(days=offset)).isoformat(),
                   "units_sold": 45 + (offset % 7) * 2} for offset in range(55, -1, -1)],
        "weather": {"status": "ok", "mode": "live_forecast", "source": "synthetic smoke fixture",
                    "fetched_at": "2026-10-24T00:00:00+00:00",
                    "days": [{"date": day, "temp_max": 24.0, "temp_min": 14.0, "rain_mm": 0.0} for day in dates]},
    }


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--epochs", type=int, default=32)
    parser.add_argument("--train-windows", type=int, default=1536)
    parser.add_argument("--validation-windows", type=int, default=192)
    parser.add_argument("--batch-size", type=int, default=64)
    parser.add_argument("--threads", type=int, default=2)
    args = parser.parse_args()
    if args.output_dir.exists() and any(args.output_dir.iterdir()):
        parser.error("output-dir must be new or empty; preserve existing trained artifacts")
    if min(args.epochs, args.train_windows, args.validation_windows, args.batch_size, args.threads) < 1:
        parser.error("training sizes must be positive")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    torch.set_num_threads(args.threads)
    torch.manual_seed(SEED)
    torch.use_deterministic_algorithms(True)
    train_x, train_y, _ = synthetic_windows(args.train_windows, SEED)
    valid_x, valid_y, valid_scale = synthetic_windows(args.validation_windows, SEED + 1)
    train_tensor, valid_tensor = torch.from_numpy(train_y), torch.from_numpy(valid_y)
    valid_inputs = tensors(valid_x)
    model = build_model().cpu().float()
    optimizer = torch.optim.Adam(model.parameters(), lr=0.003)
    best_loss, best_state, best_epoch = float("inf"), None, 0
    log = []
    start = time.perf_counter()
    with torch.no_grad():
        model.eval()
        initial = float(pinball(model(valid_inputs)["prediction"], valid_tensor))
    generator = np.random.default_rng(SEED + 2)
    for epoch in range(1, args.epochs + 1):
        model.train()
        order = generator.permutation(len(train_x))
        training_losses = []
        for offset in range(0, len(order), args.batch_size):
            indices = order[offset:offset + args.batch_size]
            optimizer.zero_grad(set_to_none=True)
            prediction = model(tensors(train_x[indices]))["prediction"]
            loss = pinball(prediction, train_tensor[indices])
            if not torch.isfinite(loss):
                raise RuntimeError("non-finite training loss")
            loss.backward()
            torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
            optimizer.step()
            training_losses.append(float(loss.detach()))
        model.eval()
        with torch.inference_mode():
            validation_loss = float(pinball(model(valid_inputs)["prediction"], valid_tensor))
        if validation_loss < best_loss:
            best_loss, best_epoch = validation_loss, epoch
            best_state = deepcopy(model.state_dict())
        log.append({"epoch": epoch, "train_normalized_pinball": float(np.mean(training_losses)), "validation_normalized_pinball": validation_loss})
        print(json.dumps({**log[-1], "elapsed_seconds": round(time.perf_counter() - start, 1)}), flush=True)
    model.load_state_dict(best_state, strict=True)
    model.eval()
    with torch.inference_mode():
        raw = model(valid_inputs)["prediction"].numpy()
    processed = np.sort(np.maximum(raw, 0), axis=-1)
    actual = valid_y * valid_scale[:, None]
    predictions = processed * valid_scale[:, None, None]
    metrics = {
        "label": "synthetic validation only; no real merchant performance claim",
        "rows": int(actual.size), "mae_units": float(np.mean(abs(predictions[:, :, 2] - actual))),
        "interval_coverage": float(np.mean((predictions[:, :, 0] <= actual) & (actual <= predictions[:, :, 4]))),
        "interval_width_units": float(np.mean(predictions[:, :, 4] - predictions[:, :, 0])),
        "normalized_pinball_5": best_loss,
    }
    checkpoint = args.output_dir / "model.ckpt"
    torch.save(best_state, checkpoint)
    model_metadata = {"name": "실시간 예보 TFT · 실험", "version": VERSION, "uses_weather": True, "training_data": "synthetic", "note": NOTE}
    manifest = {
        "schema_version": "1", "version": VERSION, "model": model_metadata,
        "architecture": CONFIG, "architecture_class": "pytorch_forecasting.TemporalFusionTransformer",
        "features": REALS, "quantiles": QUANTILES, "encoder_days": ENCODER_DAYS, "forecast_days": HORIZON,
        "checkpoint_sha256": hashlib.sha256(checkpoint.read_bytes()).hexdigest(),
        "checkpoint_bytes": checkpoint.stat().st_size,
        "training": {"data": "synthetic", "seed": SEED, "validation_seed": SEED + 1,
                     "split": "independent generated windows; validation used only to select epoch; not a real-data temporal backtest",
                     "windows": args.train_windows, "validation_windows": args.validation_windows,
                     "epochs": args.epochs, "best_epoch": best_epoch, "batch_size": args.batch_size,
                     "initial_validation_normalized_pinball": initial, "best_validation_normalized_pinball": best_loss,
                     "elapsed_seconds": time.perf_counter() - start, "threads": args.threads,
                     "device": "CPU", "precision": "float32", "optimizer": "Adam", "learning_rate": 0.003,
                     "assumptions": "synthetic sales increase 0.022 per degC relative to 20C and decrease 0.012 per rain mm; not evidence of a real causal response",
                     "forecast_noise": "temperature Gaussian sd1.5C, rain Gaussian sd2mm clipped at zero, generated independently per window"},
        "normalization": "history-only mean (minimum1); temperatures fixed physical scales; no fitted category/group/target encoders",
        "packages": {name: version(name) for name in ("torch", "pytorch-forecasting", "numpy")},
        "created_at": datetime.now(timezone.utc).isoformat(),
        "source_sha256": {filename: hashlib.sha256((ROOT / filename).read_bytes()).hexdigest() for filename in ("network.py", "train.py", "predict.py")},
        "synthetic_validation": metrics,
    }
    write_json(args.output_dir / "manifest.json", manifest)
    write_json(args.output_dir / "training-log.json", log)
    write_json(args.output_dir / "smoke.json", smoke_context())
    print(json.dumps({"completed": True, "best_epoch": best_epoch, "checkpoint_bytes": checkpoint.stat().st_size, "synthetic_validation": metrics}), flush=True)


if __name__ == "__main__":
    main()
