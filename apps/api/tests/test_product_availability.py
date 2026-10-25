"""Reversible exclusion keeps history but changes future model/order inputs."""
from test_ai_gateway import service, config, save, KEY1


def test_exclusion_preserves_history_and_model_inputs_restore(service):
    app, client, auth = service
    db = app.state.database
    headers = auth["owner"]
    app.state.weather_reader = lambda *args: {"status": "unavailable", "days": []}
    with db.connect() as connection:
        before = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in ("products", "sales", "inventory")}
    original = client.post("/stores/gwangju/forecasts", headers=headers).json()
    archive = "/stores/gwangju/products/P001/availability"
    assert client.patch(archive, headers=headers, json={"active": False}).status_code == 200
    catalog = client.get("/stores/gwangju/products", headers=headers).json()["products"]
    assert next(p for p in catalog if p["id"] == "P001")["active"] is False
    assert "P001" not in {p["id"] for p in db.products("gwangju")}
    preview = client.post("/stores/gwangju/sales/preview", headers=headers,
                          files={"file": ("history.csv", b"date,product_id,units_sold\n2001-01-01,P001,2\n", "text/csv")})
    assert preview.status_code == 200 and preview.json()["can_save"] is True
    contexts = []
    from app import forecasting
    # Use the same baseline through the adapter seam to inspect exact inputs.
    original_baseline = forecasting.baseline
    def capture(context):
        contexts.append(context)
        return original_baseline(context)
    import unittest.mock
    with unittest.mock.patch("app.forecasting.baseline", capture):
        updated = client.post("/stores/gwangju/forecasts", headers=headers)
    assert updated.status_code == 200, updated.text
    assert "P001" not in {p["product_id"] for p in updated.json()["products"]}
    assert all(row["product_id"] != "P001" for row in contexts[0]["sales"])
    stale = client.post("/stores/gwangju/recommendations", headers=headers, json={"forecast_id": original["id"]})
    assert stale.status_code == 409
    current = client.post("/stores/gwangju/recommendations", headers=headers, json={"forecast_id": updated.json()["id"]})
    assert current.status_code == 200
    assert "P001" not in {row["product_id"] for row in current.json()["rows"]}
    assert client.patch(archive, headers=headers, json={"active": True}).status_code == 200
    assert "P001" in {p["id"] for p in db.products("gwangju")}
    with db.connect() as connection:
        after = {table: connection.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] for table in before}
    assert before == after
    db.initialize(seed=False)
    assert "P001" in {p["id"] for p in db.products("gwangju")}


def test_availability_requires_owner_and_strict_boolean(service):
    _, client, auth = service
    path = "/stores/gwangju/products/P001/availability"
    assert client.patch(path, json={"active": False}).status_code == 401
    assert client.patch(path, headers=auth["staff"], json={"active": False}).status_code == 403
    assert client.patch(path, headers=auth["owner"], json={"active": "false"}).status_code == 422
    assert client.patch(path.replace("P001", "absent"), headers=auth["owner"], json={"active": False}).status_code == 404


def test_staff_can_check_required_ai_status_without_reading_settings(service):
    _, client, auth = service
    path = "/stores/gwangju/ai/status"
    assert client.get(path).status_code == 401
    assert client.get(path, headers=auth["staff"]).json() == {"ready": False}
    assert save(client, auth["operator"], [config()]).status_code == 200
    response = client.get(path, headers=auth["staff"])
    assert response.json() == {"ready": True} and KEY1 not in response.text
    # One operator connection serves every store.
    assert client.get("/stores/busan/ai/status", headers=auth["owner"]).json() == {"ready": True}
