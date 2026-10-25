"""CPU-only TFT inference trained on Dimigo store POS sales; merchant identities are opaque."""

from datetime import date, timedelta
from functools import lru_cache
import hashlib
import json
import math
from numbers import Real
import os
from pathlib import Path
import threading

import numpy as np
import torch

from .network import CONFIG, ENCODER_DAYS, HORIZON, QUANTILES, REALS, build_model, features, tensors

ROOT = Path(__file__).resolve().parent
LOCK = threading.Lock()
MODEL_NAME = "실시간 예보 TFT · 디미고 매점 학습"
NOTE = (
    "디미고사회적협동조합 매점의 실제 POS 판매(2025-10-01~2026-07-11, 판매일 223일)와 "
    "안산 와동 과거 재분석 날씨로 학습한 TFT입니다. 마지막 6주(2026-05-30~07-11)를 시간순 검증으로 "
    "epoch·설정을 골랐고 이후 30% 기간은 학습·선택에 쓰지 않았습니다. 학습 날씨는 관측값에 예보 오차 잡음을 "
    "더한 것이며 발급된 예보로 학습하지 않았습니다. 학사일정은 입력하지 않으므로 방학·휴무 시작은 예측하지 못합니다. "
    "다른 매장의 정확도는 검증하지 않았고 Walmart TFT의 평가 지표는 이 모델에 적용되지 않습니다."
)


@lru_cache(maxsize=1)
def _load():
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    checkpoint = ROOT / "model.ckpt"
    if hashlib.sha256(checkpoint.read_bytes()).hexdigest() != manifest["checkpoint_sha256"]:
        raise ValueError("merchant TFT checkpoint checksum mismatch")
    if manifest["architecture"] != CONFIG or manifest["features"] != REALS or manifest["quantiles"] != QUANTILES:
        raise ValueError("merchant TFT architecture differs from its trained manifest")
    threads = int(os.getenv("MERCHANT_TFT_NUM_THREADS", "2"))
    if not 1 <= threads <= 8:
        raise ValueError("MERCHANT_TFT_NUM_THREADS must be between 1 and 8")
    torch.set_num_threads(threads)
    # Local fixed artifact, restricted tensor loader. No pickled model class,
    # optimizer, user-supplied path or arbitrary checkpoint object is accepted.
    state = torch.load(checkpoint, map_location="cpu", weights_only=True)
    model = build_model()
    model.load_state_dict(state, strict=True)
    return model.cpu().float().eval(), manifest


def _day(raw, field):
    if not isinstance(raw, str):
        raise ValueError(f"{field} must be an ISO date")
    result = date.fromisoformat(raw)
    if result.isoformat() != raw:
        raise ValueError(f"{field} must be YYYY-MM-DD")
    return result


def _number(value, field, minimum, maximum):
    if isinstance(value, bool) or not isinstance(value, Real) or not math.isfinite(float(value)) or not minimum <= value <= maximum:
        raise ValueError(f"invalid {field}")
    return float(value)


