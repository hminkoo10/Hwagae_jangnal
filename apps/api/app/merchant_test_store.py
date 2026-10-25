"""Explicit synthetic merchant fixtures; never replace an existing user's data."""

import math
import uuid
from datetime import timedelta

from app.database import encode, now_iso, store_today

DATA_NOTE = (
    "직접 테스트용 가상 매장입니다. 5개 상품·가격·오늘을 포함한 2달 판매·재고·입고는 "
    "합성 자료이며 오늘 판매도 테스트를 위해 마감된 값으로 생성했습니다. "
    "날씨는 입력 좌표의 실제 예보를 조회합니다. 실험 TFT는 합성 자료로 학습했으며 "
    "실제 한국 매장 정확도·절감액은 검증하지 않았습니다."
)


def create_test_store(database, user_id, payload):
    store_id = uuid.uuid4().hex[:12]
    stamp, cutoff = now_iso(), store_today({"timezone": payload.timezone})
    catalog = [
        ("TEST01", "햄치즈 샌드위치", "간편식", 4800, 2600, 2, 32),
        ("TEST02", "삼각김밥", "간편식", 1800, 950, 2, 46),
        ("TEST03", "과일 컵", "신선식품", 4500, 2700, 3, 22),
        ("TEST04", "아이스 음료", "음료", 2200, 1100, 7, 40),
        ("TEST05", "소금빵", "베이커리", 2800, 1500, 2, 28),
    ]
    with database.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        db.execute(
            "INSERT INTO stores(id,name,city,latitude,longitude,provenance) VALUES (?,?,?,?,?,?)",
            (
                store_id,
                payload.name,
                payload.city,
                payload.latitude,
                payload.longitude,
                DATA_NOTE,
            ),
        )
        db.execute(
            "INSERT INTO memberships VALUES (?,?,?)", (user_id, store_id, "owner")
        )
        db.execute("INSERT INTO store_locales VALUES (?,?,?)", (store_id, payload.timezone, "noaa_gfs" if payload.timezone.startswith("America/") else "auto"))
        db.execute(
            "INSERT INTO store_forecast_settings VALUES (?,?,?)",
            (store_id, "merchant_tft", stamp),
        )
        for index, (product_id, name, category, price, cost, shelf, base) in enumerate(
            catalog
        ):
            db.execute(
                "INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)",
                (
                    store_id,
                    product_id,
                    name,
                    category,
                    "시연 공급사",
                    price,
                    cost,
                    1,
                    shelf,
                    1,
                ),
            )
            rows = []
            for offset in range(55, -1, -1):
                day = cutoff - timedelta(days=offset)
                units = max(
                    0,
                    round(
                        base * (1.16 if day.weekday() >= 5 else 1)
                        + 4 * math.sin(day.toordinal() * 0.37 + index)
                    ),
                )
                rows.append(
                    (
                        store_id,
                        product_id,
                        day.isoformat(),
                        units,
                        "synthetic_live_weather_test",
                        stamp,
                    )
                )
            db.executemany("INSERT INTO sales VALUES (?,?,?,?,?,?)", rows)
            stock = {
                "batches": [
                    {
                        "quantity": max(1, base // 4),
                        "expires_on": (cutoff + timedelta(days=shelf)).isoformat(),
                    }
                ],
                "incoming": [
                    {
                        "quantity": 3,
                        "arrives_on": (cutoff + timedelta(days=1)).isoformat(),
                        "expires_on": (cutoff + timedelta(days=shelf)).isoformat(),
                    }
                ],
                "incoming_confirmed": True,
            }
            db.execute(
                "INSERT INTO inventory VALUES (?,?,?,?,?)",
                (store_id, product_id, encode(stock), cutoff.isoformat(), stamp),
            )
    return {
        "id": store_id,
        "name": payload.name,
        "city": payload.city,
        "latitude": payload.latitude,
        "longitude": payload.longitude,
        "provenance": DATA_NOTE,
        "timezone": payload.timezone,
        "local_today": cutoff.isoformat(),
        "role": "owner",
        "provider": "merchant_tft",
        "data_note": DATA_NOTE,
    }
