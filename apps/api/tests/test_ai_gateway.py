"""Operator permissions, credential boundaries, provider adapters and real failover."""

import json
import os
import socket
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.ai_gateway import GatewayFailure, SecretStore, gateway_url, public_address, request_json
from app.database import encode, now_iso
from app.main import create_app

KEY1 = "fixture-primary-key-not-real"
KEY2 = "fixture-secondary-key-not-real"


@pytest.fixture
def service(tmp_path, monkeypatch):
    monkeypatch.setenv("AI_SECRET_KEY_PATH", str(tmp_path / "ai-master.key"))
    app = create_app(tmp_path / "ai.sqlite3")
    with TestClient(app) as client:
        auth = {}
        for role in ("owner", "staff"):
            response = client.post("/auth/login", json={"email": f"{role}@hwagae.local", "password": "hwagae-demo"})
            auth[role] = {"Authorization": "Bearer " + response.json()["token"]}
        with app.state.database.connect() as db:
            # The service operator manages one AI connection list for every store.
            row = db.execute("SELECT * FROM users WHERE id='demo-owner'").fetchone()
            db.execute("INSERT INTO users VALUES (?,?,?,?,?)", ("operator", "operator@example.com", "운영자", row["salt"], row["password_hash"]))
            db.execute("INSERT INTO platform_operators VALUES (?)", ("operator",))
        response = client.post("/auth/login", json={"email": "operator@example.com", "password": "hwagae-demo"})
        auth["operator"] = {"Authorization": "Bearer " + response.json()["token"]}
        yield app, client, auth


def config(name="기본 AI", key=KEY1, **kwargs):
    return {"name": name, "gateway": "https://gateway.example/v1", "api_key": key,
            "model": "selected-model", "reasoning_effort": "high", "protocol": "chat_completions",
            "enabled": True, **kwargs}


def save(client, auth, connections, revision=0):
    return client.put("/platform/ai/settings", headers=auth, json={"revision": revision, "connections": connections})


def ok(text="연결됐어요"):
    return {"choices": [{"message": {"content": text}, "finish_reason": "stop"}]}


def test_permissions_and_read_only_empty_settings(service):
    app, client, auth = service
    assert client.get("/platform/ai/settings").status_code == 401
    for role in ("staff", "owner"):
        assert client.get("/platform/ai/settings", headers=auth[role]).status_code == 403
        for endpoint in ("models", "test"):
            assert client.post("/platform/ai/" + endpoint, headers=auth[role], json={"gateway": "https://example.com", "api_key": KEY1}).status_code == 403
        assert save(client, auth[role], [config()]).status_code == 403
        assert client.get("/stores/gwangju/ai/settings", headers=auth[role]).status_code in (404, 405)
    assert client.get("/platform/ai/settings", headers=auth["operator"]).json() == {"revision": 0, "connections": []}
    assert client.get("/stores/gwangju/ai/status", headers=auth["staff"]).json() == {"ready": False}
    assert not (app.state.database.path.parent / "ai-master.key").exists()
    assert client.post("/stores/gwangju/ai/explain/unknown", headers=auth["staff"]).status_code == 403


def test_keys_encrypted_and_not_returned_and_edits_keep_old_key(service):
    app, client, auth = service
    result = save(client, auth["operator"], [config(), config("예비 AI", KEY2)])
    assert result.status_code == 200, result.text
    assert KEY1 not in result.text and KEY2 not in result.text and "encrypted_key" not in result.text
    settings = result.json()
    assert all(c["key_set"] for c in settings["connections"])
    with app.state.database.connect() as db:
        payload = db.execute("SELECT payload FROM platform_ai_settings WHERE id=1").fetchone()[0]
    assert KEY1 not in payload and KEY2 not in payload
    cipher = json.loads(payload)[0]["encrypted_key"]
    assert SecretStore(app.state.database).decrypt(cipher) == KEY1
    path = app.state.database.path.parent / "ai-master.key"
    if os.name != "nt":
        assert path.stat().st_mode & 0o777 == 0o600
    rows = [{k: v for k, v in c.items() if k != "key_set"} for c in settings["connections"]]
    rows.reverse(); rows[0]["model"] = "another-model"
    result = save(client, auth["operator"], rows, revision=1)
    assert result.status_code == 200
    assert [c["name"] for c in result.json()["connections"]] == ["예비 AI", "기본 AI"]
    assert save(client, auth["operator"], [], revision=1).status_code == 409
    rows[0]["gateway"] = "https://different.example/v1"
    assert save(client, auth["operator"], rows, revision=2).status_code == 400
    rows[0]["api_key"] = "replacement-key-not-real"
    assert save(client, auth["operator"], rows, revision=2).status_code == 200


