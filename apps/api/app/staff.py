"""Store staff managed by the owner: single-use invitations, per-store permissions and suspension."""
import hashlib
import json
import secrets
import uuid
from datetime import datetime, timedelta, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field, field_validator

from app.database import now_iso, password_hash
from app.platform_admin import InviteAccept, InviteInput, SafeRoute, audit, is_operator, normalized_email
from app.schemas import Payload

# Store settings, initial upload, forecast settings and staff management stay owner-only.
PERMISSIONS = {
    "sales": ("판매 기록 입력", True),
    "inventory": ("재고 확인 입력", True),
    "order_draft": ("발주 계획 저장", True),
    "order_confirm": ("발주 확정·내보내기", False),
    "products": ("상품 관리(추가·수정·제외)", False),
}
Permission = Literal["sales", "inventory", "order_draft", "order_confirm", "products"]
DEFAULT_PERMISSIONS = [key for key, (_, enabled) in PERMISSIONS.items() if enabled]


def initialize_staff(db):
    db.executescript("""
        CREATE TABLE IF NOT EXISTS staff_access (
            user_id TEXT NOT NULL, store_id TEXT NOT NULL, permissions TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('active','suspended')), joined_at TEXT,
            PRIMARY KEY(user_id,store_id),
            FOREIGN KEY(user_id,store_id) REFERENCES memberships(user_id,store_id) ON DELETE CASCADE
        );
        CREATE TABLE IF NOT EXISTS staff_invites (
            id TEXT PRIMARY KEY, store_id TEXT NOT NULL REFERENCES stores(id), email TEXT NOT NULL,
            name TEXT NOT NULL, permissions TEXT NOT NULL, token_hash TEXT UNIQUE NOT NULL,
            expires_at TEXT NOT NULL, invited_by TEXT NOT NULL REFERENCES users(id),
            created_at TEXT NOT NULL, used_at TEXT
        );
        CREATE UNIQUE INDEX IF NOT EXISTS staff_invites_pending ON staff_invites(store_id,email) WHERE used_at IS NULL;
    """)
    # Staff added before permissions existed keep exactly what they could already do.
    db.execute("INSERT OR IGNORE INTO staff_access SELECT user_id,store_id,?,'active',NULL FROM memberships WHERE role='staff'", (json.dumps(DEFAULT_PERMISSIONS),))


def granted(text):
    try:
        values = json.loads(text)
    except (TypeError, ValueError):
        return []
    return [key for key in PERMISSIONS if isinstance(values, list) and key in values]


def staff_state(db, store_id, user_id):
    row = db.execute("SELECT permissions,status FROM staff_access WHERE store_id=? AND user_id=?", (store_id, user_id)).fetchone()
    return {"status": row["status"], "permissions": granted(row["permissions"])} if row else {"status": "active", "permissions": list(DEFAULT_PERMISSIONS)}


def store_permissions(db, store_id, user_id, role):
    """What a member may do in the store, or None for suspended staff."""
    if role == "owner":
        return list(PERMISSIONS)
    state = staff_state(db, store_id, user_id)
    return state["permissions"] if state["status"] == "active" else None


def drop_idle_sessions(db, user_id):
    # Sign the account out only when no other store or contract still needs the session.
    if not db.execute("SELECT 1 FROM memberships m LEFT JOIN staff_access a ON a.user_id=m.user_id AND a.store_id=m.store_id WHERE m.user_id=? AND COALESCE(a.status,'active')='active' UNION SELECT 1 FROM merchant_contracts WHERE user_id=?", (user_id, user_id)).fetchone():
        db.execute("DELETE FROM sessions WHERE user_id=?", (user_id,))


def digest(token):
    return hashlib.sha256(token.encode()).hexdigest()


def new_token():
    token = secrets.token_urlsafe(32)
    return token, digest(token), (datetime.now(timezone.utc) + timedelta(days=7)).isoformat()


class StaffPermissions(Payload):
    permissions: list[Permission] = Field(default_factory=lambda: list(DEFAULT_PERMISSIONS), max_length=20)

    @field_validator("permissions")
    @classmethod
    def ordered(cls, value):
        return [key for key in PERMISSIONS if key in value]


class StaffInvite(StaffPermissions):
    name: str = Field(min_length=1, max_length=40)
    email: str = Field(min_length=3, max_length=200)

    @field_validator("email")
    @classmethod
    def email_valid(cls, value):
        return normalized_email(value)

    @field_validator("name")
    @classmethod
    def name_valid(cls, value):
        if not value.strip():
            raise ValueError("직원 이름을 입력하세요.")
        return value.strip()


