# backend/auth.py — JWT autentizace + API klíče

import hashlib
import os
import secrets
import sys
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import Depends, HTTPException, Security, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer, APIKeyHeader
import jwt
import bcrypt as _bcrypt

# ---------------------------------------------------------------------------
# Konfigurace — JWT_SECRET se načítá z env proměnné
# ---------------------------------------------------------------------------
JWT_SECRET     = os.getenv("JWT_SECRET", "")
JWT_ALGORITHM  = "HS256"
JWT_EXPIRE_MIN = 60 * 8   # 8 hodin

if not JWT_SECRET:
    sys.exit(
        "\nCHYBA: Proměnná JWT_SECRET není nastavena!\n"
        "Nastav ji v docker-compose.yml:\n"
        "  environment:\n"
        "    JWT_SECRET: '<64-znakový-řetězec>'\n"
        "Generuj příkazem:\n"
        "  python3 -c \"import secrets; print(secrets.token_hex(32))\"\n"
    )

if len(JWT_SECRET) < 32:
    sys.exit(
        "\nCHYBA: JWT_SECRET musí mít alespoň 32 znaků (ideálně 64)!\n"
        "Aktuální délka: " + str(len(JWT_SECRET)) + " znaků\n"
    )

# bcrypt používáme přímo — passlib má problémy s bcrypt 4.x
bearer    = HTTPBearer(auto_error=False)
api_key_h = APIKeyHeader(name="X-API-Key", auto_error=False)

# ---------------------------------------------------------------------------
# Hesla
# ---------------------------------------------------------------------------

def hash_password(plain: str) -> str:
    """Zahashuje heslo přes bcrypt. Heslo se ořízne na 72 bytů (bcrypt limit)."""
    pw_bytes = plain.encode("utf-8")[:72]
    return _bcrypt.hashpw(pw_bytes, _bcrypt.gensalt()).decode("utf-8")


def verify_password(plain: str, hashed: str) -> bool:
    """Ověří heslo. Kompatibilní s hashy vytvořenými přes passlib i přímý bcrypt."""
    try:
        pw_bytes     = plain.encode("utf-8")[:72]
        hashed_bytes = hashed.encode("utf-8") if isinstance(hashed, str) else hashed
        return _bcrypt.checkpw(pw_bytes, hashed_bytes)
    except Exception:
        return False


# ---------------------------------------------------------------------------
# JWT tokeny
# ---------------------------------------------------------------------------

def create_token(user_id: int, username: str, role: str) -> str:
    expire = datetime.now(timezone.utc) + timedelta(minutes=JWT_EXPIRE_MIN)
    payload = {
        "sub":      str(user_id),
        "username": username,
        "role":     role,
        "exp":      expire,
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict:
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGORITHM])
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=401, detail="Token vypršel")
    except jwt.InvalidTokenError:
        raise HTTPException(status_code=401, detail="Neplatný token")


# ---------------------------------------------------------------------------
# API klíče
# ---------------------------------------------------------------------------

def generate_api_key() -> tuple[str, str]:
    """Vrátí (raw_key, key_hash) — raw_key ukáže uživateli jen jednou."""
    raw    = "np_" + secrets.token_urlsafe(32)
    hashed = hashlib.sha256(raw.encode()).hexdigest()
    return raw, hashed


def hash_api_key(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


# ---------------------------------------------------------------------------
# FastAPI závislosti
# ---------------------------------------------------------------------------

class CurrentUser:
    def __init__(self, user_id: int, username: str, role: str):
        self.user_id  = user_id
        self.username = username
        self.role     = role

    @property
    def is_admin(self) -> bool:
        return self.role == "admin"


async def get_current_user(
    creds:   Optional[HTTPAuthorizationCredentials] = Security(bearer),
    api_key: Optional[str]                          = Security(api_key_h),
    db=None,
) -> CurrentUser:
    # --- JWT ---
    if creds and creds.credentials:
        payload = decode_token(creds.credentials)
        return CurrentUser(
            user_id  = int(payload["sub"]),
            username = payload["username"],
            role     = payload["role"],
        )

    # --- API klíč ---
    if api_key:
        key_hash = hash_api_key(api_key)
        if not db:
            raise HTTPException(status_code=500, detail="DB pool není dostupný")
        row = await db.fetchrow(
            """
            SELECT u.id, u.username, u.role
            FROM api_keys k JOIN api_users u ON k.user_id = u.id
            WHERE k.key_hash = $1 AND k.active = TRUE
            """,
            key_hash,
        )
        if row:
            return CurrentUser(
                user_id  = row["id"],
                username = row["username"],
                role     = row["role"],
            )
        raise HTTPException(status_code=401, detail="Neplatný API klíč")

    raise HTTPException(
        status_code = status.HTTP_401_UNAUTHORIZED,
        detail      = "Chybí autentizace (Bearer token nebo X-API-Key)",
        headers     = {"WWW-Authenticate": "Bearer"},
    )


def require_admin(user: CurrentUser = Depends(get_current_user)) -> CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Vyžaduje admin oprávnění")
    return user
