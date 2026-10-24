"""Explicit, opt-in replay of the delivered Walmart TFT sample.

The model's historical sales come from SQLite on every request. Only the fixed
Walmart identities and historical weather prefix come from the sample fixture.
No Korean store is assigned Walmart embeddings and no archive weather is fetched.
"""

from copy import deepcopy
from datetime import date, timedelta
import csv
from functools import lru_cache
import importlib
import json
import math
import os
from pathlib import Path
import sys

from app.database import now_iso


PROJECT_ROOT = Path(__file__).resolve().parents[3]
STORE_ID = "walmart-demo-4"
STORE_IDS = (STORE_ID, "walmart-demo-24", "walmart-demo-17")
AS_OF = date(2014, 9, 12)
LEGACY_PROVENANCE = "Walmart 실제 판매 표본 · 익명 상품 9·27 · 2014-09-12 기준 TFT 재현"
SEED_VERSION = "walmart-10-products-v2"
NOTICE = "실제 판매 표본의 과거 예측입니다. 매장 좌표·상품 가격·재고는 제공되지 않았으며 비용·발주 계산에 사용할 수 없습니다."


def enabled():
    return os.getenv("TFT_DEMO_ENABLED", "false").lower() == "true"


def is_demo(store):
    return store["id"] in STORE_IDS


@lru_cache(maxsize=3)
def _sample(store_id=STORE_ID):
    manifest = json.loads((PROJECT_ROOT / "ml/examples/demo-manifest.json").read_text(encoding="utf-8"))
    if {entry["store_id"] for entry in manifest["samples"]} != set(STORE_IDS) or manifest["total_products"] != 10:
        raise ValueError("Walmart demo manifest must contain the three verified stores and ten products")
    entry = next((entry for entry in manifest["samples"] if entry["store_id"] == store_id), None)
    if entry is None:
        raise ValueError("Unknown Walmart demo store")
    path = PROJECT_ROOT / "ml/examples" / entry["input"]
    sample = json.loads(path.read_text(encoding="utf-8"))
    with (PROJECT_ROOT / "ml/metadata/selected_series.csv").open(encoding="utf-8", newline="") as stream:
        trained = {(row["store_nbr"], row["item_nbr"], row["station_nbr"]) for row in csv.DictReader(stream)}
    items = [p["model_item_nbr"] for p in sample["products"]]
    if (
        sample["store_id"] != store_id
        or sample["as_of"] != AS_OF.isoformat()
        or sample["model_input"]["store_nbr"] != entry["store_nbr"]
        or sample["model_input"]["station_nbr"] != entry["station_nbr"]
        or len(set(items)) != len(items) or len(items) != entry["product_count"]
        or any((entry["store_nbr"], item, entry["station_nbr"]) not in trained for item in items)
        or any(row["date"] > sample["as_of"] for row in sample["sales"] + sample["model_input"]["history_weather"])
        or sample["model_input"]["weather_strategy"] != "persistence"
    ):
        raise ValueError("Walmart TFT demo fixture identity has changed")
    return sample


def _provenance(store_id):
    sample = _sample(store_id)
    items = "·".join(product["model_item_nbr"] for product in sample["products"])
    return f"Walmart 실제 판매 표본 · 매장 {sample['model_input']['store_nbr']} · 익명 상품 {items} · {AS_OF.isoformat()} 기준 TFT 재현"


def bridge():
    root = str(PROJECT_ROOT)
    if root not in sys.path:
        sys.path.insert(0, root)
    return importlib.import_module("ml.bridge")


