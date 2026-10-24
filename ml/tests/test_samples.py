"""Fixture provenance boundaries and genuine trained-series coverage."""

import csv
from datetime import date, timedelta
import hashlib
import json
from pathlib import Path
import unittest


ROOT = Path(__file__).parents[1]
EXAMPLES = ROOT / "examples"


def read(name):
    return json.loads((EXAMPLES / name).read_text(encoding="utf-8"))


class SampleTests(unittest.TestCase):
    def test_original_two_product_replay_contract_is_preserved(self):
        legacy = read("provenance.json")["legacy_sample"]
        for filename, expected_hash in legacy["files_sha256"].items():
            self.assertEqual(hashlib.sha256((EXAMPLES / filename).read_bytes()).hexdigest(), expected_hash)
        context = read("input.json")
        self.assertEqual([product["id"] for product in context["products"]], ["walmart-9", "walmart-27"])
        for filename in ("expected-api.json", "expected-quantiles.json"):
            self.assertEqual([product["product_id"] for product in read(filename)["products"]],
                             [product["id"] for product in context["products"]])
        self.assert_observed_context(context)
        primary = read("demo-manifest.json")["samples"][0]
        self.assertEqual(primary["input"], "input-store-4.json")
        self.assertEqual(primary["expected_api"], "expected-api-store-4.json")
        self.assertEqual(primary["expected_quantiles"], "expected-quantiles-store-4.json")
        self.assertEqual(len(read(primary["input"])["products"]), 6)

    def assert_observed_context(self, context):
        cutoff = date.fromisoformat(context["as_of"])
        history = {(cutoff - timedelta(days=i)).isoformat() for i in range(56)}
        product_ids = [product["id"] for product in context["products"]]
        self.assertEqual(len(product_ids), len(set(product_ids)))
        self.assertEqual(context["dates"], [(cutoff + timedelta(days=i)).isoformat() for i in range(1, 8)])
        for product_id in product_ids:
            rows = [row for row in context["sales"] if row["product_id"] == product_id]
            self.assertEqual(len(rows), 56)
            self.assertEqual({row["date"] for row in rows}, history)
            self.assertTrue(all(type(row["units_sold"]) is int and row["units_sold"] >= 0 for row in rows))
        self.assertTrue(all(row["date"] <= context["as_of"] for row in context["model_input"]["history_weather"]))
        with (ROOT / "metadata/selected_series.csv").open(encoding="utf-8", newline="") as stream:
            trained = {(row["store_nbr"], row["item_nbr"], row["station_nbr"]) for row in csv.DictReader(stream)}
        spec = context["model_input"]
        for product in context["products"]:
            self.assertIn((spec["store_nbr"], product["model_item_nbr"], spec["station_nbr"]), trained)

    def test_demo_has_ten_distinct_skus_and_separate_future_actuals(self):
        manifest = read("demo-manifest.json")
        future = read(manifest["actuals_file"])["stores"]
        count, items = 0, set()
        for entry in manifest["samples"]:
            context = read(entry["input"])
            self.assert_observed_context(context)
            self.assertEqual(len(context["products"]), entry["product_count"])
            rows = future[context["store_id"]]
            self.assertEqual(len(rows), 7 * entry["product_count"])
            self.assertTrue(all(row["date"] > context["as_of"] for row in rows))
            for product in context["products"]:
                self.assertEqual({row["date"] for row in rows if row["product_id"] == product["id"]}, set(context["dates"]))
                items.add(product["model_item_nbr"])
            count += len(context["products"])
        self.assertEqual(count, 10)
        self.assertEqual(len(items), 10)

    def test_benchmarks_are_real_distinct_series_not_duplicate_ids(self):
        for size in (10, 50):
            with self.subTest(products=size):
                workload = read(f"benchmark-{size}.json")
                expected = read(f"benchmark-{size}-expected.json")["results"]
                self.assertEqual(len(expected), len(workload["contexts"]))
                pairs, identifiers = [], []
                for context, reference in zip(workload["contexts"], expected, strict=True):
                    self.assert_observed_context(context)
                    self.assertEqual([product["product_id"] for product in reference["products"]],
                                     [product["id"] for product in context["products"]])
                    self.assertTrue(all(product["status"] == "ready" for product in reference["products"]))
                    pairs.extend((context["model_input"]["store_nbr"], product["model_item_nbr"]) for product in context["products"])
                    identifiers.extend(product["id"] for product in context["products"])
                self.assertEqual(len(pairs), size)
                self.assertEqual(len(set(pairs)), size)
                self.assertEqual(len(set(identifiers)), size)


if __name__ == "__main__":
    unittest.main()
