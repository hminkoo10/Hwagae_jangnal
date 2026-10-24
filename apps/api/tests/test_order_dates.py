"""Future order plans use today's stock without inventing future observations."""

import csv
import io
from datetime import date, timedelta

import pytest
from openpyxl import load_workbook

from app.ordering import recommend, simulate
from app.schemas import StoreInput
from test_model_orders import demo, draft, ready


def scenario():
    cutoff = date(2026, 10, 24)
    product = {
        "id": "P1",
        "name": "Example",
        "supplier": "Example supplier",
        "price": 10,
        "cost": 5,
        "lead_days": 1,
        "review_days": 2,
        "shelf_days": 2,
    }
    forecast = {
        "status": "ready",
        "points": [
            {
                "date": (cutoff + timedelta(days=i)).isoformat(),
                "p10": 10,
                "p50": 10,
                "p90": 10,
            }
            for i in range(1, 8)
        ],
    }
    stock = {
        "measured_on": cutoff.isoformat(),
        "incoming_confirmed": True,
        "batches": [{"quantity": 15, "expires_on": "2026-10-25"}],
        "incoming": [
            {
                "quantity": 10,
                "arrives_on": "2026-10-26",
                "expires_on": "2026-10-28",
            }
        ],
    }
    return cutoff, product, forecast, stock


def test_future_order_consumes_and_expires_stock_before_arrival():
    cutoff, product, forecast, stock = scenario()
    order_date = cutoff + timedelta(days=2)
    result = recommend(product, forecast, stock, cutoff, order_date=order_date)
    assert result["status"] == "ready"
    assert result["order_date"] == "2026-10-26"
    assert result["arrival_date"] == "2026-10-27"
    assert result["quantity"] == 20 and result["horizon_days"] == 4
    assert result["current_stock"] == 15
    assert result["scenario_results"] == [
        {"waste_units": 5, "missed_units": 0, "ending_units": 0, "loss": 25}
    ] * 3
    # The original measured stock is never rolled forward or overwritten.
    assert stock["batches"][0]["quantity"] == 15
    assert stock["measured_on"] == cutoff.isoformat()


def test_future_order_cannot_cover_sales_before_its_arrival():
    cutoff, product, _, stock = scenario()
    stock["batches"] = []
    stock["incoming"] = []
    result = simulate(
        20, [10] * 4, product, stock, cutoff, order_date=cutoff + timedelta(days=2)
    )
    assert result == {
        "waste_units": 0,
        "missed_units": 20,
        "ending_units": 0,
        "loss": 100,
    }


def test_order_date_limits_and_default_preserve_seven_day_contract():
    cutoff, product, forecast, stock = scenario()
    assert recommend(product, forecast, stock, cutoff) == recommend(
        product, forecast, stock, cutoff, order_date=cutoff
    )
    result = recommend(
        product, forecast, stock, cutoff, order_date=cutoff + timedelta(days=6)
    )
    assert result["status"] == "blocked" and "7일" in result["reason"]
    product["review_days"] = 1
    edge = recommend(
        product, forecast, stock, cutoff, order_date=cutoff + timedelta(days=6)
    )
    assert edge["status"] == "ready" and edge["arrival_date"] == "2026-10-31"
    with pytest.raises(ValueError, match="발주 예정일"):
        recommend(
            product, forecast, stock, cutoff, order_date=cutoff - timedelta(days=1)
        )


def test_store_timezone_accepts_iana_and_preserves_existing_default():
    payload = {"name": "Example", "city": "New York", "latitude": 40.7, "longitude": -74}
    assert StoreInput.model_validate(payload).timezone == "Asia/Seoul"
    assert (
        StoreInput.model_validate(
            {**payload, "timezone": "America/New_York"}
        ).timezone
        == "America/New_York"
    )
    with pytest.raises(ValueError, match="IANA"):
        StoreInput.model_validate({**payload, "timezone": "Not/A_Timezone"})


def test_personal_future_plan_survives_edit_confirm_reopen_and_exports(demo):
    client, auth, _, _ = demo
    plan, run, _ = ready(client, auth["owner"])
    order_date = (date.fromisoformat(run["as_of"]) + timedelta(days=2)).isoformat()
    response = client.post(
        "/model-demo/recommendations",
        headers=auth["owner"],
        json={
            "forecast_id": run["id"],
            "revision": plan["revision"],
            "order_date": order_date,
        },
    )
    assert response.status_code == 200, response.text
    recommendation = response.json()
    assert recommendation["order_date"] == order_date
    assert recommendation["as_of"] == run["as_of"]
    order = draft(client, auth["owner"], recommendation)
    url = f"/model-demo/orders/{order['id']}"
    assert order["order_date"] == order_date
    response = client.put(
        url,
        headers=auth["owner"],
        json={
            "version": 0,
            "lines": [
                {"product_id": order["lines"][0]["product_id"], "quantity": 23}
            ],
        },
    )
    assert response.status_code == 200 and response.json()["order_date"] == order_date
    response = client.post(
        url + "/confirm", headers=auth["owner"], json={"version": 1}
    )
    assert response.status_code == 200 and response.json()["order_date"] == order_date
    reopened = client.get("/model-demo/orders", headers=auth["owner"]).json()[
        "orders"
    ][0]
    assert reopened["order_date"] == order_date
    csv_export = client.get(url + "/export?format=csv", headers=auth["owner"])
    xlsx_export = client.get(url + "/export?format=xlsx", headers=auth["owner"])
    assert csv_export.status_code == xlsx_export.status_code == 200
    rows = list(csv.reader(io.StringIO(csv_export.content.decode("utf-8-sig"))))
    assert any("발주 예정일" in row and order_date in row for row in rows)
    sheet = load_workbook(io.BytesIO(xlsx_export.content), data_only=True).active
    assert any("발주 예정일" in row and order_date in row for row in sheet.values)


@pytest.mark.parametrize("offset", [-1, 7])
def test_personal_order_outside_prediction_window_is_rejected(demo, offset):
    client, auth, _, database = demo
    plan, run, _ = ready(client, auth["owner"])
    with database.connect() as db:
        before = db.execute(
            "SELECT COUNT(*) FROM model_demo_recommendations"
        ).fetchone()[0]
    response = client.post(
        "/model-demo/recommendations",
        headers=auth["owner"],
        json={
            "forecast_id": run["id"],
            "revision": plan["revision"],
            "order_date": (
                date.fromisoformat(run["as_of"]) + timedelta(days=offset)
            ).isoformat(),
        },
    )
    assert response.status_code == 422
    with database.connect() as db:
        assert (
            db.execute("SELECT COUNT(*) FROM model_demo_recommendations").fetchone()[0]
            == before
        )
