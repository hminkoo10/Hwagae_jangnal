"""Real-checkpoint inference invariants; set TFT_CHECKPOINT_PATH to enable."""

from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
from copy import deepcopy
import hashlib
import importlib
import json
import math
import os
from pathlib import Path
import pickle
import unittest
from unittest.mock import patch

import numpy as np
import torch
from lightning.pytorch import Trainer
from pytorch_forecasting.data.encoders import GroupNormalizer, NaNLabelEncoder, TorchNormalizer
from sklearn.preprocessing import StandardScaler


inference = importlib.import_module("ml.predict")
ML_ROOT = Path(__file__).parents[1]


def sample_context():
    """Use the exact two-product handoff fixture for all request invariants."""
    fixture = ML_ROOT / "examples" / "input.json"
    return json.loads(fixture.read_text(encoding="utf-8"))


def learned_state_digest(runtime):
    return hashlib.sha256(pickle.dumps(runtime.parameters, protocol=5)).hexdigest()


@unittest.skipUnless(os.environ.get("TFT_CHECKPOINT_PATH"), "set TFT_CHECKPOINT_PATH for real-checkpoint tests")
class PredictionTests(unittest.TestCase):
    def assert_ready_contract(self, result, context):
        self.assertEqual([p["product_id"] for p in result["products"]], [p["id"] for p in context["products"]])
        self.assertIs(result["model"]["uses_weather"], True)
        for product in result["products"]:
            self.assertEqual(product["status"], "ready")
            self.assertEqual([p["date"] for p in product["points"]], context["dates"])
            for point in product["points"]:
                self.assertEqual(set(point), {"date", "p10", "p50", "p90"})
                values = [point[name] for name in ("p10", "p50", "p90")]
                self.assertTrue(all(math.isfinite(value) and 0 <= value <= 1_000_000 for value in values))
                self.assertEqual(values, sorted(values))

    def test_cold_cpu_load_and_requests_never_refit_or_train(self):
        context = sample_context()
        original = deepcopy(context)
        inference._load_runtime.cache_clear()
        with ExitStack() as stack:
            for owner, method in [(NaNLabelEncoder, "fit"), (GroupNormalizer, "fit"),
                                  (TorchNormalizer, "fit"), (StandardScaler, "fit"),
                                  (Trainer, "fit"), (torch.Tensor, "cuda")]:
                stack.enter_context(patch.object(owner, method, side_effect=AssertionError(f"forbidden: {owner.__name__}.{method}")))
            stack.enter_context(patch.object(torch.cuda, "_lazy_init", side_effect=AssertionError("CUDA initialization is forbidden")))
            result = inference.predict(context)
            runtime = inference._runtime()
            state_before = learned_state_digest(runtime)
            self.assertEqual(result, inference.predict(context))
            self.assertEqual(state_before, learned_state_digest(runtime))
        self.assertEqual(context, original)
        self.assert_ready_contract(result, context)
        self.assertFalse(runtime.model.training)
        self.assertTrue(all(p.device.type == "cpu" and p.dtype == torch.float32 for p in runtime.model.parameters()))
        self.assertTrue(all(b.device.type == "cpu" for b in runtime.model.buffers()))

    def test_date_product_order_and_five_to_three_quantile_mapping(self):
        context = sample_context()
        context["dates"].reverse()
        context["products"].reverse()
        result = inference.predict(context)
        full = inference.predict_quantiles(context)
        self.assert_ready_contract(result, context)
        for actual, all_five in zip(result["products"], full["products"], strict=True):
            for point, expanded in zip(actual["points"], all_five["points"], strict=True):
                five = [expanded[name] for name in ("p10", "p25", "p50", "p75", "p90")]
                self.assertEqual([point["p10"], point["p50"], point["p90"]], [five[0], five[2], five[4]])
        # Decoded dataset group IDs must associate each batched prediction with
        # the right requested product, independently of category/order sorting.
        for product in context["products"]:
            single = deepcopy(context)
            single["products"] = [product]
            expected = next(p for p in result["products"] if p["product_id"] == product["id"])
            actual = inference.predict(single)["products"][0]
            np.testing.assert_allclose(
                [[p[k] for k in ("p10", "p50", "p90")] for p in actual["points"]],
                [[p[k] for k in ("p10", "p50", "p90")] for p in expected["points"]],
                rtol=1e-5, atol=1e-5,
            )

    def test_missing_and_unknown_products_never_receive_numbers(self):
        context = sample_context()
        missing_id = context["products"][0]["id"]
        index = next(i for i, sale in enumerate(context["sales"]) if sale["product_id"] == missing_id and sale["date"] == context["as_of"])
        context["sales"].pop(index)
        context["products"].extend([
            {"id": "unseen", "model_item_nbr": "unseen-item"},
            {"id": "unmapped"},
        ])
        result = inference.predict(context)
        for product in result["products"]:
            if product["product_id"] in {missing_id, "unseen", "unmapped"}:
                self.assertEqual(product["status"], "insufficient_history")
                self.assertTrue(product["reason"])
                self.assertEqual(product["points"], [])
            else:
                self.assertEqual(product["status"], "ready")

    def test_crossed_negative_quantiles_are_sorted_and_nonfinite_outputs_fail(self):
        context = sample_context()
        runtime = inference._runtime()

        def output(values):
            def forward(batch):
                return {"prediction": torch.tensor(values, dtype=torch.float32).repeat(len(batch["encoder_lengths"]), 7, 1)}
            return forward

        with patch.object(runtime.model, "forward", side_effect=output([-3.0, 9.0, 2.0, 4.0, 1.0])):
            result = inference.predict(context)
        for product in result["products"]:
            for point in product["points"]:
                self.assertEqual([point[k] for k in ("p10", "p50", "p90")], [0.0, 2.0, 9.0])
        for bad in (float("nan"), float("inf"), -float("inf")):
            with self.subTest(value=bad), patch.object(runtime.model, "forward", side_effect=output([0.0, 1.0, 2.0, 3.0, bad])):
                with self.assertRaisesRegex(ValueError, "non-finite quantiles"):
                    inference.predict(context)

    def test_persistence_ignores_future_weather_and_rejects_future_observations(self):
        context = sample_context()
        expected = inference.predict(context)
        changed = deepcopy(context)
        changed["weather"] = {"status": "ok", "mode": "live_forecast", "days": [
            {"date": day, "temp_min": -1000, "temp_max": 1000, "rain_mm": 999999}
            for day in context["dates"]
        ]}
        self.assertEqual(expected, inference.predict(changed))
        changed = deepcopy(context)
        changed["sales"].append({"product_id": context["products"][0]["id"],
                                 "date": context["dates"][0], "units_sold": 999})
        with self.assertRaisesRegex(ValueError, "after as_of"):
            inference.predict(changed)
        changed = deepcopy(context)
        changed["model_input"]["history_weather"].append({"date": context["dates"][0], "tavg": 99})
        with self.assertRaisesRegex(ValueError, "after as_of"):
            inference.predict(changed)

    def test_concurrent_calls_preserve_request_and_saved_model_state(self):
        context = sample_context()
        original = deepcopy(context)
        expected = inference.predict(context)
        runtime = inference._runtime()
        before = learned_state_digest(runtime)
        weights = {name: value.detach().clone() for name, value in runtime.model.state_dict().items()}
        with ThreadPoolExecutor(max_workers=4) as executor:
            results = list(executor.map(inference.predict, [context] * 4))
        self.assertTrue(all(value == expected for value in results))
        self.assertEqual(context, original)
        self.assertEqual(before, learned_state_digest(runtime))
        self.assertIs(runtime, inference._runtime())
        for name, value in runtime.model.state_dict().items():
            self.assertTrue(torch.equal(weights[name], value), name)


if __name__ == "__main__":
    unittest.main()
