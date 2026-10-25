"""Merchant isolation, bounded context, validated proposals and exact order values."""
import json
from datetime import timedelta
from unittest.mock import Mock

import pytest

from app.database import encode, now_iso, today
from test_ai_gateway import KEY1, KEY2, config, ok, save, service


def post(client, auth, path, body=None, store="gwangju"):
    return client.post(f"/stores/{store}/ai/{path}", headers=auth["owner"], json=body)


def counts(app):
    with app.state.database.connect() as db:
        return {table: db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("products", "sales", "inventory", "forecasts", "recommendations", "orders")}


@pytest.mark.parametrize("task", ["briefing", "forecast", "inventory", "sales", "products", "question"])
def test_help_is_scoped_read_only_and_excludes_credentials(service, task):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    before = counts(app)
    provider = Mock(return_value=ok("먼저 재고를 확인해주세요."))
    app.state.ai_request = provider
    result = post(client, auth, "help", {"task": task, "as_of": today().isoformat(), "question": "무엇부터 해?"})
    assert result.status_code == 200, result.text
    payload = provider.call_args.kwargs["payload"]
    context = json.loads(payload["messages"][1]["content"])["data"]
    assert context["as_of"] == today().isoformat()
    assert context["products"] and all("store_id" not in p for p in context["products"])
    assert all(row["period"] in ("recent_14_days", "previous_14_days") for row in context["sales"])
    assert KEY1 not in str(payload) and "encrypted_key" not in str(payload) and "owner@" not in str(payload)
    assert counts(app) == before


@pytest.mark.parametrize("endpoint,body", [
    ("help", {"task": "briefing", "as_of": "2026-01-01"}),
    ("draft-sales", {"text": "우유 3개"}), ("draft-product", {"text": "우유 2000원"}),
    ("order-message/unknown", None),
])
def test_staff_cannot_spend_owner_ai_connections(service, endpoint, body):
    app, client, auth = service
    provider = Mock()
    app.state.ai_request = provider
    assert client.post(f"/stores/gwangju/ai/{endpoint}", json=body).status_code == 401
    assert client.post(f"/stores/gwangju/ai/{endpoint}", headers=auth["staff"], json=body).status_code == 403
    assert provider.call_count == 0


def test_help_checks_reference_and_missing_question_before_calling(service):
    app, client, auth = service
    app.state.ai_request = Mock()
    assert post(client, auth, "help", {"task": "question", "as_of": today().isoformat(), "question": " "}).status_code == 422
    assert post(client, auth, "help", {"task": "briefing", "as_of": (today() + timedelta(days=1)).isoformat()}).status_code == 422
    assert post(client, auth, "draft-product", {"text": "    "}).status_code == 422
    assert app.state.ai_request.call_count == 0


