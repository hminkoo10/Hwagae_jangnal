"""Run and score three predeclared paired TFT seeds, one GPU job at a time.

The model training source/notebook are copied and hashed before the first run.
Existing completed jobs can be verified and reused; partial jobs are never
overwritten. Test metrics are aggregated only after all six jobs have completed.
"""

from __future__ import annotations

import argparse
import csv
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import statistics
import subprocess
import sys

from ml.evaluate import digest, evaluate, read_predictions


ROOT = Path(__file__).resolve().parents[1]
SEEDS = [42, 43, 44]
VARIANTS = ["weather", "no-weather"]
MEASURES = ["MAE", "WAPE", "mean_pinball_3", "interval_coverage", "interval_width"]
SUBSETS = ["full_original_test", "strict_56_observed_history"]
PACKAGES = ["torch", "pytorch-forecasting", "lightning", "pytorch-lightning",
            "torchmetrics", "pandas", "numpy", "scikit-learn"]


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8")


def now():
    return datetime.now(timezone.utc).isoformat()


def runtime(python):
    probe = """import json,platform,torch
from importlib.metadata import version
names = %r
print(json.dumps({'python':platform.python_version(), 'device':torch.cuda.get_device_name() if torch.cuda.is_available() else None,
 'precision':'bf16-mixed' if torch.cuda.is_available() and torch.cuda.is_bf16_supported() else None,
 'packages':{name:version(name) for name in names}}))
""" % PACKAGES
    return json.loads(subprocess.check_output([str(python), "-c", probe], text=True, encoding="utf-8", timeout=60))


def verify_hashes(files):
    for name, evidence in files.items():
        if digest(Path(evidence["path"])) != evidence["sha256"]:
            raise ValueError(f"Input changed since the experiment was planned: {name}")


def validate_reuse(directory, plan):
    protocol, completion = read_json(directory / "protocol.json"), read_json(directory / "completion.json")
    if completion["status"] != "trained_and_evaluated" or not completion["matched_reference_rows"] or completion["test_used_for_training"]:
        raise ValueError("Only a completed, aligned, held-out evaluation can be reused")
    expected = {"seed": 42, "variant": "no-weather", "mode": "train", "batch_size": 128,
                "max_epochs": 20, "num_workers": 2, "window_counts": [143620, 990, 1139]}
    expected.update({key: plan[key] for key in ["python", "device", "precision"]})
    if any(protocol.get(key) != value for key, value in expected.items()):
        raise ValueError("Existing seed-42 no-weather protocol differs from the paired experiment")
    if any(plan["packages"].get(key) != value for key, value in protocol["packages"].items()):
        raise ValueError("Existing no-weather package versions differ")
    if {key: value["sha256"] for key, value in protocol["input_files"].items()} != {
            key: value["sha256"] for key, value in plan["input_files"].items()}:
        raise ValueError("Existing no-weather inputs differ")
    if protocol["source_notebook_sha256"] != plan["source_sha256"]["ml/notebooks/startup_thon_1.ipynb"]:
        raise ValueError("Existing no-weather source notebook differs")
    reuse = plan["reused_no_weather_42"]
    for name, evidence in reuse["artifacts"].items():
        path = Path(completion["checkpoint"]) if name == "best_checkpoint" else directory / name
        if digest(path) != evidence["sha256"]:
            raise ValueError(f"Existing no-weather artifact changed: {name}")
    for name in ["protocol", "completion"]:
        if digest(directory / f"{name}.json") != reuse[f"{name}_sha256"]:
            raise ValueError(f"Existing no-weather {name} changed")


