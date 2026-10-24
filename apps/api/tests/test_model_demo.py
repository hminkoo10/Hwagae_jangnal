"""Historical inference is authenticated, fixed-input and separate from ordering."""

from copy import deepcopy
import json
from pathlib import Path

from fastapi.testclient import TestClient
import pytest

from app import model_demo
from app.main import create_app
from app.model_demo import DEFAULT_SAMPLE_ID, sample_context
from app.model_runtime import ModelUnavailable


class DemoRuntime:
    def __init__(self):
        root = Path(__file__).resolve().parents[3]
        self.results = {
            f"walmart-demo-{store}": json.loads(
                (root / f"ml/examples/expected-api-store-{store}.json").read_text(
                    encoding="utf-8"
                )
            )
            for store in (4, 24, 17)
        }
        self.result = self.results[DEFAULT_SAMPLE_ID]
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
        return deepcopy(self.results[context["store_id"]])


@pytest.fixture
def demo(tmp_path):
    application = create_app(tmp_path / "demo.sqlite3")
    runtime = DemoRuntime()
    application.state.model_runtime = runtime
    with TestClient(application) as client:
        login = client.post(
            "/auth/login",
            json={"email": "staff@hwagae.local", "password": "hwagae-demo"},
        )
        auth = {"Authorization": f"Bearer {login.json()['token']}"}
        yield client, auth, runtime, application.state.database
    assert runtime.started and runtime.closed


def test_demo_is_authenticated_and_does_not_write_merchant_records(demo):
    client, auth, runtime, database = demo
    assert client.get("/model-demo").status_code == 401
    assert client.post("/model-demo/forecast").status_code == 401
    assert client.get("/model-demo/evaluation").status_code == 401
    info = client.get("/model-demo", headers=auth).json()
    assert info["runtime"]["status"] == "ready"
    assert info["sample"]["as_of"] == "2014-09-12"
    assert info["sample"]["weather_strategy"] == "persistence"
    assert info["sample_id"] == DEFAULT_SAMPLE_ID
    assert info["total_products"] == 10
    assert [option["product_count"] for option in info["samples"]] == [6, 3, 1]
    assert runtime.calls == []  # Metadata is not an inference request.
    with database.connect() as db:
        before = [
            db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "stores",
                "products",
                "sales",
                "inventory",
                "forecasts",
                "recommendations",
                "orders",
            )
        ]
    response = client.post(
        "/model-demo/forecast",
        headers=auth,
        json={"context": {"store_id": "busan", "as_of": "2099-01-01"}},
    )
    assert response.status_code == 200, response.text
    result = response.json()
    assert runtime.calls == [
        sample_context()
    ]  # Clients cannot override the fixed sample.
    assert result["as_of"] == "2014-09-12"
    assert result["model"]["uses_weather"] is True
    assert result["baseline"]["model"]["uses_weather"] is False
    assert result["sample_id"] == DEFAULT_SAMPLE_ID
    assert [item["product_id"] for item in result["products"]] == [
        product["id"] for product in sample_context()["products"]
    ]
    assert all(len(item["points"]) == 7 for item in result["products"])
    assert all(
        type(point["actual"]) is int
        for item in result["products"]
        for point in item["points"]
    )
    assert "id" not in result  # It cannot be used as a saved forecast for ordering.
    with database.connect() as db:
        after = [
            db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            for table in (
                "stores",
                "products",
                "sales",
                "inventory",
                "forecasts",
                "recommendations",
                "orders",
            )
        ]
    assert before == after


def test_model_failure_never_returns_cached_or_baseline_predictions(demo):
    client, auth, runtime, _ = demo
    assert client.post("/model-demo/forecast", headers=auth).status_code == 200
    runtime.failure = True
    response = client.post("/model-demo/forecast", headers=auth)
    assert response.status_code == 503
    assert "products" not in response.json()


@pytest.mark.parametrize(
    "corruption",
    ["extra_quantile", "too_large", "wrong_dates", "duplicate_product", "empty_ready"],
)
def test_malformed_model_output_is_rejected(demo, corruption, monkeypatch):
    client, auth, runtime, _ = demo
    actual_reads = []
    monkeypatch.setattr(
        model_demo, "_actuals_by_key", lambda context: actual_reads.append(context)
    )
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
    assert actual_reads == []  # Invalid model output never reaches the outcomes.


