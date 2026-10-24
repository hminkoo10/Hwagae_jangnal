import pytest
from fastapi.testclient import TestClient

from app.main import create_app


@pytest.mark.parametrize("origin", ["capacitor://localhost", "https://localhost"])
def test_native_origin_preflight_and_authenticated_access(tmp_path, origin):
    with TestClient(create_app(tmp_path / "mobile.sqlite3")) as client:
        result = client.options("/auth/login", headers={
            "Origin": origin, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,authorization",
        })
        assert result.status_code == 200
        assert result.headers["access-control-allow-origin"] == origin
        assert "access-control-allow-credentials" not in result.headers
        assert client.get("/auth/me", headers={"Origin": origin}).status_code == 401
        login = client.post("/auth/login", headers={"Origin": origin}, json={
            "email": "owner@hwagae.local", "password": "hwagae-demo",
        })
        assert login.status_code == 200
        account = client.get("/auth/me", headers={"Origin": origin,
            "Authorization": "Bearer " + login.json()["token"]})
        assert account.status_code == 200
        assert account.headers["access-control-allow-origin"] == origin


def test_unrelated_native_origin_is_not_allowed(tmp_path):
    with TestClient(create_app(tmp_path / "mobile.sqlite3")) as client:
        result = client.options("/auth/login", headers={
            "Origin": "capacitor://untrusted", "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization",
        })
        assert result.status_code == 400
        assert "access-control-allow-origin" not in result.headers
