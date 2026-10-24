"""Service operators, merchant contracts and single-use account invitations."""
import hashlib
import secrets
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from pydantic import Field, SecretStr, field_validator, model_validator

from app.database import now_iso, password_hash, today
from app.schemas import Payload


def initialize_platform(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS platform_operators (
            user_id TEXT PRIMARY KEY REFERENCES users(id)
        );
        CREATE TABLE IF NOT EXISTS account_controls (
            user_id TEXT PRIMARY KEY REFERENCES users(id), enabled INTEGER NOT NULL CHECK(enabled IN (0,1))
        );
        CREATE TABLE IF NOT EXISTS merchant_contracts (
            id TEXT PRIMARY KEY, user_id TEXT UNIQUE REFERENCES users(id), email TEXT UNIQUE NOT NULL,
            merchant_name TEXT NOT NULL, starts_on TEXT NOT NULL, ends_on TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','suspended')), created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS merchant_invites (
            token_hash TEXT PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES merchant_contracts(id),
            expires_at TEXT NOT NULL, used_at TEXT
        );
        CREATE TABLE IF NOT EXISTS operator_audit (
            id TEXT PRIMARY KEY, actor_id TEXT NOT NULL REFERENCES users(id), action TEXT NOT NULL,
            subject_id TEXT NOT NULL, created_at TEXT NOT NULL
        );
    """)


def is_operator(db, user_id):
    return bool(db.execute("SELECT 1 FROM platform_operators WHERE user_id=?", (user_id,)).fetchone())


def account_available(db, user_id):
    control = db.execute("SELECT enabled FROM account_controls WHERE user_id=?", (user_id,)).fetchone()
    if control and not control[0]:
        return False
    contract = db.execute("SELECT * FROM merchant_contracts WHERE user_id=?", (user_id,)).fetchone()
    return contract is None or (contract["status"] == "active" and contract["starts_on"] <= today().isoformat() <= contract["ends_on"])


def store_available(db, store_id):
    owners = db.execute("SELECT user_id FROM memberships WHERE store_id=? AND role='owner'", (store_id,)).fetchall()
    return any(account_available(db, row[0]) for row in owners)


def can_create_store(db, user_id):
    return account_available(db, user_id) and bool(db.execute("SELECT 1 FROM memberships WHERE user_id=? AND role='owner' UNION SELECT 1 FROM merchant_contracts WHERE user_id=?", (user_id, user_id)).fetchone())


class ContractInput(Payload):
    email: str = Field(min_length=3, max_length=200)
    merchant_name: str = Field(min_length=1, max_length=80)
    starts_on: date
    ends_on: date

    @field_validator("email")
    @classmethod
    def email_valid(cls, value):
        value = value.strip().lower()
        if len(value.split("@")) != 2 or any(c.isspace() for c in value) or not all(value.split("@")) or "." not in value.split("@")[1]:
            raise ValueError("이메일을 확인하세요.")
        return value

    @field_validator("merchant_name")
    @classmethod
    def name_valid(cls, value):
        if not value.strip():
            raise ValueError("점주 이름을 입력하세요.")
        return value.strip()

    @model_validator(mode="after")
    def dates_valid(self):
        if self.ends_on < self.starts_on:
            raise ValueError("계약 종료일을 확인하세요.")
        return self


class ContractUpdate(Payload):
    starts_on: date
    ends_on: date
    status: str = Field(pattern="^(active|suspended)$")
    enabled: bool

    @model_validator(mode="after")
    def dates_valid(self):
        if self.ends_on < self.starts_on:
            raise ValueError("계약 종료일을 확인하세요.")
        return self


class InviteInput(Payload):
    token: SecretStr = Field(min_length=32, max_length=100)


class InviteAccept(InviteInput):
    password: SecretStr = Field(min_length=12, max_length=200)


class SafeRoute(APIRoute):
    def get_route_handler(self):
        original = super().get_route_handler()
        async def handle(request: Request):
            try:
                return await original(request)
            except RequestValidationError:
                raise HTTPException(422, "입력값을 확인하세요. 비밀번호는 12자 이상이어야 해요.") from None
        return handle


def audit(db, actor_id, action, subject):
    db.execute("INSERT INTO operator_audit VALUES (?,?,?,?,?)", (uuid.uuid4().hex, actor_id, action, subject, now_iso()))


def issue_invite(db, contract_id):
    token = secrets.token_urlsafe(32)
    expiry = (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()
    db.execute("DELETE FROM merchant_invites WHERE contract_id=? AND used_at IS NULL", (contract_id,))
    db.execute("INSERT INTO merchant_invites VALUES (?,?,?,NULL)", (hashlib.sha256(token.encode()).hexdigest(), contract_id, expiry))
    return {"token": token, "expires_at": expiry}


def invitation(db, token):
    row = db.execute("SELECT c.*,i.expires_at FROM merchant_invites i JOIN merchant_contracts c ON c.id=i.contract_id WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>?", (hashlib.sha256(token.encode()).hexdigest(), now_iso())).fetchone()
    if not row or row["user_id"] or row["status"] != "active" or row["ends_on"] < today().isoformat():
        raise HTTPException(400, "초대 링크가 만료됐거나 이미 사용됐어요. 운영자에게 새 링크를 요청하세요.")
    return row


def mount_platform_routes(application, database, authenticated):
    router = APIRouter(route_class=SafeRoute, tags=["platform"])

    def operator(user=Depends(authenticated)):
        with database.connect() as db:
            if not is_operator(db, user["id"]):
                raise HTTPException(403, "서비스 운영자만 접근할 수 있어요.")
        return user

    @router.get("/admin/overview")
    def overview(user=Depends(operator)):
        with database.connect() as db:
            def merchant_stores(user_id):
                return [dict(s) for s in db.execute("SELECT s.id,s.name,s.city,(SELECT MAX(date) FROM sales WHERE store_id=s.id) last_sales_date,(SELECT COUNT(*) FROM products WHERE store_id=s.id) product_count FROM stores s JOIN memberships m ON m.store_id=s.id WHERE m.user_id=? AND m.role='owner' ORDER BY s.name", (user_id,))]
            contracts = []
            for row in db.execute("SELECT c.*,COALESCE(a.enabled,1) enabled FROM merchant_contracts c LEFT JOIN account_controls a ON a.user_id=c.user_id ORDER BY c.created_at DESC"):
                item = dict(row)
                item["enabled"] = bool(item["enabled"])
                item["access_status"] = "suspended" if not row["enabled"] or row["status"] == "suspended" else "scheduled" if row["starts_on"] > today().isoformat() else "expired" if row["ends_on"] < today().isoformat() else "invited" if not row["user_id"] else "active"
                item["stores"] = merchant_stores(row["user_id"])
                contracts.append(item)
            legacy = [dict(r) for r in db.execute("SELECT DISTINCT u.id,u.name,u.email FROM users u JOIN memberships m ON m.user_id=u.id AND m.role='owner' LEFT JOIN merchant_contracts c ON c.user_id=u.id WHERE c.id IS NULL AND u.id NOT IN (SELECT user_id FROM platform_operators)")]
            for merchant in legacy:
                merchant["stores"] = merchant_stores(merchant["id"])
            counts = {name: db.execute(f"SELECT COUNT(*) FROM {name}").fetchone()[0] for name in ("stores", "products", "sales", "orders")}
        return {"contracts": contracts, "existing_merchants": legacy, "counts": counts, "today": today().isoformat()}

    @router.post("/admin/contracts", status_code=201)
    def create_contract(payload: ContractInput, user=Depends(operator)):
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            if db.execute("SELECT 1 FROM merchant_contracts WHERE email=?", (payload.email,)).fetchone():
                raise HTTPException(409, "이미 계약이 등록된 이메일이에요.")
            existing = db.execute("SELECT id FROM users WHERE email=?", (payload.email,)).fetchone()
            if existing and is_operator(db, existing[0]):
                raise HTTPException(400, "운영자 계정은 점주 계약에 연결할 수 없어요.")
            contract_id = uuid.uuid4().hex[:12]
            db.execute("INSERT INTO merchant_contracts VALUES (?,?,?,?,?,?,'active',?,?)", (contract_id, existing[0] if existing else None, payload.email, payload.merchant_name, payload.starts_on.isoformat(), payload.ends_on.isoformat(), now_iso(), now_iso()))
            invite = None if existing else issue_invite(db, contract_id)
            audit(db, user["id"], "contract.create", contract_id)
        return {"id": contract_id, "invite": invite, "existing_account": bool(existing)}

    @router.patch("/admin/contracts/{contract_id}")
    def update_contract(contract_id: str, payload: ContractUpdate, user=Depends(operator)):
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM merchant_contracts WHERE id=?", (contract_id,)).fetchone()
            if not row:
                raise HTTPException(404, "계약을 찾을 수 없어요.")
            db.execute("UPDATE merchant_contracts SET starts_on=?,ends_on=?,status=?,updated_at=? WHERE id=?", (payload.starts_on.isoformat(), payload.ends_on.isoformat(), payload.status, now_iso(), contract_id))
            if row["user_id"]:
                db.execute("INSERT INTO account_controls VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET enabled=excluded.enabled", (row["user_id"], int(payload.enabled)))
                if not payload.enabled or payload.status == "suspended":
                    db.execute("DELETE FROM sessions WHERE user_id=?", (row["user_id"],))
            audit(db, user["id"], "contract.update", contract_id)
        return {"ok": True}

    @router.post("/admin/contracts/{contract_id}/invite")
    def resend(contract_id: str, user=Depends(operator)):
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT * FROM merchant_contracts WHERE id=?", (contract_id,)).fetchone()
            if not row:
                raise HTTPException(404, "계약을 찾을 수 없어요.")
            if row["user_id"] or row["status"] != "active" or row["ends_on"] < today().isoformat():
                raise HTTPException(409, "미가입 상태의 유효한 계약만 초대할 수 있어요.")
            invite = issue_invite(db, contract_id)
            audit(db, user["id"], "invite.reissue", contract_id)
        return invite

    @router.post("/auth/invitations/inspect")
    def inspect(payload: InviteInput):
        with database.connect() as db:
            row = invitation(db, payload.token.get_secret_value())
        return {k: row[k] for k in ("email", "merchant_name", "starts_on", "ends_on", "expires_at")}

    @router.post("/auth/invitations/accept", status_code=201)
    def accept(payload: InviteAccept):
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = invitation(db, payload.token.get_secret_value())
            if db.execute("SELECT 1 FROM users WHERE email=?", (row["email"],)).fetchone():
                raise HTTPException(409, "이미 가입한 계정이에요. 운영자에게 계약 연결을 요청하세요.")
            user_id, salt = uuid.uuid4().hex[:12], secrets.token_hex(16)
            db.execute("INSERT INTO users VALUES (?,?,?,?,?)", (user_id, row["email"], row["merchant_name"], salt, password_hash(payload.password.get_secret_value(), salt)))
            db.execute("UPDATE merchant_contracts SET user_id=?,updated_at=? WHERE id=?", (user_id, now_iso(), row["id"]))
            db.execute("UPDATE merchant_invites SET used_at=? WHERE contract_id=? AND used_at IS NULL", (now_iso(), row["id"]))
            audit(db, user_id, "invite.accept", row["id"])
        return {"ok": True, "email": row["email"]}

    application.include_router(router)
