"""Local merchant application: authenticated, store-scoped APIs and durable planning records."""

import csv
import hashlib
import io
import json
import logging
import os
import re
import secrets
import sqlite3
import uuid
from contextlib import asynccontextmanager
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from fastapi import Depends, FastAPI, File, Header, HTTPException, Query, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from openpyxl import Workbook
from openpyxl.styles import Font, PatternFill
from pydantic import BaseModel

from app import forecasting
from app.database import Database, EARLIEST_SALES_DATE, encode, now_iso, password_matches, today, store_today
from app.evaluation_report import evaluation_report
from app.forecasting import run_forecast
from app.imports import MAX_BYTES, parse_file
from app.setup_import import mount_setup_routes
from app.ai_gateway import mount_ai_routes
from app.platform_admin import account_available, can_create_store, is_operator, mount_platform_routes, store_available
from app.staff import mount_staff_routes, store_permissions
from app.locations import mount_location_routes
from app.model_demo import (
    DEFAULT_SAMPLE_ID,
    SampleId,
    describe_sample,
    replay,
    sample_context,
    sample_options,
)
from app.model_runtime import ModelRuntime, ModelUnavailable
from app.model_orders import mount_model_order_routes, save_forecast_run
from app.merchant_test_store import create_test_store
from app.ordering import recommend
from app.schemas import (
    Inventory,
    ForecastSettings,
    Login,
    OrderRequest,
    ProductInput,
    ProductUpdate,
    ProductAvailability,
    RecommendationRequest,
    SalesBatch,
    StoreInput,
)
from app.weather import get_weather, require_live_forecast
from app.walmart_scenarios import (
    WalmartTestInput, binding as walmart_binding, create_walmart_test_store,
    model_context as walmart_model_context,
)

logger = logging.getLogger(__name__)
# Stores forecast with the weather TFT; the weekday baseline remains for comparisons and tests.
DEFAULT_FORECAST_PROVIDER = "merchant_tft"
# The bundled merchant TFT (ml/merchant_tft) is trained on the Dimigo store's POS sales.
MERCHANT_TFT_TRAINING_DATA = "dimigo_store"


class HealthResponse(BaseModel):
    status: str = "ok"
    service: str = "hwagae-jangnal-api"
    version: str = "0.2.0"
    release: str = "local"