def test_models_draft_and_existing_keys_do_not_cross_gateways_or_stores(service):
    app, client, auth = service
    calls = []
    def provider(gateway, key, endpoint, **kwargs):
        calls.append((gateway, key, endpoint))
        return {"data": [{"id": "model-b"}, {"id": "model-a"}, {"id": "model-a"}, {"id": key}]}
    app.state.ai_request = provider
    result = client.post("/platform/ai/models", headers=auth["operator"], json={"gateway": "https://gateway.example/v1/", "api_key": KEY1})
    assert result.json() == {"models": ["model-a", "model-b"]}
    assert client.get("/platform/ai/settings", headers=auth["operator"]).json()["connections"] == []
    connection = save(client, auth["operator"], [config()]).json()["connections"][0]
    payload = {"gateway": connection["gateway"], "connection_id": connection["id"]}
    result = client.post("/platform/ai/models", headers=auth["operator"], json=payload)
    assert result.status_code == 200 and calls[-1][1] == KEY1
    count = len(calls)
    payload["gateway"] = "https://other.example/v1"
    assert client.post("/platform/ai/models", headers=auth["operator"], json=payload).status_code == 400
    assert len(calls) == count


def test_official_claude_root_uses_v1_models_and_native_protocol_without_saving(service):
    app, client, auth = service
    calls = []
    def provider(gateway, key, endpoint, **kwargs):
        calls.append((gateway, endpoint, kwargs.get("protocol")))
        if gateway != "https://api.anthropic.com/v1" or kwargs.get("protocol") != "anthropic":
            raise GatewayFailure("request")
        return {"data": [{"id": "claude-fixture-model"}]}
    app.state.ai_request = provider
    response = client.post("/platform/ai/models", headers=auth["operator"], json={"gateway": "https://api.anthropic.com", "api_key": KEY1})
    assert response.status_code == 200, response.text
    assert response.json() == {"models": ["claude-fixture-model"]}
    assert calls == [("https://api.anthropic.com/v1", "/models", "anthropic")]
    assert client.get("/platform/ai/settings", headers=auth["operator"]).json()["connections"] == []
    assert KEY1 not in response.text


def test_claude_native_message_and_incomplete_fallback(service):
    app, client, auth = service
    response = save(client, auth["operator"], [config(gateway="https://api.anthropic.com", protocol="anthropic", reasoning_effort="medium"), config("예비", KEY2)])
    assert response.status_code == 200, response.text
    assert response.json()["connections"][0]["gateway"] == "https://api.anthropic.com/v1"
    calls = []
    state = {"stop": "end_turn"}
    def provider(gateway, key, endpoint, **kwargs):
        calls.append((endpoint, kwargs))
        if key == KEY2:
            return ok("예비 연결 성공")
        return {"type": "message", "role": "assistant", "stop_reason": state["stop"], "content": [{"type": "thinking", "thinking": "숨은 추론"}, {"type": "text", "text": "Claude 연결 성공"}]}
    app.state.ai_request = provider
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 200, result.text
    assert result.json()["text"] == "Claude 연결 성공"
    endpoint, options = calls[0]
    assert endpoint == "/messages" and options["protocol"] == "anthropic"
    body = options["payload"]
    assert body["system"] and body["messages"][0]["role"] == "user"
    assert body["max_tokens"] == 8192 and body["output_config"] == {"effort": "medium"}
    assert not {"store", "reasoning_effort", "max_completion_tokens"} & body.keys()
    state["stop"] = "max_tokens"
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 200 and result.json()["fallback_used"]
    assert [item["status"] for item in result.json()["attempts"]] == ["invalid_response", "ok"]


def test_official_claude_old_client_is_detected_and_custom_provider_uses_its_saved_protocol(service):
    app, client, auth = service
    saved = save(client, auth["operator"], [config(gateway="https://api.anthropic.com", reasoning_effort="default")])
    assert saved.status_code == 200
    assert saved.json()["connections"][0]["protocol"] == "anthropic"
    provider = Mock(return_value={"type": "message", "role": "assistant", "stop_reason": "end_turn", "content": [{"type": "text", "text": "정상"}]})
    app.state.ai_request = provider
    assert client.post("/platform/ai/test", headers=auth["operator"]).status_code == 200
    assert "output_config" not in provider.call_args.kwargs["payload"]
    assert provider.call_args.args[2] == "/messages"
    saved = save(client, auth["operator"], [config(protocol="anthropic", reasoning_effort="default")], revision=1).json()["connections"][0]
    provider.return_value = {"data": [{"id": "claude-test"}]}
    result = client.post("/platform/ai/models", headers=auth["operator"], json={"gateway": saved["gateway"], "connection_id": saved["id"]})
    assert result.status_code == 200
    assert provider.call_args.kwargs["protocol"] == "anthropic"
    assert "api_key" not in result.text and KEY1 not in result.text


