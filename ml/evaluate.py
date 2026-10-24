"""Recompute matched TFT/API-baseline tables from external prediction and sales CSVs.

Uses only Python's standard library. Does not train, predict, or fit a model.
The optional no-weather CSV must contain the exact same test keys and actuals.
"""

from __future__ import annotations

import argparse
import ast
from collections import defaultdict
from contextlib import contextmanager
import csv
from datetime import date, timedelta
import hashlib
import io
import json
import math
from pathlib import Path
import zipfile


ROOT = Path(__file__).resolve().parents[1]
QUANTILES = (0.1, 0.5, 0.9)


def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


@contextmanager
def csv_rows(path):
    if path.suffix.lower() == ".zip":
        with zipfile.ZipFile(path) as archive:
            members = [name for name in archive.namelist() if name.lower().endswith(".csv")]
            if len(members) != 1:
                raise ValueError("Sales ZIP must contain exactly one CSV.")
            with archive.open(members[0]) as raw, io.TextIOWrapper(raw, encoding="utf-8-sig", newline="") as stream:
                yield csv.DictReader(stream)
    else:
        with path.open(encoding="utf-8-sig", newline="") as stream:
            yield csv.DictReader(stream)


def read_predictions(path):
    predictions = {}
    with csv_rows(path) as rows:
        for row in rows:
            key = tuple(row[name] for name in ("store_nbr", "item_nbr", "origin_date", "date"))
            if key in predictions:
                raise ValueError(f"Duplicate prediction key: {key}")
            origin, day = date.fromisoformat(key[2]), date.fromisoformat(key[3])
            if not 1 <= (day - origin).days <= 7:
                raise ValueError(f"Prediction outside the next seven days: {key}")
            actual = float(row["actual"])
            values = tuple(float(row[f"q{q}"]) for q in (10, 50, 90))
            if not all(math.isfinite(value) and value >= 0 for value in (actual, *values)) or values != tuple(sorted(values)):
                raise ValueError(f"Expected finite, nonnegative, ordered postprocessed predictions: {key}")
            predictions[key] = (actual, values)
    if not predictions:
        raise ValueError("Prediction CSV is empty.")
    return predictions


def exact_api_baseline():
    path = ROOT / "apps" / "api" / "app" / "forecasting.py"
    source = path.read_text(encoding="utf-8")
    nodes = [node for node in ast.parse(source).body
             if isinstance(node, ast.FunctionDef) and node.name in {"percentile", "baseline"}]
    if {node.name for node in nodes} != {"percentile", "baseline"}:
        raise ValueError("Current API baseline functions could not be located.")
    # Execute the actual API function bodies without importing database/server
    # dependencies. A changed baseline requiring another helper fails explicitly.
    module = ast.Module(body=nodes, type_ignores=[])
    namespace = {"defaultdict": defaultdict, "date": date}
    exec(compile(module, str(path), "exec"), namespace)
    return namespace["baseline"], {
        "path": str(path.resolve()), "sha256": digest(path),
        "functions_sha256": hashlib.sha256(ast.unparse(module).encode()).hexdigest(),
        "functions": ["percentile", "baseline"],
    }


def metrics(keys, predictions):
    actuals = [predictions[key][0] for key in keys]
    values = [predictions[key][1] for key in keys]
    n = len(keys)
    if not n:
        raise ValueError("Cannot score an empty comparison subset.")
    absolute = math.fsum(abs(a - q[1]) for a, q in zip(actuals, values))
    total = math.fsum(actuals)
    return {
        "n": n, "windows": len({key[:3] for key in keys}),
        "MAE": absolute / n, "WAPE": absolute / total if total else None,
        "mean_pinball_3": math.fsum(max(tau * (a - q), (tau - 1) * (a - q))
                                   for a, qs in zip(actuals, values)
                                   for tau, q in zip(QUANTILES, qs)) / (n * 3),
        "interval_coverage": sum(q[0] <= a <= q[2] for a, q in zip(actuals, values)) / n,
        "interval_width": math.fsum(q[2] - q[0] for q in values) / n,
    }


