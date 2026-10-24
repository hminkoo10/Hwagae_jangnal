"""Extract a compact, genuine Walmart history for explicitly shifted scenarios.

Dates remain original in this artifact. The application may shift this history
only when it labels the result as a scenario, never as current observed sales.
"""

from __future__ import annotations

import argparse
import hashlib
from io import BytesIO
import json
from pathlib import Path
import zipfile

import pandas as pd

from ml.build_samples import DEMO_STORES, HASHES, native_value
from ml.preprocess import WEATHER_BASE


ROOT = Path(__file__).resolve().parent
SOURCE_END = "2014-04-23"
HISTORY_DAYS = 112


def build_history(archive: Path) -> dict:
    external = json.loads((ROOT / "evaluation/external-data.json").read_text(encoding="utf-8"))
    if hashlib.sha256(archive.read_bytes()).hexdigest() != external["sha256"]:
        raise ValueError("evaluation archive SHA-256 differs from the source manifest")
    with zipfile.ZipFile(archive) as bundle:
        frames = {}
        for filename, expected in HASHES.items():
            raw = bundle.read(f"evaluation-data/{filename}")
            if hashlib.sha256(raw).hexdigest() != expected:
                raise ValueError(f"source checksum differs: {filename}")
            frames[filename.split(".")[0]] = pd.read_csv(BytesIO(raw), compression="zip", dtype=str)
    start = pd.Timestamp(SOURCE_END) - pd.Timedelta(days=HISTORY_DAYS - 1)
    dates = pd.date_range(start, SOURCE_END).strftime("%Y-%m-%d").tolist()
    sales, weather, key = (frames[name] for name in ("train", "weather", "key"))
    selected = pd.read_csv(ROOT / "metadata/selected_series.csv", dtype=str)
    stores = []
    for number, items in DEMO_STORES.items():
        store_number = str(number)
        station = key.loc[key.store_nbr == store_number, "station_nbr"].item()
        products, records = [], []
        for item in items:
            item_number = str(item)
            if len(selected[(selected.store_nbr == store_number) &
                            (selected.item_nbr == item_number) &
                            (selected.station_nbr == station)]) != 1:
                raise ValueError("scenario pair is not registered in the checkpoint")
            product_id = f"walmart-{number}-{item}"
            products.append({"id": product_id, "name": f"Walmart 상품 {item}", "model_item_nbr": item_number})
            part = sales[(sales.store_nbr == store_number) & (sales.item_nbr == item_number) &
                         sales.date.isin(dates)].sort_values("date")
            if part.date.tolist() != dates:
                raise ValueError(f"requires complete observed history: {number}/{item}")
            for row in part.itertuples(index=False):
                units = float(row.units)
                if not units.is_integer() or units < 0:
                    raise ValueError("source sales must be nonnegative whole units")
                records.append({"product_id": product_id, "date": row.date, "units_sold": int(units)})
        station_rows = weather[(weather.station_nbr == station) & weather.date.isin(dates)].sort_values("date")
        if station_rows.date.tolist() != dates:
            raise ValueError(f"requires one weather row per day: station {station}")
        history_weather = [{"date": row["date"], **{name: native_value(row[name]) for name in WEATHER_BASE}}
                           for row in station_rows.to_dict("records")]
        stores.append({"id": f"walmart-demo-{number}", "store_nbr": store_number,
                       "station_nbr": station, "products": products,
                       "sales": records, "history_weather": history_weather})
    return {
        "schema_version": "1", "dataset": "walmart-stormy-weather",
        "source": "Kaggle Walmart Recruiting II: Sales in Stormy Weather",
        "source_start": dates[0], "source_end": dates[-1], "history_days": HISTORY_DAYS,
        "weather_units": "walmart", "stores": stores,
        "provenance": {
            "archive_path": "ml/evaluation/tft-evaluation-data.zip", "archive_sha256": external["sha256"],
            "source_files_sha256": HASHES,
            "date_policy": "Original dates retained. Any application date shift is a labelled scenario, not current observed sales.",
            "location_policy": "No store or station coordinates are supplied. A scenario city is not an identified Walmart store location.",
            "sales_policy": "112 consecutive observed days for each of ten registered products; no imputation or synthetic sales.",
            "weather_policy": "Original daily values and M/T markers. Training defaults/causal fill apply at inference; these are observations, not issued forecasts.",
        },
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--archive", type=Path, default=ROOT / "evaluation/tft-evaluation-data.zip")
    parser.add_argument("--output", type=Path, default=ROOT / "examples/walmart-scenario-history.json")
    args = parser.parse_args()
    payload = build_history(args.archive)
    args.output.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(args.output), "stores": len(payload["stores"]),
                      "products": sum(len(store["products"]) for store in payload["stores"]),
                      "history_days": payload["history_days"], "source_start": payload["source_start"],
                      "source_end": payload["source_end"]}))


if __name__ == "__main__":
    main()