@pytest.mark.parametrize("stop,content", [("max_tokens", [{"type":"text","text":"부분 응답"}]), ("end_turn", [{"type":"thinking","thinking":"숨은 추론"}]), ("end_turn", [{"type":"text","text":KEY1}]), ("tool_use", [{"type":"text","text":"도구 요청"}])])
def test_claude_rejects_incomplete_thinking_only_or_secret_echo(service, stop, content):
    app, client, auth = service
    assert save(client, auth["operator"], [config(protocol="anthropic", reasoning_effort="default")]).status_code == 200
    app.state.ai_request = Mock(return_value={"type": "message", "role": "assistant", "stop_reason": stop, "content": content})
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 503 and KEY1 not in result.text
    assert result.json()["detail"]["attempts"][0]["status"] == "invalid_response"


def test_claude_unsupported_effort_does_not_silently_change_the_requested_value(service):
    app, client, auth = service
    assert save(client, auth["operator"], [config(protocol="anthropic", reasoning_effort="minimal"), config("예비", KEY2)]).status_code == 200
    app.state.ai_request = Mock(return_value=ok())
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 200 and result.json()["fallback_used"]
    assert app.state.ai_request.call_count == 1
    assert app.state.ai_request.call_args.args[1] == KEY2
    assert result.json()["attempts"][0]["status"] == "request"


@pytest.mark.parametrize("kind, wording", [("authentication", "연결 키"), ("request", "서비스 주소"), ("timeout", "응답이 늦어"), ("rate_limit", "한도"), ("provider", "AI 서비스"), ("network", "연결하지 못"), ("invalid_response", "목록"), ("blocked_address", "HTTPS")])
def test_model_lookup_failure_explains_the_safe_cause(service, kind, wording):
    app, client, auth = service
    app.state.ai_request = Mock(side_effect=GatewayFailure(kind))
    result = client.post("/platform/ai/models", headers=auth["operator"], json={"gateway": "https://gateway.example/v1", "api_key": KEY1})
    # Cloudflare replaces origin 502 bodies; expected provider failures must
    # survive the edge so the merchant can see the actual corrective action.
    assert result.status_code == 424
    assert wording in result.json()["detail"]
    assert KEY1 not in result.text


def test_unreadable_model_list_preserves_safe_dependency_error(service):
    app, client, auth = service
    app.state.ai_request = Mock(return_value=None)
    result = client.post("/platform/ai/models", headers=auth["operator"], json={"gateway": "https://gateway.example/v1", "api_key": KEY1})
    assert result.status_code == 424
    assert "목록" in result.json()["detail"]
    assert KEY1 not in result.text


@pytest.mark.parametrize("failure", ["authentication", "rate_limit", "timeout", "network", "provider", "request", "invalid_response", "blocked_address"])
def test_ordered_fallback_skips_disabled_connections(service, failure):
    app, client, auth = service
    save(client, auth["operator"], [config(), config("제외", "disabled-key-not-real", enabled=False), config("예비", KEY2)])
    calls = []
    def provider(gateway, key, endpoint, **kwargs):
        calls.append((key, kwargs))
        if key == KEY1:
            raise GatewayFailure(failure)
        return ok("예비 AI 응답")
    app.state.ai_request = provider
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 200, result.text
    assert result.json()["fallback_used"] is True
    assert [a["status"] for a in result.json()["attempts"]] == [failure, "ok"]
    assert [c[0] for c in calls] == [KEY1, KEY2]
    assert calls[1][1]["payload"]["reasoning_effort"] == "high"
    assert calls[1][1]["payload"]["store"] is False
    assert result.json()["connection"]["name"] == "예비"
    assert KEY1 not in result.text and KEY2 not in result.text


def test_success_stops_chain_and_default_effort_is_omitted(service):
    app, client, auth = service
    save(client, auth["operator"], [config(reasoning_effort="default"), config("예비", KEY2)])
    provider = Mock(return_value=ok())
    app.state.ai_request = provider
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.json()["fallback_used"] is False and provider.call_count == 1
    assert "reasoning_effort" not in provider.call_args.kwargs["payload"]


