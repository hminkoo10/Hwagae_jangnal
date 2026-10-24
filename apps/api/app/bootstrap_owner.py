"""Explicit server-side bootstrap; never grants a public route or prints secrets."""
import argparse
import os
import secrets
import uuid
from pathlib import Path
from app.database import Database, password_hash
from app.platform_admin import ContractInput, is_operator

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--email", required=True)
    parser.add_argument("--credentials-output", required=True)
    args = parser.parse_args()
    email = ContractInput.email_valid(args.email)
    output = Path(args.credentials_output)
    database = Database(os.environ["DB_PATH"])
    database.initialize(seed=False)
    with database.connect() as db:
        db.execute("BEGIN IMMEDIATE")
        existing = db.execute("SELECT id FROM users WHERE email=?", (email,)).fetchone()
        if existing:
            if is_operator(db, existing[0]):
                print("Operator already exists; password unchanged.")
                return
            raise SystemExit("Existing merchant account cannot be promoted by bootstrap.")
        user_id, salt, password = uuid.uuid4().hex[:12], secrets.token_hex(16), secrets.token_urlsafe(24)
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(f"Service: https://hwagae.milky.kr/\nEmail: {email}\nPassword: {password}\n")
        db.execute("INSERT INTO users VALUES (?,?,?,?,?)", (user_id, email, "화개장날 운영자", salt, password_hash(password,salt)))
        db.execute("INSERT INTO platform_operators VALUES (?)", (user_id,))
    print("Operator created; credentials written to the specified protected file.")

if __name__ == "__main__":
    main()