def create_plan(args):
    from ml.train_ablation import input_evidence, prepare_output_dir

    output = args.output_dir.resolve()
    if output == ROOT or ROOT in output.parents:
        raise ValueError("All training artifacts must remain outside the Git repository")
    prepare_output_dir(output)
    observed = runtime(args.python)
    if observed["precision"] != "bf16-mixed":
        raise ValueError("This paired protocol requires a BF16-capable CUDA environment")
    config = read_json(args.reference_run / "run_config.json")
    if config["BATCH_SIZE"] != 128 or config["MAX_EPOCHS"] != 20 or config["SEED"] != 42:
        raise ValueError("Reference training policy differs")
    source = output / "frozen-source"
    source_hashes = {}
    for name in ["ml/__init__.py", "ml/train_ablation.py", "ml/notebooks/startup_thon_1.ipynb"]:
        destination = source / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(ROOT / name, destination)
        source_hashes[name] = digest(destination)
    reuse = args.reuse_no_weather_42.resolve() if args.reuse_no_weather_42 else None
    plan = {
        "experiment_id": "paired-weather-seeds-42-43-44", "created_at_utc": now(),
        "seeds": SEEDS, "variants": VARIANTS, "cohort_reference_seed": 42,
        "selection_rule": "All three predeclared seed pairs; no test-driven selection or stopping.",
        **observed, "python_executable": str(args.python.absolute()),
        "source_sha256": source_hashes, "frozen_source_dir": str(source),
        "input_files": input_evidence(args.data_dir, args.reference_run),
        "data_dir": str(args.data_dir.resolve()), "reference_run": str(args.reference_run.resolve()),
        "window_counts": [143620, 990, 1139],
        "training_policy": {key: config[key] for key in ["SEED", "ENCODER_DAYS", "HORIZON",
                            "BATCH_SIZE", "MAX_EPOCHS", "HIDDEN_SIZE", "NUM_WORKERS",
                            "TRAIN_BATCH_LIMIT", "QUANTILES", "train_end", "validation_end", "end_date"]},
        "fixed_model_policy": {"attention_heads": 4, "dropout": .15, "hidden_continuous_size": 32,
                               "lstm_layers": 1, "optimizer": "adam", "learning_rate": .001,
                               "gradient_clip": .5, "early_stopping_patience": 5,
                               "reduce_on_plateau_patience": 3, "selection_metric": "validation_loss"},
        "runs": [{"seed": seed, "variant": variant,
                  "directory": str(reuse if reuse and seed == 42 and variant == "no-weather" else output / f"seed-{seed}-{variant}"),
                  "reuse": bool(reuse and seed == 42 and variant == "no-weather")}
                 for seed in SEEDS for variant in VARIANTS],
        "limitations": ["Three seeds do not establish statistical significance or causal effects.",
                        "Historical persistence, not archived issued forecasts."],
    }
    if reuse:
        summary = read_json(ROOT / "ml/ablation/completed-run.json")
        plan["reused_no_weather_42"] = {
            "directory": str(reuse), "artifacts": summary["artifacts"],
            "protocol_sha256": digest(reuse / "protocol.json"),
            "completion_sha256": digest(reuse / "completion.json"),
            "original_script_git_commit": summary["training_script_git_commit"],
        }
        validate_reuse(reuse, plan)
        plan["limitations"].append("The reused seed-42 result was already known before this extension.")
        plan["limitations"].append("The historical reused run logged six package versions; pytorch-lightning and torchmetrics were not separately logged in that run protocol. The current unchanged environment is probed for all eight.")
    write_json(output / "experiment-plan.json", plan)
    print(json.dumps({"plan": str(output / "experiment-plan.json"), "sha256": digest(output / "experiment-plan.json")}, indent=2))


def verify_plan(plan):
    if plan["seeds"] != SEEDS or plan["variants"] != VARIANTS:
        raise ValueError("Expected the predeclared seed pairs 42,43,44")
    if [(run["seed"], run["variant"]) for run in plan["runs"]] != [(s, v) for s in SEEDS for v in VARIANTS]:
        raise ValueError("Run list differs from the predeclared six model fits")
    for name, expected in plan["source_sha256"].items():
        if digest(Path(plan["frozen_source_dir"]) / name) != expected:
            raise ValueError(f"Frozen training source changed: {name}")
    verify_hashes(plan["input_files"])


def validate_completed(run, plan):
    directory = Path(run["directory"])
    if run["reuse"]:
        validate_reuse(directory, plan)
        return
    protocol, completion = read_json(directory / "protocol.json"), read_json(directory / "completion.json")
    expected = {"seed": run["seed"], "cohort_reference_seed": 42, "variant": run["variant"],
                "mode": "train", "batch_size": 128, "max_epochs": 20, "num_workers": 2,
                "window_counts": [143620, 990, 1139],
                "source_script_sha256": plan["source_sha256"]["ml/train_ablation.py"],
                "source_notebook_sha256": plan["source_sha256"]["ml/notebooks/startup_thon_1.ipynb"]}
    expected.update({key: plan[key] for key in ["python", "device", "precision"]})
    if any(protocol.get(key) != value for key, value in expected.items()):
        raise ValueError(f"Completed training protocol differs: {directory}")
    if any(plan["packages"].get(key) != value for key, value in protocol["packages"].items()):
        raise ValueError("Completed training package versions differ")
    if {key: value["sha256"] for key, value in protocol["input_files"].items()} != {
            key: value["sha256"] for key, value in plan["input_files"].items()}:
        raise ValueError("Completed training input hashes differ")
    if completion["status"] != "trained_and_evaluated" or not completion["matched_reference_rows"] or completion["test_used_for_training"]:
        raise ValueError("Completed run did not pass held-out alignment checks")
    if completion["training_seed"] != run["seed"]:
        raise ValueError("Completed run uses a different training seed")