def test_responses_wire_format_and_incomplete_response_fallback(service):
    app, client, auth = service
    save(client, auth["operator"], [config(protocol="responses"), config("예비", KEY2, protocol="responses", reasoning_effort="max")])
    calls = []
    def provider(gateway, key, endpoint, **kwargs):
        calls.append((endpoint, kwargs["payload"]))
        if key == KEY1:
            return {"status": "incomplete", "output": []}
        return {"status": "completed", "output": [{"type": "message", "content": [{"type": "output_text", "text": "성공"}]}]}
    app.state.ai_request = provider
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 200 and result.json()["fallback_used"]
    assert calls[1][0] == "/responses" and calls[1][1]["reasoning"] == {"effort": "max"}
    assert "reasoning_effort" not in calls[1][1]


def test_no_enabled_models_and_invalid_outputs(service):
    app, client, auth = service
    provider = Mock(return_value=ok(KEY1))
    app.state.ai_request = provider
    assert client.post("/platform/ai/test", headers=auth["operator"]).status_code == 409
    assert provider.call_count == 0
    save(client, auth["operator"], [config()])
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 503 and KEY1 not in result.text
    assert result.json()["detail"]["attempts"][0]["status"] == "invalid_response"


def test_missing_master_key_is_not_silently_regenerated(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    path = app.state.database.path.parent / "ai-master.key"
    path.rename(path.with_suffix(".offline"))
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 503 and not path.exists()
    assert result.json()["detail"]["attempts"][0]["status"] == "credential"


@pytest.mark.parametrize("gateway", ["http://example.com/v1", "https://user:pass@example.com/v1", "https://example.com/v1?secret=1", "https://example.com/v1#secret", "https://example.com/v1\r\nX-Evil: yes", "https://example.com/v1/chat/completions"])
def test_settings_validation_never_echoes_submitted_keys(service, gateway):
    _, client, auth = service
    result = save(client, auth["operator"], [config(gateway=gateway)])
    assert result.status_code == 422 and KEY1 not in result.text


def test_invalid_secret_and_duplicate_ids_preserve_configuration(service):
    _, client, auth = service
    result = save(client, auth["operator"], [config(key="x")])
    assert result.status_code == 400 and "api_key" not in result.text
    row = save(client, auth["operator"], [config()]).json()["connections"][0]
    row.pop("key_set")
    assert save(client, auth["operator"], [row, row], revision=1).status_code == 400
    assert save(client, auth["operator"], [config()] * 9, revision=1).status_code == 422


def test_explanation_uses_saved_facts_and_never_changes_order_quantities(service):
    app, client, auth = service
    save(client, auth["operator"], [config()])
    with app.state.database.connect() as db:
        db.execute("INSERT INTO forecasts VALUES (?,?,?,?,?,?)", ("ai-forecast", "gwangju", "2026-10-24", 0, encode({"weather": {"days": []}}), now_iso()))
        rec = {"forecast_id": "ai-forecast", "order_date": "2026-10-26", "assumptions": "FEFO", "rows": [{"name": "샌드위치", "quantity": 24, "current_stock": 3}]}
        db.execute("INSERT INTO recommendations VALUES (?,?,?,?,?)", ("ai-rec", "gwangju", 0, encode(rec), now_iso()))
    provider = Mock(return_value=ok("추천 수량 24개를 설명해요."))
    app.state.ai_request = provider
    result = client.post("/stores/gwangju/ai/explain/ai-rec", headers=auth["owner"])
    assert result.status_code == 200
    prompt = provider.call_args.kwargs["payload"]["messages"][1]["content"]
    assert "샌드위치" in prompt and '"quantity": 24' in prompt and KEY1 not in prompt
    assert client.post("/stores/busan/ai/explain/ai-rec", headers=auth["owner"]).status_code == 404
    with app.state.database.connect() as db:
        assert json.loads(db.execute("SELECT payload FROM recommendations WHERE id='ai-rec'").fetchone()[0])["rows"][0]["quantity"] == 24
        db.execute("UPDATE stores SET revision=revision+1 WHERE id='gwangju'")
    assert client.post("/stores/gwangju/ai/explain/ai-rec", headers=auth["owner"]).status_code == 409


@pytest.mark.parametrize("address", ["127.0.0.1", "10.1.2.3", "169.254.169.254", "::1", "::ffff:127.0.0.1", "0.0.0.0", "224.0.0.1", "ff02::1"])
def test_private_dns_answers_blocked_before_any_socket_connect(monkeypatch, address):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (address, 443))])
    connect = Mock()
    monkeypatch.setattr(socket, "create_connection", connect)
    with pytest.raises(GatewayFailure, match="blocked_address"):
        request_json("https://gateway.example/v1", KEY1, "/models")
    assert connect.call_count == 0


