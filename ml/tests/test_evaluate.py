"""Evaluation safety checks using small, deliberately diagnostic sales data."""

import csv
from datetime import date, timedelta
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

from ml.evaluate import ROOT, evaluate


class EvaluationTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.origin = date(2020, 4, 1)
        self.sales = self.root / "sales.csv"
        self.predictions = self.root / "predictions.csv"
        self.sales_rows = []
        self.prediction_rows = []
        for store in ("1", "2"):
            for offset in range(-83, 8):
                # A missing recent observation excludes only the second series
                # from strict56, while leaving its weekday baseline available.
                if store == "2" and offset == -10:
                    continue
                day = (self.origin + timedelta(days=offset)).isoformat()
                units = 10 if offset <= 0 else 999
                self.sales_rows.append({"store_nbr": store, "item_nbr": "1", "date": day, "units": units})
                if offset > 0:
                    self.prediction_rows.append({"store_nbr": store, "item_nbr": "1",
                                                 "origin_date": self.origin.isoformat(), "date": day,
                                                 "actual": units, "q10": 0, "q50": 20, "q90": 1000})
        self.write(self.sales, self.sales_rows)
        self.write(self.predictions, self.prediction_rows)

    @staticmethod
    def write(path, rows):
        with path.open("w", encoding="utf-8", newline="") as stream:
            writer = csv.DictWriter(stream, fieldnames=list(rows[0]))
            writer.writeheader()
            writer.writerows(rows)

    def test_future_actuals_are_excluded_and_strict_history_is_observed(self):
        table, manifest = evaluate(self.predictions, self.sales)
        self.assertEqual(manifest["full_original_test_rows"], 14)
        self.assertEqual(manifest["strict_56_observed_history_rows"], 7)
        self.assertEqual(manifest["api_baseline_ready_rows"], 14)
        baseline = [row for row in table if row["model"] == "current_API_weekday_baseline"]
        self.assertEqual(len(baseline), 2)
        for row in baseline:
            # Historical weekdays are always 10; future actuals are all 999.
            self.assertEqual(row["MAE"], 989)
            self.assertEqual(row["interval_width"], 0)
            self.assertEqual(row["interval_coverage"], 0)
        self.assertEqual((table, manifest), evaluate(self.predictions, self.sales))

    def test_optional_no_weather_requires_identical_keys_and_actuals(self):
        table, manifest = evaluate(self.predictions, self.sales, self.predictions)
        self.assertEqual(manifest["no_weather"]["status"], "aligned_predictions_supplied")
        self.assertEqual(len([row for row in table if row["model"] == "TFT_no_weather_supplied"]), 2)
        other = self.root / "no-weather.csv"
        self.write(other, self.prediction_rows[:-1])
        with self.assertRaisesRegex(ValueError, "exactly the same"):
            evaluate(self.predictions, self.sales, other)
        altered = [dict(row) for row in self.prediction_rows]
        altered[0]["actual"] = 998
        self.write(other, altered)
        with self.assertRaisesRegex(ValueError, "exactly the same"):
            evaluate(self.predictions, self.sales, other)

    def test_missing_baseline_history_does_not_fabricate_full_comparison(self):
        rows = [row for row in self.sales_rows if row["store_nbr"] == "1"
                or row["date"] > (self.origin - timedelta(days=20)).isoformat()]
        self.write(self.sales, rows)
        table, manifest = evaluate(self.predictions, self.sales)
        self.assertEqual(manifest["api_baseline_ready_rows"], 7)
        self.assertEqual(len(manifest["api_baseline_unavailable_windows"]), 1)
        self.assertFalse(any(row["subset"] == "full_original_test" and
                             row["model"] == "current_API_weekday_baseline" for row in table))
        matched = [row for row in table if row["subset"] == "API_ready_matched"]
        self.assertEqual(len(matched), 2)
        self.assertTrue(all(row["n"] == 7 for row in matched))

    def check_cli(self, reference, output):
        return subprocess.run([sys.executable, "-m", "ml.evaluate", "--predictions", str(self.predictions),
                               "--sales", str(self.sales), "--output-dir", str(output),
                               "--check-against", str(reference)], cwd=ROOT, capture_output=True, text=True)

    def test_check_against_accepts_identical_metrics_in_a_different_directory(self):
        table, _ = evaluate(self.predictions, self.sales)
        reference = self.root / "reference.csv"
        self.write(reference, table)
        output = self.root / "regenerated"
        completed = self.check_cli(reference, output)
        self.assertEqual(completed.returncode, 0, completed.stderr)
        self.assertEqual(json.loads(completed.stdout)["comparison"], "passed")
        self.assertTrue((output / "metrics.csv").is_file())

    def test_check_against_rejects_changed_metric_before_same_path_overwrite(self):
        table, _ = evaluate(self.predictions, self.sales)
        table[0]["MAE"] += 0.1
        reference = self.root / "metrics.csv"
        self.write(reference, table)
        before = reference.read_bytes()
        completed = self.check_cli(reference, self.root)
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("MAE", completed.stderr)
        self.assertEqual(reference.read_bytes(), before)


if __name__ == "__main__":
    unittest.main()
