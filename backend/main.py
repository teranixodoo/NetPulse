# backend/main.py — FastAPI aplikace (opravená + SOA credentials)

from __future__ import annotations
import asyncio
import json
import logging
import os
from contextlib import asynccontextmanager
from typing import List, Optional

from cryptography.fernet import Fernet
from fastapi import FastAPI, Depends, HTTPException, Query, Body, status
from fastapi.responses import FileResponse
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import auth
import backup as bkp
import db
import syslog as sl
import discovery as disc
import scanner as sc
import poller
import scheduler
from models import (
    AppConfigModel, IpRangeModel,
    HostStatsModel, PingResultModel, RttTrendResponse,
    ScanStatusModel, TriggerScanResponse,
    LoginRequest, TokenResponse, UserModel, CreateUserRequest, UpdateUserRequest,
    OutageEvent, Device, DeviceCreate, DeviceWithCredentials,
    CredentialCreate, Credential,
    SiteCreate, SiteUpdate, SiteModel, ScanExclusionCreate,
)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(name)s: %(message)s")
log = logging.getLogger("netpulse.api")

# ---------------------------------------------------------------------------
# Šifrování (Fernet) — pro uložení hesel v credentials
# ---------------------------------------------------------------------------
_ENCR_KEY = os.getenv("DB_ENCRYPTION_KEY", "")
cipher: Optional[Fernet] = None
if _ENCR_KEY:
    try:
        cipher = Fernet(_ENCR_KEY.encode())
    except Exception as e:
        log.warning(f"DB_ENCRYPTION_KEY je neplatný: {e}. Credentials nebudou šifrovány.")

def encrypt_val(val: str) -> str:
    if not cipher or not val:
        return val
    return cipher.encrypt(val.encode()).decode()

def decrypt_val(val: str) -> str:
    if not cipher or not val:
        return val
    try:
        return cipher.decrypt(val.encode()).decode()
    except Exception:
        return ""

# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------
@asynccontextmanager
async def lifespan(app: FastAPI):
    # Podporujeme obě proměnné — DATABASE_URL i NETPULSE_DB_URL
    db_url = (
        os.getenv("DATABASE_URL")
        or os.getenv("NETPULSE_DB_URL")
        or "postgresql://netpulse:netpulse_secret@db/netpulse"
    )
    log.info(f"Připojuji se k DB: {db_url[:40]}...")
    pool = await db.init_pool(db_url)
    cfg  = await db.get_config_db(pool)
    sl.init(pool)   # inicializace systémového logu
    scheduler.set_main_loop(asyncio.get_event_loop())

    # Opravíme zombie joby z předchozího běhu při startu
    try:
        zombie_count = await db.mark_startup_zombies(pool)
        if zombie_count > 0:
            log.info(f"Startup: opraveno {zombie_count} zombie jobů z předchozího běhu")
    except Exception as _ze:
        log.warning(f"Startup zombie cleanup: {_ze}")

    scheduler.start_scheduler(pool, cfg)
    yield
    scheduler.stop_scheduler()
    await db.close_pool()
    log.info("NetPulse API ukončen")

# ---------------------------------------------------------------------------
# FastAPI instance
# ---------------------------------------------------------------------------
app = FastAPI(
    title       = "NetPulse API",
    description = "Network monitoring + inventory + credential vault",
    version     = "2.0.0",
    lifespan    = lifespan,
    docs_url    = "/docs",
    redoc_url   = "/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins     = ["*"],
    allow_credentials = True,
    allow_methods     = ["*"],
    allow_headers     = ["*"],
)

# ---------------------------------------------------------------------------
# Závislosti
# ---------------------------------------------------------------------------
async def get_db():
    return await db.get_pool()

async def current_user(
    creds:   Optional[HTTPAuthorizationCredentials] = Depends(HTTPBearer(auto_error=False)),
    api_key: Optional[str] = Depends(auth.api_key_h),
    pool     = Depends(get_db),
) -> auth.CurrentUser:
    if creds and creds.credentials:
        payload = auth.decode_token(creds.credentials)
        return auth.CurrentUser(
            user_id  = int(payload["sub"]),
            username = payload["username"],
            role     = payload["role"],
        )
    if api_key:
        key_hash = auth.hash_api_key(api_key)
        row = await pool.fetchrow(
            """
            SELECT u.id, u.username, u.role
            FROM api_keys k JOIN api_users u ON k.user_id = u.id
            WHERE k.key_hash = $1 AND k.active = TRUE
            """,
            key_hash,
        )
        if not row:
            raise HTTPException(status_code=401, detail="Neplatný API klíč")
        return auth.CurrentUser(user_id=row["id"], username=row["username"], role=row["role"])
    raise HTTPException(
        status_code=401,
        detail="Chybí autentizace",
        headers={"WWW-Authenticate": "Bearer"},
    )

def admin_only(user: auth.CurrentUser = Depends(current_user)) -> auth.CurrentUser:
    if not user.is_admin:
        raise HTTPException(status_code=403, detail="Vyžaduje admin")
    return user

# ---------------------------------------------------------------------------
# AUTH
# ---------------------------------------------------------------------------


