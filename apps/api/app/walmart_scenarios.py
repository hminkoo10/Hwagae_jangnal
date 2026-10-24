"""Explicit date-shifted Walmart demonstrations with a chosen US weather location."""

import json
import math
import uuid
from datetime import date, timedelta
from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field

from app.database import encode, now_iso, store_today
from app.model_demo import SampleId
from app.schemas import Payload

LOCATIONS = {
    "dallas": {"city": "댈러스, 텍사스", "latitude": 32.7767, "longitude": -96.7970, "timezone": "America/Chicago"},
    "new_york": {"city": "뉴욕", "latitude": 40.7128, "longitude": -74.0060, "timezone": "America/New_York"},
    "seattle": {"city": "시애틀", "latitude": 47.6062, "longitude": -122.3321, "timezone": "America/Los_Angeles"},
}
DATA_NOTE = (
    "Walmart 공개 판매·과거 관측 날씨의 날짜를 현재로 옮긴 시연 매장입니다. "
    "미국 도시는 사용자가 고른 날씨 시연 위치이며 원본 Walmart 매장의 실제 위치가 아닙니다. "
    "오늘 판매도 시연을 위해 마감된 것으로 가정합니다. 가격·원가(원)·재고·입고는 시연 가정입니다. "
    "기존 Walmart TFT에 선택 지역의 실제 예보를 입력하는 실험이며, 기존 persistence 평가 수치는 적용하지 않습니다. "
    "과거 날짜는 재분석·최근 수치모델 자료를 사용하는 시나리오로 당시 발급 예보 검증이 아닙니다."
)


class WalmartTestInput(Payload):
    name: str = Field(min_length=1, max_length=80)
    location: Literal["dallas", "new_york", "seattle"] = "dallas"
    sample_id: SampleId = "walmart-demo-4"


@lru_cache(maxsize=1)
def scenario_history():
    path = Path(__file__).resolve().parents[3] / "ml/examples/walmart-scenario-history.json"
    return json.loads(path.read_text(encoding="utf-8"))


def binding(database, store_id):
    with database.connect() as db:
        row = db.execute("SELECT * FROM walmart_scenarios WHERE store_id=?", (store_id,)).fetchone()
    return dict(row) if row else None


def create_walmart_test_store(database, user_id, payload):
    source = scenario_history()
    sample = next(item for item in source["stores"] if item["id"] == payload.sample_id)
    place = LOCATIONS[payload.location]
    cutoff = store_today(place)
    delta = cutoff - date.fromisoformat(source["source_end"])
    shift = lambda value: (date.fromisoformat(value) + delta).isoformat()
    store_id, stamp = uuid.uuid4().hex[:12], now_iso()
    with database.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT INTO stores(id,name,city,latitude,longitude,provenance) VALUES (?,?,?,?,?,?)",
            (store_id, payload.name.strip() or "Walmart 미국 날씨 시연", place["city"], place["latitude"], place["longitude"], DATA_NOTE),
        )
        db.execute("INSERT INTO memberships VALUES (?,?,?)", (user_id, store_id, "owner"))
        db.execute("INSERT INTO store_locales VALUES (?,?,?)", (store_id, place["timezone"], "noaa_gfs"))
        # The existing setting selects the TFT policy. The explicit binding picks
        # the Walmart runtime; unbound stores retain their synthetic merchant TFT.
        db.execute("INSERT INTO store_forecast_settings VALUES (?,?,?)", (store_id, "merchant_tft", stamp))
        db.execute("INSERT INTO walmart_scenarios VALUES (?,?,?,?,?)", (store_id, payload.sample_id, cutoff.isoformat(), source["source_end"], encode(sample)))
        for product in sample["products"]:
            product_id = product["id"]
            db.execute("INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)", (store_id, product_id, product["name"], "Walmart 공개 상품", "시연 공급사", 4000, 2000, 1, 3, 2))
            units = [row["units_sold"] for row in sample["sales"] if row["product_id"] == product_id]
            average = sum(units[-7:]) / 7
            stock = {
                "batches": [{"quantity": math.ceil(average / 2), "expires_on": (cutoff + timedelta(days=2)).isoformat()}],
                "incoming": [{"quantity": math.ceil(average / 4), "arrives_on": (cutoff + timedelta(days=2)).isoformat(), "expires_on": (cutoff + timedelta(days=4)).isoformat()}],
                "incoming_confirmed": True,
            }
            db.execute("INSERT INTO inventory VALUES (?,?,?,?,?)", (store_id, product_id, encode(stock), cutoff.isoformat(), stamp))
        db.executemany("INSERT INTO sales VALUES (?,?,?,?,?,?)", [
            (store_id, row["product_id"], shift(row["date"]), row["units_sold"], "walmart_date_shifted_demo", stamp)
            for row in sample["sales"]
        ])
    return {"id": store_id, "name": payload.name.strip(), **place, "role": "owner", "provenance": DATA_NOTE, "local_today": cutoff.isoformat()}


def model_context(context, record):
    """Attach only stored trained identities and server-fetched weather values."""
    source = json.loads(record["history_payload"])
    delta = date.fromisoformat(record["anchor_date"]) - date.fromisoformat(record["source_end"])
    history = []
    for row in source["history_weather"]:
        day = (date.fromisoformat(row["date"]) + delta).isoformat()
        if day <= context["as_of"]:
            history.append({**row, "date": day})
    mapping = {product["id"]: product["model_item_nbr"] for product in source["products"]}
    forecast = []
    for day in context["weather"]["days"]:
        values = [day.get(field) for field in ("temp_mean", "temp_max", "temp_min", "rain_mm", "wind_mean_ms")]
        if any(type(value) not in (int, float) or not math.isfinite(value) for value in values):
            raise ValueError("Walmart TFT에는 평균·최고·최저 기온, 강수량, 평균 풍속이 필요합니다.")
        forecast.append({"date": day["date"], "tavg": day["temp_mean"] * 9 / 5 + 32,
                         "tmax": day["temp_max"] * 9 / 5 + 32, "tmin": day["temp_min"] * 9 / 5 + 32,
                         "preciptotal": day["rain_mm"] / 25.4, "avgspeed": day["wind_mean_ms"] / 0.44704})
    return {
        **context,
        "products": [{**product, "model_item_nbr": mapping.get(product["id"])} for product in context["products"]],
        "model_input": {"dataset": "walmart-stormy-weather", "store_nbr": source["store_nbr"],
                        "station_nbr": source["station_nbr"], "weather_strategy": "provided_forecast",
                        "weather_units": "walmart", "history_weather": history, "forecast_weather": forecast},
    }