def run_jobs(plan_path):
    plan = read_json(plan_path)
    verify_plan(plan)
    observed = runtime(Path(plan["python_executable"]))
    if any(observed[key] != plan[key] for key in ["python", "device", "precision", "packages"]):
        raise ValueError("Current runtime differs from the frozen paired-experiment environment")
    state = {"experiment_plan_sha256": digest(plan_path), "orchestrator_sha256": digest(Path(__file__)),
             "started_at_utc": now(), "runtime_verified": observed, "status": "running", "completed": []}
    status_path = plan_path.parent / "status.json"
    for run in plan["runs"]:
        verify_plan(plan)
        directory = Path(run["directory"])
        if (directory / "completion.json").is_file():
            validate_completed(run, plan)
            state["completed"].append({**run, "verified_existing": True})
            write_json(status_path, state)
            continue
        if directory.exists():
            raise ValueError(f"Incomplete run must be investigated, never overwritten: {directory}")
        observed = runtime(Path(plan["python_executable"]))
        if any(observed[key] != plan[key] for key in ["python", "device", "precision", "packages"]):
            raise ValueError("Runtime changed between sequential training jobs")
        write_json(plan_path.parent / f"seed-{run['seed']}-{run['variant']}-runtime.json",
                   {"checked_at_utc": now(), "seed": run["seed"], "variant": run["variant"], **observed})
        command = [plan["python_executable"], "-u", "-m", "ml.train_ablation",
                   "--data-dir", plan["data_dir"], "--reference-run", plan["reference_run"],
                   "--output-dir", str(directory), "--mode", "train", "--device", "cuda",
                   "--variant", run["variant"], "--seed", str(run["seed"])]
        state["active"] = {**run, "started_at_utc": now(), "command": command}
        write_json(status_path, state)
        print(json.dumps({"status": "starting", **run}), flush=True)
        env = os.environ.copy()
        env.update(PYTHONUNBUFFERED="1", PYTHONIOENCODING="utf-8")
        with (plan_path.parent / f"seed-{run['seed']}-{run['variant']}.log").open("xb") as log:
            process = subprocess.Popen(command, cwd=plan["frozen_source_dir"], env=env,
                                       stdout=log, stderr=subprocess.STDOUT, shell=False,
                                       creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
            state["active"]["pid"] = process.pid
            write_json(status_path, state)
            try:
                code = process.wait()
            finally:
                if process.poll() is None:
                    # Windows venv launchers can have an actual interpreter
                    # child. Stop this owned process tree, not unrelated jobs.
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"],
                                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                                       check=False, timeout=10)
                    else:
                        process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=5)
        if code:
            state["status"] = "failed"
            state["exit_code"] = code
            write_json(status_path, state)
            raise RuntimeError(f"Training failed with exit code {code}; see its preserved log")
        validate_completed(run, plan)
        state["completed"].append(run)
        write_json(status_path, state)
        print(json.dumps({"status": "completed", **run}), flush=True)
    state.update(status="all_six_completed", finished_at_utc=now())
    state.pop("active", None)
    write_json(status_path, state)


def paired_tables(rows):
    paired, summary = [], []
    by_key = {(int(row["seed"]), row["variant"], row["subset"]): row for row in rows}
    if len(rows) != 12 or len(by_key) != 12 or set(by_key) != {(s, v, subset) for s in SEEDS for v in VARIANTS for subset in SUBSETS}:
        raise ValueError("Every predeclared seed/variant/subset must be present exactly once")
    for subset in SUBSETS:
        for measure in MEASURES:
            values = {variant: [by_key[(seed, variant, subset)][measure] for seed in SEEDS] for variant in VARIANTS}
            if any(value is None for series in values.values() for value in series):
                raise ValueError("Undefined metric cannot be summarized as a number")
            deltas = [weather - no_weather for weather, no_weather in zip(values["weather"], values["no-weather"], strict=True)]
            for seed, weather, no_weather, delta in zip(SEEDS, values["weather"], values["no-weather"], deltas, strict=True):
                paired.append({"seed": seed, "subset": subset, "metric": measure, "weather": weather,
                               "no_weather": no_weather, "difference_weather_minus_no_weather": delta,
                               "relative_error_reduction": (no_weather - weather) / no_weather
                               if measure in {"MAE", "WAPE", "mean_pinball_3"} and no_weather else None})
            for variant, series in {**values, "paired_difference": deltas}.items():
                summary.append({"subset": subset, "metric": measure, "variant": variant,
                                "n_seeds": len(series), "mean": statistics.mean(series),
                                "sample_std": statistics.stdev(series), "min": min(series), "max": max(series)})
    return paired, summary


def write_csv(path, rows):
    with path.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)


def summary_limitations(plan):
    limitations = list(plan["limitations"])
    limitations.append("Removing the eleven weather value/missing/trace features changes input dimension and model parameter count; this is not a parameter-count-matched or causal comparison.")
    if plan.get("reused_no_weather_42"):
        limitations.append("Historical reused seed-42 protocol directly logs six package versions; pytorch-lightning/torchmetrics are verified only in the current unchanged eight-package environment probe, not a separate historical runtime record.")
    return limitations