def test_mixed_public_private_dns_cannot_rebind(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda *a, **k: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in ("1.1.1.1", "127.0.0.1")])
    with pytest.raises(GatewayFailure, match="blocked_address"):
        public_address("gateway.example", 443)


def test_total_chain_deadline_limits_requests(service, monkeypatch):
    app, client, auth = service
    save(client, auth["operator"], [config(), config("예비", KEY2), config("세 번째", "third-key-not-real")])
    clock = {"now": 0}
    monkeypatch.setattr("app.ai_gateway.monotonic", lambda: clock["now"])
    def provider(*args, **kwargs):
        clock["now"] += 40
        raise GatewayFailure("timeout")
    app.state.ai_request = provider
    result = client.post("/platform/ai/test", headers=auth["operator"])
    assert result.status_code == 503
    assert len(result.json()["detail"]["attempts"]) == 2


def test_https_transport_keeps_host_tls_and_handles_connection_close(tmp_path, monkeypatch):
    """Use a local TLS fixture, with DNS safety separately covered above."""
    import ssl
    import threading
    from datetime import datetime, timedelta, timezone
    from http.server import BaseHTTPRequestHandler, HTTPServer
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "gateway.example")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
            .public_key(key.public_key()).serial_number(x509.random_serial_number())
            .not_valid_before(now - timedelta(minutes=1)).not_valid_after(now + timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("gateway.example")]), critical=False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = tmp_path / "fixture-cert.pem", tmp_path / "fixture-key.pem"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    received, versions, response = [], [], {"status": 200, "body": {"data": [{"id": "model-a"}]}}
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"
        def do_GET(self):
            received.append((self.path, self.headers["Host"], self.headers["Authorization"]))
            versions.append(self.headers.get("anthropic-version"))
            raw = json.dumps(response["body"]).encode()
            self.send_response(response["status"])
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.send_header("Connection", "close")
            self.end_headers(); self.wfile.write(raw)
        def log_message(self, *args):
            pass
    server = HTTPServer(("127.0.0.1", 0), Handler)
    server_context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    server_context.load_cert_chain(cert_path, key_path)
    server.socket = server_context.wrap_socket(server.socket, server_side=True)
    thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
    trusted = ssl.create_default_context(cafile=str(cert_path))
    assert trusted.check_hostname and trusted.verify_mode == ssl.CERT_REQUIRED
    # Connection setup time must be subtracted before the TLS handshake.
    clock, tls_timeouts = {"now": 0}, []
    connect, wrap = socket.create_connection, trusted.wrap_socket
    def delayed_connect(*args, **kwargs):
        raw = connect(*args, **kwargs)
        clock["now"] += 3
        return raw
    def timed_wrap(raw, *args, **kwargs):
        tls_timeouts.append(raw.gettimeout())
        return wrap(raw, *args, **kwargs)
    monkeypatch.setattr("app.ai_gateway.monotonic", lambda: clock["now"])
    monkeypatch.setattr(socket, "create_connection", delayed_connect)
    monkeypatch.setattr(trusted, "wrap_socket", timed_wrap)
    monkeypatch.setattr("app.ai_gateway.ssl.create_default_context", lambda: trusted)
    monkeypatch.setattr("app.ai_gateway.public_address", lambda host, port: "127.0.0.1")
    gateway = f"https://gateway.example:{server.server_port}/v1"
    try:
        try:
            reply = request_json(gateway, KEY1, "/models")
        except GatewayFailure as exc:
            pytest.fail(f"Local TLS fixture: {type(exc.__context__).__name__}: {exc.__context__}")
        assert reply["data"][0]["id"] == "model-a"
        assert tls_timeouts[0] == pytest.approx(5)
        assert received[0] == ("/v1/models", f"gateway.example:{server.server_port}", "Bearer " + KEY1)
        response["status"] = 302
        with pytest.raises(GatewayFailure, match="request"):
            request_json(gateway, KEY1, "/models")
        assert len(received) == 2  # no redirect followed
        response["status"] = 200
        request_json(gateway, KEY1, "/models", protocol="anthropic")
        assert received[-1][0] == "/v1/models"
        assert received[-1][2] == "Bearer " + KEY1
        assert versions[-1] == "2026-10-21" and versions[0] is None
        response.update(status=200, body={"oversized": "x" * 1000})
        monkeypatch.setattr("app.ai_gateway.MAX_RESPONSE", 64)
        with pytest.raises(GatewayFailure, match="invalid_response"):
            request_json(gateway, KEY1, "/models")
    finally:
        server.shutdown(); server.server_close(); thread.join(timeout=2)
