"""Matched no-weather TFT experiment using the original notebook protocol.

This is an offline training command, never imported by inference. The original
notebook's preprocessing and evaluation functions are executed explicitly; its
installation, Drive mounting, training and ordering cells are never executed.
Large data and all generated artifacts must remain outside the repository.
"""

from __future__ import annotations

import argparse
import ast
from datetime import datetime, timezone
import hashlib
from importlib.metadata import version
import json
from pathlib import Path
import pickle
import platform
import statistics
import time

import lightning.pytorch as pl
from lightning.pytorch.callbacks import EarlyStopping, LearningRateMonitor, ModelCheckpoint
from lightning.pytorch.loggers import CSVLogger
import numpy as np
import pandas as pd
import torch
from pytorch_forecasting import TemporalFusionTransformer, TimeSeriesDataSet
from pytorch_forecasting.data.encoders import GroupNormalizer, NaNLabelEncoder
from pytorch_forecasting.metrics import MAE, MAPE, RMSE, SMAPE, QuantileLoss


ROOT = Path(__file__).resolve().parents[1]
NOTEBOOK = ROOT / "ml/notebooks/startup_thon_1.ipynb"
WEATHER_FEATURES = ["tavg", "tmax", "tmin", "preciptotal", "avgspeed",
                    "tavg_missing", "tmax_missing", "tmin_missing",
                    "preciptotal_missing", "avgspeed_missing", "precip_trace"]
QCOLS = ["q10", "q25", "q50", "q75", "q90"]
KEYS = ["store_nbr", "item_nbr", "origin_time_idx", "time_idx", "horizon"]


class WeatherCollator:
    """Top-level/picklable version of notebook cell 10's exact collator."""

    def __init__(self, reals, mode="persistence"):
        self.indices = [reals.index(name) for name in WEATHER_FEATURES if name in reals]
        self.mode = mode

    def __call__(self, samples):
        x, y = TimeSeriesDataSet._collate_fn(samples)
        if self.mode == "persistence":
            rows = torch.arange(x["encoder_lengths"].shape[0])
            for index in self.indices:
                last = x["encoder_cont"][rows, x["encoder_lengths"] - 1, index]
                x["decoder_cont"][:, :, index] = last[:, None]
        return x, y


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def load_csv(root, name):
    matches = [path for path in (root / name, root / (name + ".zip")) if path.is_file()]
    if len(matches) != 1:
        raise ValueError(f"provide exactly one of {name} and {name}.zip under {root}")
    return pd.read_csv(matches[0], low_memory=False)


def install_functions(namespace, source, names):
    parsed = ast.parse(source)
    selected = [node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name in names]
    if {node.name for node in selected} != set(names):
        raise ValueError(f"original notebook functions not found: {names}")
    exec(compile(ast.Module(body=selected, type_ignores=[]), str(NOTEBOOK), "exec"), namespace)


