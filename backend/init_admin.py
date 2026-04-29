#!/usr/bin/env python3
# init_admin.py — vytvoří prvního admin uživatele a API klíč
# Spusť: docker compose exec backend python init_admin.py

import asyncio
import hashlib
import os
import secrets
import sys

import asyncpg
import bcrypt

DB_URL = (
    os.getenv("DATABASE_URL")
    or os.getenv("NETPULSE_DB_URL")
    or "postgresql://netpulse:netpulse_secret@db/netpulse"
)


def hash_password(plain: str) -> str:
    """Přímý bcrypt bez passlib — kompatibilní s bcrypt 4.x."""
    return bcrypt.hashpw(plain.encode("utf-8")[:72], bcrypt.gensalt()).decode("utf-8")


def generate_api_key() -> tuple[str, str]:
    raw    = "np_" + secrets.token_urlsafe(32)
    hashed = hashlib.sha256(raw.encode()).hexdigest()
    return raw, hashed


async def main():
    print(f"Připojuji se k DB: {DB_URL[:45]}...")
    try:
        conn = await asyncpg.connect(DB_URL)
    except Exception as e:
        print(f"CHYBA: nelze se připojit k DB: {e}")
        sys.exit(1)

    user_count = await conn.fetchval("SELECT COUNT(*) FROM api_users")
    key_count  = await conn.fetchval("SELECT COUNT(*) FROM api_keys")
    print(f"Aktuální stav: {user_count} uživatelů, {key_count} API klíčů")

    username = input("\nZadej uživatelské jméno admina [admin]: ").strip() or "admin"
    password = input("Zadej heslo (min. 8 znaků): ").strip()

    if len(password) < 8:
        print("CHYBA: Heslo musí mít alespoň 8 znaků")
        sys.exit(1)

    existing = await conn.fetchrow(
        "SELECT id, role FROM api_users WHERE username = $1", username
    )

    pw_hash = hash_password(password)

    if existing:
        await conn.execute(
            "UPDATE api_users SET password_hash = $1, role = 'admin' WHERE username = $2",
            pw_hash, username,
        )
        user_id = existing["id"]
        print(f"\nUživatel '{username}' aktualizován (heslo změněno, role = admin)")
    else:
        user_id = await conn.fetchval(
            "INSERT INTO api_users (username, password_hash, role) VALUES ($1, $2, 'admin') RETURNING id",
            username, pw_hash,
        )
        print(f"\nUživatel '{username}' vytvořen (id={user_id}, role=admin)")

    raw_key, key_hash = generate_api_key()
    await conn.execute(
        """
        INSERT INTO api_keys (user_id, key_hash, description, active)
        VALUES ($1, $2, 'Init API key', TRUE)
        """,
        user_id, key_hash,
    )

    await conn.close()

    print("\n" + "="*60)
    print("✅ HOTOVO — uložte si tyto údaje:")
    print("="*60)
    print(f"  Uživatel : {username}")
    print(f"  Heslo    : {password}")
    print(f"  API klíč : {raw_key}")
    print("="*60)
    print("⚠️  API klíč se zobrazí pouze jednou!")
    print("\nPřihlášení přes UI: http://localhost:8501")
    print("API docs:           http://localhost:8000/docs")


if __name__ == "__main__":
    asyncio.run(main())