class StaffUpdate(Payload):
    permissions: list[Permission] | None = Field(default=None, max_length=20)
    status: Literal["active", "suspended"] | None = None

    @field_validator("permissions")
    @classmethod
    def ordered(cls, value):
        return None if value is None else [key for key in PERMISSIONS if key in value]


def mount_staff_routes(application, database, access, authenticated):
    public = APIRouter(route_class=SafeRoute, tags=["staff"])

    def pending(db, store_id, invite_id):
        row = db.execute("SELECT * FROM staff_invites WHERE id=? AND store_id=? AND used_at IS NULL", (invite_id, store_id)).fetchone()
        if not row:
            raise HTTPException(404, "초대를 찾을 수 없어요. 이미 가입했거나 취소된 초대예요.")
        return row

    def staff_member(db, store_id, user_id):
        # Only staff rows: an owner's own or another owner's membership is never changed here.
        if not db.execute("SELECT 1 FROM memberships WHERE store_id=? AND user_id=? AND role='staff'", (store_id, user_id)).fetchone():
            raise HTTPException(404, "직원을 찾을 수 없어요.")

    @application.get("/stores/{store_id}/staff", tags=["staff"])
    def staff(store_id: str, user=Depends(authenticated)):
        access(store_id, user, owner=True)
        with database.connect() as db:
            invites = [
                {"kind": "invite", "id": r["id"], "name": r["name"], "email": r["email"], "status": "invited",
                 "permissions": granted(r["permissions"]), "joined_at": None, "expires_at": r["expires_at"], "expired": r["expires_at"] <= now_iso()}
                for r in db.execute("SELECT * FROM staff_invites WHERE store_id=? AND used_at IS NULL ORDER BY created_at DESC", (store_id,))
            ]
            members = [
                {"kind": "member", "id": r["id"], "name": r["name"], "email": r["email"], **staff_state(db, store_id, r["id"]), "joined_at": r["joined_at"]}
                for r in db.execute("SELECT u.id,u.name,u.email,a.joined_at FROM memberships m JOIN users u ON u.id=m.user_id LEFT JOIN staff_access a ON a.user_id=m.user_id AND a.store_id=m.store_id WHERE m.store_id=? AND m.role='staff' ORDER BY u.name", (store_id,))
            ]
        return {"staff": invites + members, "permissions": [{"key": key, "label": label, "default": enabled} for key, (label, enabled) in PERMISSIONS.items()]}

    @application.post("/stores/{store_id}/staff", status_code=201, tags=["staff"])
    def invite_staff(store_id: str, payload: StaffInvite, user=Depends(authenticated)):
        access(store_id, user, owner=True)
        permissions = json.dumps(payload.permissions)
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            existing = db.execute("SELECT id FROM users WHERE email=?", (payload.email,)).fetchone()
            if existing and is_operator(db, existing[0]):
                raise HTTPException(400, "이 이메일은 직원으로 추가할 수 없어요.")
            if existing and db.execute("SELECT 1 FROM memberships WHERE user_id=? AND store_id=?", (existing[0], store_id)).fetchone():
                raise HTTPException(409, "이미 이 매장에 등록된 계정이에요.")
            if existing:
                # An existing account joins with its own password; no new link is made.
                db.execute("DELETE FROM staff_invites WHERE store_id=? AND email=? AND used_at IS NULL", (store_id, payload.email))
                db.execute("INSERT INTO memberships VALUES (?,?,'staff')", (existing[0], store_id))
                db.execute("INSERT INTO staff_access VALUES (?,?,?,'active',?)", (existing[0], store_id, permissions, now_iso()))
                audit(db, user["id"], "staff.attach", f"{store_id}:{existing[0]}")
                return {"id": existing[0], "existing_account": True, "invite": None}
            if db.execute("SELECT 1 FROM staff_invites WHERE store_id=? AND email=? AND used_at IS NULL", (store_id, payload.email)).fetchone():
                raise HTTPException(409, "이미 초대한 이메일이에요. 목록에서 링크를 다시 발급하세요.")
            token, token_hash, expiry = new_token()
            invite_id = uuid.uuid4().hex[:12]
            db.execute("INSERT INTO staff_invites VALUES (?,?,?,?,?,?,?,?,?,NULL)", (invite_id, store_id, payload.email, payload.name, permissions, token_hash, expiry, user["id"], now_iso()))
            audit(db, user["id"], "staff.invite", invite_id)
        return {"id": invite_id, "existing_account": False, "invite": {"token": token, "expires_at": expiry}}

    @application.patch("/stores/{store_id}/staff/members/{member_id}", tags=["staff"])
    def update_member(store_id: str, member_id: str, payload: StaffUpdate, user=Depends(authenticated)):
        access(store_id, user, owner=True)
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            staff_member(db, store_id, member_id)
            state = staff_state(db, store_id, member_id)
            permissions = state["permissions"] if payload.permissions is None else payload.permissions
            status = payload.status or state["status"]
            db.execute("INSERT INTO staff_access VALUES (?,?,?,?,NULL) ON CONFLICT(user_id,store_id) DO UPDATE SET permissions=excluded.permissions,status=excluded.status", (member_id, store_id, json.dumps(permissions), status))
            if status == "suspended":
                drop_idle_sessions(db, member_id)
            audit(db, user["id"], "staff.update", f"{store_id}:{member_id}")
        return {"ok": True, "status": status, "permissions": permissions}

    @application.post("/stores/{store_id}/staff/members/{member_id}/remove", tags=["staff"])
    def remove_member(store_id: str, member_id: str, user=Depends(authenticated)):
        access(store_id, user, owner=True)
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            staff_member(db, store_id, member_id)
            # The account and the orders it wrote stay; only this store's access goes.
            db.execute("DELETE FROM memberships WHERE store_id=? AND user_id=? AND role='staff'", (store_id, member_id))
            drop_idle_sessions(db, member_id)
            audit(db, user["id"], "staff.remove", f"{store_id}:{member_id}")
        return {"ok": True}

    @application.patch("/stores/{store_id}/staff/invites/{invite_id}", tags=["staff"])
    def update_invite(store_id: str, invite_id: str, payload: StaffPermissions, user=Depends(authenticated)):
        access(store_id, user, owner=True)
        with database.connect() as db:
            pending(db, store_id, invite_id)
            db.execute("UPDATE staff_invites SET permissions=? WHERE id=?", (json.dumps(payload.permissions), invite_id))
        return {"ok": True, "permissions": payload.permissions}

    @application.post("/stores/{store_id}/staff/invites/{invite_id}/reissue", tags=["staff"])
    def reissue_invite(store_id: str, invite_id: str, user=Depends(authenticated)):
        access(store_id, user, owner=True)
        token, token_hash, expiry = new_token()
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            pending(db, store_id, invite_id)
            # Replacing the hash revokes the previous unused link.
            db.execute("UPDATE staff_invites SET token_hash=?,expires_at=? WHERE id=?", (token_hash, expiry, invite_id))
            audit(db, user["id"], "staff.invite.reissue", invite_id)
        return {"token": token, "expires_at": expiry}

    @application.post("/stores/{store_id}/staff/invites/{invite_id}/cancel", tags=["staff"])
    def cancel_invite(store_id: str, invite_id: str, user=Depends(authenticated)):
        access(store_id, user, owner=True)
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            pending(db, store_id, invite_id)
            db.execute("DELETE FROM staff_invites WHERE id=?", (invite_id,))
            audit(db, user["id"], "staff.invite.cancel", invite_id)
        return {"ok": True}

    def invitation(db, token):
        row = db.execute("SELECT i.*,s.name store_name FROM staff_invites i JOIN stores s ON s.id=i.store_id WHERE i.token_hash=? AND i.used_at IS NULL AND i.expires_at>?", (digest(token), now_iso())).fetchone()
        if not row:
            raise HTTPException(400, "초대 링크가 만료됐거나 이미 사용됐어요. 점주에게 새 링크를 요청하세요.")
        return row

    @public.post("/auth/staff-invitations/inspect")
    def inspect(payload: InviteInput):
        with database.connect() as db:
            row = invitation(db, payload.token.get_secret_value())
        return {key: row[key] for key in ("email", "name", "store_name", "expires_at")}

    @public.post("/auth/staff-invitations/accept", status_code=201)
    def accept(payload: InviteAccept):
        with database.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = invitation(db, payload.token.get_secret_value())
            if db.execute("SELECT 1 FROM users WHERE email=?", (row["email"],)).fetchone():
                raise HTTPException(409, "이미 가입한 계정이에요. 점주에게 이 이메일로 다시 추가해달라고 요청하세요.")
            user_id, salt = uuid.uuid4().hex[:12], secrets.token_hex(16)
            db.execute("INSERT INTO users VALUES (?,?,?,?,?)", (user_id, row["email"], row["name"], salt, password_hash(payload.password.get_secret_value(), salt)))
            db.execute("INSERT INTO memberships VALUES (?,?,'staff')", (user_id, row["store_id"]))
            db.execute("INSERT INTO staff_access VALUES (?,?,?,'active',?)", (user_id, row["store_id"], row["permissions"], now_iso()))
            db.execute("UPDATE staff_invites SET used_at=? WHERE id=?", (now_iso(), row["id"]))
            audit(db, user_id, "staff.accept", row["id"])
        return {"ok": True, "email": row["email"]}

    application.include_router(public)
