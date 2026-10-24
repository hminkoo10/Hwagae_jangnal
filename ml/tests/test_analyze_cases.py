"""Case selection must not depend on future errors; baseline inputs stay causal."""

from copy import deepcopy
from pathlib import Path
import tempfile
import unittest

from ml.analyze_cases import choose_examples, failure_cases, failure_evidence, forecast_metrics, history_stats, sample_cases
from ml.evaluate import exact_api_baseline


class CaseAnalysisTests(unittest.TestCase):
    def test_selection_uses_only_history_and_breaks_ties_numerically(self):
        candidates = []
        for item, values in [(1, [10] * 56), (2, [5, 15] * 28), (3, [1, 19] * 28),
                             (9, [0] * 56), (10, [0] * 56)]:
            candidates.append({"store_nbr": "4", "item_nbr": str(item), "history_stats": history_stats(values)})
        expected = [("normal", "2"), ("volatile", "3"), ("zero", "9")]
        selected = choose_examples(candidates)
        self.assertEqual([(label, case["item_nbr"]) for label, case in selected], expected)
        changed = deepcopy(candidates[::-1])
        for case in changed:
            case.update(future_actuals=[1_000_000] * 7, forecast_error=-1_000_000)
        self.assertEqual([(label, case["item_nbr"]) for label, case in choose_examples(changed)], expected)

    def test_metric_zero_denominator_and_coverage_boundaries(self):
        result = forecast_metrics([{"actual": 0, "p10": 0, "p50": 2, "p90": 3},
                                   {"actual": 4, "p10": 3, "p50": 5, "p90": 6}])
        self.assertEqual(result["MAE"], 1.5)
        self.assertEqual(result["WAPE"], .75)
        self.assertEqual(result["interval_coverage"], 1)
        self.assertEqual(result["zero_day_p50_MAE"], 2)
        self.assertEqual(result["zero_day_positive_p50_count"], 1)
        self.assertIsNone(forecast_metrics([{"actual": 0, "p10": 0, "p50": 0, "p90": 0}])["WAPE"])
        self.assertIsNone(forecast_metrics([{"actual": 4, "p10": 0, "p50": 4, "p90": 4}])["zero_day_p50_MAE"])

    def test_real_examples_use_exact_56_day_baseline_history(self):
        baseline, _ = exact_api_baseline()
        requests = []

        def capture(context):
            requests.append(deepcopy(context))
            return baseline(context)

        result = sample_cases(capture)
        self.assertEqual([(case["store_nbr"], case["item_nbr"]) for case in result["cases"]],
                         [("24", "43"), ("24", "6"), ("4", "93")])
        for context, case in zip(requests, result["cases"], strict=True):
            self.assertEqual(len(context["sales"]), 56)
            self.assertEqual(max(row["date"] for row in context["sales"]), case["as_of"])
            self.assertTrue(all(row["date"] < min(context["dates"]) for row in context["sales"]))
            self.assertEqual([row["date"] for row in case["points"]], context["dates"])

    def test_failure_analysis_rejects_an_unverified_archive(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / "altered.zip"
            path.write_bytes(b"not the delivered evaluation data")
            with self.assertRaisesRegex(ValueError, "archive hash"):
                failure_cases(path, lambda _: self.fail("Unverified data reached the baseline"))

    def test_failure_descriptions_distinguish_recent_trend_and_unseen_peak(self):
        for values, actual, pattern in [
            ([10] * 49 + [20] * 7, 40, "recent_rise_and_new_peak"),
            ([10] * 49 + [20] * 7, 15, "recent_rise_but_worst_day_within_history_range"),
            ([10] * 49 + [8] * 7, 30, "new_peak_without_recent_average_rise"),
        ]:
            with self.subTest(pattern=pattern):
                points = [{"date": f"2020-01-{day:02}", "actual": actual, "p10": 0, "p50": 5, "p90": 10} for day in range(1, 8)]
                result = failure_evidence({"history_stats": history_stats(values), "points": points,
                                           "metrics": {"TFT": forecast_metrics(points)}})
                self.assertEqual(result["descriptive_pattern"], pattern)
                self.assertEqual(result["worst_day"]["date"], "2020-01-01")
                self.assertEqual(result["worst_day"]["absolute_p50_error"], actual - 5)


if __name__ == "__main__":
    unittest.main()
