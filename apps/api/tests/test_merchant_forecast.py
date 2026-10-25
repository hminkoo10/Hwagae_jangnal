"""Selected live-weather inference, explicit synthetic onboarding and order safety."""

from copy import deepcopy
from datetime import date, timedelta

import pytest
from fastapi.testclient import TestClient

from app.database import now_iso, today
from app.main import create_app
from app.model_runtime import ModelUnavailable


def valid_weather(cutoff):
    return {
        "status": "ok",
        "source": "forecast fixture",
        "mode": "live_forecast",
        "timezone": "Asia/Seoul",
        "units": {"temperature": "celsius", "precipitation": "mm"},
        "fetched_at": now_iso(),
        "cached": False,
        "days": [
            {
                "date": (cutoff + timedelta(days=i)).isoformat(),
                "temp_max": 25,
                "temp_min": 15,
                "rain_mm": 1,
            }
            for i in range(1, 8)
        ],
    }


class MerchantRuntime:
    def __init__(self):
        self.calls = []
        self.failure = False
        self.invalid = False
        self.started = self.closed = False

    def start(self):
        self.started = True

    def close(self):
        self.closed = True

    def status(self):
        return {"status": "ready", "message": "test"}

    def predict(self, context):
        self.calls.append(deepcopy(context))
        if self.failure:
            raise ModelUnavailable("실험 모델을 준비하지 못했습니다.")
        result = {
            "model": {
                "name": "실시간 예보 TFT · 디미고 매점 학습",
                "version": "dimigo-test-v1",
                "uses_weather": True,
                "training_data": "dimigo_store",
                "note": "디미고 매점 학습 · 다른 매장 성능 미검증",
            },
            "products": [
                {
                    "product_id": product["id"],
                    "status": "ready",
                    "reason": None,
                    "points": [
                        {"date": day, "p10": 20.0, "p50": 30.0, "p90": 40.0}
                        for day in context["dates"]
                    ],
                }
                for product in context["products"]
            ],
        }
        if self.invalid:
            result["model"]["uses_weather"] = False
        return result


@pytest.fixture
def demo(tmp_path):
    app = create_app(tmp_path / "merchant.sqlite3")
    runtime = MerchantRuntime()
    app.state.merchant_model_runtime = runtime
    app.state.weather_reader = lambda db, store, cutoff: valid_weather(cutoff)
    with TestClient(app) as client:
        auth = {}
        for role in ("owner", "staff"):
            login = client.post(
                "/auth/login",
                json={"email": f"{role}@hwagae.local", "password": "hwagae-demo"},
            )
            auth[role] = {"Authorization": f"Bearer {login.json()['token']}"}
        yield client, auth, runtime, app.state.database
    assert runtime.started and runtime.closed


