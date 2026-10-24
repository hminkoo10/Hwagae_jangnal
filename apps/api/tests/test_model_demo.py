"""Historical inference is authenticated, fixed-input and separate from ordering."""

from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app.main import create_app
from app.model_demo import sample_context
from app.model_runtime import ModelUnavailable


class DemoRuntime:
    def __init__(self):
        root = Path(__file__).resolve().parents[3]
        self.result = json.loads((root / "ml/examples/expected-api.json").read_text(encoding="utf-8"))
        self.calls = []
        self.failure = False
        self.started = self.closed = False

    def start(self):
        self.started = True

    def close(self):
        self.closed = True

    def status(self):
        return {"status": "ready", "message": "준비 완료"}

    def predict(self, context):
        self.calls.append(deepcopy(context))
        if self.failure:
            raise ModelUnavailable("모델을 사용할 수 없습니다.")
        return deepcopy(self.result)


@pytest.fixture
def demo(tmp_path):
    application = create_app(tmp_path / "demo.sqlite3")
    runtime = DemoRuntime()
    application.state.model_runtime = runtime
    with TestClient(application) as client:
        login = client.post("/auth/login", json={"email": "staff@hwagae.local", "password": "hwagae-demo"})
        auth = {"Authorization": f"Bearer {login.json()['token']}"}
        yield client, auth, runtime, application.state.database
    assert runtime.started and runtime.closed


def test_demo_is_authenticated_and_does_not_write_merchant_records(demo):
    client, auth, runtime, database = demo
    assert client.get("/model-demo").status_code == 401
    assert client.post("/model-demo/forecast").status_code == 401
    info = client.get("/model-demo", headers=auth).json()
    assert info["runtime"]["status"] == "ready"
    assert info["sample"]["as_of"] == "2014-09-12"
    assert info["sample"]["weather_strategy"] == "persistence"
    assert runtime.calls == []  # Metadata is not an inference request.
    with database.connect() as db:
        before = [db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                  for table in ("stores", "sales", "forecasts", "recommendations", "orders")]
    response = client.post("/model-demo/forecast", headers=auth,
                           json={"context": {"store_id": "busan", "as_of": "2099-01-01"}})
    assert response.status_code == 200, response.text
    result = response.json()
    assert runtime.calls == [sample_context()]  # Clients cannot override the fixed sample.
    assert result["as_of"] == "2014-09-12"
    assert result["model"]["uses_weather"] is True
    assert result["baseline"]["model"]["uses_weather"] is False
    assert [item["product_id"] for item in result["products"]] == ["walmart-9", "walmart-27"]
    assert all(len(item["points"]) == 7 for item in result["products"])
    assert all(point["actual"] is None for item in result["products"] for point in item["points"])
    assert "id" not in result  # It cannot be used as a saved forecast for ordering.
    with database.connect() as db:
        after = [db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                 for table in ("stores", "sales", "forecasts", "recommendations", "orders")]
    assert before == after


def test_model_failure_never_returns_cached_or_baseline_predictions(demo):
    client, auth, runtime, _ = demo
    assert client.post("/model-demo/forecast", headers=auth).status_code == 200
    runtime.failure = True
    response = client.post("/model-demo/forecast", headers=auth)
    assert response.status_code == 503
    assert "products" not in response.json()


@pytest.mark.parametrize("corruption", ["extra_quantile", "too_large", "wrong_dates", "duplicate_product", "empty_ready"])
def test_malformed_model_output_is_rejected(demo, corruption):
    client, auth, runtime, _ = demo
    item = runtime.result["products"][0]
    if corruption == "extra_quantile":
        item["points"][0]["p25"] = 1
    elif corruption == "too_large":
        item["points"][0]["p90"] = 1_000_001
    elif corruption == "wrong_dates":
        item["points"].reverse()
    elif corruption == "duplicate_product":
        runtime.result["products"][1]["product_id"] = item["product_id"]
    else:
        item["points"] = []
    assert client.post("/model-demo/forecast", headers=auth).status_code == 503
