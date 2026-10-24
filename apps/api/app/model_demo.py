"""Fixed, authenticated historical replay; never creates merchant/order records."""

import json
from pathlib import Path
from time import perf_counter

from app.database import now_iso
from app.forecasting import baseline
from app.schemas import Point


SAMPLE_PATH = Path(__file__).resolve().parents[3] / "ml/examples/input.json"
SOURCE = "Kaggle Walmart Recruiting — Sales in Stormy Weather"
NOTE = (
    "미국 Walmart의 과거 판매·관측 날씨로 학습한 TFT를 실행합니다. "
    "미래 날씨는 마지막 관측값을 7일간 유지하며 실제 발급 예보를 사용하지 않습니다. "
    "한국 매장 예측이나 발주 계산에 적용되는 결과가 아닙니다."
)


def sample_context():
    # Read the versioned sample, never a client-supplied path, mapping or weather.
    context = json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))
    if context["model_input"]["weather_strategy"] != "persistence":
        raise ValueError("unsupported demo weather strategy")
    if context["model_input"]["dataset"] != "walmart-stormy-weather":
        raise ValueError("unsupported demo dataset")
    return context


def describe_sample(context):
    sales_dates = [row["date"] for row in context["sales"]]
    return {
        "title": "Walmart 과거 자료로 TFT 체험",
        "as_of": context["as_of"],
        "dates": context["dates"],
        "history_start": min(sales_dates),
        "history_end": max(sales_dates),
        "history_days": 56,
        "product_count": len(context["products"]),
        "products": [
            {"id": product["id"], "name": product["name"]}
            for product in context["products"]
        ],
        "source": SOURCE,
        "weather_strategy": "persistence",
        "note": NOTE,
    }


def checked_output(result, context):
    """Apply the live API's quantity/date boundaries without bypassing its gate."""
    model = result["model"]
    if not isinstance(model.get("uses_weather"), bool):
        raise ValueError("model must declare uses_weather")
    for field in ("name", "version"):
        if not isinstance(model.get(field), str) or not 0 < len(model[field]) <= 200:
            raise ValueError("model identity is missing or invalid")
    names = {item["id"]: item["name"] for item in context["products"]}
    products = result["products"]
    if not isinstance(products, list) or len(products) != len(names):
        raise ValueError("model product count differs from the sample")
    seen, output = set(), []
    for item in products:
        product_id = item["product_id"]
        if product_id not in names or product_id in seen:
            raise ValueError("model product identity differs from the sample")
        seen.add(product_id)
        points = [Point.model_validate(point).model_dump(mode="json") for point in item["points"]]
        status, reason = item["status"], item.get("reason")
        if status == "ready":
            if [point["date"] for point in points] != context["dates"]:
                raise ValueError("model must return exactly the seven requested dates")
        elif status != "insufficient_history" or points or not isinstance(reason, str) or not reason:
            raise ValueError("invalid model product status")
        output.append({
            "product_id": product_id,
            "name": names[product_id],
            "status": status,
            "reason": reason,
            "points": [{**point, "actual": None} for point in points],
        })
    by_id = {item["product_id"]: item for item in output}
    return {
        "model": {key: model[key] for key in ("name", "version", "uses_weather")},
        "products": [by_id[item["id"]] for item in context["products"]],
    }


def replay(runtime):
    context = sample_context()
    start = perf_counter()
    result = checked_output(runtime.predict(context), context)
    comparison = checked_output(baseline(context), context)
    return {
        **result,
        "as_of": context["as_of"],
        "dates": context["dates"],
        "created_at": now_iso(),
        "elapsed_ms": round((perf_counter() - start) * 1000, 1),
        "baseline": comparison,
        "provenance": SOURCE,
        "weather_strategy": "persistence",
        "note": NOTE + " 비교 기준선에도 같은 56일 판매를 사용합니다. 이 체험 응답에는 실제 판매 정답을 포함하지 않으며 이 화면에서 정확도를 계산하지 않습니다.",
    }
