"""Explicit sample replay, isolation and separate-interpreter integration."""

from copy import deepcopy
import json
import math
import os
from pathlib import Path
import sys
from types import ModuleType

import pytest
from fastapi.testclient import TestClient

from app.database import Database
from app.main import create_app
from app import tft_demo


EXAMPLES = Path(__file__).resolve().parents[3] / "ml/examples"
EXPECTED = json.loads((EXAMPLES / "expected-api.json").read_text(encoding="utf-8"))


def login(client, role="owner"):
    result = client.post("/auth/login", json={"email": f"{role}@hwagae.local", "password": "hwagae-demo"})
    assert result.status_code == 200, result.text
    return {"Authorization": f"Bearer {result.json()['token']}"}


@pytest.fixture
def demo(tmp_path, monkeypatch):
    monkeypatch.setenv("TFT_DEMO_ENABLED", "true")
    monkeypatch.delenv("FORECAST_PROVIDER", raising=False)
    calls = {"contexts": [], "warmup": 0, "close": 0}
    fake = ModuleType("ml.bridge")

    def warmup():
        calls["warmup"] += 1
        return {"python": "3.11-test", "device": "cpu"}

    def close():
        calls["close"] += 1

    def predict(context):
        calls["contexts"].append(deepcopy(context))
        expected_by_id = {p["product_id"]: p for p in EXPECTED["products"]}
        products = []
        for product in context["products"]:
            rows = [row for row in context["sales"] if row["product_id"] == product["id"]]
            if product.get("model_item_nbr") and len(rows) == 56:
                products.append(deepcopy(expected_by_id[product["id"]]))
            else:
                products.append({"product_id": product["id"], "status": "insufficient_history", "points": [], "reason": "56 observed days required"})
        return {"model": deepcopy(EXPECTED["model"]), "products": products}

    fake.warmup, fake.close, fake.predict = warmup, close, predict
    monkeypatch.setitem(sys.modules, "ml.bridge", fake)
    application = create_app(tmp_path / "tft-demo.sqlite3")
    # The demo must not fetch Open-Meteo or replace its observations with archive data.
    application.state.weather_reader = lambda *args: pytest.fail("demo fetched external weather")
    with TestClient(application) as client:
        yield client, calls, fake
    assert calls["close"] == 1


def test_demo_is_opt_in_and_model_is_not_started_by_default(tmp_path, monkeypatch):
    monkeypatch.delenv("TFT_DEMO_ENABLED", raising=False)
    monkeypatch.setattr(tft_demo, "bridge", lambda: pytest.fail("disabled demo started model"))
    with TestClient(create_app(tmp_path / "normal.sqlite3")) as client:
        stores = client.get("/stores", headers=login(client)).json()["stores"]
        assert {store["id"] for store in stores} == {"gwangju", "busan"}


def test_demo_store_metadata_auth_and_unavailable_commercial_values(demo):
    client, calls, _ = demo
    assert calls["warmup"] == 1
    assert client.get("/stores").status_code == 401
    owner = login(client)
    stores = client.get("/stores", headers=owner).json()["stores"]
    store = next(row for row in stores if row["id"] == tft_demo.STORE_ID)
    assert store["demo_as_of"] == "2014-09-12"
    assert store["demo_kind"] == "walmart_tft"
    assert store["latitude"] is None and store["longitude"] is None
    assert store["ordering_available"] is False
    products = client.get(f"/stores/{tft_demo.STORE_ID}/products", headers=owner).json()["products"]
    assert len(products) == 2
    assert all(p["price"] is None and p["cost"] is None for p in products)
    assert client.post(f"/stores/{tft_demo.STORE_ID}/forecasts", headers=login(client, "staff")).status_code == 403


