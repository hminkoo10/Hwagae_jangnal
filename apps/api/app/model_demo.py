"""Fixed, authenticated historical replay; never creates merchant/order records."""

import json
from pathlib import Path
from time import perf_counter
from typing import Literal

from app.database import now_iso
from app.forecasting import baseline
from app.schemas import Point


SampleId = Literal["walmart-demo-4", "walmart-demo-24", "walmart-demo-17"]
DEFAULT_SAMPLE_ID: SampleId = "walmart-demo-4"
EXAMPLES_PATH = Path(__file__).resolve().parents[3] / "ml/examples"
ACTUALS_PATH = EXAMPLES_PATH / "actuals.json"
SAMPLE_FILES = {
    "walmart-demo-4": "input-store-4.json",
    "walmart-demo-24": "input-store-24.json",
    "walmart-demo-17": "input-store-17.json",
}
SOURCE = "Kaggle Walmart Recruiting — Sales in Stormy Weather"
NOTE = (
    "미국 Walmart의 과거 판매·관측 날씨로 학습한 TFT를 실행합니다. "
    "미래 날씨는 마지막 관측값을 7일간 유지하며 실제 발급 예보를 사용하지 않습니다. "
    "한국 매장 예측이나 발주 계산에 적용되는 결과가 아닙니다."
)


def _manifest():
    manifest = json.loads(
        (EXAMPLES_PATH / "demo-manifest.json").read_text(encoding="utf-8")
    )
    entries = manifest["samples"]
    if (
        manifest["schema_version"] != "1"
        or len(entries) != len(SAMPLE_FILES)
        or {entry["store_id"] for entry in entries} != set(SAMPLE_FILES)
        or manifest["total_products"] != 10
        or sum(entry["product_count"] for entry in entries) != 10
    ):
        raise ValueError("invalid demo manifest")
    for entry in entries:
        if entry["input"] != SAMPLE_FILES[entry["store_id"]]:
            raise ValueError("unsupported demo input file")
        if type(entry["product_count"]) is not int or entry["product_count"] <= 0:
            raise ValueError("invalid demo product count")
    return manifest


def sample_options():
    return [
        {
            "id": entry["store_id"],
            "label": f"Walmart 매장 {entry['store_nbr']}",
            "product_count": entry["product_count"],
        }
        for entry in _manifest()["samples"]
    ]


def sample_context(sample_id: SampleId = DEFAULT_SAMPLE_ID):
    # Read the versioned sample, never a client-supplied path, mapping or weather.
    if sample_id not in SAMPLE_FILES:
        raise ValueError("unsupported demo sample")
    manifest = _manifest()
    entry = next(
        entry for entry in manifest["samples"] if entry["store_id"] == sample_id
    )
    context = json.loads((EXAMPLES_PATH / entry["input"]).read_text(encoding="utf-8"))
    if (
        context["store_id"] != sample_id
        or context["as_of"] != manifest["as_of"]
        or len(context["products"]) != entry["product_count"]
        or len({product["id"] for product in context["products"]})
        != entry["product_count"]
        or context["model_input"]["store_nbr"] != entry["store_nbr"]
        or context["model_input"]["station_nbr"] != entry["station_nbr"]
    ):
        raise ValueError("sample identity differs from the manifest")
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
        points = [
            Point.model_validate(point).model_dump(mode="json")
            for point in item["points"]
        ]
        status, reason = item["status"], item.get("reason")
        if status == "ready":
            if [point["date"] for point in points] != context["dates"]:
                raise ValueError("model must return exactly the seven requested dates")
        elif (
            status != "insufficient_history"
            or points
            or not isinstance(reason, str)
            or not reason
        ):
            raise ValueError("invalid model product status")
        output.append(
            {
                "product_id": product_id,
                "name": names[product_id],
                "status": status,
                "reason": reason,
                "points": [{**point, "actual": None} for point in points],
            }
        )
    by_id = {item["product_id"]: item for item in output}
    return {
        "model": {key: model[key] for key in ("name", "version", "uses_weather")},
        "products": [by_id[item["id"]] for item in context["products"]],
    }


def _actuals_by_key(context):
    """Read comparison outcomes only after model inference and output checks."""
    source = json.loads(ACTUALS_PATH.read_text(encoding="utf-8"))
    expected = {
        (product["id"], day)
        for product in context["products"]
        for day in context["dates"]
    }
    if source["schema_version"] != "1" or any(
        day <= context["as_of"] for _, day in expected
    ):
        raise ValueError("invalid comparison dates")
    actuals = {}
    for row in source["stores"][context["store_id"]]:
        key = (row["product_id"], row["date"])
        units = row["units_sold"]
        if key not in expected or key in actuals:
            raise ValueError("duplicate or unexpected comparison key")
        if type(units) is not int or not 0 <= units <= 1_000_000:
            raise ValueError("invalid comparison sales quantity")
        actuals[key] = units
    if set(actuals) != expected:
        raise ValueError("missing comparison observations")
    return actuals


def replay(runtime, sample_id: SampleId = DEFAULT_SAMPLE_ID):
    context = sample_context(sample_id)
    start = perf_counter()
    result = checked_output(runtime.predict(context), context)
    comparison = checked_output(baseline(context), context)
    actuals = _actuals_by_key(context)
    for output in (result, comparison):
        for product in output["products"]:
            for point in product["points"]:
                point["actual"] = actuals[(product["product_id"], point["date"])]
    return {
        **result,
        "sample_id": sample_id,
        "as_of": context["as_of"],
        "dates": context["dates"],
        "created_at": now_iso(),
        "elapsed_ms": round((perf_counter() - start) * 1000, 1),
        "baseline": comparison,
        "provenance": SOURCE,
        "weather_strategy": "persistence",
        "note": NOTE
        + " 비교 기준선에도 같은 56일 판매를 사용합니다. 실제 판매는 추론이 끝난 뒤 비교용으로 연결하며 모델 입력에는 넣지 않습니다.",
    }
