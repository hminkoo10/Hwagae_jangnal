"""Open-Meteo integration with explicit provenance and a persistent 30-minute cache."""

import json
import math
from datetime import datetime, timedelta, timezone

import httpx2 as httpx

from app.database import encode, now_iso, today


def require_live_forecast(weather, as_of):
    """Validate the exact forecast snapshot before a weather model sees it."""
    if weather.get("status") != "ok" or weather.get("mode") != "live_forecast":
        raise ValueError("최신 실시간 예보 7일이 필요합니다. 날씨를 새로 조회하세요.")
    if weather.get("timezone") != "Asia/Seoul" or weather.get("units") != {
        "temperature": "celsius",
        "precipitation": "mm",
    }:
        raise ValueError("예보의 시간대와 기온·강수 단위를 확인할 수 없습니다.")
    try:
        fetched = datetime.fromisoformat(weather["fetched_at"])
        if fetched.tzinfo is None:
            raise ValueError("missing timezone")
        age = (datetime.now(timezone.utc) - fetched).total_seconds()
        if age < -60 or age >= 1800:
            raise ValueError("stale snapshot")
    except KeyError, TypeError, ValueError:
        raise ValueError("30분 이내 조회한 실시간 예보가 필요합니다.") from None
    expected = [(as_of + timedelta(days=i)).isoformat() for i in range(1, 8)]
    days = weather.get("days")
    if (
        not isinstance(days, list)
        or len(days) != 7
        or [day.get("date") for day in days if isinstance(day, dict)] != expected
    ):
        raise ValueError("예보 날짜가 다음 7일과 일치하지 않습니다.")
    for day in days:
        if any(
            type(day.get(field)) not in (int, float) or not math.isfinite(day[field])
            for field in ("temp_max", "temp_min", "rain_mm")
        ):
            raise ValueError("예보의 최고·최저기온과 강수량이 모두 필요합니다.")
        if (
            not -90 <= day["temp_min"] <= day["temp_max"] <= 65
            or not 0 <= day["rain_mm"] <= 2000
        ):
            raise ValueError("예보의 기온 범위 또는 강수량이 올바르지 않습니다.")


def get_weather(database, store, as_of):
    start, end = as_of + timedelta(days=1), as_of + timedelta(days=7)
    historical = as_of < today()
    mode = "historical_reanalysis" if historical else "live_forecast"
    key = f"v2:{store['latitude']}:{store['longitude']}:{as_of}:{mode}"
    with database.connect() as db:
        cached = db.execute(
            "SELECT * FROM weather_cache WHERE cache_key=?", (key,)
        ).fetchone()
    if (
        cached
        and (
            datetime.now(timezone.utc) - datetime.fromisoformat(cached["fetched_at"])
        ).total_seconds()
        < 1800
    ):
        return {**json.loads(cached["payload"]), "cached": True}
    base = {
        "source": "Open-Meteo",
        "timezone": "Asia/Seoul",
        "units": {"temperature": "celsius", "precipitation": "mm"},
        "mode": mode,
        "fetched_at": now_iso(),
        "cached": False,
        "days": [],
        "note": "과거 재분석 자료이며 당시 발급된 예보가 아닙니다."
        if historical
        else "현재 제공되는 수치예보입니다.",
    }
    if historical and end > today() - timedelta(days=6):
        return {
            **base,
            "status": "unavailable",
            "message": "최근 과거 구간은 재분석 자료가 준비되지 않았습니다. 2주 이전 날짜를 선택하세요.",
        }
    fields = [
        "temperature_2m_max",
        "temperature_2m_min",
        "precipitation_sum",
        "weather_code",
    ]
    if not historical:
        fields.append("precipitation_probability_max")
    params = {
        "latitude": store["latitude"],
        "longitude": store["longitude"],
        "timezone": "Asia/Seoul",
        "temperature_unit": "celsius",
        "precipitation_unit": "mm",
        "daily": ",".join(fields),
        "start_date": start.isoformat(),
        "end_date": end.isoformat(),
    }
    url = (
        "https://archive-api.open-meteo.com/v1/archive"
        if historical
        else "https://api.open-meteo.com/v1/forecast"
    )
    try:
        with httpx.Client(timeout=8.0) as client:
            response = client.get(url, params=params)
            response.raise_for_status()
            daily = response.json()["daily"]
        by_day = {}
        for index, day in enumerate(daily["time"]):

            def value(field, index=index):
                values = daily.get(field, [])
                item = values[index] if index < len(values) else None
                return (
                    item if type(item) in (float, int) and math.isfinite(item) else None
                )

            by_day[day] = {
                "date": day,
                "temp_max": value("temperature_2m_max"),
                "temp_min": value("temperature_2m_min"),
                "rain_mm": value("precipitation_sum"),
                "rain_probability": value("precipitation_probability_max"),
                "code": value("weather_code"),
            }
        days = [
            by_day.get(
                (start + timedelta(days=i)).isoformat(),
                {
                    "date": (start + timedelta(days=i)).isoformat(),
                    "temp_max": None,
                    "temp_min": None,
                    "rain_mm": None,
                    "rain_probability": None,
                    "code": None,
                },
            )
            for i in range(7)
        ]
        complete = all(
            day["temp_max"] is not None and day["rain_mm"] is not None for day in days
        )
        result = {
            **base,
            "status": "ok" if complete else "partial",
            "days": days,
            "message": None
            if complete
            else "제공되지 않은 날씨 항목은 비워 두었습니다.",
        }
        with database.connect() as db:
            db.execute(
                "INSERT OR REPLACE INTO weather_cache VALUES (?,?,?)",
                (key, encode(result), result["fetched_at"]),
            )
        return result
    except httpx.HTTPError, KeyError, ValueError, TypeError, IndexError:
        if cached:
            return {
                **json.loads(cached["payload"]),
                "status": "stale",
                "cached": True,
                "message": "갱신에 실패해 이전 날씨를 표시합니다. 조회 시각을 확인하세요.",
            }
        return {
            **base,
            "status": "unavailable",
            "message": "날씨 제공처에 연결하지 못했습니다. 잠시 후 다시 시도하세요.",
        }