def _prepare(context):
    if not isinstance(context, dict) or context.get("schema_version") != "1":
        raise ValueError("merchant context schema_version must be '1'")
    origin = _day(context.get("as_of"), "as_of")
    dates = [(origin + timedelta(days=offset)).isoformat() for offset in range(1, HORIZON + 1)]
    if context.get("dates") != dates:
        raise ValueError("dates must contain the next seven days in order")
    products = context.get("products")
    if not isinstance(products, list) or not 1 <= len(products) <= 50:
        raise ValueError("provide between 1 and 50 products")
    ids = [product.get("id") for product in products]
    if any(not isinstance(value, str) or not value.strip() for value in ids) or len(ids) != len(set(ids)):
        raise ValueError("product IDs must be unique nonempty strings")
    weather = context.get("weather", {})
    if weather.get("status") != "ok" or weather.get("mode") not in {
        "live_forecast", "historical_reanalysis", "recent_weather"
    }:
        raise ValueError("complete forecast or explicitly labelled reanalysis weather required")
    days = weather.get("days", [])
    if not isinstance(days, list) or [day.get("date") for day in days] != dates:
        raise ValueError("weather must contain exactly the seven requested days in order")
    for day in days:
        maximum = _number(day.get("temp_max"), "temp_max", -90, 65)
        minimum = _number(day.get("temp_min"), "temp_min", -90, 65)
        _number(day.get("rain_mm"), "rain_mm", 0, 2000)
        if minimum > maximum:
            raise ValueError("temp_min exceeds temp_max")
    records = context.get("sales")
    if not isinstance(records, list):
        raise ValueError("sales must be a list")
    history = {product_id: {} for product_id in ids}
    seen = set()
    for row in records:
        product_id = row.get("product_id")
        day = _day(row.get("date"), "sales.date")
        if day > origin:
            raise ValueError("sales after as_of must not enter model inputs")
        key = (product_id, day)
        if key in seen:
            raise ValueError("duplicate product/date sales")
        seen.add(key)
        value = row.get("units_sold")
        if value is not None:
            value = _number(value, "units_sold", 0, 1_000_000)
            if not value.is_integer():
                raise ValueError("sales units must be whole units")
        if product_id in history:
            history[product_id][day] = value
    required = [origin - timedelta(days=offset) for offset in range(ENCODER_DAYS - 1, -1, -1)]
    output, arrays, scales, ready = [], [], [], []
    for product_id in ids:
        values = [history[product_id].get(day) for day in required]
        product = {"product_id": product_id, "status": "insufficient_history", "reason": None, "points": []}
        count = sum(value is not None for value in values)
        if count != ENCODER_DAYS:
            product["reason"] = f"기준일까지 연속 56일 판매 기록이 필요합니다. 현재 {count}/56일이며 누락일은 0으로 채우지 않습니다."
        else:
            array, scale = features(values, origin, days)
            arrays.append(array)
            scales.append(scale)
            ready.append(len(output))
            product["status"] = "ready"
        output.append(product)
    return output, arrays, np.asarray(scales), ready, dates


def predict(context):
    products, arrays, scales, ready, dates = _prepare(context)
    with LOCK:
        model, manifest = _load()
        if arrays:
            with torch.inference_mode():
                raw = model(tensors(np.stack(arrays)))["prediction"].numpy()
            if raw.shape != (len(arrays), HORIZON, len(QUANTILES)) or not np.isfinite(raw).all():
                raise ValueError("merchant TFT returned malformed quantiles")
            # Same clip-at-zero-then-sort quantile postprocessing as ml/predict.py.
            values = np.sort(np.maximum(raw, 0.0), axis=-1) * scales[:, None, None]
            if np.any(values > 1_000_000):
                raise ValueError("merchant TFT output exceeds the API quantity boundary")
            for batch, index in enumerate(ready):
                products[index]["points"] = [
                    {"date": day, "p10": float(values[batch, offset, 0]),
                     "p50": float(values[batch, offset, 2]), "p90": float(values[batch, offset, 4])}
                    for offset, day in enumerate(dates)
                ]
    model = {"name": MODEL_NAME, "version": manifest["version"],
             "uses_weather": True, "training_data": "dimigo_store", "note": NOTE}
    if context["weather"]["mode"] != "live_forecast":
        model.update(
            name="과거 날씨 TFT · 실험", experimental=True,
            weather_strategy=context["weather"]["mode"],
            note=("디미고 매점 판매로 학습한 TFT에 과거 날씨 자료를 입력합니다. "
                  "당시 발급된 예보가 아니므로 실제 예보를 쓰는 미래 예측 성능과 같지 않습니다. "
                  "학습 기간 이후 평가는 실제 예보 오차가 없는 낙관적 조건으로 해석합니다. "
                  "Walmart TFT 평가 지표를 적용하지 않습니다."),
        )
    return {"model": model, "products": products}