def prepare(args):
    config = json.loads((args.reference_run / "run_config.json").read_text(encoding="utf-8"))
    if config["SMOKE_TEST"] or config["selected_series"] != 200 or config["QUANTILES"] != [.1, .25, .5, .75, .9]:
        raise ValueError("expected the delivered 200-series five-quantile full training run")
    notebook = json.loads(NOTEBOOK.read_text(encoding="utf-8"))
    source = lambda index: "".join(notebook["cells"][index]["source"])
    namespace = dict(config)
    namespace.update(np=np, pd=pd, torch=torch, TimeSeriesDataSet=TimeSeriesDataSet,
                     GroupNormalizer=GroupNormalizer, NaNLabelEncoder=NaNLabelEncoder,
                     WeatherCollator=WeatherCollator, OUT=args.output_dir,
                     display=lambda *values: None,
                     sales_raw=load_csv(args.data_dir, "train.csv"),
                     weather_raw=load_csv(args.data_dir, "weather.csv"),
                     key_raw=load_csv(args.data_dir, "key.csv"))
    if args.num_workers is not None:
        namespace["NUM_WORKERS"] = args.num_workers
    # These two reviewed cells contain schema validation, chronological splits,
    # training-only selection/imputation and the causal daily panel, no training.
    exec(compile(source(7), str(NOTEBOOK), "exec"), namespace)
    exec(compile(source(8), str(NOTEBOOK), "exec"), namespace)
    expected = pd.read_csv(args.reference_run / "selected_series.csv", dtype=str)
    pd.testing.assert_frame_equal(namespace["series_map"].reset_index(drop=True), expected, check_dtype=False)
    for key, actual in [("start_date", "START_DATE"), ("end_date", "END_DATE"),
                        ("train_end", "TRAIN_END"), ("validation_end", "VALID_END")]:
        if pd.Timestamp(config[key]) != namespace[actual]:
            raise ValueError(f"reference split changed: {key}")
    namespace["CALENDAR_REAL"] = ["time_idx", "weekend", "year_sin", "year_cos"]
    namespace["observation_prefix"] = {
        tuple(group): np.r_[0, part.sales_observed.to_numpy().cumsum()]
        for group, part in namespace["panel"].groupby(namespace["GROUP"], sort=False)
    }
    install_functions(namespace, source(10), ["valid_windows", "build_datasets", "make_loader"])
    datasets = namespace["build_datasets"](args.variant == "weather")
    for dataset, key in zip(datasets, ["train_windows", "validation_windows", "test_windows"], strict=True):
        if len(dataset) != config[key]:
            raise ValueError(f"reference window count changed: {key}: {len(dataset)} != {config[key]}")
    namespace.update(QCOLS=QCOLS, QMED="q50", device=torch.device(args.device))
    install_functions(namespace, source(13), ["batch_forecasts", "evaluate_predictions"])
    namespace["weather_defaults"].to_json(args.output_dir / "weather_fill_defaults.json")
    with (args.output_dir / "dataset_parameters.pkl").open("wb") as handle:
        pickle.dump(datasets[0].get_parameters(), handle)
    return namespace, datasets, config


def create_model(dataset, config):
    pl.seed_everything(config["SEED"], workers=True)
    return TemporalFusionTransformer.from_dataset(
        dataset, learning_rate=1e-3, hidden_size=config["HIDDEN_SIZE"], attention_head_size=4,
        dropout=.15, hidden_continuous_size=min(32, config["HIDDEN_SIZE"]), lstm_layers=1,
        output_size=5, loss=QuantileLoss(quantiles=config["QUANTILES"]), optimizer="adam",
        reduce_on_plateau_patience=3, log_interval=-1, mask_bias=-float("inf"),
    )


def reload_trained_checkpoint(path):
    # The locally generated checkpoint is trusted. Fresh metric objects avoid
    # Lightning's saved CUDA metric-device state during FP32 CPU reloading.
    checkpoint = torch.load(path, map_location="cpu", weights_only=False)
    params = dict(checkpoint["hyper_parameters"])
    params["loss"] = QuantileLoss(quantiles=[.1, .25, .5, .75, .9])
    params["logging_metrics"] = torch.nn.ModuleList([SMAPE(), MAE(), RMSE(), MAPE()])
    model = TemporalFusionTransformer(**params)
    model.load_state_dict(checkpoint["state_dict"], strict=True)
    return model.cpu().float().eval()


def assert_matched_rows(predictions, reference):
    left, right = predictions.sort_values(KEYS).reset_index(drop=True), reference.sort_values(KEYS).reset_index(drop=True)
    pd.testing.assert_frame_equal(left[KEYS].astype(str), right[KEYS].astype(str), check_dtype=False)
    np.testing.assert_allclose(left.actual, right.actual, rtol=0, atol=1e-4)
    if left.duplicated(KEYS).any():
        raise ValueError("duplicate evaluation rows")