def test_historical_context_excludes_future_stock_and_marks_old_stock(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    cutoff = today() - timedelta(days=2)
    with app.state.database.connect() as db:
        products = [r[0] for r in db.execute("SELECT id FROM products WHERE store_id='gwangju' ORDER BY id")]
        db.execute("DELETE FROM inventory WHERE store_id='gwangju'")
        for product_id, measured, batches in [(products[0], today(), []), (products[1], cutoff - timedelta(days=1), [])]:
            db.execute("INSERT INTO inventory VALUES (?,?,?,?,?)", ("gwangju", product_id, encode({"batches": batches, "incoming": [], "incoming_confirmed": True}), measured.isoformat(), now_iso()))
    provider = Mock(return_value=ok("확인 날짜를 점검해주세요."))
    app.state.ai_request = provider
    assert post(client, auth, "help", {"task": "inventory", "as_of": cutoff.isoformat()}).status_code == 200
    context = json.loads(provider.call_args.kwargs["payload"]["messages"][1]["content"])["data"]
    assert len(context["inventory"]) == 1
    assert context["inventory"][0]["product_id"] == products[1]
    assert context["inventory"][0]["usable_quantity"] == 0
    assert context["inventory"][0]["current_on_reference_date"] is False


def test_forecast_identity_and_new_sales_are_checked_before_spending(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    provider = Mock(return_value=ok("예측을 확인해주세요."))
    app.state.ai_request = provider
    with app.state.database.connect() as db:
        db.execute("INSERT INTO forecasts VALUES (?,?,?,?,?,?)", ("help-f", "gwangju", today().isoformat(), 0, encode({"products": []}), now_iso()))
    body = {"task": "forecast", "as_of": today().isoformat(), "forecast_id": "help-f"}
    assert post(client, auth, "help", body, store="busan").status_code == 404
    assert provider.call_count == 0
    assert post(client, auth, "help", body).status_code == 200
    with app.state.database.connect() as db:
        db.execute("UPDATE stores SET sales_revision=sales_revision+1 WHERE id='gwangju'")
    assert post(client, auth, "help", body).status_code == 409
    assert provider.call_count == 1


def test_changes_while_help_is_generated_discard_the_old_answer(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    def provider(*args, **kwargs):
        with app.state.database.connect() as db:
            db.execute("UPDATE stores SET revision=revision+1 WHERE id='gwangju'")
        return ok("과거 기록에 대한 답변")
    app.state.ai_request = provider
    result = post(client, auth, "help", {"task": "briefing", "as_of": today().isoformat()})
    assert result.status_code == 409 and "과거 기록에 대한 답변" not in result.text


def test_sales_draft_keeps_zero_detects_existing_and_never_saves(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    with app.state.database.connect() as db:
        row = dict(db.execute("SELECT date,product_id FROM sales WHERE store_id='gwangju' LIMIT 1").fetchone())
    before = counts(app)
    draft = {"rows": [{**row, "units_sold": 0}], "unresolved": ["등록하지 않은 상품은 확인해주세요."]}
    app.state.ai_request = Mock(return_value=ok(json.dumps(draft)))
    result = post(client, auth, "draft-sales", {"text": "오늘 우유는 0개 팔렸어"})
    assert result.status_code == 200, result.text
    assert result.json()["draft"]["rows"][0]["units_sold"] == 0
    assert result.json()["draft"]["existing"] == [row]
    assert counts(app) == before


def test_memo_dates_outside_range_become_items_to_check(service):
    app, client, auth = service
    save(client, auth["operator"], [config(), config("예비", KEY2)])
    rows = [{"date": "2999-01-01", "product_id": "P001", "units_sold": 1}, {"date": "1000-01-01", "product_id": "P001", "units_sold": 2},
            {"date": today().isoformat(), "product_id": "P001", "units_sold": 3}]
    app.state.ai_request = Mock(return_value=ok(json.dumps({"rows": rows, "unresolved": []})))
    result = post(client, auth, "draft-sales", {"text": "내일 1개, 1000년 2개, 오늘 3개"})
    assert result.status_code == 200 and not result.json()["fallback_used"], result.text
    draft = result.json()["draft"]
    assert [row["date"] for row in draft["rows"]] == [today().isoformat()]
    assert "기준일 이후" in draft["unresolved"][0] and "2000년 이전" in draft["unresolved"][1]
    assert client.post("/stores/gwangju/sales", headers=auth["owner"], json={"rows": [rows[1]]}).status_code == 422


@pytest.mark.parametrize("invalid", [
    {"date": "2026-01-01", "product_id": "foreign-store-product", "units_sold": 2},
    {"date": "2026-01-01", "product_id": "P001", "units_sold": -1},
    {"date": "2026-01-01", "product_id": "P001", "units_sold": 1.5},
])
def test_invalid_sales_output_falls_back_to_the_next_connection(service, invalid):
    app, client, auth = service
    save(client, auth["operator"], [config(), config("예비", KEY2)])
    good ={"rows": [], "unresolved": ["상품 이름을 확인해주세요."]}
    def provider(gateway, key, endpoint, **kwargs):
        return ok(json.dumps({"rows": [invalid], "unresolved": []} if key == KEY1 else good))
    app.state.ai_request = provider
    result = post(client, auth, "draft-sales", {"text": "메모"})
    assert result.status_code == 200 and result.json()["fallback_used"]
    assert result.json()["attempts"][0]["status"] == "invalid_response"
    assert result.json()["draft"]["rows"] == []


def test_product_draft_does_not_invent_defaults_or_save(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    before = counts(app)
    app.state.ai_request = Mock(return_value=ok('```json\n{"name":"딸기 우유","category":"유제품","price":2000,"cost":null}\n```'))
    result = post(client, auth, "draft-product", {"text": "딸기 우유 판매가 2000원"})
    assert result.status_code == 200
    assert result.json()["draft"] == {"name": "딸기 우유", "category": "유제품", "price": 2000}
    assert counts(app) == before


@pytest.mark.parametrize("draft", [{"price": -1}, {"id": "injected-id", "name": "우유"}, {"shelf_days": 99999}, {"category": "임의 종류"}, {"name": "\n"}, {}])
def test_unusable_product_drafts_do_not_reach_the_form(service, draft):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    app.state.ai_request = Mock(return_value=ok(json.dumps(draft)))
    result = post(client, auth, "draft-product", {"text": "메모"})
    assert result.status_code == 503 and "draft" not in result.json()


def test_supplier_message_uses_saved_edits_and_does_not_send_or_change_orders(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    with app.state.database.connect() as db:
        db.execute("INSERT INTO recommendations VALUES (?,?,?,?,?)", ("msg-rec", "gwangju", 0, "{}", now_iso()))
        lines = [{"name": "우유", "supplier": "화개유업", "quantity": 9, "recommended_quantity": 24}]
        db.execute("INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?)", ("msg-order", "gwangju", "demo-owner", "msg-rec", 0, "draft", encode({"as_of": "2026-01-01", "order_date": "2026-01-02", "lines": lines}), now_iso(), None))
    before = counts(app)
    provider = Mock(return_value=ok('{"greeting":"안녕하세요.","closing":"확인 부탁드립니다."}'))
    app.state.ai_request = provider
    result = post(client, auth, "order-message/msg-order")
    assert result.status_code == 200, result.text
    text = result.json()["text"]
    assert "우유 9개" in text and "24" not in text and "2026-01-02" in text and "초안" in text
    assert "quantity" not in provider.call_args.kwargs["payload"]["messages"][1]["content"]
    assert counts(app) == before and provider.call_count == 1
    assert post(client, auth, "order-message/msg-order", store="busan").status_code == 404
    with app.state.database.connect() as db:
        db.execute("UPDATE stores SET revision=revision+1 WHERE id='gwangju'")
    assert post(client, auth, "order-message/msg-order").status_code == 409
