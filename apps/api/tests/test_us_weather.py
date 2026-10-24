"""US weather dates, provenance, provider selection and cache isolation."""

from datetime import date, datetime, timedelta, timezone

import pytest

from app import database as database_module
from app.database import Database, store_today
from app.weather import get_weather, require_live_forecast


@pytest.fixture
def weather_service(tmp_path, monkeypatch):
    database = Database(tmp_path / "weather-us.sqlite3")
    database.initialize(seed=False)
    calls = []
    state = {"fail": False, "missing_wind": False}
    monkeypatch.setattr("app.weather.store_today", lambda store: date(2026, 10, 24))

    class WeatherClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def get(self, url, params):
            calls.append({"url": url, "params": params})
            if state["fail"]:
                raise ValueError("weather provider unavailable")
            self.start = date.fromisoformat(params["start_date"])
            return self

        def raise_for_status(self):
            pass

        def json(self):
            daily = {
                "time": [(self.start + timedelta(days=i)).isoformat() for i in range(7)],
                "temperature_2m_max": [30] * 7,
                "temperature_2m_min": [10] * 7,
                "temperature_2m_mean": [20] * 7,
                "precipitation_sum": [25.4] * 7,
                "precipitation_probability_max": [40] * 7,
                "wind_speed_10m_mean": [4.4704] * 7,
                "weather_code": [3] * 7,
            }
            if state["missing_wind"]:
                daily.pop("wind_speed_10m_mean")
            return {"daily": daily}

    monkeypatch.setattr("app.weather.httpx.Client", WeatherClient)
    store = {
        "latitude": 40.7128,
        "longitude": -74.006,
        "timezone": "America/New_York",
        "weather_provider": "noaa_gfs",
    }
    return database, store, calls, state


@pytest.mark.parametrize(
    "cutoff,mode,url",
    [
        (date(2026, 10, 24), "live_forecast", "https://api.open-meteo.com/v1/gfs"),
        (date(2026, 10, 23), "recent_weather", "https://api.open-meteo.com/v1/gfs"),
        (
            date(2026, 10, 10),
            "historical_reanalysis",
            "https://archive-api.open-meteo.com/v1/archive",
        ),
    ],
)
def test_us_weather_uses_local_dates_units_and_honest_modes(weather_service, cutoff, mode, url):
    database, store, calls, _ = weather_service
    result = get_weather(database, store, cutoff)
    assert result["status"] == "ok" and result["mode"] == mode
    assert result["timezone"] == "America/New_York"
    assert calls[0]["url"] == url
    params = calls[0]["params"]
    assert params["timezone"] == "America/New_York"
    assert params["wind_speed_unit"] == "ms"
    assert params["temperature_unit"] == "celsius"
    assert params["precipitation_unit"] == "mm"
    assert "temperature_2m_mean" in params["daily"]
    assert "wind_speed_10m_mean" in params["daily"]
    assert result["days"][0]["date"] == (cutoff + timedelta(days=1)).isoformat()
    assert result["days"][-1]["date"] == (cutoff + timedelta(days=7)).isoformat()
    assert result["days"][0]["temp_mean"] == 20
    assert result["days"][0]["wind_mean_ms"] == 4.4704
    require_live_forecast(
        result,
        cutoff,
        timezone_name="America/New_York",
        historical=mode != "live_forecast",
    )
    assert get_weather(database, store, cutoff)["cached"] is True
    assert len(calls) == 1


def test_us_weather_cache_separates_timezone_and_provider(weather_service):
    database, store, calls, _ = weather_service
    cutoff = date(2026, 10, 24)
    get_weather(database, store, cutoff)
    west = get_weather(database, {**store, "timezone": "America/Los_Angeles"}, cutoff)
    ordinary = get_weather(database, {**store, "weather_provider": "open_meteo"}, cutoff)
    assert len(calls) == 3
    assert west["timezone"] == "America/Los_Angeles" and not west["cached"]
    assert calls[-1]["url"] == "https://api.open-meteo.com/v1/forecast"
    assert "NOAA" not in ordinary["source"]


def test_missing_us_wind_and_failed_refresh_are_not_complete_forecasts(weather_service):
    database, store, calls, state = weather_service
    cutoff = date(2026, 10, 24)
    state["missing_wind"] = True
    result = get_weather(database, store, cutoff)
    assert result["status"] == "partial"
    assert result["days"][0]["wind_mean_ms"] is None
    with database.connect() as db:
        db.execute("UPDATE weather_cache SET fetched_at='2000-01-01T00:00:00+00:00'")
    state["fail"] = True
    stale = get_weather(database, store, cutoff)
    assert stale["status"] == "stale" and stale["cached"]
    assert len(calls) == 2
    with pytest.raises(ValueError):
        require_live_forecast(stale, cutoff, timezone_name="America/New_York")


def test_weather_validation_never_relabels_current_forecast_as_past(weather_service):
    database, store, _, _ = weather_service
    cutoff = date(2026, 10, 24)
    result = get_weather(database, store, cutoff)
    with pytest.raises(ValueError):
        require_live_forecast(result, cutoff, timezone_name="America/New_York", historical=True)
    with pytest.raises(ValueError):
        require_live_forecast(result, cutoff, timezone_name="Asia/Seoul")


@pytest.mark.parametrize(
    "utc_value,expected",
    [
        ("2026-03-08T04:30:00+00:00", "2026-03-07"),
        ("2026-03-09T04:30:00+00:00", "2026-03-09"),
        ("2026-11-01T04:30:00+00:00", "2026-11-01"),
        ("2026-11-02T04:30:00+00:00", "2026-11-01"),
    ],
)
def test_store_today_observes_us_dst_and_utc_date_boundaries(monkeypatch, utc_value, expected):
    instant = datetime.fromisoformat(utc_value)

    class Clock(datetime):
        @classmethod
        def now(cls, tz=None):
            return instant.astimezone(tz or timezone.utc)

    monkeypatch.setattr(database_module, "datetime", Clock)
    assert store_today({"timezone": "America/New_York"}).isoformat() == expected
    assert store_today({}).isoformat() == instant.date().isoformat()
