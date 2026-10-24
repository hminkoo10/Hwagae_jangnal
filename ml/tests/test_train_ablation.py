"""Prevent silent cohort changes in the matched weather comparison."""

import unittest

import pandas as pd

from ml.train_ablation import assert_matched_rows, install_functions


class AblationProtocolTests(unittest.TestCase):
    def rows(self):
        return pd.DataFrame([
            {"store_nbr": "4", "item_nbr": "9", "origin_time_idx": 980,
             "time_idx": 981, "horizon": 1, "actual": 0.0},
            {"store_nbr": "4", "item_nbr": "27", "origin_time_idx": 980,
             "time_idx": 981, "horizon": 1, "actual": 12.0},
        ])

    def test_alignment_accepts_row_order_changes_but_not_missing_series(self):
        reference = self.rows()
        assert_matched_rows(reference.iloc[::-1], reference)
        with self.assertRaises(AssertionError):
            assert_matched_rows(reference.iloc[:1], reference)

    def test_alignment_rejects_different_origin_actual_or_duplicate(self):
        reference = self.rows()
        for name, value in [("origin_time_idx", 979), ("actual", 99.0)]:
            with self.subTest(name=name):
                changed = reference.copy()
                changed.loc[0, name] = value
                with self.assertRaises(AssertionError):
                    assert_matched_rows(changed, reference)
        duplicate = pd.concat([reference, reference.iloc[[0]]], ignore_index=True)
        with self.assertRaises(ValueError):
            assert_matched_rows(duplicate, duplicate)

    def test_only_requested_notebook_functions_execute(self):
        namespace = {"factor": 3}
        source = "raise RuntimeError('training must not run')\ndef feature(value):\n    return value * factor\ndef train():\n    raise RuntimeError('not requested')\n"
        install_functions(namespace, source, ["feature"])
        self.assertEqual(namespace["feature"](4), 12)
        self.assertNotIn("train", namespace)
        with self.assertRaisesRegex(ValueError, "not found"):
            install_functions({}, source, ["missing"])


if __name__ == "__main__":
    unittest.main()
