"""Local SQLite persistence. Demo sales are synthetic; inventory starts unknown."""

import hashlib
import hmac
import json
import math
import os
import secrets
import sqlite3
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path

KST = timezone(timedelta(hours=9))


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def today():
    return datetime.now(KST).date()


def password_hash(password: str, salt: str) -> str:
    return hashlib.pbkdf2_hmac(
        "sha256", password.encode(), bytes.fromhex(salt), 310_000
    ).hex()


def password_matches(password: str, salt: str, expected: str) -> bool:
    return hmac.compare_digest(password_hash(password, salt), expected)


def encode(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, allow_nan=False)


class Database:
    def __init__(self, path: str | Path):
        self.path = Path(path)

    @contextmanager
    def connect(self):
        connection = sqlite3.connect(self.path, timeout=10)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA foreign_keys=ON")
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def initialize(self, seed: bool = True):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as db:
            db.executescript("""
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS users (
                    id TEXT PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
                    salt TEXT NOT NULL, password_hash TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS sessions (
                    token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    expires_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS stores (
                    id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL,
                    latitude REAL NOT NULL, longitude REAL NOT NULL,
                    revision INTEGER NOT NULL DEFAULT 0, sales_revision INTEGER NOT NULL DEFAULT 0,
                    provenance TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS memberships (
                    user_id TEXT NOT NULL REFERENCES users(id), store_id TEXT NOT NULL REFERENCES stores(id),
                    role TEXT NOT NULL CHECK(role IN ('owner','staff')), PRIMARY KEY(user_id,store_id)
                );
                CREATE TABLE IF NOT EXISTS store_forecast_settings (
                    store_id TEXT PRIMARY KEY REFERENCES stores(id),
                    provider TEXT NOT NULL CHECK(provider IN ('weekday','merchant_tft')),
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS products (
                    store_id TEXT NOT NULL REFERENCES stores(id), id TEXT NOT NULL, name TEXT NOT NULL,
                    category TEXT NOT NULL, supplier TEXT NOT NULL, price INTEGER NOT NULL CHECK(price>=0),
                    cost INTEGER NOT NULL CHECK(cost>=0), lead_days INTEGER NOT NULL CHECK(lead_days>=1),
                    shelf_days INTEGER NOT NULL CHECK(shelf_days>=1), review_days INTEGER NOT NULL DEFAULT 1,
                    PRIMARY KEY(store_id,id)
                );
                CREATE TABLE IF NOT EXISTS sales (
                    store_id TEXT NOT NULL, product_id TEXT NOT NULL, date TEXT NOT NULL,
                    units_sold INTEGER NOT NULL CHECK(units_sold>=0), source TEXT NOT NULL,
                    created_at TEXT NOT NULL, PRIMARY KEY(store_id,product_id,date),
                    FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id)
                );
                CREATE TABLE IF NOT EXISTS inventory (
                    store_id TEXT NOT NULL, product_id TEXT NOT NULL, payload TEXT NOT NULL,
                    measured_on TEXT NOT NULL, updated_at TEXT NOT NULL,
                    PRIMARY KEY(store_id,product_id),
                    FOREIGN KEY(store_id,product_id) REFERENCES products(store_id,id)
                );
                CREATE TABLE IF NOT EXISTS weather_cache (
                    cache_key TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS forecasts (
                    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
                    as_of TEXT NOT NULL, sales_revision INTEGER NOT NULL,
                    payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS recommendations (
                    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
                    revision INTEGER NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS orders (
                    id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id),
                    author_id TEXT NOT NULL REFERENCES users(id), recommendation_id TEXT NOT NULL REFERENCES recommendations(id),
                    revision INTEGER NOT NULL, status TEXT NOT NULL CHECK(status IN ('draft','confirmed')),
                    payload TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT
                );
                CREATE TABLE IF NOT EXISTS model_demo_runs (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    sample_id TEXT NOT NULL, as_of TEXT NOT NULL,
                    payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS model_demo_workspaces (
                    user_id TEXT NOT NULL REFERENCES users(id), sample_id TEXT NOT NULL,
                    revision INTEGER NOT NULL CHECK(revision>=0), payload TEXT NOT NULL,
                    updated_at TEXT NOT NULL, PRIMARY KEY(user_id,sample_id)
                );
                CREATE TABLE IF NOT EXISTS model_demo_recommendations (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    sample_id TEXT NOT NULL, forecast_id TEXT NOT NULL REFERENCES model_demo_runs(id),
                    revision INTEGER NOT NULL, as_of TEXT NOT NULL,
                    payload TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS model_demo_orders (
                    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id),
                    sample_id TEXT NOT NULL,
                    recommendation_id TEXT NOT NULL REFERENCES model_demo_recommendations(id),
                    forecast_id TEXT NOT NULL REFERENCES model_demo_runs(id),
                    revision INTEGER NOT NULL, version INTEGER NOT NULL CHECK(version>=0),
                    status TEXT NOT NULL CHECK(status IN ('draft','confirmed')),
                    payload TEXT NOT NULL, created_at TEXT NOT NULL, confirmed_at TEXT
                );
            """)
            if seed and not db.execute("SELECT 1 FROM users LIMIT 1").fetchone():
                self._seed(db)

    def _seed(self, db):
        password = os.getenv("DEMO_PASSWORD", "hwagae-demo")
        for user_id, email, name in [
            ("demo-owner", "owner@hwagae.local", "화개 사장님"),
            ("demo-staff", "staff@hwagae.local", "화개 직원"),
        ]:
            salt = secrets.token_hex(16)
            db.execute(
                "INSERT INTO users VALUES (?,?,?,?,?)",
                (user_id, email, name, salt, password_hash(password, salt)),
            )
        catalog = [
            ("P001", "햄치즈 샌드위치", "간편식", 4800, 2600, 2, 30),
            ("P002", "참치마요 삼각김밥", "간편식", 1800, 950, 2, 46),
            ("P003", "닭가슴살 샐러드", "간편식", 6500, 3600, 3, 22),
            ("P004", "딸기 요거트", "유제품", 2400, 1300, 7, 25),
            ("P005", "바나나 우유", "유제품", 1800, 1000, 7, 41),
            ("P006", "아이스 아메리카노", "음료", 2200, 1100, 14, 37),
            ("P007", "착즙 오렌지 주스", "음료", 3900, 2200, 5, 18),
            ("P008", "소금빵", "베이커리", 2800, 1500, 2, 32),
            ("P009", "초코 쿠키", "베이커리", 2300, 1200, 14, 24),
            ("P010", "계절 과일 컵", "신선식품", 4500, 2700, 2, 21),
        ]
        stamp = now_iso()
        for index, store in enumerate(
            [
                ("gwangju", "화개장날 동명점", "광주 동명동", 35.1477, 126.9256),
                ("busan", "화개장날 전포점", "부산 전포동", 35.1578, 129.0631),
            ]
        ):
            store_id = store[0]
            db.execute(
                "INSERT INTO stores(id,name,city,latitude,longitude,provenance) VALUES (?,?,?,?,?,?)",
                (*store, "가상 샘플 · 판매·상품·가격은 시연용 생성 자료"),
            )
            db.execute(
                "INSERT INTO memberships VALUES (?,?,?)",
                ("demo-owner", store_id, "owner"),
            )
            if index == 0:
                db.execute(
                    "INSERT INTO memberships VALUES (?,?,?)",
                    ("demo-staff", store_id, "staff"),
                )
            for product_id, name, category, price, cost, shelf, base in catalog:
                supplier = (
                    "화개푸드"
                    if category in ("간편식", "베이커리", "신선식품")
                    else "전경유통"
                )
                db.execute(
                    "INSERT INTO products VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (
                        store_id,
                        product_id,
                        name,
                        category,
                        supplier,
                        price,
                        cost,
                        1 if supplier == "화개푸드" else 2,
                        shelf,
                        1,
                    ),
                )
                for offset in range(84, 0, -1):
                    day = today() - timedelta(days=offset)
                    wave = math.sin(
                        day.toordinal() * 0.37 + int(product_id[1:]) + index
                    )
                    units = max(
                        0,
                        round(
                            base
                            * (1.15 if day.weekday() >= 5 else 0.95)
                            * (1 + 0.12 * index)
                            + wave * 5
                        ),
                    )
                    db.execute(
                        "INSERT INTO sales VALUES (?,?,?,?,?,?)",
                        (
                            store_id,
                            product_id,
                            day.isoformat(),
                            units,
                            "synthetic_demo",
                            stamp,
                        ),
                    )

    def products(self, store_id: str):
        with self.connect() as db:
            return [
                dict(row)
                for row in db.execute(
                    "SELECT * FROM products WHERE store_id=? ORDER BY id", (store_id,)
                )
            ]

    def stock(self, store_id: str):
        with self.connect() as db:
            return {
                row["product_id"]: {
                    **json.loads(row["payload"]),
                    "measured_on": row["measured_on"],
                    "updated_at": row["updated_at"],
                }
                for row in db.execute(
                    "SELECT * FROM inventory WHERE store_id=?", (store_id,)
                )
            }