def summarize(plan_path, output):
    plan = read_json(plan_path)
    verify_plan(plan)
    for run in plan["runs"]:
        validate_completed(run, plan)
    reference = read_predictions(Path(plan["reference_run"]) / "test_predictions.csv")
    runs = {(run["seed"], run["variant"]): run for run in plan["runs"]}
    rows, manifests, artifacts, baseline_rows = [], [], [], None
    for seed in SEEDS:
        paths = {}
        for variant in VARIANTS:
            directory = Path(runs[(seed, variant)]["directory"])
            label = "tft_weather_control" if variant == "weather" else "tft_no_weather"
            path = directory / f"{label}_test_predictions.csv"
            predictions = read_predictions(path)
            if set(predictions) != set(reference) or any(predictions[key][0] != reference[key][0] for key in reference):
                raise ValueError("A seed uses different reference test keys or actuals")
            paths[variant] = path
            completion = read_json(directory / "completion.json")
            protocol = read_json(directory / "protocol.json")
            artifacts.append({"seed": seed, "variant": variant, "test_csv_sha256": digest(path),
                              "checkpoint_sha256": digest(Path(completion["checkpoint"])),
                              "protocol_sha256": digest(directory / "protocol.json"),
                              "packages_recorded_in_run_protocol": protocol["packages"],
                              "completion": completion})
        table, manifest = evaluate(paths["weather"], Path(plan["input_files"]["train.csv"]["path"]), paths["no-weather"])
        manifests.append(manifest)
        current_baseline = [row for row in table if row["model"] == "current_API_weekday_baseline"]
        if baseline_rows is not None and current_baseline != baseline_rows:
            raise ValueError("API baseline changed between paired evaluations")
        baseline_rows = current_baseline
        for row in table:
            if row["model"] == "current_API_weekday_baseline":
                continue
            variant = "weather" if row["model"] == "TFT_persistence_postprocessed" else "no-weather"
            rows.append({"seed": seed, "variant": variant, **{k: v for k, v in row.items() if k != "model"}})
    for key in ["full_keys_sha256", "strict_56_keys_sha256", "full_original_test_rows", "strict_56_observed_history_rows"]:
        if len({manifest[key] for manifest in manifests}) != 1:
            raise ValueError("Matched evaluation subset changed between seeds")
    paired, summary = paired_tables(rows)
    output.mkdir(parents=True, exist_ok=True)
    write_csv(output / "metrics.csv", rows)
    write_csv(output / "api-baseline.csv", baseline_rows)
    write_csv(output / "paired-differences.csv", paired)
    write_csv(output / "summary.csv", summary)
    write_json(output / "manifest.json", {
        "status": "three_pairs_completed_and_aligned", "created_at_utc": now(),
        "experiment_plan_sha256": digest(plan_path), "orchestrator_sha256": digest(Path(__file__)),
        "evaluator_sha256": digest(ROOT / "ml/evaluate.py"), "seeds": SEEDS, "n_seed_pairs": 3,
        "runtime": {key: plan[key] for key in ["python", "device", "precision", "packages"]},
        "full_rows": manifests[0]["full_original_test_rows"], "strict_rows": manifests[0]["strict_56_observed_history_rows"],
        "full_keys_sha256": manifests[0]["full_keys_sha256"], "strict_keys_sha256": manifests[0]["strict_56_keys_sha256"],
        "api_baseline": manifests[0]["inputs"]["api_baseline"], "artifacts": artifacts,
        "difference_convention": "weather minus no-weather; negative error differences favor weather; coverage differences alone are not improvements",
        "standard_deviation": "Sample standard deviation across three training seeds (ddof=1), not over daily prediction rows",
        "limitations": summary_limitations(plan),
    })
    print(json.dumps({"status": "summarized", "seed_pairs": 3, "output": str(output)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="mode", required=True)
    create = commands.add_parser("plan")
    create.add_argument("--data-dir", type=Path, required=True)
    create.add_argument("--reference-run", type=Path, required=True)
    create.add_argument("--output-dir", type=Path, required=True)
    create.add_argument("--python", type=Path, default=Path(sys.executable))
    create.add_argument("--reuse-no-weather-42", type=Path)
    run = commands.add_parser("run")
    run.add_argument("--plan", type=Path, required=True)
    score = commands.add_parser("summarize")
    score.add_argument("--plan", type=Path, required=True)
    score.add_argument("--output-dir", type=Path, required=True)
    args = parser.parse_args()
    if args.mode == "plan":
        create_plan(args)
    elif args.mode == "run":
        run_jobs(args.plan)
    else:
        summarize(args.plan, args.output_dir)


if __name__ == "__main__":
    main()
