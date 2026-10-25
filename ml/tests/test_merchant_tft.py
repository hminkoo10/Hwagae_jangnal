"""Bundled real TFT artifact: live-weather response and safe merchant boundaries."""

from copy import deepcopy
import hashlib
import importlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np
import torch
from pytorch_forecasting import TemporalFusionTransformer
from pytorch_forecasting.data.encoders import NaNLabelEncoder, TorchNormalizer

inference = importlib.import_module("ml.merchant_tft.predict")
ROOT = Path(__file__).resolve().parents[1] / "merchant_tft"


def context():
    return json.loads((ROOT / "smoke.json").read_text(encoding="utf-8"))


class MerchantTftTests(unittest.TestCase):
    def test_bundled_weights_are_actual_tft_and_match_smoke_without_fitting(self):
        inference._load.cache_clear()
        sample = context()
        original = deepcopy(sample)
        with patch.object(NaNLabelEncoder, "fit", side_effect=AssertionError("inference must not fit")), patch.object(TorchNormalizer, "fit", side_effect=AssertionError("inference must not fit")):
            result = inference.predict(sample)
        model, manifest = inference._load()
        self.assertIsInstance(model, TemporalFusionTransformer)
        self.assertFalse(model.training)
        self.assertEqual(model.hparams.static_categoricals, [])
        self.assertEqual(model.hparams.x_categoricals, [])
        self.assertTrue(all(parameter.device.type == "cpu" for parameter in model.parameters()))
        self.assertEqual(sample, original)
        self.assertEqual(result["model"], manifest["model"])
        self.assertEqual(result["model"]["training_data"], "dimigo_store")
        self.assertTrue(result["model"]["uses_weather"])
        self.assertEqual(result, inference.predict(sample))
        expected = json.loads((ROOT / "expected-api.json").read_text(encoding="utf-8"))
        left = [[point[name] for name in ("p10", "p50", "p90")] for point in result["products"][0]["points"]]
        right = [[point[name] for name in ("p10", "p50", "p90")] for point in expected["products"][0]["points"]]
        np.testing.assert_allclose(left, right, rtol=1e-5, atol=1e-4)
        self.assertEqual(manifest["checkpoint_sha256"], hashlib.sha256((ROOT / "model.ckpt").read_bytes()).hexdigest())
        self.assertLess(manifest["checkpoint_bytes"], 5_000_000)

    def test_future_forecast_rain_and_within_week_temperature_enter_the_decoder(self):
        # Temperatures enter only relative to the same 7-day forecast mean, so a uniform
        # shift is invisible by design. No direction is asserted: the real-data response
        # is learned, not a causal effect.
        def p50(update):
            sample = context()
            for index, day in enumerate(sample["weather"]["days"]):
                update(index, day)
            return [point["p50"] for point in inference.predict(sample)["products"][0]["points"]]
        base = p50(lambda index, day: None)
        np.testing.assert_allclose(p50(lambda index, day: day.update(temp_max=34, temp_min=24)), base, rtol=1e-6, atol=1e-6)
        np.testing.assert_allclose(p50(lambda index, day: day.update(temp_max=5, temp_min=-3)), base, rtol=1e-6, atol=1e-6)
        rainy = p50(lambda index, day: day.update(rain_mm=30 if index == 1 else 0))
        cold_day = p50(lambda index, day: day.update(temp_max=10 if index == 1 else 18, temp_min=2 if index == 1 else 9))
        self.assertGreater(np.abs(np.subtract(rainy, base)).max(), 0.5)
        self.assertGreater(np.abs(np.subtract(cold_day, base)).max(), 0.5)

    def test_arbitrary_ids_do_not_change_predictions_and_volume_scales(self):
        sample = context()
        original = inference.predict(sample)
        changed = deepcopy(sample)
        changed["store_id"] = "신규 국내 매장"
        changed["products"][0]["id"] = "new-product-never-seen-before"
        for row in changed["sales"]:
            row["product_id"] = changed["products"][0]["id"]
        renamed = inference.predict(changed)
        self.assertEqual(original["products"][0]["points"], renamed["products"][0]["points"])
        for row in changed["sales"]:
            row["units_sold"] *= 3
        scaled = inference.predict(changed)
        for before, after in zip(original["products"][0]["points"], scaled["products"][0]["points"]):
            for name in ("p10", "p50", "p90"):
                self.assertAlmostEqual(before[name] * 3, after[name], places=4)

    def test_zero_sales_is_observed_but_missing_and_null_history_are_not_zero(self):
        zero = context()
        for row in zero["sales"]:
            row["units_sold"] = 0
        result = inference.predict(zero)["products"][0]
        self.assertEqual(result["status"], "ready")
        self.assertEqual(len(result["points"]), 7)
        for point in result["points"]:
            self.assertTrue(0 <= point["p10"] <= point["p50"] <= point["p90"])
        for missing in (None, "remove"):
            sample = context()
            if missing == "remove":
                sample["sales"].pop()
            else:
                sample["sales"][-1]["units_sold"] = None
            product = inference.predict(sample)["products"][0]
            self.assertEqual(product["status"], "insufficient_history")
            self.assertEqual(product["points"], [])
            self.assertIn("55/56", product["reason"])

    def test_no_future_targets_or_invalid_weather_can_enter(self):
        for case in ("future_sale", "duplicate_sale", "negative_sale", "nan_sale", "bool_sale", "stale", "unknown_weather_mode", "missing_weather", "duplicate_weather", "inverted_temperature", "nan_rain"):
            with self.subTest(case=case):
                sample = context()
                if case == "future_sale":
                    sample["sales"][0]["date"] = sample["dates"][0]
                elif case == "duplicate_sale":
                    sample["sales"].append(deepcopy(sample["sales"][0]))
                elif case.endswith("_sale"):
                    sample["sales"][0]["units_sold"] = {"negative_sale": -1, "nan_sale": float("nan"), "bool_sale": True}[case]
                elif case == "stale":
                    sample["weather"]["status"] = "stale"
                elif case == "unknown_weather_mode":
                    sample["weather"]["mode"] = "unspecified_weather"
                elif case == "missing_weather":
                    sample["weather"]["days"].pop()
                elif case == "duplicate_weather":
                    sample["weather"]["days"][1] = deepcopy(sample["weather"]["days"][0])
                elif case == "inverted_temperature":
                    sample["weather"]["days"][0]["temp_min"] = 40
                else:
                    sample["weather"]["days"][0]["rain_mm"] = float("nan")
                with self.assertRaises(ValueError):
                    inference.predict(sample)

    def test_historical_weather_is_an_explicit_experiment_with_unchanged_date_contract(self):
        for mode in ("historical_reanalysis", "recent_weather"):
            with self.subTest(mode=mode):
                sample = context()
                reference = inference.predict(sample)
                sample["weather"]["mode"] = mode
                result = inference.predict(sample)
                self.assertEqual(result["products"], reference["products"])
                self.assertTrue(result["model"]["experimental"])
                self.assertEqual(result["model"]["weather_strategy"], mode)
                self.assertIn("과거", result["model"]["name"])
                self.assertIn("당시 발급된 예보가 아니", result["model"]["note"])
                sample["weather"]["days"][0]["date"] = sample["as_of"]
                with self.assertRaises(ValueError):
                    inference.predict(sample)

    def test_actuals_and_product_order_do_not_change_input_predictions(self):
        sample = context()
        expected = inference.predict(sample)["products"][0]["points"]
        sample["actuals"] = [{"date": sample["dates"][0], "units_sold": 999999}]
        sample["products"].append({"id": "missing-product"})
        result = inference.predict(sample)
        self.assertEqual(result["products"][0]["points"], expected)
        self.assertEqual(result["products"][1]["status"], "insufficient_history")
        sample["products"].reverse()
        reversed_result = inference.predict(sample)
        self.assertEqual(reversed_result["products"][1]["points"], expected)

    def test_checkpoint_checksum_is_verified_before_tensor_loading(self):
        manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
        inference._load.cache_clear()
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                (root / "model.ckpt").write_bytes(b"wrong bytes")
                with patch.object(inference, "ROOT", root), patch.object(torch, "load", side_effect=AssertionError("must not deserialize")):
                    with self.assertRaisesRegex(ValueError, "checksum"):
                        inference._load()
        finally:
            inference._load.cache_clear()


if __name__ == "__main__":
    unittest.main()
