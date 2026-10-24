"""Rebuild genuine Walmart fixtures from local originals, without fitting.

Run from the repository root with the pinned inference environment. Raw ZIPs
stay outside Git. --write-expected runs the existing CPU checkpoint explicitly;
the normal smoke test only reads and compares the committed references.
The original two-product replay files remain byte-for-byte unchanged.
"""

from __future__ import annotations

import argparse
from copy import deepcopy
import hashlib
import json
import os
from pathlib import Path

import numpy as np
import pandas as pd

from ml.preprocess import WEATHER_BASE, _weather_frame


ROOT = Path(__file__).parent
HASHES = {
    "train.csv.zip": "70d7b0c7f24a55369ac22f092148e8cced5991623645d1f136ea1977c9d7eadf",
    "weather.csv.zip": "feb96736bad00d4e819715049d7cbc9af7352105c04e488f468c7b2d4b0edced",
    "key.csv.zip": "145270ab9b544e0fc5c93a822e36c48621c1ba3ebc895170b7ffc96c2250004a",
}
DEMO_STORES = {4: [9, 27, 90, 93, 96, 97], 24: [6, 43, 60], 17: [37]}
DEMO_CUTOFF = "2014-09-12"
BENCHMARK_CUTOFF = "2014-10-17"
LEGACY_SAMPLE = {
    "source_commit": "3056d6be24e4a39bf2df7a19dcc05318d281bdcb",
    "products": 2, "store_nbr": "4", "item_nbr": ["9", "27"],
    "policy": "Preserve the original main replay input and expected files byte-for-byte; the ten-product manifest uses separate store-specific files.",
    "files_sha256": {
        "input.json": "65a40a2bdc5af2b8a4b693403f06f3b44fa8d580f2e82760170c019bb9a66feb",
        "expected-api.json": "9c141a9ffd9488c569c70f3c2b2663426102ad54a0613f06e6b1432787392c0c",
        "expected-quantiles.json": "d350d111e311ae7e125018c30a12b468613f562cc0b7ea95e04ac6b1bfc4b390",
    },
}


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def preserve_legacy(output_dir):
    """Keep main's two-product replay contract, also in an isolated output dir."""
    for filename, digest in LEGACY_SAMPLE["files_sha256"].items():
        source = ROOT / "examples" / filename
        content = source.read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError(f"legacy replay fixture changed: {filename}")
        destination = output_dir / filename
        if destination.resolve() != source.resolve():
            destination.write_bytes(content)


def native_value(raw):
    value = str(raw).strip()
    if value in {"M", "T"}:
        return value
    try:
        number = float(value)
    except ValueError:
        return None
    return number if np.isfinite(number) else None