def benchmark(args, namespace, datasets, config):
    class BatchTimer(pl.Callback):
        def __init__(self):
            self.times = []

        def on_train_batch_start(self, trainer, model, batch, batch_idx):
            if args.device == "cuda":
                torch.cuda.synchronize()
            self.start = time.perf_counter()

        def on_train_batch_end(self, trainer, model, outputs, batch, batch_idx):
            if args.device == "cuda":
                torch.cuda.synchronize()
            self.times.append(time.perf_counter() - self.start)

    timer = BatchTimer()
    model = create_model(datasets[0], config)
    trainer = pl.Trainer(accelerator="gpu" if args.device == "cuda" else "cpu", devices=1,
                         precision=args.precision, max_steps=args.batches + 3, max_epochs=1,
                         gradient_clip_val=.5, limit_val_batches=0, num_sanity_val_steps=0,
                         callbacks=[timer], logger=False, enable_checkpointing=False,
                         enable_model_summary=False, enable_progress_bar=False)
    start = time.perf_counter()
    trainer.fit(model, train_dataloaders=namespace["make_loader"](datasets[0], True))
    measured = timer.times[3:]
    seconds = statistics.mean(measured)
    steps = len(namespace["make_loader"](datasets[0], True))
    report = {"status": "benchmark_only_not_trained", "measured_batches": len(measured),
              "seconds_per_batch_mean": seconds, "train_batches_per_epoch": steps,
              "estimated_train_seconds_per_epoch": seconds * steps,
              "estimated_train_seconds_max_epochs": seconds * steps * config["MAX_EPOCHS"],
              "elapsed_seconds": time.perf_counter() - start,
              "gpu_peak_allocated_bytes": torch.cuda.max_memory_allocated() if args.device == "cuda" else None,
              "caveat": "Estimate excludes validation/checkpoint time, thermal throttling and data-loading stalls. Benchmark weights are discarded."}
    write_json(args.output_dir / "benchmark.json", report)
    print(json.dumps(report, indent=2))


