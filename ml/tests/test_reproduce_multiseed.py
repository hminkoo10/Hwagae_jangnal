"""Diagnostic synthetic archives, never substitutes for the six real runs."""

import csv
from datetime import date, timedelta
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
import zipfile

from ml.evaluate import ROOT, digest, evaluate
from ml.reproduce_multiseed import DATA_FILES, NO_WEATHER_PROTOCOL, compare_table, reproduce
from ml.run_multiseed import SEEDS, VARIANTS, paired_tables, write_csv, write_json


class ReproduceMultiseedTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.data = self.root / "evaluation-data"
        self.runs = self.root / "runs"
        self.output = self.root / "output"
        (self.data / "current").mkdir(parents=True)
        self.runs.mkdir()
        origin = date(2020, 4, 1)
        sales, predictions = [], []
        for store in ("1", "2"):
            for offset in range(-83, 8):
                if store == "2" and offset == -10:
                    continue
                day = (origin + timedelta(days=offset)).isoformat()
                sales.append({"store_nbr": store, "item_nbr": "1", "date": day,
                              "units": 10 if offset <= 0 else 999})
                if offset > 0:
                    predictions.append({"store_nbr": store, "item_nbr": "1", "origin_date": origin.isoformat(),
                                        "date": day, "actual": 999, "q10": 997, "q50": 998, "q90": 999})
        self.predictions = predictions
        self.zip_csv(self.data / "train.csv.zip", sales)
        self.zip_csv(self.data / "weather.csv.zip", [{"station_nbr": "1", "date": origin.isoformat(), "tavg": "60"}])
        self.zip_csv(self.data / "key.csv.zip", [{"store_nbr": "1", "station_nbr": "1"}])
        write_json(self.data / "current/run_config.json", {"SEED": 42, "BATCH_SIZE": 128, "MAX_EPOCHS": 20})
        write_csv(self.data / "current/selected_series.csv", [{"store_nbr": "1", "item_nbr": "1"}])
        for name in ("validation_predictions.csv", "test_predictions.csv"):
            write_csv(self.data / "current" / name, predictions)
        self.seal(self.data)
        input_files = {key: {"path": "/original-machine/unavailable/" + name, "sha256": digest(self.data / name)}
                       for key, name in DATA_FILES.items()}
        for seed in SEEDS:
            for variant in VARIANTS:
                directory = self.directory(seed, variant)
                directory.mkdir()
                error = seed - 41 + (2 if variant == "no-weather" else 0)
                rows = [{**row, "q10": 998 - error, "q50": 999 - error, "q90": 1000 - error} for row in predictions]
                write_csv(directory / "test_predictions.csv", rows)
                protocol = {
                    "mode": "train", "seed": seed, "variant": variant, "cohort_reference_seed": 42,
                    "batch_size": 128, "num_workers": 2, "max_epochs": 20,
                    "window_counts": [143620, 990, 1139], "input_files": input_files,
                    "source_script_sha256": "a" * 64, "source_notebook_sha256": "b" * 64,
                    "python": "3.11.0", "device": "diagnostic-test-device", "precision": "bf16-mixed",
                    "packages": {"diagnostic-fixture": "1"},
                    "weather_protocol": "persistence" if variant == "weather" else NO_WEATHER_PROTOCOL,
                }
                completion = {"status": "trained_and_evaluated", "variant": variant, "training_seed": seed,
                              "matched_reference_rows": True, "test_used_for_training": False,
                              "checkpoint": "/deliberately-absent/checkpoint.ckpt"}
                if seed == 42 and variant == "no-weather":
                    protocol.pop("cohort_reference_seed")
                    protocol.pop("source_script_sha256")
                    protocol["training_script_git_commit"] = "de56d49"
                    completion.pop("training_seed")
                write_json(directory / "protocol.json", protocol)
                write_json(directory / "completion.json", completion)
        self.seal(self.runs)

    @staticmethod
    def zip_csv(path, rows):
        stream = io.StringIO(newline="")
        writer = csv.DictWriter(stream, fieldnames=list(rows[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(rows)
        with zipfile.ZipFile(path, "w") as archive:
            archive.writestr(path.stem, stream.getvalue())

    @staticmethod
    def seal(directory):
        records = [{"path": path.relative_to(directory).as_posix(), "bytes": path.stat().st_size, "sha256": digest(path)}
                   for path in sorted(directory.rglob("*")) if path.is_file() and path.name != "MANIFEST.json"]
        write_json(directory / "MANIFEST.json", {"files": records})

    def directory(self, seed=42, variant="weather"):
        return self.runs / f"seed-{seed}-{variant}"

    @staticmethod
    def read_rows(path):
        with path.open(encoding="utf-8", newline="") as stream:
            return list(csv.DictReader(stream))

    def change_json(self, path, updates):
        value = json.loads(path.read_text(encoding="utf-8"))
        value.update(updates)
        write_json(path, value)
        self.seal(self.runs)

    def test_tables_match_training_summarizer_and_keep_causal_strict_subsets(self):
        manifest = reproduce(self.data, self.runs, self.output)
        self.assertEqual((manifest["full_rows"], manifest["strict_rows"]), (14, 7))
        self.assertTrue(manifest["run_artifacts"][1]["legacy_seed_42_metadata"])
        original = self.root / "original-summary"
        original.mkdir()
        rows = []
        for seed in SEEDS:
            table, _ = evaluate(self.directory(seed) / "test_predictions.csv", self.data / "train.csv.zip",
                                self.directory(seed, "no-weather") / "test_predictions.csv")
            baselines = [row for row in table if row["model"] == "current_API_weekday_baseline"]
            # Future sales jump to 999; the baseline only sees historical 10s.
            self.assertTrue(all(row["MAE"] == 989 for row in baselines))
            for row in table:
                if row["model"] != "current_API_weekday_baseline":
                    rows.append({"seed": seed, "variant": "weather" if row["model"] == "TFT_persistence_postprocessed" else "no-weather",
                                 **{key: value for key, value in row.items() if key != "model"}})
        paired, summary = paired_tables(rows)
        for name, expected in {"metrics.csv": rows, "api-baseline.csv": baselines,
                               "paired-differences.csv": paired, "summary.csv": summary}.items():
            write_csv(original / name, expected)
            self.assertEqual((self.output / name).read_bytes(), (original / name).read_bytes())
        mae = [row for row in summary if row["metric"] == "MAE" and row["variant"] == "weather"]
        self.assertTrue(all(row["mean"] == 2 and row["sample_std"] == 1 for row in mae))
        self.assertTrue(all(row["difference_weather_minus_no_weather"] == -2 for row in paired if row["metric"] == "MAE"))

    def test_cli_runs_without_site_packages_or_checkpoints_and_checks_all_four_tables(self):
        reproduce(self.data, self.runs, self.output)
        fresh = self.root / "verified"
        result = subprocess.run([sys.executable, "-S", "-m", "ml.reproduce_multiseed",
                                 "--evaluation-data", str(self.data), "--runs-dir", str(self.runs),
                                 "--reference-dir", str(self.output), "--output-dir", str(fresh)],
                                cwd=ROOT, capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout)["comparison"], "passed")
        evidence = json.loads((fresh / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(len(evidence["comparison"]["reference_sha256"]), 4)

    def test_missing_sixth_run_and_tampered_archive_fail_before_output(self):
        path = self.directory(44, "no-weather") / "test_predictions.csv"
        original = path.read_bytes()
        path.unlink()
        with self.assertRaisesRegex(ValueError, "Missing required archive file"):
            reproduce(self.data, self.runs, self.output)
        path.write_bytes(original + b"\n")
        with self.assertRaisesRegex(ValueError, "hash/size mismatch"):
            reproduce(self.data, self.runs, self.output)
        self.assertFalse(self.output.exists())

    def test_even_resealed_different_keys_or_actuals_are_rejected(self):
        path = self.directory(44, "no-weather") / "test_predictions.csv"
        original = self.read_rows(path)
        for altered in (original[:-1], [{**original[0], "actual": "998"}, *original[1:]]):
            with self.subTest(altered_rows=len(altered)):
                write_csv(path, altered)
                self.seal(self.runs)
                with self.assertRaisesRegex(ValueError, "Different reference test keys or actuals"):
                    reproduce(self.data, self.runs, self.output)
                self.assertFalse(self.output.exists())

    def test_incomplete_or_test_trained_completion_is_rejected(self):
        path = self.directory(43) / "completion.json"
        for updates in ({"status": "running"}, {"status": "trained_and_evaluated", "test_used_for_training": True},
                        {"test_used_for_training": False, "training_seed": None}):
            with self.subTest(updates=updates):
                self.change_json(path, updates)
                with self.assertRaisesRegex(ValueError, "held-out run evidence"):
                    reproduce(self.data, self.runs, self.output)
                self.assertFalse(self.output.exists())

    def test_no_weather_protocol_and_equal_runtime_are_checked(self):
        path = self.directory(43, "no-weather") / "protocol.json"
        self.change_json(path, {"weather_protocol": "persistence"})
        with self.assertRaisesRegex(ValueError, "Run protocol differs"):
            reproduce(self.data, self.runs, self.output)
        self.change_json(path, {"weather_protocol": NO_WEATHER_PROTOCOL, "precision": "32-true"})
        with self.assertRaisesRegex(ValueError, "metadata differs: precision"):
            reproduce(self.data, self.runs, self.output)
        self.assertFalse(self.output.exists())

    def test_original_input_hash_and_fixed_cohort_evidence_are_required(self):
        path = self.directory(43) / "protocol.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        original = value["input_files"]["weather.csv"]["sha256"]
        value["input_files"]["weather.csv"]["sha256"] = "c" * 64
        self.change_json(path, value)
        with self.assertRaisesRegex(ValueError, "input hashes differ"):
            reproduce(self.data, self.runs, self.output)
        value["input_files"]["weather.csv"]["sha256"] = original
        value["cohort_reference_seed"] = 43
        self.change_json(path, value)
        with self.assertRaisesRegex(ValueError, "fixed cohort/source evidence"):
            reproduce(self.data, self.runs, self.output)
        self.assertFalse(self.output.exists())

    def test_reference_changes_fail_before_output_and_existing_output_is_preserved(self):
        reproduce(self.data, self.runs, self.output)
        path = self.output / "summary.csv"
        rows = self.read_rows(path)
        rows[0]["mean"] = str(float(rows[0]["mean"]) + 0.1)
        write_csv(path, rows)
        saved = path.read_bytes()
        fresh = self.root / "not-written"
        with self.assertRaisesRegex(ValueError, "summary.csv"):
            reproduce(self.data, self.runs, fresh, self.output)
        self.assertFalse(fresh.exists())
        with self.assertRaisesRegex(ValueError, "already exists"):
            reproduce(self.data, self.runs, self.output, self.output)
        self.assertEqual(saved, path.read_bytes())

    def test_comparison_checks_identity_counts_nulls_and_tolerance(self):
        actual = [{"seed": 42, "variant": "weather", "subset": "test", "n": 7, "MAE": 2., "WAPE": None}]
        compare_table("metrics.csv", actual, [{**actual[0], "MAE": 2. + 1e-13, "WAPE": ""}])
        for change in ({"seed": 43}, {"n": 8}, {"MAE": 2. + 1e-7}, {"MAE": "nan"}, {"WAPE": 0}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                compare_table("metrics.csv", actual, [{**actual[0], **change}])


if __name__ == "__main__":
    unittest.main()
