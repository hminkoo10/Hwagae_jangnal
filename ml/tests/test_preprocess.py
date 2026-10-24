"""Boundary tests and executable comparison against the supplied notebook."""

from contextlib import redirect_stdout
from copy import deepcopy
from datetime import date, timedelta
import io
import json
from pathlib import Path
import unittest

import numpy as np
import pandas as pd

from ml.preprocess import (
    START_DATE, WEATHER_BASE, WEATHER_FEATURES, prepare_context,
)


PARAMETERS = {"max_encoder_length": 56, "max_prediction_length": 7}
DEFAULTS = {"tavg": 63.0, "tmax": 74.0, "tmin": 51.0, "preciptotal": 0.0, "avgspeed": 7.4}
SERIES = pd.DataFrame([{"store_nbr": "33", "item_nbr": "44", "station_nbr": "3"}])


def sample_context():
    origin = date(2014, 10, 31)
    days = [origin - timedelta(days=55 - i) for i in range(56)]
    return {
        "schema_version": "1", "store_id": "walmart-demo-33", "as_of": origin.isoformat(),
        "dates": [(origin + timedelta(days=i)).isoformat() for i in range(1, 8)],
        "products": [{"id": "demo-44", "model_item_nbr": "44"}],
        "sales": [{"product_id": "demo-44", "date": day.isoformat(), "units_sold": i % 11}
                  for i, day in enumerate(days)],
        "model_input": {
            "dataset": "walmart-stormy-weather", "store_nbr": "33", "station_nbr": "3",
            "weather_units": "walmart", "weather_strategy": "persistence",
            "history_weather": [{"date": day.isoformat(), **DEFAULTS} for day in days],
        },
    }


