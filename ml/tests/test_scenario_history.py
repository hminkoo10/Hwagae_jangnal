"""The shifted-date demo starts from verified original Walmart observations."""

from datetime import date, timedelta
import json
from pathlib import Path
import unittest

from ml.build_scenario_history import build_history


ROOT = Path(__file__).resolve().parents[1]


class ScenarioHistoryTests(unittest.TestCase):
    def test_committed_history_rebuilds_exactly_from_verified_source(self):
        expected = json.loads((ROOT / "examples/walmart-scenario-history.json").read_text(encoding="utf-8"))
        self.assertEqual(build_history(ROOT / "evaluation/tft-evaluation-data.zip"), expected)
        self.assertEqual(expected["history_days"], 112)
        self.assertEqual(expected["weather_units"], "walmart")
        self.assertEqual(len(expected["stores"]), 3)
        self.assertEqual(sum(len(store["products"]) for store in expected["stores"]), 10)
        start = date.fromisoformat(expected["source_start"])
        dates = [(start + timedelta(days=offset)).isoformat() for offset in range(112)]
        self.assertEqual(dates[-1], expected["source_end"])
        for store in expected["stores"]:
            self.assertEqual([row["date"] for row in store["history_weather"]], dates)
            for product in store["products"]:
                rows = [row for row in store["sales"] if row["product_id"] == product["id"]]
                self.assertEqual([row["date"] for row in rows], dates)
                self.assertTrue(all(type(row["units_sold"]) is int and row["units_sold"] >= 0 for row in rows))


if __name__ == "__main__":
    unittest.main()
