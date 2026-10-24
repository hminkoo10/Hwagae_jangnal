"""Rebuild the six-run paired evaluation using only Python's standard library.

Run from the repository root, without installing inference/training packages::

    python -m ml.reproduce_multiseed --evaluation-data unpacked/evaluation-data \
        --runs-dir unpacked/runs --reference-dir unpacked/summary \
        --output-dir reproduced-multiseed

The evaluation-data directory is the existing evaluation ZIP's extracted folder.
Each seed-{42,43,44}-{weather,no-weather} directory under runs must contain
test_predictions.csv, protocol.json and completion.json. Both input directories
require MANIFEST.json with a files list of {path, bytes, sha256} entries relative
to that directory. Preserve original run file bytes when renaming/copying them.
The optional reference directory contains the four original summary CSVs.
Output must be a new directory. No checkpoint, original-machine path, model
import, training, prediction, or server execution is used.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
from pathlib import Path

from ml.evaluate import ROOT, digest, evaluate, read_predictions
from ml.run_multiseed import SEEDS, SUBSETS, VARIANTS, paired_tables, write_csv, write_json


DATA_FILES = {
    "train.csv": "train.csv.zip",
    "weather.csv": "weather.csv.zip",
    "key.csv": "key.csv.zip",
    **{"reference/" + name: "current/" + name for name in (
        "run_config.json", "selected_series.csv", "validation_predictions.csv", "test_predictions.csv")},
}
RUN_FILES = ("test_predictions.csv", "protocol.json", "completion.json")
TABLE_KEYS = {
    "metrics.csv": ("seed", "variant", "subset"),
    "api-baseline.csv": ("subset", "model"),
    "paired-differences.csv": ("seed", "subset", "metric"),
    "summary.csv": ("subset", "metric", "variant"),
}
INTEGER_COLUMNS = {"seed", "n", "windows", "n_seeds"}
NO_WEATHER_PROTOCOL = "all eleven weather values and missing/trace indicators removed; station identity retained"


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def checked_files(directory, names):
    """Verify required archive entries; never follow paths supplied by metadata."""
    manifest_path = directory / "MANIFEST.json"
    records = read_json(manifest_path)["files"]
    indexed = {record["path"]: record for record in records}
    if len(indexed) != len(records):
        raise ValueError(f"Duplicate archive manifest paths: {manifest_path}")
    evidence = {}
    for name in names:
        path = directory / name  # names are fixed by this script, not the archive
        record = indexed.get(name)
        if record is None:
            raise ValueError(f"Missing archive manifest entry: {name}")
        if not path.is_file():
            raise ValueError(f"Missing required archive file: {name}")
        if path.stat().st_size != record["bytes"] or digest(path) != record["sha256"]:
            raise ValueError(f"Archive hash/size mismatch: {name}")
        evidence[name] = {"bytes": record["bytes"], "sha256": record["sha256"]}
    return evidence, digest(manifest_path)


def validate_run(protocol, completion, seed, variant, input_hashes):
    expected = {
        "seed": seed, "variant": variant, "mode": "train", "batch_size": 128,
        "max_epochs": 20, "num_workers": 2, "window_counts": [143620, 990, 1139],
        "weather_protocol": "persistence" if variant == "weather" else NO_WEATHER_PROTOCOL,
    }
    if any(protocol.get(key) != value for key, value in expected.items()):
        raise ValueError(f"Run protocol differs from the paired experiment: seed-{seed}-{variant}")
    recorded = {key: value["sha256"] for key, value in protocol["input_files"].items()}
    if recorded != input_hashes:
        raise ValueError(f"Run input hashes differ from the supplied evaluation data: seed-{seed}-{variant}")
    legacy = (seed == 42 and variant == "no-weather"
              and "cohort_reference_seed" not in protocol and "source_script_sha256" not in protocol
              and protocol.get("training_script_git_commit") == "de56d49")
    if not legacy and (protocol.get("cohort_reference_seed") != 42 or not protocol.get("source_script_sha256")):
        raise ValueError(f"Missing fixed cohort/source evidence: seed-{seed}-{variant}")
    if (completion.get("status") != "trained_and_evaluated"
            or completion.get("variant") != variant
            or completion.get("matched_reference_rows") is not True
            or completion.get("test_used_for_training") is not False
            or completion.get("training_seed", 42 if legacy else None) != seed):
        raise ValueError(f"Missing completed, aligned, held-out run evidence: seed-{seed}-{variant}")
    return legacy


def compare_table(name, actual, expected):
    """Compare identities/counts exactly, floating values with abs/rel 1e-12."""
    if not actual or len(actual) != len(expected):
        raise ValueError(f"{name}: row counts differ or the table is empty")
    columns = set(actual[0])
    if any(set(row) != columns for row in (*actual, *expected)):
        raise ValueError(f"{name}: columns differ")
    identifiers = TABLE_KEYS[name]

    def identity(row):
        return tuple(int(row[key]) if key in INTEGER_COLUMNS else row[key] for key in identifiers)

    indexed = {identity(row): row for row in expected}
    actual_keys = {identity(row) for row in actual}
    if len(indexed) != len(expected) or len(actual_keys) != len(actual) or set(indexed) != actual_keys:
        raise ValueError(f"{name}: missing, different or duplicate row identities")
    for row in actual:
        key = identity(row)
        for column in columns - set(identifiers):
            got, want = row[column], indexed[key][column]
            if column in INTEGER_COLUMNS:
                same = got == int(want)
            elif got is None:
                same = want in (None, "")
            else:
                value = float(want)
                same = math.isfinite(value) and math.isclose(got, value, rel_tol=1e-12, abs_tol=1e-12)
            if not same:
                raise ValueError(f"{name}: {key}, {column}: expected {want}, got {got}")


def reproduce(evaluation_data, runs_dir, output_dir, reference_dir=None):
    if output_dir.exists():
        raise ValueError("Output directory already exists; choose a new directory to preserve saved results")
    data_evidence, data_manifest_hash = checked_files(evaluation_data, DATA_FILES.values())
    run_names = [f"seed-{seed}-{variant}/{name}" for seed in SEEDS for variant in VARIANTS for name in RUN_FILES]
    run_evidence, run_manifest_hash = checked_files(runs_dir, run_names)
    input_hashes = {key: data_evidence[name]["sha256"] for key, name in DATA_FILES.items()}
    config = read_json(evaluation_data / "current/run_config.json")
    if any(config.get(key) != value for key, value in {"SEED": 42, "BATCH_SIZE": 128, "MAX_EPOCHS": 20}.items()):
        raise ValueError("Reference training policy differs from the paired experiment")
    reference = read_predictions(evaluation_data / "current/test_predictions.csv")
    protocols, run_artifacts, paths = [], [], {}
    for seed in SEEDS:
        for variant in VARIANTS:
            name = f"seed-{seed}-{variant}"
            directory = runs_dir / name
            protocol, completion = read_json(directory / "protocol.json"), read_json(directory / "completion.json")
            legacy = validate_run(protocol, completion, seed, variant, input_hashes)
            protocols.append(protocol)
            path = directory / "test_predictions.csv"
            predictions = read_predictions(path)
            if set(predictions) != set(reference) or any(predictions[key][0] != reference[key][0] for key in reference):
                raise ValueError(f"Different reference test keys or actuals: {name}")
            paths[(seed, variant)] = path
            run_artifacts.append({"seed": seed, "variant": variant, "legacy_seed_42_metadata": legacy,
                                  "files": {file: run_evidence[f"{name}/{file}"] for file in RUN_FILES}})
    for field in ("python", "device", "precision", "packages", "source_notebook_sha256"):
        if not protocols[0].get(field) or any(p.get(field) != protocols[0][field] for p in protocols):
            raise ValueError(f"Paired run runtime/source metadata differs: {field}")
    if len({p["source_script_sha256"] for p in protocols if "source_script_sha256" in p}) != 1:
        raise ValueError("New run training source hashes differ")

    rows, manifests, baseline_rows = [], [], None
    for seed in SEEDS:
        table, manifest = evaluate(paths[(seed, "weather")], evaluation_data / DATA_FILES["train.csv"],
                                   paths[(seed, "no-weather")])
        manifests.append(manifest)
        current_baseline = [row for row in table if row["model"] == "current_API_weekday_baseline"]
        if baseline_rows is not None and current_baseline != baseline_rows:
            raise ValueError("API baseline changed between paired evaluations")
        baseline_rows = current_baseline
        for row in table:
            if row["model"] != "current_API_weekday_baseline":
                variant = "weather" if row["model"] == "TFT_persistence_postprocessed" else "no-weather"
                rows.append({"seed": seed, "variant": variant, **{key: value for key, value in row.items() if key != "model"}})
    for key in ("full_keys_sha256", "strict_56_keys_sha256", "full_original_test_rows", "strict_56_observed_history_rows"):
        if len({manifest[key] for manifest in manifests}) != 1:
            raise ValueError("Matched evaluation subset changed between seeds")
    if {row["subset"] for row in baseline_rows} != set(SUBSETS):
        raise ValueError("Complete original and strict56 API baseline tables are required")
    paired, summary = paired_tables(rows)
    tables = {"metrics.csv": rows, "api-baseline.csv": baseline_rows,
              "paired-differences.csv": paired, "summary.csv": summary}
    reference_hashes = {}
    if reference_dir is not None:
        for name, table in tables.items():
            path = reference_dir / name
            with path.open(encoding="utf-8-sig", newline="") as stream:
                expected = list(csv.DictReader(stream))
            compare_table(name, table, expected)
            reference_hashes[name] = digest(path)
    manifest = {
        "status": "reproduced_three_seed_pairs_from_stored_predictions",
        "seeds": SEEDS, "variants": VARIANTS, "n_seed_pairs": len(SEEDS),
        "full_rows": manifests[0]["full_original_test_rows"],
        "strict_rows": manifests[0]["strict_56_observed_history_rows"],
        "full_keys_sha256": manifests[0]["full_keys_sha256"],
        "strict_keys_sha256": manifests[0]["strict_56_keys_sha256"],
        "input_manifests_sha256": {"evaluation_data": data_manifest_hash, "runs": run_manifest_hash},
        "evaluation_data_files": data_evidence, "run_artifacts": run_artifacts,
        "source_sha256": {"ml/reproduce_multiseed.py": digest(Path(__file__)),
                          "ml/evaluate.py": digest(ROOT / "ml/evaluate.py"),
                          "ml/run_multiseed.py": digest(ROOT / "ml/run_multiseed.py")},
        "api_baseline": {key: value for key, value in manifests[0]["inputs"]["api_baseline"].items() if key != "path"},
        "baseline_lookback_days": 84, "strict_observed_history_days": 56,
        "weather_data_use": "Archive hash and protocol verification only; scoring uses saved predictions and original observed sales.",
        "weather_strategy": "Historical observations with decoder persistence, not archived issued forecasts.",
        "comparison": {"status": "passed" if reference_dir is not None else "not_requested",
                       "abs_tol": 1e-12, "rel_tol": 1e-12, "reference_sha256": reference_hashes},
        "difference_convention": "weather minus no-weather; negative error differences favor weather; coverage differences alone are not improvements",
        "standard_deviation": "Sample standard deviation across three training seeds (ddof=1), not over daily prediction rows",
        "limitations": [
            "This reproduces evaluation of stored predictions; it does not rerun training or inference or independently prove how the model was trained.",
            "Supplied archive manifests detect corruption relative to those manifests, not independent authenticity; compare the distributed archive SHA separately.",
            "The reused no-weather seed-42 protocol lacks cohort_reference_seed/source_script_sha256 and completion.training_seed; its original de56d49 record is retained without inventing missing fields.",
            "Run protocols log six package versions; this replay cannot verify the two additional packages logged only in the training environment probe.",
            "Three predeclared seed pairs do not establish statistical significance or causal weather effects; the reused no-weather seed-42 result was already known.",
        ],
    }
    # All six runs and optional regression comparisons must pass before writing.
    output_dir.mkdir(parents=True, exist_ok=False)
    for name, table in tables.items():
        write_csv(output_dir / name, table)
    manifest["output_sha256"] = {name: digest(output_dir / name) for name in tables}
    write_json(output_dir / "manifest.json", manifest)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--evaluation-data", type=Path, required=True)
    parser.add_argument("--runs-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True, help="New directory; existing directories are never overwritten")
    parser.add_argument("--reference-dir", type=Path, help="Compare all four original summary tables with abs/rel tolerance 1e-12")
    args = parser.parse_args()
    try:
        manifest = reproduce(args.evaluation_data, args.runs_dir, args.output_dir, args.reference_dir)
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"Reproduction failed: {error}\n")
    print(json.dumps({"status": manifest["status"], "seed_pairs": manifest["n_seed_pairs"],
                      "full_rows": manifest["full_rows"], "strict_rows": manifest["strict_rows"],
                      "comparison": manifest["comparison"]["status"], "output": str(args.output_dir)}, indent=2))


if __name__ == "__main__":
    main()