def evaluate(prediction_path, sales_path, no_weather_path=None):
    tft = read_predictions(prediction_path)
    keys = sorted(tft)
    groups = {key[:2] for key in keys}
    windows = defaultdict(list)
    for key in keys:
        windows[key[:3]].append(key)
    first = min(date.fromisoformat(key[2]) for key in keys) - timedelta(days=83)
    last = max(date.fromisoformat(key[3]) for key in keys)
    sales = defaultdict(dict)
    with csv_rows(sales_path) as rows:
        for row in rows:
            group = (row["store_nbr"], row["item_nbr"])
            raw_day = row["date"]
            if group not in groups or not first.isoformat() <= raw_day <= last.isoformat():
                continue
            day, units = date.fromisoformat(raw_day), float(row["units"])
            if day in sales[group] or not math.isfinite(units) or units < 0:
                raise ValueError(f"Duplicate or invalid observed sales: {group}, {raw_day}")
            sales[group][day] = units
    baseline, baseline_source = exact_api_baseline()
    baseline_predictions, strict_keys, unavailable = {}, set(), []
    for window, window_keys in sorted(windows.items()):
        store, item, raw_origin = window
        origin = date.fromisoformat(raw_origin)
        wanted = [(origin + timedelta(days=i)).isoformat() for i in range(1, 8)]
        if [key[3] for key in window_keys] != wanted:
            raise ValueError(f"Expected a complete seven-day window: {window}")
        observed = sales[(store, item)]
        for key in window_keys:
            if observed.get(date.fromisoformat(key[3])) != tft[key][0]:
                raise ValueError(f"Prediction actual differs from original sales: {key}")
        history = [{"product_id": item, "date": day.isoformat(), "units_sold": units}
                   for day, units in sorted(observed.items())
                   if origin - timedelta(days=83) <= day <= origin]
        context = {"products": [{"id": item}], "dates": wanted, "sales": history}
        result = baseline(context)["products"][0]
        if result["status"] == "ready":
            for key, point in zip(window_keys, result["points"], strict=True):
                if point["date"] != key[3]:
                    raise ValueError("API baseline returned unexpected dates.")
                baseline_predictions[key] = (tft[key][0], tuple(point[name] for name in ("p10", "p50", "p90")))
        else:
            unavailable.append({"store_nbr": store, "item_nbr": item, "origin_date": raw_origin,
                                "reason": result["reason"]})
        if all(origin - timedelta(days=i) in observed for i in range(56)):
            strict_keys.update(window_keys)
    models = {"TFT_persistence_postprocessed": tft, "current_API_weekday_baseline": baseline_predictions}
    no_weather = {"status": "not_supplied", "reason": "No aligned no-weather prediction CSV supplied; weather contribution remains unverified."}
    if no_weather_path:
        alternative = read_predictions(no_weather_path)
        if set(alternative) != set(tft) or any(alternative[key][0] != tft[key][0] for key in keys):
            raise ValueError("No-weather CSV must have exactly the same store/item/origin/date keys and actuals.")
        models["TFT_no_weather_supplied"] = alternative
        no_weather = {"status": "aligned_predictions_supplied", "path": str(no_weather_path.resolve()),
                      "sha256": digest(no_weather_path), "training_protocol": "See separate experiment provenance; CSV alignment alone does not verify training."}
    subsets = {"full_original_test": keys,
               "strict_56_observed_history": [key for key in keys if key in strict_keys]}
    if unavailable:
        subsets["API_ready_matched"] = [key for key in keys if key in baseline_predictions]
    table = []
    for subset, subset_keys in subsets.items():
        if not subset_keys:
            continue
        for name, predictions in models.items():
            if all(key in predictions for key in subset_keys):
                table.append({"subset": subset, "model": name, **metrics(subset_keys, predictions)})
    manifest = {
        "inputs": {"predictions": {"path": str(prediction_path.resolve()), "sha256": digest(prediction_path)},
                   "sales": {"path": str(sales_path.resolve()), "sha256": digest(sales_path)},
                   "api_baseline": baseline_source},
        "quantiles": list(QUANTILES), "forecast_days": 7, "baseline_lookback_days": 84,
        "weather_strategy": "historical observations with decoder persistence; not archived issued forecasts",
        "full_original_test_rows": len(keys), "full_original_test_windows": len(windows),
        "full_original_test_series": len(groups),
        "strict_56_observed_history_rows": len(strict_keys),
        "strict_56_observed_history_windows": len({key[:3] for key in strict_keys}),
        "strict_56_observed_history_series": len({key[:2] for key in strict_keys}),
        "full_keys_sha256": hashlib.sha256(json.dumps(keys, separators=(",", ":")).encode()).hexdigest(),
        "strict_56_keys_sha256": hashlib.sha256(json.dumps(sorted(strict_keys), separators=(",", ":")).encode()).hexdigest(),
        "api_baseline_ready_rows": len(baseline_predictions), "api_baseline_unavailable_windows": unavailable,
        "no_weather": no_weather,
        "row_order": "sorted store_nbr,item_nbr,origin_date,date",
        "notes": ["No missing observed sales are filled with zero.",
                  "Every baseline input date is between origin-83 days and origin, inclusive.",
                  "Strict subset additionally requires each of origin-55 through origin to have an observed sale.",
                  "Mean pinball uses only common q10/q50/q90, not the original five-quantile aggregate.",
                  "If the API baseline lacks required history, no full-test baseline score is fabricated; matched ready rows are scored separately."],
    }
    return table, manifest


