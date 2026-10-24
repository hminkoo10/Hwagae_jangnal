"""External weather and model failure boundaries; no Internet required."""

from datetime import timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import Database, today
from app.main import create_app
from app.weather import get_weather


def test_weather_is_cached_and_failed_refresh_is_explicit(tmp_path, monkeypatch):
    database = Database(tmp_path / "weather.sqlite3")
    database.initialize(seed=False)
    dates = [(today() + timedelta(days=i)).isoformat() for i in range(1, 8)]
    calls = []

    class WeatherClient:
        def __init__(self, **kwargs):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def get(self, url, params):
            calls.append(params)
            return self

        def raise_for_status(self):
            pass

        def json(self):
            return {
                "daily": {
                    "time": dates,
                    "temperature_2m_max": [25] * 7,
                    "temperature_2m_min": [15] * 7,
                    "precipitation_sum": [0] * 7,
                    "precipitation_probability_max": [20] * 7,
                    "weather_code": [1] * 7,
                }
            }

    monkeypatch.setattr("app.weather.httpx.Client", WeatherClient)
    store = {"latitude": 35.1, "longitude": 126.9}
    live = get_weather(database, store, today())
    assert live["status"] == "ok" and len(live["days"]) == 7
    assert calls[0]["start_date"] == dates[0] and calls[0]["end_date"] == dates[-1]
    assert get_weather(database, store, today())["cached"]
    assert len(calls) == 1
    with database.connect() as db:
        db.execute("UPDATE weather_cache SET fetched_at='2000-01-01T00:00:00+00:00'")

    def broken(*args, **kwargs):
        raise ValueError("unavailable")

    monkeypatch.setattr("app.weather.httpx.Client", broken)
    stale = get_weather(database, store, today())
    assert stale["status"] == "stale" and stale["cached"]
    assert stale["fetched_at"] == live["fetched_at"]
    unavailable = get_weather(database, {"latitude": 36.1, "longitude": 127.9}, today())
    assert unavailable["status"] == "unavailable" and unavailable["days"] == []
    recent = get_weather(database, store, today() - timedelta(days=1))
    assert (
        recent["status"] == "unavailable" and recent["mode"] == "recent_weather"
    )


def test_invalid_model_output_is_not_served(tmp_path, monkeypatch):
    import app.forecasting as forecasting

    valid_baseline = forecasting.baseline

    def broken(context):
        result = valid_baseline(context)
        result["products"][0]["points"][0]["p10"] = 999999
        return result

    monkeypatch.setattr(forecasting, "baseline", broken)
    application = create_app(tmp_path / "models.sqlite3")
    application.state.weather_reader = lambda *args: {
        "status": "unavailable",
        "mode": "live_forecast",
        "days": [],
    }
    with TestClient(application) as client:
        login = client.post(
            "/auth/login",
            json={"email": "owner@hwagae.local", "password": "hwagae-demo"},
        ).json()
        result = client.post(
            "/stores/gwangju/forecasts",
            headers={"Authorization": f"Bearer {login['token']}"},
        )
        assert result.status_code == 503


def test_public_mode_rejects_default_demo_password(tmp_path, monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.setenv("DEMO_PASSWORD", "hwagae-demo")
    with pytest.raises(RuntimeError, match="16"):
        with TestClient(create_app(tmp_path / "public.sqlite3")):
            pass