def seed_sample(database):
    """Create the fixture once; never restore sales deleted/changed by a user."""
    with database.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        owner = db.execute(
            "SELECT id FROM users WHERE id='demo-owner' AND email='owner@hwagae.local'"
        ).fetchone()
        if not owner:
            raise RuntimeError("TFT demo requires the existing local demo-owner account; no user permissions were added")
        db.execute("CREATE TABLE IF NOT EXISTS tft_demo_seeds (store_id TEXT PRIMARY KEY REFERENCES stores(id), version TEXT NOT NULL)")
        for store_id in STORE_IDS:
            sample = _sample(store_id)
            provenance = _provenance(store_id)
            existing = db.execute("SELECT provenance FROM stores WHERE id=?", (store_id,)).fetchone()
            allowed = {provenance, LEGACY_PROVENANCE} if store_id == STORE_ID else {provenance}
            if existing and existing["provenance"] not in allowed:
                raise RuntimeError("Walmart demo store identifier is already used by another store")
            seeded = db.execute("SELECT version FROM tft_demo_seeds WHERE store_id=?", (store_id,)).fetchone()
            if seeded:
                if seeded["version"] != SEED_VERSION:
                    raise RuntimeError("Unrecognized Walmart demo seed version")
                continue
            if not existing:
                # Required SQLite numeric values are internal placeholders;
                # public_store/products hide unavailable coordinates/prices.
                db.execute(
                    "INSERT INTO stores(id,name,city,latitude,longitude,provenance) VALUES (?,?,?,?,?,?)",
                    (store_id, f"Walmart TFT 매장 {sample['model_input']['store_nbr']} · {len(sample['products'])}개 상품",
                     "미국 · 세부 위치 비공개", 0, 0, provenance),
                )
                db.execute("INSERT INTO memberships VALUES (?,?,?)", ("demo-owner", store_id, "owner"))
            old_products = {row["id"] for row in db.execute("SELECT id FROM products WHERE store_id=?", (store_id,))}
            stamp = now_iso()
            for product in sample["products"]:
                if product["id"] in old_products:
                    continue
                db.execute(
                    "INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (store_id, product["id"], f"Walmart 익명 상품 {product['model_item_nbr']}",
                     "실제 판매 표본", "미제공 · 발주 불가", 0, 0, 1, 1, 1),
                )
                db.executemany(
                    "INSERT INTO sales VALUES (?,?,?,?,?,?)",
                    [(store_id, row["product_id"], row["date"], row["units_sold"], "walmart_observed_sample", stamp)
                     for row in sample["sales"] if row["product_id"] == product["id"]],
                )
            # Future comparison observations remain in actuals.json only.
            # The version marker also prevents restoring history deleted later.
            db.execute("UPDATE stores SET name=?,provenance=?,revision=revision+1,sales_revision=sales_revision+1 WHERE id=?",
                       (f"Walmart TFT 매장 {sample['model_input']['store_nbr']} · {len(sample['products'])}개 상품", provenance, store_id))
            db.execute("INSERT INTO tft_demo_seeds VALUES (?,?)", (store_id, SEED_VERSION))


def public_store(store):
    if not is_demo(store):
        return store
    return {**store, "latitude": None, "longitude": None,
            "demo_kind": "walmart_tft", "demo_as_of": AS_OF.isoformat(),
            "demo_notice": NOTICE, "demo_products": len(_sample(store["id"])["products"]),
            "demo_store_nbr": _sample(store["id"])["model_input"]["store_nbr"], "coordinates_available": False,
            "ordering_available": False}


def validate_replay(store, cutoff):
    if not enabled() or not is_demo(store) or store.get("provenance") != _provenance(store["id"]):
        raise ValueError("Walmart TFT replay is not enabled for this store")
    if cutoff != AS_OF:
        raise ValueError(f"이 TFT 표본의 기준일은 {AS_OF.isoformat()}입니다.")


def add_model_input(context, store):
    validate_replay(store, date.fromisoformat(context["as_of"]))
    sample = _sample(store["id"])
    mapping = {p["id"]: p["model_item_nbr"] for p in sample["products"]}
    return {
        **context,
        "products": [{**p, "model_item_nbr": mapping.get(p["id"])} for p in context["products"]],
        "model_input": deepcopy(sample["model_input"]),
    }


def weather(store, cutoff):
    validate_replay(store, cutoff)
    sample = _sample(store["id"])
    defaults = json.loads((PROJECT_ROOT / "ml/metadata/weather_fill_defaults.json").read_text(encoding="utf-8"))
    latest = dict(defaults)
    for record in sorted(sample["model_input"]["history_weather"], key=lambda row: row["date"]):
        if record["date"] > cutoff.isoformat():
            continue
        for name in defaults:
            raw = record.get(name)
            try:
                value = 0.0 if str(raw).strip() == "T" else float(raw)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value):
                latest[name] = value
    days = [
        {"date": (cutoff + timedelta(days=offset)).isoformat(),
         "temp_max": (latest["tmax"] - 32) * 5 / 9,
         "temp_min": (latest["tmin"] - 32) * 5 / 9,
         "rain_mm": latest["preciptotal"] * 25.4, "rain_probability": None, "code": None}
        for offset in range(1, 8)
    ]
    return {
        "status": "ok", "mode": "historical_persistence_demo",
        "source": "Walmart Stormy Weather 관측자료", "days": days,
        "fetched_at": now_iso(), "cached": False,
        "note": "2014-09-12까지의 마지막 관측 날씨를 7일간 유지한 가정입니다. 당시 발급 예보나 미래 실제 날씨가 아닙니다.",
        "message": "조회 시각은 샘플을 읽은 시각입니다. 실제 판매 표본의 재현용이며 현재 영업·발주용이 아닙니다.",
    }