def new_store(client, auth):
    response = client.post(
        "/stores/test-weather",
        headers=auth,
        json={
            "name": "날씨 테스트",
            "city": "서울",
            "latitude": 37.5,
            "longitude": 127.0,
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_test_store_is_explicit_private_and_preserves_existing_records(demo):
    client, auth, _, database = demo
    with database.connect() as db:
        before = {
            table: [tuple(row) for row in db.execute(f"SELECT * FROM {table}")]
            for table in ("stores", "products", "sales", "inventory")
        }
    created = new_store(client, auth["owner"])
    store_id = created["id"]
    assert created["provider"] == "merchant_tft"
    assert created["latitude"] == 37.5 and "합성" in created["data_note"]
    assert "오늘" in created["data_note"] and "실제 예보" in created["data_note"]
    assert (
        client.get(f"/stores/{store_id}/products", headers=auth["staff"]).status_code
        == 403
    )
    assert (
        client.get(
            f"/stores/{store_id}/forecast-settings", headers=auth["staff"]
        ).status_code
        == 403
    )
    with database.connect() as db:
        assert (
            db.execute(
                "SELECT COUNT(*) FROM products WHERE store_id=?", (store_id,)
            ).fetchone()[0]
            == 5
        )
        sales = db.execute(
            "SELECT COUNT(*),MIN(date),MAX(date),MIN(source) FROM sales WHERE store_id=?",
            (store_id,),
        ).fetchone()
        assert tuple(sales) == (
            280,
            (today() - timedelta(days=55)).isoformat(),
            today().isoformat(),
            "synthetic_live_weather_test",
        )
        assert (
            db.execute(
                "SELECT COUNT(*) FROM inventory WHERE store_id=? AND measured_on=?",
                (store_id, today().isoformat()),
            ).fetchone()[0]
            == 5
        )
        for table in before:
            assert [
                tuple(row)
                for row in db.execute(
                    f"SELECT * FROM {table} WHERE {'id' if table == 'stores' else 'store_id'} !=?",
                    (store_id,),
                )
            ] == before[table]
    again = new_store(client, auth["owner"])
    assert again["id"] != store_id


def test_settings_require_owner_invalidate_forecasts_and_persist(demo):
    client, auth, runtime, database = demo
    url = "/stores/gwangju/forecast-settings"
    assert client.get(url).status_code == 401
    assert (
        client.put(
            url, headers=auth["staff"], json={"provider": "merchant_tft"}
        ).status_code
        == 403
    )
    assert (
        client.put(
            url, headers=auth["owner"], json={"provider": "arbitrary.module:predict"}
        ).status_code
        == 422
    )
    assert (
        client.put(
            url,
            headers=auth["owner"],
            json={"provider": "merchant_tft", "checkpoint": "forged"},
        ).status_code
        == 422
    )
    initial = client.get(url, headers=auth["owner"]).json()
    assert initial["provider"] == "weekday" and initial["runtime"]["status"] == "ready"
    old = client.post("/stores/gwangju/forecasts", headers=auth["owner"]).json()
    assert old["model"]["uses_weather"] is False and runtime.calls == []
    result = client.put(url, headers=auth["owner"], json={"provider": "merchant_tft"})
    assert result.status_code == 200
    assert result.json()["requirements"]["history_days"] == 56
    with database.connect() as db:
        first = db.execute("SELECT MIN(date) FROM sales WHERE store_id='gwangju'").fetchone()[0]
    assert result.json()["history_available_from"] == (date.fromisoformat(first) + timedelta(days=62)).isoformat()
    assert result.json()["runtime"]["status"] == "ready"
    assert client.get(url, headers=auth["owner"]).json()["provider"] == "merchant_tft"
    assert (
        client.post(
            "/stores/gwangju/recommendations",
            headers=auth["owner"],
            json={"forecast_id": old["id"]},
        ).status_code
        == 409
    )
    with database.connect() as db:
        revision = tuple(
            db.execute(
                "SELECT revision,sales_revision FROM stores WHERE id='gwangju'"
            ).fetchone()
        )
    client.put(url, headers=auth["owner"], json={"provider": "merchant_tft"})
    with database.connect() as db:
        assert (
            tuple(
                db.execute(
                    "SELECT revision,sales_revision FROM stores WHERE id='gwangju'"
                ).fetchone()
            )
            == revision
        )


def test_selected_runtime_receives_own_ids_live_snapshot_and_orders_end_to_end(demo):
    client, auth, runtime, database = demo
    store = new_store(client, auth["owner"])
    prefix = f"/stores/{store['id']}"
    response = client.post(
        prefix + "/forecasts",
        headers=auth["owner"],
        json={"store_id": "walmart-demo-4", "weather": "forged"},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert (
        result["model"]["training_data"] == "dimigo_store"
        and result["model"]["uses_weather"] is True
    )
    context = runtime.calls[0]
    assert context["store_id"] == store["id"] and len(context["sales"]) == 280
    assert all(product["id"].startswith("TEST") for product in context["products"])
    assert max(row["date"] for row in context["sales"]) == today().isoformat()
    assert all(row["date"] <= context["as_of"] for row in context["sales"])
    assert context["weather"] == result["weather"]
    assert "actual" not in str(context)
    rec_response = client.post(
        prefix + "/recommendations",
        headers=auth["owner"],
        json={"forecast_id": result["id"]},
    )
    assert rec_response.status_code == 200
    rec = rec_response.json()
    assert rec["calculated_count"] == 5
    row = rec["rows"][0]
    saved = client.post(
        prefix + "/orders",
        headers=auth["owner"],
        json={
            "recommendation_id": rec["id"],
            "lines": [{"product_id": row["product_id"], "quantity": row["quantity"]}],
        },
    )
    assert saved.status_code == 201, saved.text
    order_id = saved.json()["id"]
    assert (
        client.post(
            prefix + f"/orders/{order_id}/confirm", headers=auth["owner"]
        ).status_code
        == 200
    )
    assert (
        client.get(
            prefix + f"/orders/{order_id}/export", headers=auth["owner"]
        ).status_code
        == 200
    )
    with database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM model_demo_runs").fetchone()[0] == 0


@pytest.mark.parametrize(
    "case",
    [
        "stale",
        "partial",
        "historical",
        "old_time",
        "naive_time",
        "bad_date",
        "missing_min",
        "negative_rain",
        "inverted_temp",
        "bad_units",
        "boolean_temp",
        "out_of_range_temp",
    ],
)
def test_bad_weather_blocks_before_inference_and_saves_nothing(demo, case):
    client, auth, runtime, database = demo
    store = new_store(client, auth["owner"])
    weather = valid_weather(today())
    if case == "stale":
        weather["status"] = "stale"
    elif case == "partial":
        weather["status"] = "partial"
    elif case == "historical":
        weather["mode"] = "historical_reanalysis"
    elif case == "old_time":
        weather["fetched_at"] = "2000-01-01T00:00:00Z"
    elif case == "naive_time":
        weather["fetched_at"] = "2026-10-24T00:00:00"
    elif case == "bad_date":
        weather["days"][0]["date"] = today().isoformat()
    elif case == "missing_min":
        weather["days"][0]["temp_min"] = None
    elif case == "negative_rain":
        weather["days"][0]["rain_mm"] = -1
    elif case == "inverted_temp":
        weather["days"][0]["temp_min"] = 99
    elif case == "bad_units":
        weather["units"]["temperature"] = "fahrenheit"
    elif case == "boolean_temp":
        weather["days"][0]["temp_max"] = True
    elif case == "out_of_range_temp":
        weather["days"][0]["temp_max"] = 66
    client.app.state.weather_reader = lambda *args: weather
    response = client.post(f"/stores/{store['id']}/forecasts", headers=auth["owner"])
    assert response.status_code == 503
    assert runtime.calls == []
    with database.connect() as db:
        assert (
            db.execute(
                "SELECT COUNT(*) FROM forecasts WHERE store_id=?", (store["id"],)
            ).fetchone()[0]
            == 0
        )


def test_runtime_failures_and_invalid_identity_never_fall_back(demo):
    client, auth, runtime, database = demo
    store = new_store(client, auth["owner"])
    prefix = f"/stores/{store['id']}"
    runtime.failure = True
    response = client.post(prefix + "/forecasts", headers=auth["owner"])
    assert response.status_code == 503 and "실험 모델" in response.json()["detail"]
    runtime.failure, runtime.invalid = False, True
    assert client.post(prefix + "/forecasts", headers=auth["owner"]).status_code == 503
    with database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0] == 0
    previous = (today() - timedelta(days=14)).isoformat()
    runtime.invalid = False
    past_weather = valid_weather(today() - timedelta(days=14))
    past_weather["mode"] = "historical_reanalysis"
    client.app.state.weather_reader = lambda *args: past_weather
    assert (
        client.post(
            prefix + f"/forecasts?as_of={previous}", headers=auth["owner"]
        ).status_code
        == 200
    )
    client.put(
        prefix + "/forecast-settings",
        headers=auth["owner"],
        json={"provider": "weekday"},
    )
    calls = len(runtime.calls)
    response = client.post(
        prefix + f"/forecasts?as_of={previous}", headers=auth["owner"]
    )
    assert (
        response.status_code == 200
        and response.json()["model"]["uses_weather"] is False
    )
    assert len(runtime.calls) == calls


def test_test_store_creation_auth_and_boundary(demo):
    client, auth, _, _ = demo
    payload = {"name": "test", "city": "서울", "latitude": 37.5, "longitude": 127.0}
    assert client.post("/stores/test-weather", json=payload).status_code == 401
    assert (
        client.post(
            "/stores/test-weather", headers=auth["staff"], json=payload
        ).status_code
        == 403
    )
    assert (
        client.post(
            "/stores/test-weather",
            headers=auth["owner"],
            json={**payload, "latitude": 100},
        ).status_code
        == 422
    )
    assert (
        client.post(
            "/stores/test-weather",
            headers=auth["owner"],
            json={**payload, "provider": "weekday"},
        ).status_code
        == 422
    )


def test_empty_merchant_store_is_rejected_before_worker_or_weather(demo):
    client, auth, runtime, _ = demo
    created = client.post(
        "/stores",
        headers=auth["owner"],
        json={"name": "빈 매장", "city": "서울", "latitude": 37.5, "longitude": 127.0},
    )
    assert created.status_code == 201
    prefix = f"/stores/{created.json()['id']}"
    assert (
        client.put(
            prefix + "/forecast-settings",
            headers=auth["owner"],
            json={"provider": "merchant_tft"},
        ).status_code
        == 200
    )
    weather_calls = []
    client.app.state.weather_reader = lambda *args: (
        weather_calls.append(True) or valid_weather(today())
    )
    response = client.post(prefix + "/forecasts", headers=auth["owner"])
    assert response.status_code == 422
    assert "상품" in response.json()["detail"]
    assert runtime.calls == weather_calls == []
    populated = new_store(client, auth["owner"])
    assert (
        client.post(
            f"/stores/{populated['id']}/forecasts", headers=auth["owner"]
        ).status_code
        == 200
    )
    assert len(runtime.calls) == 1