@pytest.mark.parametrize(
    "sample_id,count",
    [("walmart-demo-4", 6), ("walmart-demo-24", 3), ("walmart-demo-17", 1)],
)
def test_all_samples_match_actuals_without_leaking_outcomes_into_model_input(
    demo, sample_id, count
):
    client, auth, runtime, _ = demo
    info = client.get("/model-demo", headers=auth, params={"sample_id": sample_id})
    assert info.status_code == 200
    assert info.json()["sample_id"] == sample_id
    assert info.json()["sample"]["product_count"] == count
    assert len(info.json()["samples"]) == 3
    source = json.loads(model_demo.ACTUALS_PATH.read_text(encoding="utf-8"))
    expected = {
        (row["product_id"], row["date"]): row["units_sold"]
        for row in source["stores"][sample_id]
    }
    response = client.post(
        "/model-demo/forecast",
        headers=auth,
        params={"sample_id": sample_id},
        json={
            "sample_id": "busan",
            "actuals": [{"units_sold": 999999}],
            "context": {"sales": []},
        },
    )
    assert response.status_code == 200, response.text
    result = response.json()
    context = sample_context(sample_id)
    assert runtime.calls == [context]
    assert "actuals" not in runtime.calls[0]
    assert all(row["date"] <= context["as_of"] for row in runtime.calls[0]["sales"])
    assert all("actual" not in row for row in runtime.calls[0]["sales"])
    for output in (result, result["baseline"]):
        assert len(output["products"]) == count
        actuals = {
            (product["product_id"], point["date"]): point["actual"]
            for product in output["products"]
            for point in product["points"]
        }
        assert actuals == expected
    assert result["sample_id"] == sample_id


@pytest.mark.parametrize(
    "method,path", [("GET", "/model-demo"), ("POST", "/model-demo/forecast")]
)
@pytest.mark.parametrize(
    "sample_id", ["busan", "../../ml/examples/input.json", "walmart-demo-999"]
)
def test_unknown_sample_queries_are_rejected(demo, method, path, sample_id):
    client, auth, runtime, _ = demo
    result = client.request(method, path, headers=auth, params={"sample_id": sample_id})
    assert result.status_code == 422
    assert runtime.calls == []


@pytest.mark.parametrize(
    "corruption",
    [
        "duplicate",
        "missing",
        "unknown_product",
        "wrong_date",
        "negative",
        "fraction",
        "boolean",
    ],
)
def test_invalid_actuals_are_rejected_without_partial_comparison(
    demo, tmp_path, monkeypatch, corruption
):
    client, auth, runtime, _ = demo
    source = json.loads(model_demo.ACTUALS_PATH.read_text(encoding="utf-8"))
    rows = source["stores"][DEFAULT_SAMPLE_ID]
    if corruption == "duplicate":
        rows.append(deepcopy(rows[0]))
    elif corruption == "missing":
        rows.pop()
    elif corruption == "unknown_product":
        rows[0]["product_id"] = "unknown"
    elif corruption == "wrong_date":
        rows[0]["date"] = "2099-01-01"
    else:
        rows[0]["units_sold"] = {"negative": -1, "fraction": 1.5, "boolean": True}[
            corruption
        ]
    path = tmp_path / "actuals.json"
    path.write_text(json.dumps(source), encoding="utf-8")
    monkeypatch.setattr(model_demo, "ACTUALS_PATH", path)
    response = client.post("/model-demo/forecast", headers=auth)
    assert response.status_code == 503
    assert "products" not in response.json()
    assert str(path) not in response.text
    assert runtime.calls == [sample_context()]


def test_actual_zero_is_preserved_and_read_only_after_prediction(
    demo, tmp_path, monkeypatch
):
    client, auth, runtime, _ = demo
    source = json.loads(model_demo.ACTUALS_PATH.read_text(encoding="utf-8"))
    first = source["stores"][DEFAULT_SAMPLE_ID][0]
    first["units_sold"] = 0
    path = tmp_path / "actuals.json"
    path.write_text(json.dumps(source), encoding="utf-8")
    monkeypatch.setattr(model_demo, "ACTUALS_PATH", path)
    read_actuals = model_demo._actuals_by_key

    def after_prediction(context):
        assert runtime.calls == [sample_context()]
        return read_actuals(context)

    monkeypatch.setattr(model_demo, "_actuals_by_key", after_prediction)
    response = client.post("/model-demo/forecast", headers=auth)
    assert response.status_code == 200, response.text
    result = response.json()
    for output in (result, result["baseline"]):
        product = next(
            product
            for product in output["products"]
            if product["product_id"] == first["product_id"]
        )
        point = next(
            point for point in product["points"] if point["date"] == first["date"]
        )
        assert point["actual"] == 0
        assert type(point["actual"]) is int


def test_evaluation_route_authentication_and_sanitized_failure(demo, monkeypatch):
    client, auth, runtime, _ = demo
    report = {"status": "test fixture"}
    monkeypatch.setattr("app.main.evaluation_report", lambda: report)
    assert client.get("/model-demo/evaluation").status_code == 401
    response = client.get("/model-demo/evaluation", headers=auth)
    assert response.status_code == 200
    assert response.json() == report

    def broken_report():
        raise ValueError("internal-report-path-and-error")

    monkeypatch.setattr("app.main.evaluation_report", broken_report)
    failed = client.get("/model-demo/evaluation", headers=auth)
    assert failed.status_code == 503
    assert "internal-report-path-and-error" not in failed.text
    assert runtime.calls == []