class PreprocessingTests(unittest.TestCase):
    def prepare(self, context):
        return prepare_context(context, PARAMETERS, DEFAULTS, SERIES)

    def test_reference_notebook_feature_equivalence(self):
        """Execute the actual training cell, including causal fill and flags."""
        context = sample_context()
        records = context["model_input"]["history_weather"]
        records.insert(0, {"date": "2012-01-01", **DEFAULTS})
        records[1]["tavg"] = "M"
        records[2]["preciptotal"] = "T"
        records[3]["avgspeed"] = float("inf")
        del records[4]
        weather = pd.DataFrame(records)
        weather["date"] = pd.to_datetime(weather.date)
        weather["station_nbr"] = "3"
        sales = pd.DataFrame(context["sales"]).rename(columns={"units_sold": "units"})
        sales["date"] = pd.to_datetime(sales.date)
        sales["store_nbr"], sales["item_nbr"] = "33", "44"
        namespace = {
            "np": np, "pd": pd, "WEATHER_BASE": WEATHER_BASE, "GROUP": ["store_nbr", "item_nbr"],
            "series_map": SERIES.copy(), "selected": SERIES[["store_nbr", "item_nbr"]].copy(),
            "key": SERIES[["store_nbr", "station_nbr"]].copy(), "sales": sales,
            "weather": weather, "START_DATE": START_DATE, "END_DATE": pd.Timestamp(context["as_of"]),
            "TRAIN_END": pd.Timestamp("2014-07-11"), "VALID_END": pd.Timestamp("2014-09-05"),
            "display": lambda *args: None,
        }
        notebook = json.loads((Path(__file__).parents[1] / "notebooks" / "startup_thon_1.ipynb").read_text(encoding="utf-8"))
        with redirect_stdout(io.StringIO()):
            exec("".join(notebook["cells"][8]["source"]), namespace)
        frame, results = self.prepare(context)
        expected = namespace["panel"].tail(56).reset_index(drop=True)
        columns = ["store_nbr", "item_nbr", "station_nbr", "date", "units", "sales_observed",
                   "time_idx", "dow", "month", "weekend", "year_sin", "year_cos", *WEATHER_FEATURES]
        pd.testing.assert_frame_equal(frame.iloc[:56][columns], expected[columns], check_exact=True)
        self.assertEqual(results[0]["status"], "ready")
        self.assertEqual(len(frame), 63)
        np.testing.assert_array_equal(frame.iloc[56:][WEATHER_FEATURES].to_numpy(),
                                      np.repeat(frame.iloc[[55]][WEATHER_FEATURES].to_numpy(), 7, axis=0))

    def test_missing_weather_prefix_and_trace_are_preserved(self):
        context = sample_context()
        first_day = date.fromisoformat(context["sales"][0]["date"])
        context["model_input"]["history_weather"] = [
            {"date": (first_day - timedelta(days=3)).isoformat(), **{**DEFAULTS, "tavg": 50}},
            {"date": first_day.isoformat(), "tavg": "M", "preciptotal": "T"},
        ]
        frame, _ = self.prepare(context)
        self.assertEqual(float(frame.iloc[0].tavg), 50.0)
        self.assertEqual(float(frame.iloc[0].tavg_missing), 1.0)
        self.assertEqual(float(frame.iloc[0].preciptotal), 0.0)
        self.assertEqual(float(frame.iloc[0].preciptotal_missing), 0.0)
        self.assertEqual(float(frame.iloc[0].precip_trace), 1.0)
        self.assertEqual(float(frame.iloc[1].precip_trace), 0.0)
        self.assertEqual(float(frame.iloc[1].preciptotal_missing), 1.0)

    def test_empty_weather_uses_saved_defaults_and_missing_flags(self):
        context = sample_context()
        context["model_input"]["history_weather"] = []
        frame, _ = self.prepare(context)
        for name in WEATHER_BASE:
            self.assertAlmostEqual(float(frame.iloc[0][name]), DEFAULTS[name], places=5)
            self.assertEqual(float(frame.iloc[0][name + "_missing"]), 1.0)

    def test_si_and_walmart_inputs_create_equal_features(self):
        context = sample_context()
        si_context = deepcopy(context)
        si_context["model_input"]["weather_units"] = "si"
        for record in si_context["model_input"]["history_weather"]:
            for name in ["tavg", "tmax", "tmin"]:
                record[name] = (record[name] - 32) * 5 / 9
            record["preciptotal"] *= 25.4
            record["avgspeed"] *= 0.44704
        native, _ = self.prepare(context)
        converted, _ = self.prepare(si_context)
        pd.testing.assert_frame_equal(native, converted, check_exact=True)

    def test_sales_missing_is_insufficient_and_zero_is_observed(self):
        context = sample_context()
        frame, results = self.prepare(context)
        self.assertIsNotNone(frame)
        self.assertEqual(float(frame.iloc[0].units), 0.0)
        context["sales"].pop(20)
        frame, results = self.prepare(context)
        self.assertIsNone(frame)
        self.assertEqual(results[0]["status"], "insufficient_history")
        self.assertIn("55/56", results[0]["reason"])
        self.assertEqual(results[0]["points"], [])

    def test_unknown_pair_and_absent_mapping_require_training(self):
        for item in ["unseen-product", None]:
            with self.subTest(item=item):
                context = sample_context()
                context["products"][0]["model_item_nbr"] = item
                frame, results = self.prepare(context)
                self.assertIsNone(frame)
                self.assertEqual(results[0]["status"], "insufficient_history")
                self.assertEqual(results[0]["points"], [])

    def test_invalid_sales_rejected(self):
        for value in [-1, float("nan"), float("inf"), True, "2", 1.5]:
            with self.subTest(value=value):
                context = sample_context()
                context["sales"][0]["units_sold"] = value
                with self.assertRaises(ValueError):
                    self.prepare(context)

    def test_duplicate_sales_and_future_observations_rejected(self):
        context = sample_context()
        context["sales"].append(deepcopy(context["sales"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate sales"):
            self.prepare(context)
        context = sample_context()
        context["sales"][0]["date"] = context["dates"][0]
        with self.assertRaisesRegex(ValueError, "after as_of"):
            self.prepare(context)
        context = sample_context()
        context["model_input"]["history_weather"][0]["date"] = context["dates"][0]
        with self.assertRaisesRegex(ValueError, "after as_of"):
            self.prepare(context)

    def test_mapping_weather_mode_and_duplicate_dates_rejected(self):
        changes = [
            ("station_nbr", "19"), ("weather_strategy", "provided"),
            ("weather_units", "unspecified"), ("dataset", "korean-market"),
        ]
        for key, value in changes:
            with self.subTest(key=key):
                context = sample_context()
                context["model_input"][key] = value
                with self.assertRaises(ValueError):
                    self.prepare(context)
        context = sample_context()
        context["model_input"]["history_weather"].append(deepcopy(context["model_input"]["history_weather"][0]))
        with self.assertRaisesRegex(ValueError, "duplicate history_weather"):
            self.prepare(context)
        context = sample_context()
        del context["model_input"]
        with self.assertRaisesRegex(ValueError, "model_input is required"):
            self.prepare(context)

    def test_request_is_not_mutated_and_date_order_is_allowed(self):
        context = sample_context()
        context["dates"].reverse()
        original = deepcopy(context)
        frame, results = self.prepare(context)
        self.assertEqual(context, original)
        self.assertEqual(results[0]["status"], "ready")
        self.assertTrue(frame.time_idx.is_monotonic_increasing)

    def test_provided_weather_reaches_decoder_and_converts_si_without_fill(self):
        context = sample_context()
        context["model_input"]["weather_strategy"] = "provided_forecast"
        context["model_input"]["forecast_weather"] = [
            {"date": day, "tavg": 60 + index, "tmin": 50 + index, "tmax": 70 + index,
             "preciptotal": index / 10, "avgspeed": 5 + index}
            for index, day in enumerate(context["dates"])
        ]
        original = deepcopy(context)
        native, _ = self.prepare(context)
        for index, row in enumerate(context["model_input"]["forecast_weather"]):
            for name in WEATHER_BASE:
                self.assertAlmostEqual(native.iloc[56 + index][name], row[name], places=5)
        self.assertTrue((native.iloc[56:][[name for name in WEATHER_FEATURES if name not in WEATHER_BASE]] == 0).all().all())
        converted = deepcopy(context)
        converted["model_input"]["weather_units"] = "si"
        for row in [*converted["model_input"]["history_weather"], *converted["model_input"]["forecast_weather"]]:
            for name in ("tavg", "tmax", "tmin"):
                row[name] = (row[name] - 32) * 5 / 9
            row["preciptotal"] *= 25.4
            row["avgspeed"] *= 0.44704
        si, _ = self.prepare(converted)
        pd.testing.assert_frame_equal(native, si, check_exact=True)
        self.assertEqual(context, original)

    def test_provided_weather_rejects_missing_invalid_or_misaligned_data(self):
        for case in ("missing", "short", "duplicate", "wrong_date", "reversed", "nan", "bool", "string",
                     "temperature", "order", "negative_rain", "wind", "missing_field"):
            with self.subTest(case=case):
                context = sample_context()
                spec = context["model_input"]
                spec["weather_strategy"] = "provided_forecast"
                rows = [{"date": day, **DEFAULTS} for day in context["dates"]]
                spec["forecast_weather"] = rows
                if case == "missing":
                    del spec["forecast_weather"]
                elif case == "short":
                    rows.pop()
                elif case == "duplicate":
                    rows[1] = deepcopy(rows[0])
                elif case == "wrong_date":
                    rows[0]["date"] = context["as_of"]
                elif case == "reversed":
                    rows.reverse()
                elif case == "missing_field":
                    del rows[0]["tavg"]
                elif case in {"nan", "bool", "string", "temperature", "order"}:
                    rows[0]["tavg"] = {"nan": float("nan"), "bool": True, "string": "65", "temperature": 999,
                                       "order": DEFAULTS["tmin"] - 1}[case]
                elif case == "negative_rain":
                    rows[0]["preciptotal"] = -1
                else:
                    rows[0]["avgspeed"] = 1000
                with self.assertRaises(ValueError):
                    self.prepare(context)


if __name__ == "__main__":
    unittest.main()