def build_context(sales, weather, selected, defaults, store, items, cutoff, *, benchmark=False):
    day = pd.Timestamp(cutoff)
    first = day - pd.Timedelta(days=55)
    pairs = selected[(selected.store_nbr == store) & selected.item_nbr.isin(items)]
    assert len(pairs) == len(items) and pairs.station_nbr.nunique() == 1
    station = int(pairs.iloc[0].station_nbr)
    raw = weather[(weather.station_nbr == str(station)) & (weather.date <= cutoff)].copy()
    numeric = raw[WEATHER_BASE].apply(lambda column: pd.to_numeric(
        column.str.strip().replace({"M": np.nan, "T": "0"}), errors="coerce",
    )).replace([np.inf, -np.inf], np.nan)
    older = raw.date < first.strftime("%Y-%m-%d")
    # Include the last earlier observation for each feature. Their union is
    # sufficient to reproduce full-history causal fill without a long prefix.
    prefix_dates = set()
    for name in WEATHER_BASE:
        prior = raw.loc[older & numeric[name].notna(), "date"]
        if len(prior):
            prefix_dates.add(prior.iloc[-1])
    subset = raw[(raw.date >= first.strftime("%Y-%m-%d")) | raw.date.isin(prefix_dates)]
    history = [
        {"date": row["date"], **{name: native_value(row[name]) for name in WEATHER_BASE}}
        for row in subset.to_dict("records")
    ]
    full = _weather_frame(raw[["date", *WEATHER_BASE]].to_dict("records"), "walmart", str(station), day.date(), defaults)
    small = _weather_frame(history, "walmart", str(station), day.date(), defaults)
    pd.testing.assert_frame_equal(full, small)
    products, records, actuals = [], [], []
    for item in items:
        product_id = f"walmart-{item}" if store == 4 and not benchmark else f"walmart-{store}-{item}"
        products.append({"id": product_id, "model_item_nbr": str(item), "name": f"Walmart store {store} item {item} (observed sample)"})
        observed = sales[(sales.store_nbr == store) & (sales.item_nbr == item)]
        encoder = observed[observed.date.between(first, day)].sort_values("date")
        assert encoder.date.tolist() == list(pd.date_range(first, day)), (store, item, cutoff)
        records.extend({"product_id": product_id, "date": row.date.strftime("%Y-%m-%d"), "units_sold": int(row.units)}
                       for row in encoder.itertuples(index=False))
        future = observed[observed.date.between(day + pd.Timedelta(days=1), day + pd.Timedelta(days=7))].sort_values("date")
        actuals.extend({"product_id": product_id, "date": row.date.strftime("%Y-%m-%d"), "units_sold": int(row.units)}
                       for row in future.itertuples(index=False))
    context = {
        "schema_version": "1", "store_id": f"walmart-{'benchmark' if benchmark else 'demo'}-{store}",
        "as_of": cutoff, "dates": [(day + pd.Timedelta(days=i)).strftime("%Y-%m-%d") for i in range(1, 8)],
        "products": products, "sales": records,
        "weather": {"status": "ok", "mode": "historical_observations", "source": "Walmart Stormy Weather", "fetched_at": None, "days": []},
        "model_input": {"dataset": "walmart-stormy-weather", "store_nbr": str(store), "station_nbr": str(station),
                        "weather_units": "walmart", "history_weather": history, "weather_strategy": "persistence"},
    }
    assert all(row["date"] <= cutoff for row in records + history)
    return context, actuals


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data-dir", required=True, type=Path)
    parser.add_argument("--output-dir", type=Path, default=ROOT / "examples")
    parser.add_argument("--checkpoint", type=Path)
    parser.add_argument("--write-expected", action="store_true")
    args = parser.parse_args()
    if args.checkpoint:
        os.environ["TFT_CHECKPOINT_PATH"] = str(args.checkpoint.resolve(strict=True))
    for filename, digest in HASHES.items():
        assert hashlib.sha256((args.data_dir / filename).read_bytes()).hexdigest() == digest, filename
    selected = pd.read_csv(ROOT / "metadata/selected_series.csv")
    key = pd.read_csv(args.data_dir / "key.csv.zip")
    assert selected.merge(key, on="store_nbr", suffixes=("", "_original")).eval("station_nbr == station_nbr_original").all()
    sales = pd.read_csv(args.data_dir / "train.csv.zip", parse_dates=["date"]).merge(selected, on=["store_nbr", "item_nbr"])
    weather = pd.read_csv(args.data_dir / "weather.csv.zip", dtype=str).sort_values(["station_nbr", "date"])
    defaults = json.loads((ROOT / "metadata/weather_fill_defaults.json").read_text())
    args.output_dir.mkdir(parents=True, exist_ok=True)
    preserve_legacy(args.output_dir)
    contexts, entries, actual_by_store = [], [], {}
    for store, items in DEMO_STORES.items():
        context, actuals = build_context(sales, weather, selected, defaults, store, items, DEMO_CUTOFF)
        assert len(actuals) == 7 * len(items), "demo must have all seven comparison observations"
        suffix = f"-store-{store}"
        entry = {"store_id": context["store_id"], "store_nbr": str(store), "station_nbr": context["model_input"]["station_nbr"],
                 "input": f"input{suffix}.json", "expected_quantiles": f"expected-quantiles{suffix}.json",
                 "expected_api": f"expected-api{suffix}.json", "product_count": len(items)}
        write(args.output_dir / entry["input"], context)
        contexts.append(context)
        entries.append(entry)
        actual_by_store[context["store_id"]] = actuals
    manifest = {"schema_version": "1", "as_of": DEMO_CUTOFF, "total_products": 10,
                "actuals_file": "actuals.json", "samples": entries}
    write(args.output_dir / "demo-manifest.json", manifest)
    write(args.output_dir / "actuals.json", {"schema_version": "1", "description": "Future observed sales for comparison ONLY. Never merge into predict context.", "stores": actual_by_store})
    insufficient = deepcopy(contexts[0])
    insufficient["sales"] = [row for row in insufficient["sales"] if not (row["product_id"] == "walmart-9" and row["date"] == "2014-08-01")]
    insufficient["products"].append({"id": "new-product", "name": "Unregistered product example"})
    write(args.output_dir / "insufficient-history.json", insufficient)
    workloads = {10: contexts}
    # The fixed sources contain 56 trained series with all 56 observed days.
    # Exclude store 35's six series: all five station 5 weather fields are M
    # throughout this window. The remaining 50 pairs are not replicas.
    day = pd.Timestamp(BENCHMARK_CUTOFF)
    counts = sales[sales.date.between(day - pd.Timedelta(days=55), day)].groupby(["store_nbr", "item_nbr"]).date.nunique()
    eligible = counts[counts == 56].reset_index()
    eligible_count = len(eligible)
    eligible = eligible[eligible.store_nbr != 35]
    assert len(eligible) == 50
    workloads[50] = [build_context(sales, weather, selected, defaults, int(store), group.item_nbr.tolist(), BENCHMARK_CUTOFF, benchmark=True)[0]
                     for store, group in eligible.groupby("store_nbr", sort=True)]
    for size, workload in workloads.items():
        pairs = [(c["model_input"]["store_nbr"], p["model_item_nbr"]) for c in workload for p in c["products"]]
        assert len(pairs) == len(set(pairs)) == size
        write(args.output_dir / f"benchmark-{size}.json", {
            "schema_version": "1", "description": f"{size} genuine trained store/item series; {len(workload)} independent store requests, sequential workload, not one store or one batch. Performance fixture, not a new accuracy evaluation.",
            "contexts": workload,
        })
    write(args.output_dir / "provenance.json", {
        "schema_version": "1", "dataset": "Walmart Recruiting II: Sales in Stormy Weather",
        "local_source_directory": str(args.data_dir.resolve()), "source_zip_sha256": HASHES,
        "training_run": "walmart_20261024T020058Z", "max_trained_products_per_store": int(selected.groupby("store_nbr").size().max()),
        "demo_products": 10, "demo_requests": len(contexts), "demo_as_of": DEMO_CUTOFF,
        "demo_distinct_skus": len({p["model_item_nbr"] for c in contexts for p in c["products"]}),
        "benchmark_products": 50, "benchmark_requests": len(workloads[50]), "benchmark_as_of": BENCHMARK_CUTOFF,
        "benchmark_distinct_skus": int(eligible.item_nbr.nunique()),
        "benchmark_selection": {
            "history_start": (day - pd.Timedelta(days=55)).date().isoformat(),
            "history_end": BENCHMARK_CUTOFF,
            "eligible_trained_series_with_56_observed_days": eligible_count,
            "excluded_store_nbr": "35", "excluded_series": eligible_count - len(eligible),
            "exclusion_reason": "Station 5 has M for all five weather fields on every history date; omit its six store-35 series to select exactly 50 supported pairs with observed weather.",
            "ordering": "Ascending numeric store_nbr, then item_nbr; one sequential request per store.",
            "scope": "50 distinct trained store/item pairs, 29 distinct item_nbr values, 10 requests; fixed performance workload, not an accuracy cohort.",
        },
        "history_policy": "56 consecutive observed sales days; no sales imputation. Minimal earlier weather observations seed exact full-history causal fill, verified during build.",
        "future_actuals": "actuals.json is a separate comparison fixture; all input sales and weather dates are <= as_of.",
        "expected_values": "CPU float32 checkpoint predictions, clipped at zero then sorted across all five quantiles; rtol=1e-5, atol=1e-4.",
        "legacy_sample": LEGACY_SAMPLE,
    })
    if args.write_expected:
        from ml.predict import predict, predict_quantiles
        for entry, context in zip(entries, contexts, strict=True):
            write(args.output_dir / entry["expected_quantiles"], predict_quantiles(context))
            write(args.output_dir / entry["expected_api"], predict(context))
        write(args.output_dir / "expected-insufficient-history.json", predict(insufficient))
        for size, workload in workloads.items():
            write(args.output_dir / f"benchmark-{size}-expected.json", {"schema_version": "1", "results": [predict(context) for context in workload]})
    print(json.dumps({"demo_products": 10, "demo_requests": len(contexts), "benchmark_products": 50,
                      "benchmark_requests": len(workloads[50]), "expected_written": args.write_expected}))


if __name__ == "__main__":
    main()
