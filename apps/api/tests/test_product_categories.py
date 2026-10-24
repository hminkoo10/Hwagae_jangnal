from fastapi.testclient import TestClient

from app.main import create_app


def test_product_category_edit_preserves_price_history_and_rejects_staff(tmp_path):
    with TestClient(create_app(tmp_path / "products.sqlite3")) as client:
        def auth(role):
            token = client.post(
                "/auth/login",
                json={"email": f"{role}@hwagae.local", "password": "hwagae-demo"},
            ).json()["token"]
            return {"Authorization": "Bearer " + token}

        owner, staff = auth("owner"), auth("staff")
        products_url = "/stores/gwangju/products"
        product_url = products_url + "/P002"
        sales_url = "/stores/gwangju/sales"

        def read_product():
            return next(
                p for p in client.get(products_url, headers=owner).json()["products"]
                if p["id"] == "P002"
            )

        product = read_product()
        history = client.get(sales_url, headers=owner).json()
        settings = {
            key: product[key]
            for key in ("price", "cost", "lead_days", "shelf_days", "review_days")
        }
        response = client.patch(
            product_url, headers=owner, json={**settings, "category": "유제품"}
        )
        assert response.status_code == 200, response.text
        updated = read_product()
        assert updated["category"] == "유제품"
        assert updated["cost"] == 950
        assert client.get(sales_url, headers=owner).json() == history

        assert client.patch(
            product_url, headers=staff, json={**settings, "category": "음료"}
        ).status_code == 403
        assert client.patch(product_url, headers=owner, json=settings).status_code == 200
        assert read_product()["category"] == "유제품"
        assert client.patch(
            product_url, headers=owner, json={**settings, "category": " "}
        ).status_code == 422
