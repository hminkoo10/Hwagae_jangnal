"""Integration smoke checks for the local web/API boundary."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_application_serves_health_and_documents_it() -> None:
    response = client.get("/health")
    assert response.status_code == 200
    assert response.json()["service"] == "hwagae-jangnal-api"
    schema = client.get("/openapi.json")
    assert schema.status_code == 200
    assert "/health" in schema.json()["paths"]


def test_frontend_can_call_api_across_local_ports() -> None:
    response = client.options(
        "/health",
        headers={
            "Origin": "http://127.0.0.1:3000",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "Content-Type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "http://127.0.0.1:3000"


def test_unknown_origin_is_not_allowed() -> None:
    response = client.options(
        "/health",
        headers={
            "Origin": "https://unrelated.example",
            "Access-Control-Request-Method": "GET",
        },
    )
    assert response.status_code == 400
    assert "access-control-allow-origin" not in response.headers