def train(args, namespace, datasets, config):
    label = "tft_no_weather" if args.variant == "no-weather" else "tft_weather_control"
    directory = args.output_dir / label
    if (directory / "checkpoints").exists():
        raise ValueError("checkpoint directory already exists; choose a fresh output directory")
    checkpoint = ModelCheckpoint(dirpath=directory / "checkpoints", filename="best-{epoch:02d}-{val_loss:.4f}",
                                 monitor="val_loss", mode="min", save_top_k=1, save_last=True)
    model = create_model(datasets[0], config)
    trainer = pl.Trainer(
        accelerator="gpu" if args.device == "cuda" else "cpu", devices=1, precision=args.precision,
        max_epochs=config["MAX_EPOCHS"], gradient_clip_val=.5, limit_train_batches=config["TRAIN_BATCH_LIMIT"],
        limit_val_batches=1.0, num_sanity_val_steps=2,
        callbacks=[checkpoint, EarlyStopping(monitor="val_loss", patience=5, mode="min", check_finite=True),
                   LearningRateMonitor(logging_interval="epoch")],
        logger=CSVLogger(str(directory), name="logs"), log_every_n_steps=10,
        enable_model_summary=False, enable_progress_bar=False,
    )
    start = time.perf_counter()
    trainer.fit(model, train_dataloaders=namespace["make_loader"](datasets[0], True),
                val_dataloaders=namespace["make_loader"](datasets[1]))
    if not checkpoint.best_model_path:
        raise RuntimeError("training produced no selected checkpoint")
    best = reload_trained_checkpoint(checkpoint.best_model_path)
    del model, trainer
    if args.device == "cuda":
        torch.cuda.empty_cache()
    metrics = []
    for split, dataset in zip(["validation", "test"], datasets[1:], strict=True):
        predictions = namespace["batch_forecasts"](best, dataset)
        reference = pd.read_csv(args.reference_run / f"{split}_predictions.csv", dtype={"store_nbr": str, "item_nbr": str})
        assert_matched_rows(predictions, reference)
        predictions.to_csv(args.output_dir / f"{label}_{split}_predictions.csv", index=False)
        for processed, columns in [(False, ["raw_" + c for c in QCOLS]), (True, QCOLS)]:
            metrics.append({"model": label, "split": split, "postprocessed": processed,
                            **namespace["evaluate_predictions"](predictions, columns)})
        pd.DataFrame([{"horizon": horizon, **namespace["evaluate_predictions"](part)}
                      for horizon, part in predictions.groupby("horizon")]).to_csv(
                          args.output_dir / f"{label}_{split}_metrics_by_horizon.csv", index=False)
    pd.DataFrame(metrics).to_csv(args.output_dir / "metrics.csv", index=False)
    write_json(args.output_dir / "completion.json", {
        "status": "trained_and_evaluated", "variant": args.variant,
        "checkpoint": checkpoint.best_model_path, "best_validation_loss": float(checkpoint.best_model_score),
        "elapsed_train_and_evaluation_seconds": time.perf_counter() - start,
        "matched_reference_rows": True, "test_used_for_training": False,
    })


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--reference-run", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--mode", choices=["prepare", "benchmark", "train"], default="prepare")
    parser.add_argument("--variant", choices=["no-weather", "weather"], default="no-weather")
    parser.add_argument("--device", choices=["cpu", "cuda", "auto"], default="auto")
    parser.add_argument("--num-workers", type=int)
    parser.add_argument("--batches", type=int, default=12, help="measured benchmark batches after three warmup batches")
    args = parser.parse_args()
    args.output_dir = args.output_dir.resolve()
    if args.output_dir == ROOT or ROOT in args.output_dir.parents:
        parser.error("training output must be outside the Git repository")
    if args.batches < 1 or (args.num_workers is not None and args.num_workers < 0):
        parser.error("batches must be positive and num-workers nonnegative")
    if args.device == "auto":
        args.device = "cuda" if torch.cuda.is_available() else "cpu"
    if args.device == "cuda" and not torch.cuda.is_available():
        parser.error("CUDA unavailable in this interpreter")
    args.precision = "bf16-mixed" if args.device == "cuda" and torch.cuda.is_bf16_supported() else "32-true"
    torch.set_float32_matmul_precision("high")
    if args.device == "cuda":
        torch.backends.cuda.matmul.allow_tf32 = True
    args.output_dir.mkdir(parents=True, exist_ok=True)
    namespace, datasets, config = prepare(args)
    write_json(args.output_dir / "protocol.json", {
        "created_at": datetime.now(timezone.utc).isoformat(), "mode": args.mode, "variant": args.variant,
        "reference_run": str(args.reference_run.resolve()), "python": platform.python_version(),
        "device": torch.cuda.get_device_name() if args.device == "cuda" else "CPU", "precision": args.precision,
        "reference_device": config["gpu"], "reference_precision": config["precision"],
        "same_precision": args.precision == config["precision"],
        "hardware_changed": args.device != "cuda" or torch.cuda.get_device_name() != config["gpu"],
        "source_notebook_sha256": hashlib.sha256(NOTEBOOK.read_bytes()).hexdigest(),
        "packages": {name: version(name) for name in ["torch", "pytorch-forecasting", "lightning", "pandas", "numpy", "scikit-learn"]},
        "seed": config["SEED"], "batch_size": config["BATCH_SIZE"], "num_workers": namespace["NUM_WORKERS"],
        "max_epochs": config["MAX_EPOCHS"], "window_counts": [len(ds) for ds in datasets],
        "weather_protocol": "persistence" if args.variant == "weather" else "all eleven weather values and missing/trace indicators removed; station identity retained",
        "comparison_limits": "Single seed; hardware/runtime may differ from the historical A100 run. Weather contribution is predictive, not causal.",
    })
    if args.mode == "benchmark":
        benchmark(args, namespace, datasets, config)
    elif args.mode == "train":
        train(args, namespace, datasets, config)


if __name__ == "__main__":
    main()