@app.get("/system/db-stats", tags=["System"])
async def get_db_stats(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Statistiky databáze — velikost tabulek, počty řádků, celková velikost."""
    async with pool.acquire() as conn:
        tables = await conn.fetch("""
            SELECT
                s.relname                                            AS table_name,
                pg_size_pretty(pg_total_relation_size(c.oid))       AS total_size,
                pg_size_pretty(pg_relation_size(c.oid))             AS data_size,
                pg_size_pretty(
                    pg_total_relation_size(c.oid)
                    - pg_relation_size(c.oid))                       AS index_size,
                pg_total_relation_size(c.oid)                       AS total_bytes,
                COALESCE(s.n_live_tup, 0)                           AS row_count
            FROM pg_stat_user_tables s
            JOIN pg_class c ON c.relname = s.relname
            ORDER BY total_bytes DESC
        """)

        db_size = await conn.fetchrow("""
            SELECT
                pg_size_pretty(pg_database_size(current_database())) AS total_size,
                pg_database_size(current_database())                  AS total_bytes,
                current_database()                                    AS db_name
        """)

        ping_range = await conn.fetchrow("""
            SELECT
                MIN(scanned_at) AS oldest,
                MAX(scanned_at) AS newest,
                COUNT(*)        AS total_rows
            FROM ping_results
        """)

    return {
        "database": {
            "name":        db_size["db_name"],
            "total_size":  db_size["total_size"],
            "total_bytes": db_size["total_bytes"],
        },
        "tables": [
            {
                "name":        r["table_name"],
                "total_size":  r["total_size"],
                "data_size":   r["data_size"],
                "index_size":  r["index_size"],
                "total_bytes": r["total_bytes"],
                "row_count":   r["row_count"],
            }
            for r in tables
        ],
        "ping_results": {
            "oldest":     ping_range["oldest"].isoformat() if ping_range["oldest"] else None,
            "newest":     ping_range["newest"].isoformat() if ping_range["newest"] else None,
            "total_rows": ping_range["total_rows"],
        }
    }


@app.get("/health", tags=["System"])
async def health_check():
    """Health check endpoint pro Docker healthcheck."""
    return {"status": "ok"}


@app.post("/auth/login", response_model=TokenResponse, tags=["Auth"])
async def login(req: LoginRequest, pool=Depends(get_db)):
    user = await db.get_user_by_username(pool, req.username)
    if not user or not auth.verify_password(req.password, user["password_hash"]):
        raise HTTPException(status_code=401, detail="Špatné přihlašovací údaje")
    token = auth.create_token(user["id"], user["username"], user["role"])
    sl.write_bg("INFO", "netpulse.auth", "user_login",
        f"Přihlášení: {user['username']} (role={user['role']})",
        user_name=user["username"],
        meta={"role": user["role"]})
    return TokenResponse(access_token=token, expires_in=auth.JWT_EXPIRE_MIN * 60)

@app.post("/auth/users", response_model=UserModel, tags=["Auth"])
async def create_user(req: CreateUserRequest, user=Depends(admin_only), pool=Depends(get_db)):
    pw_hash = auth.hash_password(req.password)
    uid     = await db.create_user(pool, req.username, pw_hash, req.role)
    return UserModel(id=uid, username=req.username, role=req.role)

@app.get("/auth/users", response_model=List[UserModel], tags=["Auth"])
async def list_users(user=Depends(admin_only), pool=Depends(get_db)):
    """Seznam všech uživatelů (pouze admin)."""
    users = await db.get_all_users(pool)
    return [UserModel(**u) for u in users]


@app.put("/auth/users/{user_id}", response_model=UserModel, tags=["Auth"])
async def update_user(
    user_id: int,
    req: UpdateUserRequest,
    current_user=Depends(admin_only),
    pool=Depends(get_db),
):
    """Aktualizace uživatele — role, email, heslo, aktivace (pouze admin)."""
    new_pw_hash = None
    if req.new_password:
        if len(req.new_password) < 8:
            raise HTTPException(status_code=400, detail="Heslo musí mít alespoň 8 znaků")
        new_pw_hash = auth.hash_password(req.new_password)
    updated = await db.update_user(
        pool, user_id,
        role=req.role,
        email=req.email,
        active=req.active,
        new_password_hash=new_pw_hash,
    )
    if not updated:
        raise HTTPException(status_code=404, detail="Uživatel nenalezen")
    return UserModel(**updated)


@app.delete("/auth/users/{user_id}", tags=["Auth"])
async def delete_user(
    user_id: int,
    current_user=Depends(admin_only),
    pool=Depends(get_db),
):
    """Smaže uživatele (pouze admin, nelze smazat sebe)."""
    if user_id == current_user.user_id:
        raise HTTPException(status_code=400, detail="Nemůžeš smazat sám sebe")
    ok = await db.delete_user(pool, user_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Uživatel nenalezen")
    return {"status": "deleted"}


@app.get("/auth/users/{user_id}/api-keys", tags=["Auth"])
async def get_user_api_keys(
    user_id: int,
    current_user=Depends(admin_only),
    pool=Depends(get_db),
):
    """Vrátí API klíče uživatele."""
    keys = await db.get_user_api_keys(pool, user_id)
    return keys


@app.delete("/auth/api-keys/{key_id}", tags=["Auth"])
async def deactivate_api_key(
    key_id: int,
    current_user=Depends(admin_only),
    pool=Depends(get_db),
):
    """Deaktivuje API klíč."""
    ok = await db.deactivate_api_key(pool, key_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Klíč nenalezen")
    return {"status": "deactivated"}


@app.post("/auth/api-keys", tags=["Auth"])
async def generate_api_key(
    description: str = Body(..., embed=True),
    user = Depends(current_user),
    pool = Depends(get_db),
):
    raw, hashed = auth.generate_api_key()
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO api_keys (user_id, key_hash, description) VALUES ($1, $2, $3)",
            user.user_id, hashed, description,
        )
    return {"api_key": raw, "warning": "Klíč se zobrazí pouze jednou!"}

# ---------------------------------------------------------------------------
# SCAN
# ---------------------------------------------------------------------------

@app.put("/credentials/{credential_id}", tags=["Credentials"])
async def update_credential(
    credential_id: int,
    data: CredentialCreate,
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Aktualizuje přihlašovací profil. Pokud je heslo prázdné, zachová stávající."""
    if not cipher:
        raise HTTPException(
            status_code=500,
            detail="DB_ENCRYPTION_KEY není nastaven"
        )
    async with pool.acquire() as conn:
        # Ověříme existenci
        row = await conn.fetchrow(
            "SELECT id, password_cipher FROM credentials WHERE id = $1",
            credential_id
        )
        if not row:
            raise HTTPException(status_code=404, detail="Profil nenalezen")

        # Heslo — pokud je prázdné zachováme stávající
        if data.password:
            encrypted_pw = cipher.encrypt(data.password.encode()).decode()
        else:
            encrypted_pw = row["password_cipher"]

        await conn.execute(
            """
            UPDATE credentials SET
                name         = $1,
                auth_type    = $2,
                username     = $3,
                password_cipher = $4,
                port         = $5,
                extra_params = $6
            WHERE id = $7
            """,
            data.name,
            data.auth_type,
            data.username or None,
            encrypted_pw,
            data.port or None,
            json.dumps(data.extra_params or {}),
            credential_id,
        )
    return {"status": "ok", "id": credential_id}


@app.get("/scan/status", response_model=ScanStatusModel, tags=["Scan"])
async def get_scan_status(user=Depends(current_user)):
    s = scheduler.get_scan_state()
    return ScanStatusModel(
        running    = s["running"],
        is_scanning= s["running"],
        progress   = s["progress"],
        total_ips  = s["total_ips"],
        done_ips   = s["done_ips"],
        last_scan  = s["last_scan"],
        scan_count = s["scan_count"],
    )



@app.get("/scan/jobs", tags=["Scan"])
async def get_scan_jobs(
    job_type: Optional[str] = None,
    limit:    int = 100,
    offset:   int = 0,
    user      = Depends(current_user),
    pool      = Depends(get_db),
):
    """Vrátí historii scan jobů."""
    return await db.get_scan_jobs(pool, job_type=job_type, limit=limit, offset=offset)


@app.get("/scan/jobs/stats", tags=["Scan"])
async def get_scan_jobs_stats(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Statistiky scan jobů za posledních 30 dní."""
    return await db.get_scan_jobs_stats(pool)

@app.post("/scan/trigger", response_model=TriggerScanResponse, tags=["Scan"])
async def trigger_scan(user=Depends(current_user), pool=Depends(get_db)):
    if scheduler.get_scan_state()["running"]:
        raise HTTPException(status_code=409, detail="Scan již probíhá")
    cfg = await db.get_config_db(pool)
    await scheduler.trigger_now(pool, cfg, triggered_by=user.username)
    return TriggerScanResponse(status="started", message="Scan zahájen")

# ---------------------------------------------------------------------------
# DATA
# ---------------------------------------------------------------------------
@app.get("/hosts", response_model=List[HostStatsModel], tags=["Data"])
async def get_hosts(user=Depends(current_user), pool=Depends(get_db)):
    return await db.get_host_stats(pool)

@app.get("/results/latest", response_model=List[PingResultModel], tags=["Data"])
async def get_latest(
    limit: int = Query(1000, ge=1, le=5000),
    user = Depends(current_user),
    pool = Depends(get_db),
):
    return await db.get_recent_results(pool, limit)

@app.get("/hosts/{ip_or_id}/rtt-trend", response_model=RttTrendResponse, tags=["Data"])
async def get_rtt_trend(
    ip_or_id: str,
    days:  Optional[int] = Query(None, ge=1),
    hours: int           = Query(24, ge=1, le=720),
    limit: int           = Query(500, ge=10, le=2000),
    user = Depends(current_user),
    pool = Depends(get_db),
):
    lookback = hours if days is None else days * 24
    points = await db.get_rtt_trend(pool, ip_or_id, lookback, limit)
    return RttTrendResponse(ip=ip_or_id, points=points)

@app.get("/hosts/{ip}/stats", response_model=Optional[HostStatsModel], tags=["Data"])
async def get_host_detail(ip: str, user=Depends(current_user), pool=Depends(get_db)):
    all_stats = await db.get_host_stats(pool)
    for s in all_stats:
        if s.ip == ip:
            return s
    raise HTTPException(status_code=404, detail=f"IP {ip} nenalezena")


@app.post("/hosts/{ip}/ping", tags=["Data"])
async def ping_single_host(
    ip:   str,
    user  = Depends(current_user),
    pool  = Depends(get_db),
):
    """Okamžitý ping jedné IP — pro live graf. Výsledek se uloží do DB."""
    sem    = asyncio.Semaphore(1)
    result = await sc.ping_host(ip, sem, count=3, timeout_ms=1000)
    await db.save_results(pool, [result])
    await db.sync_ip_addresses_after_ping(pool, [result])
    return {
        "ip":          result.ip,
        "is_alive":    result.is_alive,
        "rtt_ms":      result.rtt_ms,
        "packet_loss": result.packet_loss,
        "jitter_ms":   result.jitter_ms,
        "scanned_at":  result.scanned_at.isoformat(),
    }


@app.get("/outages", response_model=List[OutageEvent], tags=["Data"])
async def get_outages(
    hours: int = Query(24, ge=1, le=168),
    user = Depends(current_user),
    pool = Depends(get_db),
):
    return await db.get_outages(pool, hours)

@app.delete("/results/orphaned", tags=["Data"])
async def delete_orphaned_logs(user=Depends(admin_only), pool=Depends(get_db)):
    async with pool.acquire() as conn:
        count = await conn.fetchval("""
            WITH deleted AS (
                DELETE FROM ping_results
                WHERE NOT EXISTS (
                    SELECT 1 FROM ip_ranges WHERE ping_results.ip <<= ip_ranges.network
                )
                RETURNING *
            )
            SELECT count(*) FROM deleted
        """)
    log.info(f"Admin {user.username} smazal {count} osiřelých záznamů")
    return {"status": "success", "deleted_rows": count}

# ---------------------------------------------------------------------------
# KONFIGURACE
# ---------------------------------------------------------------------------
@app.get("/config", tags=["Config"])
async def get_config(user=Depends(current_user), pool=Depends(get_db)):
    return await db.get_config_db(pool)

@app.put("/config", tags=["Config"])
async def update_config(
    updates: dict = Body(...),
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    allowed = {
        "scan_interval_s", "ping_count", "ping_timeout_ms", "max_concurrent",
        "alert_email", "alert_rtt_ms", "retention_days",
        # Discovery scheduler
        "discovery_enabled", "discovery_interval_s", "discovery_only_online",
        "discovery_skip_polled",
        # Backup scheduler
        "backup_enabled", "backup_interval_s", "backup_only_online", "backup_only_successful",
        # Poll scheduler
        "poll_scheduler_enabled", "poll_scheduler_interval_s",
    }
    for key in updates:
        if key not in allowed:
            raise HTTPException(status_code=400, detail=f"Neznámý klíč: {key}")
        await db.set_config_value(pool, key, str(updates[key]))
    # Restartujeme scheduler při změně ping, discovery nebo backup konfigurace
    if any(k in updates for k in ("scan_interval_s", "discovery_enabled",
                                   "discovery_interval_s", "discovery_only_online",
                                   "discovery_skip_polled", "backup_enabled",
                                   "backup_interval_s",
                                   "poll_scheduler_enabled", "poll_scheduler_interval_s")):
        cfg = await db.get_config_db(pool)
        scheduler.restart_scheduler(pool, cfg)
    return {"status": "ok", "updated": list(updates.keys())}

# ---------------------------------------------------------------------------
# IP ROZSAHY
# ---------------------------------------------------------------------------
@app.get("/ranges", response_model=List[IpRangeModel], tags=["Ranges"])
async def get_ranges(user=Depends(current_user), pool=Depends(get_db)):
    return await db.get_ip_ranges(pool)

@app.post("/ranges", response_model=IpRangeModel, tags=["Ranges"])
async def add_range(rng: IpRangeModel, user=Depends(admin_only), pool=Depends(get_db)):
    return await db.upsert_ip_range(pool, rng)

@app.put("/ranges/{range_id}", response_model=IpRangeModel, tags=["Ranges"])
async def update_range(range_id: int, rng: IpRangeModel, user=Depends(admin_only), pool=Depends(get_db)):
    rng.id = range_id
    return await db.upsert_ip_range(pool, rng)

@app.get("/ranges/{range_id}/impact", tags=["Ranges"])
async def get_range_impact(range_id: int, user=Depends(admin_only), pool=Depends(get_db)):
    """Vrátí dopad smazání/změny rozsahu — počty ovlivněných záznamů."""
    async with pool.acquire() as conn:
        # Načteme rozsah
        row = await conn.fetchrow("SELECT id, label, network::text FROM ip_ranges WHERE id=$1", range_id)
        if not row:
            raise HTTPException(status_code=404, detail="Rozsah nenalezen")
        network = row["network"]

        # Počet ping_results záznamů
        ping_count = await conn.fetchval(
            "SELECT COUNT(*) FROM ping_results WHERE ip << $1::cidr", network
        )
        # Počet záznamů za posledních 30 dní
        ping_30d = await conn.fetchval(
            "SELECT COUNT(*) FROM ping_results WHERE ip << $1::cidr "
            "AND scanned_at > NOW() - INTERVAL '30 days'", network
        )
        # Počet zařízení v rozsahu
        device_count = await conn.fetchval(
            "SELECT COUNT(*) FROM devices WHERE ip << $1::cidr", network
        )
        # Zařízení — jejich jména
        devices_in = await conn.fetch(
            "SELECT id, hostname, alias, ip::text FROM devices WHERE ip << $1::cidr LIMIT 10", network
        )
        # Počet outage eventů
        outage_count = await conn.fetchval(
            "SELECT COUNT(*) FROM outage_events WHERE ip << $1::cidr", network
        ) or 0

    return {
        "range_id":     range_id,
        "label":        row["label"],
        "network":      network,
        "ping_total":   int(ping_count or 0),
        "ping_30d":     int(ping_30d or 0),
        "device_count": int(device_count or 0),
        "devices":      [dict(d) for d in devices_in],
        "outage_count": int(outage_count),
    }


@app.delete("/ranges/{range_id}", tags=["Ranges"])
async def delete_range(
    range_id:     int,
    delete_data:  bool = False,  # smazat i ping_results a outage_events
    user          = Depends(admin_only),
    pool          = Depends(get_db),
):
    """Smaže rozsah. Volitelně i historická ping data."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("SELECT network::text FROM ip_ranges WHERE id=$1", range_id)
        if not row:
            raise HTTPException(status_code=404, detail="Rozsah nenalezen")
        network = row["network"]

        deleted_pings   = 0
        deleted_outages = 0

        if delete_data:
            # Smažeme historická ping data pro IP v rozsahu
            r = await conn.fetchval(
                "WITH d AS (DELETE FROM ping_results WHERE ip << $1::cidr RETURNING 1) "
                "SELECT COUNT(*) FROM d", network
            )
            deleted_pings = int(r or 0)
            # Smažeme outage eventy
            r2 = await conn.fetchval(
                "WITH d AS (DELETE FROM outage_events WHERE ip << $1::cidr RETURNING 1) "
                "SELECT COUNT(*) FROM d", network
            )
            deleted_outages = int(r2 or 0)

        await conn.execute("DELETE FROM ip_ranges WHERE id=$1", range_id)

    return {
        "status":          "deleted",
        "id":              range_id,
        "deleted_pings":   deleted_pings,
        "deleted_outages": deleted_outages,
    }

# ---------------------------------------------------------------------------
# CREDENTIALS — trezor přihlašovacích profilů (SOA)
# ---------------------------------------------------------------------------
@app.get("/credentials", response_model=List[Credential], tags=["Credentials"])
async def list_credentials(user=Depends(current_user), pool=Depends(get_db)):
    """Seznam všech profilů — hesla se NIKDY neposílají."""
    rows = await db.get_credentials(pool)
    return rows

@app.post("/credentials", response_model=Credential, tags=["Credentials"])
async def create_credential(data: CredentialCreate, user=Depends(admin_only), pool=Depends(get_db)):
    """Uloží šifrovaný přihlašovací profil (SSH/SNMP/API/HTTP)."""
    if not cipher:
        raise HTTPException(
            status_code=500,
            detail="DB_ENCRYPTION_KEY není nastaven — credentials nelze bezpečně uložit"
        )
    encrypted_pw = encrypt_val(data.password)
    cred_id = await db.create_credential(
        pool,
        name            = data.name,
        auth_type       = data.auth_type,
        username        = data.username,
        password_cipher = encrypted_pw,
        port            = data.port,
        extra_params    = json.dumps(data.extra_params),
    )
    return Credential(id=cred_id, name=data.name, auth_type=data.auth_type,
                      username=data.username, port=data.port)

@app.delete("/credentials/{credential_id}", tags=["Credentials"])
async def delete_credential(credential_id: int, user=Depends(admin_only), pool=Depends(get_db)):
    await db.delete_credential(pool, credential_id)
    return {"status": "deleted", "id": credential_id}

# ---------------------------------------------------------------------------
# DEVICES — inventář zařízení
# ---------------------------------------------------------------------------
@app.get("/devices", response_model=List[DeviceWithCredentials], tags=["Devices"])
async def list_devices(user=Depends(current_user), pool=Depends(get_db)):
    """Zařízení včetně přiřazených přihlašovacích profilů."""
    return await db.get_devices_with_credentials(pool)

@app.post("/devices", response_model=Device, tags=["Devices"])
async def create_device(device: DeviceCreate, user=Depends(admin_only), pool=Depends(get_db)):
    try:
        return await db.add_device(pool, device)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/devices/{device_id}/credentials/{credential_id}", tags=["Devices"])
async def link_credential(
    device_id: int, credential_id: int,
    user = Depends(admin_only), pool = Depends(get_db),
):
    """Přiřadí credential profil k zařízení (M:N)."""
    await db.link_device_credential(pool, device_id, credential_id)
    return {"status": "linked", "device_id": device_id, "credential_id": credential_id}

@app.delete("/devices/{device_id}/credentials/{credential_id}", tags=["Devices"])
async def unlink_credential(
    device_id: int, credential_id: int,
    user = Depends(admin_only), pool = Depends(get_db),
):
    """Odebere přiřazení credential profilu od zařízení."""
    await db.unlink_device_credential(pool, device_id, credential_id)
    return {"status": "unlinked"}

@app.get("/scan/discovery-status", tags=["Scan"])
async def get_discovery_status(user=Depends(current_user)):
    """Vrátí aktuální stav discovery scheduleru."""
    return scheduler.get_discovery_state()


@app.post("/scan/trigger-discovery", tags=["Scan"])
async def trigger_discovery_scan(user=Depends(current_user), pool=Depends(get_db)):
    """Manuálně spustí discovery scan všech online zařízení."""
    if scheduler.discovery_state["running"]:
        raise HTTPException(status_code=409, detail="Discovery scan již probíhá")
    cfg = await db.get_config_db(pool)
    await scheduler.trigger_discovery_now(pool, cfg, triggered_by=user.username)
    return {"status": "started", "message": "Discovery scan zahájen"}




@app.put("/devices/{device_id}", response_model=Device, tags=["Devices"])
async def update_device(
    device_id: int,
    device: DeviceCreate,
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Aktualizuje existující zařízení."""
    log.info(
        f"update_device id={device_id}: hostname={device.hostname} "
        f"vendor={device.vendor!r} serial={device.serial_number!r} "
        f"device_type={device.device_type!r}"
    )
    try:
        return await db.update_device(pool, device_id, device)
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.delete("/devices/{device_id}", tags=["Devices"])
async def delete_device(
    device_id: int,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    """Smaže zařízení."""
    await db.delete_device(pool, device_id)
    return {"status": "deleted", "id": device_id}


# ---------------------------------------------------------------------------
# DISCOVERY — automatická detekce vlastností zařízení
# ---------------------------------------------------------------------------
@app.post("/devices/{device_id}/discovery", tags=["Devices"])
async def run_device_discovery(
    device_id: int,
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """
    Spustí vrstvený discovery na IP adrese zařízení.
    Výsledky (hostname, MAC, výrobce, typ, popis) automaticky zapíše do zařízení.
    Podmínky: zařízení musí existovat. Doporučuje se volat jen pro online IP.
    """
    # Načteme zařízení
    devices = await db.get_devices_with_credentials(pool)
    device  = next((d for d in devices if d["id"] == device_id), None)
    if not device:
        raise HTTPException(status_code=404, detail="Zařízení nenalezeno")

    ip_str = str(device["ip"]).split("/")[0]
    log.info(f"Discovery spuštěn pro device_id={device_id} ip={ip_str} uživatelem={user.username}")

    # Zápis začátku discovery jobu
    job_id = await db.scan_job_start(
        pool,
        job_type      = "discovery",
        trigger_type  = "manual",
        triggered_by  = user.username,
        total_targets = 1,
        meta          = {"device_id": device_id, "ip": ip_str,
                         "hostname": device.get("hostname", "")},
    )

    try:
        result = await disc.run_discovery(ip_str)
    except Exception as e:
        log.error(f"Discovery selhalo pro {ip_str}: {e}", exc_info=True)
        await db.scan_job_finish(pool, job_id, status="error", error_msg=str(e)[:500])
        raise HTTPException(status_code=500, detail=f"Discovery selhalo: {e}")

    # Patch — aktualizujeme jen pole která byla zjištěna
    patch = result.to_device_patch()
    if patch:
        await db.patch_device(pool, device_id, patch)
        log.info(f"Discovery: zapsáno do device_id={device_id}: {patch}")

    # Sestavíme strukturovaný log po vrstvách
    layers = _build_discovery_layers(result)

    # Uložíme log do DB
    await db.save_discovery_log(
        pool          = pool,
        device_id     = device_id,
        ip            = ip_str,
        layers        = layers,
        open_ports    = result.open_ports,
        services      = {str(k): v for k, v in result.services.items()},
        patch_applied = patch,
    )

    # Uzavřeme scan job
    ok_layers = sum(1 for l in layers if l.get("ok"))
    await db.scan_job_finish(
        pool, job_id,
        status        = "done",
        ok_count      = ok_layers,
        fail_count    = len(layers) - ok_layers,
        changed_count = len(patch),
    )

    return {
        "device_id":     device_id,
        "ip":            ip_str,
        "patch_applied": patch,
        "hostname":      result.hostname,
        "mac":           result.mac,
        "vendor":        result.vendor,
        "device_type":   result.device_type,
        "description":   result.description,
        "open_ports":    result.open_ports,
        "services":      result.services,
        "notes":         result.notes,
        "layers":        layers,
    }


def _build_discovery_layers(result) -> list[dict]:
    """Deleguje na DiscoveryResult.to_layers_list() — 10 vrstev."""
    return result.to_layers_list()



@app.post("/devices/{device_id}/poll", tags=["Devices"])
async def poll_device_data(
    device_id:     int,
    credential_id: int = None,  # pokud zadán, použije pouze tento profil
    user           = Depends(current_user),
    pool           = Depends(get_db),
):
    """
    Přečte data ze zařízení.
    credential_id: ruční poll — použije pouze zadaný profil.
    Bez credential_id: automatický poll dle vendor priority.
    """
    # Načteme zařízení s credentials
    devices = await db.get_devices_with_credentials(pool)
    device  = next((d for d in devices if d["id"] == device_id), None)
    if not device:
        raise HTTPException(status_code=404, detail="Zařízení nenalezeno")

    if not device["credentials"]:
        raise HTTPException(
            status_code=400,
            detail="Zařízení nemá přiřazeny žádné přihlašovací profily"
        )

    ip_str = str(device["ip"]).split("/")[0]
    log.info(
        f"Poll zahájen pro device_id={device_id} ip={ip_str} "
        f"uživatelem={user.username} "
        f"({len(device['credentials'])} profilů)"
    )

    # Spustíme polling
    vendor = device.get("vendor") or None

    # Ruční poll s konkrétním profilem — použijeme pouze ten jeden
    if credential_id:
        selected = [c for c in device["credentials"] if c["id"] == credential_id]
        if not selected:
            raise HTTPException(
                status_code=404,
                detail=f"Přihlašovací profil {credential_id} není přiřazen tomuto zařízení"
            )
        poll_creds = selected
        log.info(f"Poll {ip_str}: ruční poll s profilem {selected[0]["name"]} (id={credential_id})")
    else:
        poll_creds = device["credentials"]

    result = await poller.poll_device(
        ip      = ip_str,
        creds   = poll_creds,
        cipher  = cipher,
        timeout = 20.0,
        vendor  = vendor,
        # Pokud jeden profil — přeskočíme vendor priority sorting
        force_single = credential_id is not None,
    )

    # Uložíme výsledek
    poll_id = await db.save_poll_result(
        pool        = pool,
        device_id   = device_id,
        ip          = ip_str,
        method      = result.method,
        success     = result.success,
        hostname    = result.hostname,
        model       = result.model,
        vendor      = result.vendor,
        firmware    = result.firmware,
        uptime_s                 = result.uptime_s,
        uptime_str               = result.uptime,   # originální textový uptime ze zařízení
        successful_credential_id = result.credential_id,   # ID úspěšného profilu
        successful_auth          = result.successful_auth,  # Kompletní snapshot přihlášení
        interfaces  = result.interfaces,
        ports       = getattr(result, "ports", []),
        serial      = getattr(result, "serial", None),
        system_info = result.system_info,
        error       = result.error,
    )

    log.info(
        f"Poll dokončen device_id={device_id}: "
        f"method={result.method} success={result.success} "
        f"hostname={result.hostname} firmware={result.firmware}"
    )
    # Aktualizujeme device_ips z výsledků pollu
    if result.success and result.extended:
        ext        = result.extended
        ip_entries = []
        def _strip_prefix(ip_str: str) -> str:
            """Odstraní /prefix z IP adresy."""
            return ip_str.split("/")[0] if ip_str else ip_str

        for entry in ext.get("own_ips", []):
            ip_entries.append({"ip": _strip_prefix(entry["ip"]), "mac": entry.get("mac"),
                "interface": entry.get("interface"), "source": entry.get("source", "api_address"),
                "is_primary": _strip_prefix(entry["ip"]) == ip_str})
        for entry in ext.get("arp", []):
            arp_status = str(entry.get("status", "")).strip().lower()
            if entry.get("ip") and (not arp_status or arp_status == "reachable"):
                ip_entries.append({"ip": _strip_prefix(entry["ip"]), "mac": entry.get("mac"),
                    "interface": entry.get("interface"), "source": entry.get("source", "api_arp"),
                    "is_primary": False})
        for lease in ext.get("dhcp", []):
            lease_status = str(lease.get("status", "")).strip().lower()
            dynamic_raw = lease.get("dynamic")
            is_permanent = dynamic_raw is False or str(dynamic_raw).strip().lower() in ("false", "0", "no")
            if lease.get("ip") and lease_status == "bound" and is_permanent:
                ip_entries.append({"ip": _strip_prefix(lease["ip"]), "mac": lease.get("mac"),
                    "interface": lease.get("server"), "source": "api_dhcp",
                    "is_primary": False})
        if ip_entries:
            try:
                src_pfx  = "api" if result.method == "api" else "snmp"
                ip_stats = await db.update_device_ips(pool, device_id, ip_entries, src_pfx)
                if ip_stats["changes"]:
                    log.info(f"device_ips {ip_str}: +{ip_stats['inserted']} "
                             f"~{ip_stats['updated']} -{ip_stats['released']} "
                             f"events={len(ip_stats['changes'])}")
                try:
                    sync_n = await db.sync_ip_addresses_from_device_ips(
                        pool, device_id=device_id,
                    )
                    await db.sync_ip_range_assignments(
                        pool,
                        ips=[e["ip"] for e in ip_entries if e.get("ip")],
                    )
                    if sync_n.get("upserted"):
                        log.info(
                            f"ip_addresses sync z pollu {ip_str}: "
                            f"{sync_n['upserted']} záznamů"
                        )
                except Exception as _se:
                    log.warning(f"ip_addresses sync po pollu: {_se}")
            except Exception as _ie:
                log.warning(f"device_ips update: {_ie}")


    # Uložíme rozšířená data (interfaces, ARP, DHCP) pokud byla sebrána
    if result.success and result.extended:
        for data_type, data in result.extended.items():
            if data:  # uložíme jen neprázdná data
                try:
                    await db.save_device_data(
                        pool, device_id, data_type, data,
                        source=result.method
                    )
                    log.info(f"Uloženo {data_type}: {len(data)} záznamů")
                except Exception as _de:
                    log.warning(f"Chyba ukládání {data_type}: {_de}")
    sl.write_bg(
        "INFO" if result.success else "ERROR",
        "netpulse.poller",
        "poll_ok" if result.success else "poll_fail",
        f"Poll {result.hostname or ip_str}: "
        f"{"OK" if result.success else "FAIL"} (method={result.method})",
        device_id = device_id,
        user_name = user.username,
        meta      = {"ip": ip_str, "method": result.method,
                     "hostname": result.hostname, "firmware": result.firmware,
                     "error": result.error},
    )

    return {
        "poll_id":              poll_id,
        "device_id":            device_id,
        "ip":                   ip_str,
        "method":               result.method,
        "success":              result.success,
        "hostname":             result.hostname,
        "model":                result.model,
        "vendor":               result.vendor,
        "firmware":             result.firmware,
        "uptime":               result.uptime,
        "uptime_s":             result.uptime_s,
        "serial":               result.serial,
        "software_id":          getattr(result, "software_id", None),
        "device_type_detected": getattr(result, "device_type_detected", None),
        "interfaces":           result.interfaces,
        "ports":                getattr(result, "ports", []),
        "system_info":          result.system_info,
        "error":                result.error,
    }


@app.get("/devices/{device_id}/poll-results", tags=["Devices"])
async def get_device_poll_results(
    device_id: int,
    limit:     int = 20,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """Vrátí historii poll výsledků pro zařízení."""
    return await db.get_poll_results(pool, device_id, limit)


@app.get("/devices/{device_id}/discovery-logs", tags=["Devices"])
async def get_device_discovery_logs(
    device_id: int,
    limit: int = 20,
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Vrátí historii discovery testů pro zařízení."""
    logs = await db.get_discovery_logs(pool, device_id, limit)
    return logs



# ===========================================================================
# BACKUP ENDPOINTY
# ===========================================================================

@app.post("/devices/{device_id}/backup", tags=["Backup"])
async def run_device_backup(
    device_id: int,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """
    Spustí export zálohu (.rsc) MikroTik zařízení.
    Zařízení musí mít last_polled_at a API nebo SSH credentials.
    """
    devices = await db.get_devices_with_credentials(pool)
    device  = next((d for d in devices if d["id"] == device_id), None)
    if not device:
        raise HTTPException(status_code=404, detail="Zařízení nenalezeno")

    if not device.get("last_polled_at"):
        raise HTTPException(
            status_code=400,
            detail="Záloha není dostupná — zařízení nebylo ještě polled"
        )

    usable_creds = [c for c in device["credentials"] if c.get("auth_type") in ("api", "ssh")]
    if not usable_creds:
        raise HTTPException(
            status_code=400,
            detail="Záloha vyžaduje API nebo SSH přihlašovací profil"
        )

    ip_str      = str(device["ip"]).split("/")[0]
    hostname    = device.get("hostname") or device.get("alias") or ip_str
    device_uuid = device["device_uuid"]

    log.info(f"Backup zahájen: device_id={device_id} ip={ip_str} user={user.username}")

    # Načteme credentials včetně šifrovaných hesel
    creds_with_pass = []
    for c in usable_creds:
        raw = await db.get_credential_raw(pool, c["id"])
        if raw:
            creds_with_pass.append(raw)

    # Záznam v DB — stav running
    backup_db_id = await db.create_backup_record(
        pool, device_id, "export",
        filename     = f"pending_{device_uuid}",
        filepath     = f"/backups/{device_uuid}/pending",
        triggered_by = user.username,
    )

    # Spustíme zálohu
    try:
        result = await bkp.backup_mikrotik(
            ip                      = ip_str,
            creds                   = creds_with_pass,
            cipher                  = cipher,
            device_uuid             = device_uuid,
            hostname                = hostname,
            triggered_by            = user.username,
            timeout                 = 90.0,
            last_successful_cred_id = device.get("last_successful_credential_id"),
            last_successful_auth    = device.get("last_successful_auth"),  # snapshot přihlášení
        )
    except Exception as e:
        err_str = str(e)[:400]
        await db.finish_backup_record(pool, backup_db_id, False, error_msg=err_str)
        raise HTTPException(status_code=500, detail=f"Záloha selhala: {err_str}")

    # Uložíme výsledek
    await db.finish_backup_record(
        pool, backup_db_id,
        success          = result.success,
        file_size_bytes  = result.file_size_bytes,
        mikrotik_version = result.mikrotik_version,
        duration_ms      = result.duration_ms,
        error_msg        = result.error if not result.success else None,
    )

    # Aktualizujeme filepath/filename na skutečné hodnoty
    if result.success and result.filepath:
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE device_backups SET filename=$2, filepath=$3 WHERE id=$1",
                backup_db_id, result.filename, str(result.filepath),
            )

    log.info(f"Backup dokončen device_id={device_id}: {'OK' if result.success else 'FAIL'}")
    sl.write_bg(
        "INFO" if result.success else "ERROR",
        "netpulse.backup",
        "backup_ok" if result.success else "backup_fail",
        f"Ruční backup {hostname}: {'OK' if result.success else 'FAIL'} "
        f"({result.file_size_bytes or 0}B)",
        device_id = device_id,
        user_name = user.username,
        meta      = {"ip": ip_str, "filename": result.filename,
                     "size_bytes": result.file_size_bytes,
                     "version": result.mikrotik_version,
                     "error": result.error},
    )

    return {
        "backup_id":        backup_db_id,
        "device_id":        device_id,
        "hostname":         hostname,
        "success":          result.success,
        "filename":         result.filename,
        "file_size_bytes":  result.file_size_bytes,
        "file_size_human":  bkp.format_file_size(result.file_size_bytes),
        "mikrotik_version": result.mikrotik_version,
        "duration_ms":      result.duration_ms,
        "error":            result.error,
    }


@app.get("/devices/{device_id}/backups", tags=["Backup"])
async def get_device_backups(
    device_id: int,
    limit:     int = 50,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """Vrátí seznam záloh konkrétního zařízení."""
    backups = await db.get_device_backups(pool, device_id, limit)
    for b in backups:
        b["file_size_human"] = bkp.format_file_size(b.get("file_size_bytes"))
    return backups


@app.get("/backups/stats", tags=["Backup"])
async def get_backup_stats(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Celkové statistiky záloh."""
    stats = await db.get_backup_stats(pool)
    stats["total_size_human"] = bkp.format_file_size(stats.get("total_bytes"))
    return stats


@app.get("/backups", tags=["Backup"])
async def get_all_backups(
    limit:  int = 200,
    status: str = None,
    user    = Depends(current_user),
    pool    = Depends(get_db),
):
    """Přehled všech záloh přes všechna zařízení."""
    backups = await db.get_all_backups(pool, limit=limit, status_filter=status)
    for b in backups:
        b["file_size_human"] = bkp.format_file_size(b.get("file_size_bytes"))
    return backups


@app.get("/backups/{backup_id}/download", tags=["Backup"])
async def download_backup(
    backup_id: int,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """Stáhne soubor zálohy."""
    from pathlib import Path
    record = await db.get_backup_by_id(pool, backup_id)
    if not record:
        raise HTTPException(status_code=404, detail="Záloha nenalezena")
    if record["status"] != "ok":
        raise HTTPException(status_code=400, detail="Záloha není ve stavu OK")
    filepath = Path(record["filepath"])
    if not filepath.exists():
        raise HTTPException(status_code=404, detail=f"Soubor neexistuje: {filepath}")
    return FileResponse(
        path       = str(filepath),
        filename   = record["filename"],
        media_type = "application/octet-stream",
    )


@app.delete("/backups/{backup_id}", tags=["Backup"])
async def delete_backup(
    backup_id: int,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """Smaže zálohu z DB a disku."""
    from pathlib import Path
    record = await db.get_backup_by_id(pool, backup_id)
    if not record:
        raise HTTPException(status_code=404, detail="Záloha nenalezena")
    filepath    = Path(record["filepath"])
    deleted_file = False
    if filepath.exists():
        try:
            filepath.unlink()
            deleted_file = True
        except Exception as e:
            log.warning(f"Nelze smazat soubor {filepath}: {e}")
    await db.delete_backup_record(pool, backup_id)
    return {"backup_id": backup_id, "deleted_file": deleted_file}


@app.post("/scan/trigger-backup", tags=["Backup"])
async def trigger_backup_scan(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Spustí backup scheduler okamžitě pro všechna způsobilá zařízení."""
    config = await db.get_config_db(pool)
    await scheduler.trigger_backup_now(pool, config, triggered_by=user.username)
    return {"status": "started", "triggered_by": user.username}


@app.patch("/devices/{device_id}/backup-settings", tags=["Backup"])
async def update_device_backup_settings(
    device_id:      int,
    backup_enabled: bool = Body(..., embed=True),
    user            = Depends(current_user),
    pool            = Depends(get_db),
):
    """Nastaví individuální backup pro zařízení (zapnout/vypnout)."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE devices SET backup_enabled=$2 WHERE id=$1",
            device_id, backup_enabled,
        )
    return {"device_id": device_id, "backup_enabled": backup_enabled}


# ===========================================================================
# SYSTEM LOGS ENDPOINTY (pouze admin)
# ===========================================================================

@app.get("/system-logs", tags=["SystemLogs"])
async def get_system_logs(
    limit:      int           = 200,
    level:      str           = None,
    module:     str           = None,
    event_type: str           = None,
    device_id:  int           = None,
    search:     str           = None,
    hours:      int           = None,
    user        = Depends(admin_only),
    pool        = Depends(get_db),
):
    """Vrátí systémové logy. Pouze pro administrátory."""
    return await sl.get_logs(
        pool, limit=limit, level=level, module=module,
        event_type=event_type, device_id=device_id,
        search=search, hours=hours,
    )


@app.get("/system-logs/stats", tags=["SystemLogs"])
async def get_system_log_stats(
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    """Statistiky systémových logů."""
    stats   = await sl.get_log_stats(pool)
    modules = await sl.get_distinct_modules(pool)
    events  = await sl.get_distinct_event_types(pool)
    return {"stats": stats, "modules": modules, "event_types": events}


@app.delete("/system-logs/cleanup", tags=["SystemLogs"])
async def cleanup_system_logs(
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    """Ručně spustí cleanup starých systémových logů."""
    cfg     = await db.get_config_db(pool)
    deleted = await sl.cleanup_old_logs(pool, cfg)
    return {"deleted": deleted, "total": sum(deleted.values())}


# ===========================================================================
# DEVICE DATA — rozšířená data ze zařízení (interfaces, ARP, DHCP)
# ===========================================================================

@app.get("/devices/{device_id}/data", tags=["Devices"])
async def get_device_data_all(
    device_id: int,
    user      = Depends(current_user),
    pool      = Depends(get_db),
):
    """Vrátí všechna rozšířená data zařízení (interfaces, ARP, DHCP)."""
    return await db.get_all_device_data(pool, device_id)


@app.get("/devices/{device_id}/data/{data_type}", tags=["Devices"])
async def get_device_data_type(
    device_id: int,
    data_type: str,
    user      = Depends(current_user),
    pool      = Depends(get_db),
):
    """Vrátí nejnovější data daného typu pro zařízení."""
    result = await db.get_device_data(pool, device_id, data_type)
    if not result:
        raise HTTPException(status_code=404, detail=f"Žádná data typu '{data_type}'")
    return result


@app.patch("/devices/{device_id}/cron-poll", tags=["Devices"])
async def update_device_cron_poll(
    device_id:  int,
    cron_poll:  bool = Body(..., embed=True),
    user        = Depends(admin_only),
    pool        = Depends(get_db),
):
    """Nastaví povolení cron pollu pro zařízení."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE devices SET cron_poll=$2 WHERE id=$1",
            device_id, cron_poll,
        )
    return {"device_id": device_id, "cron_poll": cron_poll}


# ===========================================================================
# DEVICE IPs — IP adresy zařízení + historie změn
# ===========================================================================

@app.get("/devices/{device_id}/ips", tags=["Devices"])
async def get_device_ips(
    device_id: int,
    user      = Depends(current_user),
    pool      = Depends(get_db),
):
    """Vrátí aktuální IP adresy zařízení (vlastní + klienti z ARP/DHCP)."""
    return await db.get_device_ips(pool, device_id)


@app.get("/devices/{device_id}/ips/history", tags=["Devices"])
async def get_device_ip_history(
    device_id: int,
    limit:     int = 200,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """Vrátí historii změn IP adres zařízení."""
    return await db.get_device_ip_history(pool, device_id, limit)


@app.get("/ips/{ip}/owner", tags=["Devices"])
async def get_ip_owner(
    ip:   str,
    user  = Depends(current_user),
    pool  = Depends(get_db),
):
    """Vrátí zařízení které vlastní danou IP adresu."""
    result = await db.get_ip_owner(pool, ip)
    if not result:
        raise HTTPException(status_code=404, detail="IP není přiřazena žádnému zařízení")
    return result


@app.get("/devices/{device_id}/ips/stats", tags=["Devices"])
async def get_device_ip_stats(
    device_id: int,
    hours:     int = 24,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """Vrátí statistiky změn IP za posledních N hodin."""
    return await db.get_ip_changes_stats(pool, device_id, hours)


@app.post("/poll/trigger", tags=["Poll"])
async def trigger_poll_scan(
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    """Ručně spustí poll pro všechna zařízení s cron_poll=True."""
    cfg = await db.get_config_db(pool)
    asyncio.create_task(
        scheduler.run_poll_scan(pool, cfg, trigger_type="manual")
    )
    return {"status": "started"}


@app.get("/hosts/ip-device-map", tags=["Hosts"])
async def get_ip_device_map(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Vrátí mapu IP → zařízení pro zobrazení v hosts tabulce."""
    return await db.get_ip_device_map(pool)


# ---------------------------------------------------------------------------
# Scan exclusions — IP vyloučené ze scanu
# ---------------------------------------------------------------------------
@app.get("/scan-exclusions", tags=["Scan"])
async def list_scan_exclusions(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    return await db.get_scan_exclusions(pool)


@app.post("/scan-exclusions", tags=["Scan"])
async def add_scan_exclusion(
    body: ScanExclusionCreate,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    return await db.add_scan_exclusion(pool, body.ip, body.reason, user.username)


@app.delete("/scan-exclusions/{exclusion_id}", tags=["Scan"])
async def remove_scan_exclusion(
    exclusion_id: int,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    ok = await db.remove_scan_exclusion(pool, exclusion_id)
    if not ok:
        raise HTTPException(status_code=404, detail="Výjimka nenalezena")
    return {"status": "deleted", "id": exclusion_id}


# ---------------------------------------------------------------------------
# Sites — logické sítě
# ---------------------------------------------------------------------------
@app.get("/sites", response_model=List[SiteModel], tags=["Sites"])
async def list_sites(user=Depends(current_user), pool=Depends(get_db)):
    return await db.get_sites(pool)


@app.post("/sites", response_model=SiteModel, tags=["Sites"])
async def create_site(
    body: SiteCreate,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    return await db.create_site(pool, body.name, body.description, body.color)


@app.put("/sites/{site_id}", response_model=SiteModel, tags=["Sites"])
async def update_site(
    site_id: int,
    body: SiteUpdate,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    row = await db.update_site(
        pool, site_id, body.name, body.description, body.color, body.active,
    )
    if not row:
        raise HTTPException(status_code=404, detail="Síť nenalezena")
    return row


@app.delete("/sites/{site_id}", tags=["Sites"])
async def delete_site(
    site_id: int,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    await db.delete_site(pool, site_id)
    return {"status": "deleted", "id": site_id}


@app.get("/ip-addresses", tags=["Hosts"])
async def list_ip_addresses(
    alive_only: bool = False,
    range_id:   Optional[int] = None,
    limit:      int = Query(5000, ge=1, le=20000),
    user        = Depends(current_user),
    pool        = Depends(get_db),
):
    return await db.get_ip_addresses(pool, alive_only, range_id, limit)


@app.post("/ip-addresses/refresh", tags=["Hosts"])
async def refresh_ip_addresses(
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    return await db.refresh_ip_addresses(pool)


@app.post("/ip-addresses/sync-ranges", tags=["Hosts"])
async def sync_ip_ranges(
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    """
    Zpětně přiřadí ip_addresses.range_id podle ip_ranges (a tím síť/site).
    Volat po migraci nebo změně rozsahů.
    """
    return await db.backfill_ip_range_assignments(pool)


@app.get("/unknown-networks", tags=["Hosts"])
async def get_unknown_networks(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    return await db.get_unknown_networks(pool)


@app.get("/unknown-networks/{subnet:path}", tags=["Hosts"])
async def get_unknown_network_ips(
    subnet: str,
    user   = Depends(current_user),
    pool   = Depends(get_db),
):
    return await db.get_unknown_network_ips(pool, subnet)


@app.get("/ip-presence/{ip:path}", tags=["Hosts"])
async def get_ip_presence(
    ip:    str,
    hours: int = Query(24, ge=1, le=168),
    user   = Depends(current_user),
    pool   = Depends(get_db),
):
    return await db.get_ip_presence(pool, ip, hours)


@app.get("/hosts/enriched", tags=["Hosts"])
async def get_hosts_enriched(
    site_id:  Optional[int] = Query(None),
    range_id: Optional[int] = Query(None),
    status:   Optional[str] = Query(None),
    device:   Optional[str] = Query(None),
    search:   Optional[str] = Query(None),
    limit:    int           = Query(100, ge=1, le=500),
    offset:   int           = Query(0, ge=0),
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """IP adresy se statistikami, filtrováním a agregovanými metrikami."""
    return await db.get_hosts_enriched(
        pool,
        site_id=site_id,
        range_id=range_id,
        status=status,
        device=device,
        search=search,
        limit=limit,
        offset=offset,
    )


# ===========================================================================
# KONFIGURACE — číselníky
# ===========================================================================

@app.get("/config/lists", tags=["Config"])
async def get_all_config_lists(
    user = Depends(current_user),
    pool = Depends(get_db),
):
    """Vrátí všechny číselníky seskupené podle kategorie."""
    return await db.get_all_config_lists(pool)


@app.get("/config/lists/{category}", tags=["Config"])
async def get_config_list(
    category:    str,
    active_only: bool = Query(True),
    user = Depends(current_user),
    pool = Depends(get_db),
):
    return await db.get_config_list(pool, category, active_only)


@app.post("/config/lists", tags=["Config"])
async def create_config_item(
    data: dict,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    return await db.create_config_item(
        pool,
        category   = data["category"],
        value      = data["value"],
        label      = data["label"],
        color      = data.get("color"),
        sort_order = data.get("sort_order", 0),
    )


@app.put("/config/lists/{item_id}", tags=["Config"])
async def update_config_item(
    item_id: int,
    data:    dict,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    return await db.update_config_item(
        pool, item_id,
        label      = data["label"],
        color      = data.get("color"),
        sort_order = data.get("sort_order", 0),
        active     = data.get("active", True),
    )


@app.delete("/config/lists/{item_id}", tags=["Config"])
async def delete_config_item(
    item_id: int,
    user = Depends(admin_only),
    pool = Depends(get_db),
):
    try:
        await db.delete_config_item(pool, item_id)
        return {"status": "ok"}
    except ValueError as e:
        raise HTTPException(400, str(e))