def create_app(db_path=None, seed=True):
    database = Database(
        db_path
        or os.getenv(
            "DB_PATH",
            str(Path(__file__).resolve().parents[3] / "data/runtime/hwagae.sqlite3"),
        )
    )
    revision_path = Path(__file__).resolve().parents[3] / "REVISION"
    release_id = (
        revision_path.read_text(encoding="utf-8").strip()
        if revision_path.is_file()
        else "local"
    )

    @asynccontextmanager
    async def lifespan(application):
        if (
            os.getenv("APP_ENV") == "production"
            and seed
            and os.getenv("SEED_DEMO", "true").lower() == "true"
        ):
            if (
                len(os.getenv("DEMO_PASSWORD", "")) < 16
                or os.getenv("DEMO_PASSWORD") == "hwagae-demo"
            ):
                raise RuntimeError(
                    "공개 환경의 초기 체험 계정에는 16자 이상의 별도 비밀번호가 필요합니다."
                )
        database.initialize(
            seed=seed and os.getenv("SEED_DEMO", "true").lower() == "true"
        )
        application.state.model_runtime.start()
        application.state.merchant_model_runtime.start()
        try:
            yield
        finally:
            application.state.model_runtime.close()
            application.state.merchant_model_runtime.close()

    application = FastAPI(
        title="화개장날 API",
        version="0.2.0",
        description="판매 입력·날씨·예측 연결·재고 기반 발주 계획. 기본 예측은 날씨를 사용하지 않는 요일 기준선입니다.",
        lifespan=lifespan,
    )
    application.state.database = database
    application.state.weather_reader = get_weather
    application.state.model_runtime = ModelRuntime()
    application.state.merchant_model_runtime = ModelRuntime(profile="merchant")
    origins = [
        item.strip()
        for item in os.getenv(
            "CORS_ORIGINS", "http://127.0.0.1:3000,http://localhost:3000"
        ).split(",")
        if item.strip()
    ]
    # Bundled Capacitor apps use these fixed local WebView origins. Every API
    # request still requires the same bearer token; cookies stay disabled.
    origins.extend(["capacitor://localhost", "https://localhost"])
    application.add_middleware(
        CORSMiddleware,
        allow_origins=origins,
        allow_credentials=False,
        allow_methods=["GET", "POST", "PUT", "PATCH"],
        allow_headers=["Content-Type", "Authorization"],
    )

    def authenticated(authorization: str | None = Header(default=None)):
        if not authorization or not authorization.startswith("Bearer "):
            raise HTTPException(401, "로그인이 필요합니다.")
        digest = hashlib.sha256(authorization[7:].encode()).hexdigest()
        with database.connect() as db:
            row = db.execute(
                "SELECT u.id,u.email,u.name FROM sessions s JOIN users u ON u.id=s.user_id WHERE token_hash=? AND expires_at>?",
                (digest, now_iso()),
            ).fetchone()
            if row and not account_available(db, row["id"]):
                raise HTTPException(401, "계정 이용이 중지됐거나 계약 기간이 아니에요. 운영자에게 문의하세요.")
            operator = bool(row and is_operator(db, row["id"]))
        if not row:
            raise HTTPException(401, "로그인이 만료되었습니다. 다시 로그인하세요.")
        return {**dict(row), "token_hash": digest, "platform_role": "operator" if operator else "merchant"}

    def access(store_id, user, owner=False, permission=None):
        with database.connect() as db:
            row = db.execute(
                "SELECT s.*,m.role FROM stores s JOIN memberships m ON m.store_id=s.id WHERE s.id=? AND m.user_id=?",
                (store_id, user["id"]),
            ).fetchone()
            if row and not store_available(db, store_id):
                raise HTTPException(403, "이 매장의 계약이 중지됐거나 만료됐어요. 점주에게 문의하세요.")
            allowed = store_permissions(db, store_id, user["id"], row["role"]) if row else None
        if not row or (owner and row["role"] != "owner"):
            raise HTTPException(403, "이 매장 또는 작업에 접근할 권한이 없습니다.")
        if allowed is None:
            raise HTTPException(403, "이 매장에서 사용이 중지된 계정이에요. 점주에게 문의하세요.")
        if permission and permission not in allowed:
            raise HTTPException(403, "점주가 허용하지 않은 작업이에요. 필요하면 점주에게 권한을 요청하세요.")
        return localized_store(dict(row))

    def localized_store(store):
        with database.connect() as db:
            locale = db.execute("SELECT timezone,weather_provider FROM store_locales WHERE store_id=?", (store["id"],)).fetchone()
        result = {**store, **(dict(locale) if locale else {"timezone": "Asia/Seoul", "weather_provider": "auto"})}
        return {**result, "local_today": store_today(result).isoformat()}

    def find_product(store_id, product_id):
        with database.connect() as db:
            row = db.execute(
                "SELECT * FROM products WHERE store_id=? AND id=?",
                (store_id, product_id),
            ).fetchone()
        if not row:
            raise HTTPException(404, "상품을 찾을 수 없습니다.")
        return dict(row)

    def saved_record(table, record_id, store_id):
        assert table in {"forecasts", "recommendations", "orders"}
        with database.connect() as db:
            row = db.execute(
                f"SELECT * FROM {table} WHERE id=? AND store_id=?",
                (record_id, store_id),
            ).fetchone()
        if not row:
            raise HTTPException(404, "저장된 결과를 찾을 수 없습니다.")
        return dict(row), json.loads(row["payload"])

    def forecast_provider(store_id):
        with database.connect() as db:
            row = db.execute(
                "SELECT provider FROM store_forecast_settings WHERE store_id=?",
                (store_id,),
            ).fetchone()
        return row[0] if row else DEFAULT_FORECAST_PROVIDER

    def forecast_settings_response(store):
        provider = forecast_provider(store["id"])
        binding = walmart_binding(database, store["id"])
        if provider == "merchant_tft" and binding:
            runtime = application.state.model_runtime.status()
            model = {"name": "Walmart 예보 TFT · 실험", "version": "provided-forecast-scenario-v1", "uses_weather": True, "training_data": "walmart", "experimental": True, "note": store["provenance"]}
        elif provider == "merchant_tft":
            runtime = application.state.merchant_model_runtime.status()
            model = None
            try:
                manifest = json.loads(
                    (
                        Path(__file__).resolve().parents[3]
                        / "ml/merchant_tft/manifest.json"
                    ).read_text(encoding="utf-8")
                )
                source = manifest["model"]
                if (
                    source["uses_weather"] is True
                    and source["training_data"] == MERCHANT_TFT_TRAINING_DATA
                    and all(
                        isinstance(source[key], str) and source[key]
                        for key in ("name", "version", "note")
                    )
                ):
                    model = {
                        key: source[key]
                        for key in (
                            "name",
                            "version",
                            "uses_weather",
                            "training_data",
                            "note",
                        )
                    }
            except OSError, ValueError, KeyError, TypeError:
                pass
        else:
            runtime = {"status": "ready", "message": "요일 기준선을 사용할 수 있어요."}
            model = {
                "name": "요일 기준선",
                "version": "weekday-empirical-v1",
                "uses_weather": False,
            }
        with database.connect() as db:
            history = db.execute("SELECT MIN(date),MAX(date) FROM sales WHERE store_id=?", (store["id"],)).fetchone()
        return {
            "provider": provider,
            "model_kind": "walmart" if binding else MERCHANT_TFT_TRAINING_DATA,
            # A week of slack past the bare minimum so products first sold a few days late still have full history.
            "history_available_from": (date.fromisoformat(history[0]) + timedelta(days=(55 if provider == "merchant_tft" else 27) + 7)).isoformat() if history[0] else None,
            "history_available_to": history[1],
            "runtime": runtime,
            "model": model,
            "requirements": {
                "history_days": 56 if provider == "merchant_tft" else 28,
                "horizon_days": 7,
                "weather_fields": ["temp_max", "temp_min", "rain_mm"]
                if provider == "merchant_tft"
                else [],
                "live_forecast_required": False,
            },
            "data_note": store["provenance"],
        }

    @application.get("/health", response_model=HealthResponse, tags=["system"])
    def health():
        return HealthResponse(release=release_id)

    @application.post("/auth/login", tags=["accounts"])
    def login(payload: Login):
        with database.connect() as db:
            row = db.execute(
                "SELECT * FROM users WHERE email=?", (payload.email.strip().lower(),)
            ).fetchone()
            if not row or not password_matches(
                payload.password, row["salt"], row["password_hash"]
            ):
                raise HTTPException(401, "이메일 또는 비밀번호를 확인하세요.")
            if not account_available(db, row["id"]):
                raise HTTPException(403, "계정 이용이 중지됐거나 계약 기간이 아니에요. 운영자에게 문의하세요.")
            operator = is_operator(db, row["id"])
            token = secrets.token_urlsafe(32)
            db.execute("DELETE FROM sessions WHERE expires_at<=?", (now_iso(),))
            expiry = (datetime.now(timezone.utc) + timedelta(hours=12)).isoformat()
            db.execute(
                "INSERT INTO sessions VALUES (?,?,?)",
                (hashlib.sha256(token.encode()).hexdigest(), row["id"], expiry),
            )
        return {
            "token": token,
            "expires_at": expiry,
            "user": {"id": row["id"], "name": row["name"], "email": row["email"], "platform_role": "operator" if operator else "merchant"},
        }

    @application.get("/model-demo", tags=["model demo"])
    def model_demo(
        sample_id: SampleId = DEFAULT_SAMPLE_ID, user=Depends(authenticated)
    ):
        try:
            sample = describe_sample(sample_context(sample_id))
            options = sample_options()
        except Exception:
            logger.exception("TFT demo sample could not be read")
            raise HTTPException(
                503, "모델 체험용 자료를 준비하지 못했습니다."
            ) from None
        return {
            "runtime": application.state.model_runtime.status(),
            "sample": sample,
            "sample_id": sample_id,
            "samples": options,
            "total_products": sum(option["product_count"] for option in options),
        }

    @application.get("/model-demo/evaluation", tags=["model demo"])
    def model_demo_evaluation(user=Depends(authenticated)):
        try:
            return evaluation_report()
        except Exception:
            logger.exception("TFT evaluation report could not be read")
            raise HTTPException(503, "모델 평가 자료를 준비하지 못했습니다.") from None

    @application.post("/model-demo/forecast", tags=["model demo"])
    def model_demo_forecast(
        sample_id: SampleId = DEFAULT_SAMPLE_ID, user=Depends(authenticated)
    ):
        try:
            result = replay(application.state.model_runtime, sample_id)
            result["id"] = save_forecast_run(database, user, result)
            return result
        except ModelUnavailable as exc:
            raise HTTPException(503, str(exc)) from None
        except Exception:
            logger.exception("TFT historical replay failed")
            raise HTTPException(
                503,
                "TFT 실행 또는 출력 검사에 실패했습니다. 잠시 후 다시 시도해주세요.",
            ) from None

    mount_model_order_routes(application, database, authenticated)

    @application.get("/auth/me", tags=["accounts"])
    def me(user=Depends(authenticated)):
        return {key: user[key] for key in ("id", "name", "email", "platform_role")}

    @application.post("/auth/logout", tags=["accounts"])
    def logout(user=Depends(authenticated)):
        with database.connect() as db:
            db.execute("DELETE FROM sessions WHERE token_hash=?", (user["token_hash"],))
        return {"ok": True}

    @application.get("/stores", tags=["stores"])
    def stores(user=Depends(authenticated)):
        with database.connect() as db:
            rows = [
                dict(row)
                for row in db.execute(
                    "SELECT s.*,m.role FROM stores s JOIN memberships m ON s.id=m.store_id WHERE m.user_id=? ORDER BY s.id",
                    (user["id"],),
                )
            ]
        with database.connect() as db:
            rows = [row for row in rows if store_available(db, row["id"])]
            # Suspended staff no longer see the store; everyone else gets what they may do there.
            rows = [{**row, "permissions": allowed} for row in rows if (allowed := store_permissions(db, row["id"], user["id"], row["role"])) is not None]
        return {"stores": [localized_store(row) for row in rows], "today": today().isoformat()}

    mount_setup_routes(application, database, access, authenticated)
    mount_ai_routes(application, database, access, authenticated, saved_record)
    mount_platform_routes(application, database, authenticated)
    mount_staff_routes(application, database, access, authenticated)
    mount_location_routes(application, database, authenticated)

    @application.post("/stores", status_code=201, tags=["stores"])
    def create_store(payload: StoreInput, user=Depends(authenticated)):
        with database.connect() as db:
            if not can_create_store(db, user["id"]):
                raise HTTPException(403, "점주만 매장을 추가할 수 있습니다.")
            store_id = uuid.uuid4().hex[:12]
            db.execute(
                "INSERT INTO stores(id,name,city,latitude,longitude,provenance) VALUES (?,?,?,?,?,?)",
                (
                    store_id,
                    payload.name.strip(),
                    payload.city.strip(),
                    payload.latitude,
                    payload.longitude,
                    "사용자 입력 자료 · 실제 수요·재고 여부 미검증",
                ),
            )
            db.execute(
                "INSERT INTO memberships VALUES (?,?,?)",
                (user["id"], store_id, "owner"),
            )
            db.execute("INSERT INTO store_locales VALUES (?,?,?)", (store_id, payload.timezone, "noaa_gfs" if payload.timezone.startswith("America/") else "auto"))
        return {"id": store_id}

    @application.post("/stores/test-weather", status_code=201, tags=["stores"])
    def test_weather_store(payload: StoreInput, user=Depends(authenticated)):
        with database.connect() as db:
            if not db.execute(
                "SELECT 1 FROM memberships WHERE user_id=? AND role='owner' LIMIT 1",
                (user["id"],),
            ).fetchone():
                raise HTTPException(403, "점주만 테스트 매장을 만들 수 있습니다.")
        return create_test_store(database, user["id"], payload)

    @application.post("/stores/test-walmart", status_code=201, tags=["stores"])
    def walmart_test_store(payload: WalmartTestInput, user=Depends(authenticated)):
        with database.connect() as db:
            if not db.execute("SELECT 1 FROM memberships WHERE user_id=? AND role='owner' LIMIT 1", (user["id"],)).fetchone():
                raise HTTPException(403, "점주만 테스트 매장을 만들 수 있습니다.")
        return create_walmart_test_store(database, user["id"], payload)

    @application.get("/stores/{store_id}/forecast-settings", tags=["forecast"])
    def get_forecast_settings(store_id: str, user=Depends(authenticated)):
        return forecast_settings_response(access(store_id, user))

    @application.put("/stores/{store_id}/forecast-settings", tags=["forecast"])
    def update_forecast_settings(
        store_id: str, payload: ForecastSettings, user=Depends(authenticated)
    ):
        store = access(store_id, user, owner=True)
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            current = db.execute(
                "SELECT provider FROM store_forecast_settings WHERE store_id=?",
                (store_id,),
            ).fetchone()
            if (current[0] if current else DEFAULT_FORECAST_PROVIDER) != payload.provider:
                db.execute(
                    "INSERT INTO store_forecast_settings VALUES (?,?,?) ON CONFLICT(store_id) DO UPDATE SET provider=excluded.provider,updated_at=excluded.updated_at",
                    (store_id, payload.provider, now_iso()),
                )
                db.execute(
                    "UPDATE stores SET revision=revision+1,sales_revision=sales_revision+1 WHERE id=?",
                    (store_id,),
                )
        return forecast_settings_response(store)

    @application.get("/stores/{store_id}/products", tags=["products"])
    def products(store_id: str, user=Depends(authenticated)):
        store = access(store_id, user)
        return {
            "products": database.products(store_id, include_inactive=True),
            "inventory": database.stock(store_id),
            "revision": store["revision"],
        }

    @application.post("/stores/{store_id}/products", status_code=201, tags=["products"])
    def create_product(
        store_id: str, payload: ProductInput, user=Depends(authenticated)
    ):
        access(store_id, user, permission="products")
        try:
            with database.connect() as db:
                db.execute("BEGIN IMMEDIATE")
                if (
                    db.execute(
                        "SELECT COUNT(*) FROM products WHERE store_id=?", (store_id,)
                    ).fetchone()[0]
                    >= 50
                ):
                    raise HTTPException(
                        409, "첫 버전은 매장당 50개 상품까지 지원합니다."
                    )
                db.execute(
                    "INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        store_id,
                        payload.id,
                        payload.name.strip(),
                        payload.category.strip(),
                        payload.supplier.strip(),
                        payload.price,
                        payload.cost,
                        payload.lead_days,
                        payload.shelf_days,
                        payload.review_days,
                    ),
                )
                db.execute(
                    "UPDATE stores SET revision=revision+1,sales_revision=sales_revision+1 WHERE id=?",
                    (store_id,),
                )
        except sqlite3.IntegrityError:
            raise HTTPException(409, "이미 등록된 상품코드입니다.") from None
        return {"id": payload.id}

    @application.patch("/stores/{store_id}/products/{product_id}", tags=["products"])
    def update_product(
        store_id: str,
        product_id: str,
        payload: ProductUpdate,
        user=Depends(authenticated),
    ):
        access(store_id, user, permission="products")
        find_product(store_id, product_id)
        with database.connect() as db:
            db.execute(
                "UPDATE products SET price=?,cost=?,lead_days=?,shelf_days=?,review_days=?,category=COALESCE(?,category) WHERE store_id=? AND id=?",
                (
                    payload.price,
                    payload.cost,
                    payload.lead_days,
                    payload.shelf_days,
                    payload.review_days,
                    payload.category,
                    store_id,
                    product_id,
                ),
            )
            db.execute(
                "UPDATE stores SET revision=revision+1,sales_revision=sales_revision+1 WHERE id=?",
                (store_id,),
            )
        return {"ok": True}

    @application.patch("/stores/{store_id}/products/{product_id}/availability", tags=["products"])
    def product_availability(store_id: str, product_id: str, payload: ProductAvailability, user=Depends(authenticated)):
        access(store_id, user, permission="products")
        find_product(store_id, product_id)
        with database.connect() as db:
            db.execute("INSERT INTO product_availability VALUES (?,?,?) ON CONFLICT(store_id,product_id) DO UPDATE SET active=excluded.active",
                       (store_id, product_id, int(payload.active)))
            db.execute("UPDATE stores SET revision=revision+1,sales_revision=sales_revision+1 WHERE id=?", (store_id,))
        return {"ok": True, "active": payload.active}

    @application.get("/stores/{store_id}/sales", tags=["sales"])
    def sales(
        store_id: str,
        limit: int = Query(default=50, ge=1, le=200),
        user=Depends(authenticated),
    ):
        access(store_id, user)
        with database.connect() as db:
            rows = [
                dict(row)
                for row in db.execute(
                    "SELECT s.*,p.name FROM sales s JOIN products p ON s.store_id=p.store_id AND s.product_id=p.id WHERE s.store_id=? ORDER BY s.date DESC,s.product_id LIMIT ?",
                    (store_id, limit),
                )
            ]
            summary = dict(
                db.execute(
                    "SELECT COUNT(*) AS count, MIN(date) AS first_date,MAX(date) AS last_date FROM sales WHERE store_id=?",
                    (store_id,),
                ).fetchone()
            )
        return {"rows": rows, "summary": summary}

    @application.post("/stores/{store_id}/sales/preview", tags=["sales"])
    async def preview(
        store_id: str, file: UploadFile = File(...), user=Depends(authenticated)
    ):
        store = access(store_id, user, permission="sales")
        try:
            content = await file.read(MAX_BYTES + 1)
            rows, errors = parse_file(file.filename or "", content, latest_date=store_today(store))
        except Exception as exc:
            message = (
                str(exc)
                if isinstance(exc, (ValueError, UnicodeError))
                else "파일을 읽을 수 없습니다. 정상적인 CSV/XLSX인지 확인하세요."
            )
            raise HTTPException(400, message) from None
        finally:
            await file.close()
        product_ids = {product["id"] for product in database.products(store_id, include_inactive=True)}
        with database.connect() as db:
            existing = {
                (row["date"], row["product_id"])
                for row in db.execute(
                    "SELECT date,product_id FROM sales WHERE store_id=?", (store_id,)
                )
            }
        for row in rows:
            if row["product_id"] not in product_ids:
                errors.append(
                    {
                        "row": row["row_number"],
                        "message": f"미등록 상품: {row['product_id']}",
                    }
                )
            if (row["date"], row["product_id"]) in existing:
                errors.append(
                    {
                        "row": row["row_number"],
                        "message": "이미 저장된 날짜·상품입니다. 자동 덮어쓰지 않습니다.",
                    }
                )
        return {
            "rows": [
                {key: value for key, value in row.items() if key != "row_number"}
                for row in rows
            ],
            "errors": errors,
            "can_save": bool(rows) and not errors,
        }

    @application.post("/stores/{store_id}/sales", status_code=201, tags=["sales"])
    def save_sales(store_id: str, payload: SalesBatch, user=Depends(authenticated)):
        store = access(store_id, user, permission="sales")
        if any(row.date > store_today(store) for row in payload.rows):
            raise HTTPException(422, "미래 날짜의 판매 기록은 저장할 수 없습니다.")
        if any(row.date < EARLIEST_SALES_DATE for row in payload.rows):
            raise HTTPException(422, "2000년 이전 날짜의 판매 기록은 저장할 수 없습니다.")
        if len({(row.date, row.product_id) for row in payload.rows}) != len(
            payload.rows
        ):
            raise HTTPException(409, "요청 안에 같은 날짜·상품이 중복되었습니다.")
        known = {product["id"] for product in database.products(store_id, include_inactive=True)}
        if any(row.product_id not in known for row in payload.rows):
            raise HTTPException(422, "매장에 등록하지 않은 상품이 있습니다.")
        try:
            with database.connect() as db:
                db.executemany(
                    "INSERT INTO sales VALUES (?,?,?,?,?,?)",
                    [
                        (
                            store_id,
                            row.product_id,
                            row.date.isoformat(),
                            row.units_sold,
                            "user_input",
                            now_iso(),
                        )
                        for row in payload.rows
                    ],
                )
                db.execute(
                    "UPDATE stores SET revision=revision+1,sales_revision=sales_revision+1 WHERE id=?",
                    (store_id,),
                )
        except sqlite3.IntegrityError:
            raise HTTPException(
                409, "이미 저장된 날짜·상품이 있습니다. 전체 요청을 취소했습니다."
            ) from None
        return {"saved": len(payload.rows)}

    @application.put("/stores/{store_id}/inventory/{product_id}", tags=["inventory"])
    def save_inventory(
        store_id: str, product_id: str, payload: Inventory, user=Depends(authenticated)
    ):
        store = access(store_id, user, permission="inventory")
        find_product(store_id, product_id)
        cutoff = store_today(store)
        if any(batch.arrives_on <= cutoff for batch in payload.incoming):
            raise HTTPException(
                422,
                "이미 도착한 상품은 현재 재고로 입력하세요. 입고 예정일은 내일부터 가능합니다.",
            )
        with database.connect() as db:
            db.execute(
                "INSERT INTO inventory VALUES (?,?,?,?,?) ON CONFLICT(store_id,product_id) DO UPDATE SET payload=excluded.payload,measured_on=excluded.measured_on,updated_at=excluded.updated_at",
                (
                    store_id,
                    product_id,
                    payload.model_dump_json(),
                    cutoff.isoformat(),
                    now_iso(),
                ),
            )
            db.execute("UPDATE stores SET revision=revision+1 WHERE id=?", (store_id,))
        return {"ok": True}

    @application.get("/stores/{store_id}/weather", tags=["weather"])
    def weather(store_id: str, as_of: date | None = None, user=Depends(authenticated)):
        store = access(store_id, user)
        cutoff = as_of or store_today(store)
        if cutoff > store_today(store):
            raise HTTPException(422, "기준일은 오늘 또는 과거 날짜여야 합니다.")
        return application.state.weather_reader(database, store, cutoff)

    @application.post("/stores/{store_id}/forecasts", tags=["forecast"])
    def forecasts(
        store_id: str, as_of: date | None = None, user=Depends(authenticated)
    ):
        store = access(store_id, user)
        cutoff = as_of or store_today(store)
        if cutoff > store_today(store):
            raise HTTPException(422, "기준일은 오늘 또는 과거 날짜여야 합니다.")
        provider = forecast_provider(store_id)
        binding = walmart_binding(database, store_id)
        if (
            provider == "merchant_tft"
            and not 1 <= len(database.products(store_id)) <= 50
        ):
            raise HTTPException(
                422,
                "실시간 예보 TFT에는 등록한 상품 1~50개가 필요합니다. 상품을 먼저 추가하세요.",
            )
        weather_data = application.state.weather_reader(database, store, cutoff)
        if provider == "merchant_tft":
            try:
                require_live_forecast(weather_data, cutoff, timezone_name=store["timezone"], historical=cutoff < store_today(store))
            except ValueError as exc:
                raise HTTPException(503, str(exc)) from None
        try:
            if provider == "merchant_tft":

                def predictor(context):
                    if binding:
                        result = application.state.model_runtime.predict(walmart_model_context(context, binding))
                    else:
                        result = application.state.merchant_model_runtime.predict(context)
                    model = result.get("model", {})
                    if (
                        model.get("uses_weather") is not True
                        or model.get("training_data") != ("walmart" if binding else MERCHANT_TFT_TRAINING_DATA)
                        or not isinstance(model.get("note"), str)
                        or not model["note"]
                    ):
                        raise ValueError(
                            "experimental merchant model metadata is missing"
                        )
                    if binding:
                        result["model"] = {**model, "name": "Walmart 예보 TFT · 실험" if cutoff == store_today(store) else "Walmart 과거 날씨 시나리오", "note": model["note"] + " " + store["provenance"] + " " + weather_data.get("note", "")}
                    return result
            else:
                predictor = forecasting.baseline
            return run_forecast(
                database, store, cutoff, weather_data, predictor=predictor
            )
        except (ModelUnavailable, ValueError) as exc:
            # Only our known weather/runtime errors are shown; adapter errors stay generic.
            if isinstance(exc, ModelUnavailable):
                raise HTTPException(503, str(exc)) from None
            logger.exception("Forecast validation failed for store %s", store_id)
            raise HTTPException(
                503,
                "예보 또는 모델 입력·출력 조건을 확인하세요. 최신 날씨와 56일 판매 기록이 필요합니다.",
            ) from None
        except Exception:
            logger.exception("Forecast provider failed for store %s", store_id)
            raise HTTPException(
                503,
                "예측 모델 실행 또는 출력 검사에 실패했습니다. 모델 연결과 입력 조건을 확인하세요.",
            ) from None

    @application.post("/stores/{store_id}/recommendations", tags=["ordering"])
    def recommendations(
        store_id: str, payload: RecommendationRequest, user=Depends(authenticated)
    ):
        store = access(store_id, user)
        _, forecast = saved_record("forecasts", payload.forecast_id, store_id)
        cutoff = store_today(store)
        if forecast["as_of"] != cutoff.isoformat():
            raise HTTPException(
                409,
                "과거 재생은 수요 예측 비교용입니다. 현재 재고로 과거 발주량을 계산하지 않습니다.",
            )
        if forecast["sales_revision"] != store["sales_revision"]:
            raise HTTPException(
                409, "판매 기록 또는 상품 설정이 바뀌었습니다. 예측을 다시 생성하세요."
            )
        order_date = payload.order_date or cutoff
        if not cutoff <= order_date <= cutoff + timedelta(days=6):
            raise HTTPException(422, "발주 예정일은 매장 현지 오늘부터 6일 뒤까지 선택하세요.")
        stock = database.stock(store_id)
        points = {product["product_id"]: product for product in forecast["products"]}
        products = database.products(store_id)
        # Use one catalog snapshot: another user may have added a product since
        # the forecast revision check, leaving no corresponding forecast point.
        if {product["id"] for product in products} != set(points):
            raise HTTPException(
                409, "상품 목록이 바뀌었습니다. 예측을 다시 생성하세요."
            )
        rows = [
            recommend(product, points[product["id"]], stock.get(product["id"]), cutoff, order_date)
            for product in products
        ]
        result = {
            "id": uuid.uuid4().hex,
            "forecast_id": payload.forecast_id,
            "as_of": forecast["as_of"],
            "order_date": order_date.isoformat(),
            "rows": rows,
            "revision": store["revision"],
            "created_at": now_iso(),
            "total": sum(row["amount"] or 0 for row in rows),
            "calculated_count": sum(row["status"] == "ready" for row in rows),
            "assumptions": "1일 단위·만료일 당일까지 판매·먼저 만료되는 재고부터 사용. 회수액·보관비·처리비는 0, 유효 잔여재고는 원가로 이월. 고정 수요 3경로의 균등 비용 비교.",
        }
        with database.connect() as db:
            # Keep calculation outside the write lock, then atomically reject
            # any sales, inventory or product change made while it was running.
            db.execute("BEGIN IMMEDIATE")
            revision = db.execute(
                "SELECT revision FROM stores WHERE id=?", (store_id,)
            ).fetchone()[0]
            if revision != store["revision"]:
                raise HTTPException(
                    409, "계산 기준이 바뀌었습니다. 예측과 발주량을 다시 확인하세요."
                )
            db.execute(
                "INSERT INTO recommendations VALUES (?,?,?,?,?)",
                (
                    result["id"],
                    store_id,
                    store["revision"],
                    encode(result),
                    result["created_at"],
                ),
            )
        return result

    @application.get("/stores/{store_id}/orders", tags=["orders"])
    def orders(store_id: str, user=Depends(authenticated)):
        store = access(store_id, user)
        with database.connect() as db:
            rows = [
                dict(row)
                for row in db.execute(
                    "SELECT o.*,u.name AS author FROM orders o JOIN users u ON u.id=o.author_id WHERE store_id=? ORDER BY created_at DESC LIMIT 100",
                    (store_id,),
                )
            ]
        return {
            "orders": [
                {
                    **{key: value for key, value in row.items() if key != "payload"},
                    **json.loads(row["payload"]),
                    "stale": row["revision"] != store["revision"],
                }
                for row in rows
            ]
        }

    @application.post("/stores/{store_id}/orders", status_code=201, tags=["orders"])
    def save_order(store_id: str, payload: OrderRequest, user=Depends(authenticated)):
        store = access(store_id, user, permission="order_draft")
        record, recommendation = saved_record(
            "recommendations", payload.recommendation_id, store_id
        )
        allowed = {
            row["product_id"]: row
            for row in recommendation["rows"]
            if row["status"] == "ready"
        }
        if len({line.product_id for line in payload.lines}) != len(
            payload.lines
        ) or any(line.product_id not in allowed for line in payload.lines):
            raise HTTPException(422, "계산 가능한 상품만 중복 없이 저장할 수 있습니다.")
        lines = [
            {
                **allowed[line.product_id],
                "recommended_quantity": allowed[line.product_id]["quantity"],
                "quantity": line.quantity,
                "amount": line.quantity * allowed[line.product_id]["cost"],
            }
            for line in payload.lines
        ]
        result = {
            "as_of": recommendation["as_of"],
            "order_date": recommendation.get("order_date", recommendation["as_of"]),
            "forecast_id": recommendation["forecast_id"],
            "lines": lines,
            "total": sum(line["amount"] for line in lines),
            "assumptions": recommendation["assumptions"],
        }
        order_id = uuid.uuid4().hex
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            revision = db.execute(
                "SELECT revision FROM stores WHERE id=?", (store_id,)
            ).fetchone()[0]
            if (
                revision != record["revision"]
                or recommendation["as_of"] != store_today(store).isoformat()
            ):
                raise HTTPException(
                    409, "계산 기준이 바뀌었습니다. 예측과 발주량을 다시 확인하세요."
                )
            db.execute(
                "INSERT INTO orders VALUES (?,?,?,?,?,?,?,?,?)",
                (
                    order_id,
                    store_id,
                    user["id"],
                    payload.recommendation_id,
                    revision,
                    "draft",
                    encode(result),
                    now_iso(),
                    None,
                ),
            )
        return {"id": order_id, "status": "draft", **result}

    @application.post("/stores/{store_id}/orders/{order_id}/confirm", tags=["orders"])
    def confirm_order(store_id: str, order_id: str, user=Depends(authenticated)):
        store = access(store_id, user, permission="order_confirm")
        record, payload = saved_record("orders", order_id, store_id)
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            revision = db.execute(
                "SELECT revision FROM stores WHERE id=?", (store_id,)
            ).fetchone()[0]
            if payload["as_of"] != store_today(store).isoformat():
                raise HTTPException(
                    409, "이전 날짜의 자료로 만든 발주안이에요. 오늘 자료로 다시 계산해 저장해주세요."
                )
            if revision != record["revision"]:
                raise HTTPException(
                    409, "저장 후 판매·재고·상품 정보가 바뀌었어요. 다시 계산해 저장해주세요."
                )
            db.execute(
                "UPDATE orders SET status='confirmed',confirmed_at=? WHERE id=?",
                (now_iso(), order_id),
            )
        return {"ok": True}

    @application.get("/stores/{store_id}/orders/{order_id}/export", tags=["orders"])
    def export_order(
        store_id: str,
        order_id: str,
        format: str = Query(default="csv", pattern="^(csv|xlsx)$"),
        user=Depends(authenticated),
    ):
        store = access(store_id, user, permission="order_confirm")
        record, payload = saved_record("orders", order_id, store_id)
        if record["status"] != "confirmed":
            raise HTTPException(409, "점주가 확정한 발주안만 내보낼 수 있습니다.")

        def safe(value):
            if not isinstance(value, str):
                return value
            # Stored legacy values can contain XML-invalid characters. Clean
            # them before checking for a newly exposed spreadsheet formula.
            value = re.sub(
                r"[^\x09\x0A\x0D\x20-\uD7FF\uE000-\uFFFD\U00010000-\U0010FFFF]",
                "",
                value,
            )
            return (
                "'" + value
                if value.lstrip().startswith(("=", "+", "-", "@"))
                else value
            )

        rows = [
            [
                "매장",
                "기준일",
                "공급사",
                "입고예정일",
                "상품코드",
                "상품명",
                "수량(개)",
                "매입원가(원)",
                "합계(원)",
                "발주예정일",
            ]
        ]
        rows += [
            [
                safe(value)
                for value in [
                    store["name"],
                    payload["as_of"],
                    line["supplier"],
                    line["arrival_date"],
                    line["product_id"],
                    line["name"],
                    line["quantity"],
                    line["cost"],
                    line["amount"],
                    payload.get("order_date", payload["as_of"]),
                ]
            ]
            for line in payload["lines"]
        ]
        if format == "csv":
            text = io.StringIO(newline="")
            csv.writer(text).writerows(rows)
            content, media = (
                text.getvalue().encode("utf-8-sig"),
                "text/csv; charset=utf-8",
            )
        else:
            book = Workbook()
            sheet = book.active
            sheet.title = "발주서"
            for row in rows:
                sheet.append(row)
            for cell in sheet[1]:
                cell.fill, cell.font = (
                    PatternFill("solid", fgColor="167D68"),
                    Font(color="FFFFFF", bold=True),
                )
            sheet.freeze_panes = "A2"
            for column in "ABCDEFGHIJ":
                sheet.column_dimensions[column].width = 22
            stream = io.BytesIO()
            book.save(stream)
            content, media = (
                stream.getvalue(),
                "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            )
        return Response(
            content,
            media_type=media,
            headers={
                "Content-Disposition": f'attachment; filename="hwagae-order-{order_id[:8]}.{format}"'
            },
        )

    return application


app = create_app()