def test_demo_forecast_uses_database_history_and_explicit_persistence(demo):
    client, calls, _ = demo
    auth = login(client)
    response = client.post(f"/stores/{tft_demo.STORE_ID}/forecasts", headers=auth)
    assert response.status_code == 200, response.text
    result = response.json()
    assert result["as_of"] == "2014-09-12"
    assert result["weather"]["mode"] == "historical_persistence_demo"
    assert result["weather"]["source"] == "Walmart Stormy Weather 관측자료"
    assert result["model"]["uses_weather"] is True
    assert result["model"]["weather_strategy"] == "persistence"
    assert len(result["products"]) == 2
    assert all(len(p["points"]) == 7 for p in result["products"])
    assert all(set(point) == {"date", "p10", "p50", "p90", "actual"}
               for product in result["products"] for point in product["points"])
    supplied = calls["contexts"][-1]
    fixture = tft_demo._sample()
    assert supplied["model_input"] == fixture["model_input"]
    assert sorted(supplied["sales"], key=lambda row: (row["product_id"], row["date"])) == sorted(fixture["sales"], key=lambda row: (row["product_id"], row["date"]))
    assert all(row["date"] <= supplied["as_of"] for row in supplied["sales"])
    assert client.post(f"/stores/{tft_demo.STORE_ID}/recommendations", headers=auth,
                       json={"forecast_id": result["id"]}).status_code == 409
    with client.app.state.database.connect() as db:
        db.execute("UPDATE sales SET units_sold=1 WHERE store_id=? AND product_id='walmart-9' AND date='2014-09-12'", (tft_demo.STORE_ID,))
        db.execute("INSERT INTO sales VALUES (?,?,?,?,?,?)", (tft_demo.STORE_ID, "walmart-9", "2014-09-13", 9999, "test_future", "2014-09-13T00:00:00Z"))
    second = client.post(f"/stores/{tft_demo.STORE_ID}/forecasts", headers=auth)
    assert second.status_code == 200
    latest = calls["contexts"][-1]["sales"]
    assert next(row["units_sold"] for row in latest if row["product_id"] == "walmart-9" and row["date"] == "2014-09-12") == 1
    assert all(row["date"] <= "2014-09-12" for row in latest)
    product = next(p for p in second.json()["products"] if p["product_id"] == "walmart-9")
    assert product["points"][0]["actual"] == 9999


def test_demo_missing_history_is_not_reseeded(demo):
    client, _, _ = demo
    auth = login(client)
    with client.app.state.database.connect() as db:
        db.execute("DELETE FROM sales WHERE store_id=? AND product_id='walmart-9' AND date='2014-08-01'", (tft_demo.STORE_ID,))
    tft_demo.seed_sample(client.app.state.database)
    result = client.post(f"/stores/{tft_demo.STORE_ID}/forecasts", headers=auth).json()
    statuses = {p["product_id"]: p for p in result["products"]}
    assert statuses["walmart-9"]["status"] == "insufficient_history"
    assert statuses["walmart-9"]["points"] == []
    assert statuses["walmart-27"]["status"] == "ready"


def test_demo_rejects_wrong_cutoff_and_worker_failure(demo):
    client, _, fake = demo
    auth = login(client)
    for suffix in ["forecasts", "weather"]:
        request = client.post if suffix == "forecasts" else client.get
        result = request(f"/stores/{tft_demo.STORE_ID}/{suffix}?as_of=2014-09-11", headers=auth)
        assert result.status_code == 422
    def broken(context):
        raise TimeoutError("worker timeout")
    fake.predict = broken
    assert client.post(f"/stores/{tft_demo.STORE_ID}/forecasts", headers=auth).status_code == 503


def test_regular_store_reanalysis_gate_is_unchanged(demo, monkeypatch):
    client, _, fake = demo
    monkeypatch.setenv("FORECAST_PROVIDER", "ml.bridge:predict")
    fake.predict = lambda context: {"model": EXPECTED["model"], "products": []}
    client.app.state.weather_reader = lambda *args: {"status": "ok", "mode": "historical_reanalysis", "days": []}
    assert client.post("/stores/gwangju/forecasts?as_of=2014-09-12", headers=login(client)).status_code == 503


def test_seed_never_grants_access_to_an_unrelated_account(tmp_path):
    database = Database(tmp_path / "unrelated.sqlite3")
    database.initialize(seed=False)
    with pytest.raises(RuntimeError, match="demo-owner"):
        tft_demo.seed_sample(database)
    with database.connect() as db:
        assert db.execute("SELECT COUNT(*) FROM memberships").fetchone()[0] == 0
        assert db.execute("SELECT COUNT(*) FROM stores").fetchone()[0] == 0


@pytest.mark.skipif(os.getenv("TFT_REAL_INTEGRATION") != "1", reason="requires configured isolated model interpreter and checkpoint")
def test_actual_cpu_worker_matches_sample_through_api(tmp_path, monkeypatch):
    monkeypatch.setenv("TFT_DEMO_ENABLED", "true")
    monkeypatch.delenv("FORECAST_PROVIDER", raising=False)
    application = create_app(tmp_path / "real-tft.sqlite3")
    application.state.weather_reader = lambda *args: pytest.fail("sample fetched external weather")
    with TestClient(application) as client:
        response = client.post(f"/stores/{tft_demo.STORE_ID}/forecasts", headers=login(client))
        assert response.status_code == 200, response.text
        by_id = {p["product_id"]: p for p in response.json()["products"]}
        for expected in EXPECTED["products"]:
            actual = by_id[expected["product_id"]]
            assert actual["status"] == "ready"
            for observed, reference in zip(actual["points"], expected["points"], strict=True):
                assert observed["date"] == reference["date"]
                for key in ["p10", "p50", "p90"]:
                    assert math.isclose(observed[key], reference[key], rel_tol=1e-5, abs_tol=1e-4)