def compare_metrics(actual, expected):
    """Compare saved table identities/counts exactly and metrics to 1e-12."""
    if len(actual) != len(expected):
        raise ValueError(f"Table row count differs: expected {len(expected)}, got {len(actual)}")
    if not actual:
        raise ValueError("Cannot compare empty metric tables.")
    columns = set(actual[0])
    if any(set(row) != columns for row in expected):
        raise ValueError("Metric table columns differ.")
    indexed = {(row["subset"], row["model"]): row for row in expected}
    actual_keys = {(row["subset"], row["model"]) for row in actual}
    if len(indexed) != len(expected) or set(indexed) != actual_keys:
        raise ValueError("Metric table subset/model row keys differ or are duplicated.")
    for row in actual:
        key = (row["subset"], row["model"])
        reference = indexed[key]
        for column in columns - {"subset", "model"}:
            got, raw_expected = row[column], reference[column]
            if column in {"n", "windows"}:
                same = got == int(raw_expected)
            elif got is None:
                same = raw_expected in (None, "")
            else:
                want = float(raw_expected)
                same = math.isfinite(want) and math.isclose(got, want, abs_tol=1e-12, rel_tol=1e-12)
            if not same:
                raise ValueError(f"{key}, {column}: expected {raw_expected}, got {got}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--predictions", type=Path, required=True)
    parser.add_argument("--sales", type=Path, required=True, help="Original train.csv or ZIP containing it")
    parser.add_argument("--no-weather-predictions", type=Path)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "ml" / "evaluation" / "api-comparison")
    parser.add_argument("--check-against", type=Path, help="Existing metrics.csv to compare; absolute/relative tolerance 1e-12")
    args = parser.parse_args()
    # Snapshot the reference before evaluation or any output writes. Comparing
    # before writing also preserves a same-path reference when a check fails.
    expected = None
    if args.check_against:
        with args.check_against.open(encoding="utf-8-sig", newline="") as stream:
            expected = list(csv.DictReader(stream))
    table, manifest = evaluate(args.predictions, args.sales, args.no_weather_predictions)
    if expected is not None:
        try:
            compare_metrics(table, expected)
        except (ValueError, TypeError) as error:
            parser.exit(1, f"Evaluation comparison failed: {error}\n")
    args.output_dir.mkdir(parents=True, exist_ok=True)
    with (args.output_dir / "metrics.csv").open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=list(table[0]), lineterminator="\n")
        writer.writeheader()
        writer.writerows(table)
    (args.output_dir / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({"status": "recomputed", "tables": len(table),
                      "original_rows": manifest["full_original_test_rows"],
                      "strict_rows": manifest["strict_56_observed_history_rows"],
                      "comparison": "passed" if expected is not None else "not_requested",
                      "no_weather": manifest["no_weather"]["status"]}, indent=2))


if __name__ == "__main__":
    main()
