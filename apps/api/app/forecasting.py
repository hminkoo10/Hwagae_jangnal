"""Model handoff boundary. Default is an empirical weekday baseline, not a trained weather model."""

import importlib
import os
import sys
import uuid
from collections import defaultdict
from datetime import date, timedelta
from pathlib import Path

from app.database import encode, now_iso
from app.schemas import Point


def percentile(values, quantile):
    values = sorted(values)
    position = (len(values) - 1) * quantile
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    return round(
        values[lower] + (values[upper] - values[lower]) * (position - lower), 2
    )


def baseline(context):
    grouped = defaultdict(list)
    for row in context["sales"]:
        grouped[(row["product_id"], date.fromisoformat(row["date"]).weekday())].append(
            row["units_sold"]
        )
    products = []
    for product in context["products"]:
        points = []
        for raw_day in context["dates"]:
            values = grouped[(product["id"], date.fromisoformat(raw_day).weekday())]
            if len(values) < 4:
                break
            points.append(
                {
                    "date": raw_day,
                    "p10": percentile(values, 0.1),
                    "p50": percentile(values, 0.5),
                    "p90": percentile(values, 0.9),
                }
            )
        ready = len(points) == 7
        products.append(
            {
                "product_id": product["id"],
                "status": "ready" if ready else "insufficient_history",
                "reason": None
                if ready
                else "요일마다 4일 이상의 판매 기록이 필요합니다. 누락일을 0으로 채우지 않습니다.",
                "points": points if ready else [],
            }
        )
    return {
        "model": {
            "name": "요일 기준선",
            "version": "weekday-empirical-v1",
            "uses_weather": False,
        },
        "products": products,
    }


def run_forecast(database, store, as_of, weather, predictor=None):
    dates = [(as_of + timedelta(days=i)).isoformat() for i in range(1, 8)]
    products = database.products(store["id"])
    with database.connect() as db:
        sales = [
            dict(row)
            for row in db.execute(
                "SELECT product_id,date,units_sold FROM sales WHERE store_id=? AND date<=? AND date>=? ORDER BY date",
                (
                    store["id"],
                    as_of.isoformat(),
                    (as_of - timedelta(days=83)).isoformat(),
                ),
            )
        ]
        actuals = {
            (row["product_id"], row["date"]): row["units_sold"]
            for row in db.execute(
                "SELECT product_id,date,units_sold FROM sales WHERE store_id=? AND date>? AND date<=?",
                (store["id"], as_of.isoformat(), dates[-1]),
            )
        }
    context = {
        "schema_version": "1",
        "store_id": store["id"],
        "as_of": as_of.isoformat(),
        "dates": dates,
        "products": products,
        "sales": sales,
        "weather": weather,
    }
    entry = os.getenv("FORECAST_PROVIDER", "").strip()
    if predictor is not None:
        result = predictor(context)
    elif entry:
        project_root = str(Path(__file__).resolve().parents[3])
        if project_root not in sys.path:
            sys.path.insert(0, project_root)
        module_name, function_name = entry.split(":", 1)
        result = getattr(importlib.import_module(module_name), function_name)(context)
    else:
        result = baseline(context)
    # The adapter may be replaced by a teammate; never trust malformed model output.
    if not isinstance(result.get("model", {}).get("uses_weather"), bool):
        raise ValueError("모델의 uses_weather 값이 필요합니다.")
    model = result["model"]
    if not model.get("name") or not model.get("version"):
        raise ValueError("모델 이름과 버전이 필요합니다.")
    if model["uses_weather"] and (
        weather["status"] != "ok" or weather["mode"] not in {"live_forecast", "historical_reanalysis", "recent_weather"}
    ):
        raise ValueError(
            "이 모델의 예측에 필요한 날씨가 없습니다. 날씨 조회 상태와 대상 기간을 확인하세요."
        )
    names = {product["id"]: product["name"] for product in products}
    output, seen = [], set()
    for product in result["products"]:
        product_id = product["product_id"]
        if product_id not in names or product_id in seen:
            raise ValueError("모델의 상품 목록이 요청과 다릅니다.")
        seen.add(product_id)
        points = [
            Point.model_validate(point).model_dump(mode="json")
            for point in product["points"]
        ]
        if product["status"] == "ready":
            if [point["date"] for point in points] != dates:
                raise ValueError("모델은 요청한 순서의 7일 예측을 반환해야 합니다.")
        elif product["status"] != "insufficient_history" or points:
            raise ValueError("모델의 상품 상태가 잘못되었습니다.")
        for point in points:
            point["actual"] = actuals.get((product_id, point["date"]))
        output.append(
            {
                "product_id": product_id,
                "name": names[product_id],
                "status": product["status"],
                "reason": product.get("reason"),
                "points": points,
            }
        )
    if seen != set(names):
        raise ValueError("모델에서 누락된 상품이 있습니다.")
    payload = {
        "id": uuid.uuid4().hex,
        "store_id": store["id"],
        "as_of": as_of.isoformat(),
        "dates": dates,
        "sales_revision": store["sales_revision"],
        "model": model,
        "weather": weather,
        "products": output,
        "created_at": now_iso(),
        "provenance": store["provenance"],
    }
    with database.connect() as db:
        db.execute(
            "INSERT INTO forecasts VALUES (?,?,?,?,?,?)",
            (
                payload["id"],
                store["id"],
                payload["as_of"],
                store["sales_revision"],
                encode(payload),
                payload["created_at"],
            ),
        )
    return payload
