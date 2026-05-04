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
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

import auth
import db
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
    }
    for key in updates:
        if key not in allowed:
            raise HTTPException(status_code=400, detail=f"Neznámý klíč: {key}")
        await db.set_config_value(pool, key, str(updates[key]))
    # Restartujeme scheduler při změně ping nebo discovery konfigurace
    if any(k in updates for k in ("scan_interval_s", "discovery_enabled",
                                   "discovery_interval_s", "discovery_only_online")):
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

@app.delete("/ranges/{range_id}", tags=["Ranges"])
async def delete_range(range_id: int, user=Depends(admin_only), pool=Depends(get_db)):
    await db.delete_ip_range(pool, range_id)
    return {"status": "deleted", "id": range_id}

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
    device_id: int,
    user       = Depends(current_user),
    pool       = Depends(get_db),
):
    """
    Přečte data ze zařízení pomocí přiřazených přihlašovacích profilů.
    Priorita metod: api → snmp → ssh → http
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
    result = await poller.poll_device(
        ip      = ip_str,
        creds   = device["credentials"],
        cipher  = cipher,
        timeout = 20.0,
        vendor  = vendor,
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
        successful_credential_id = result.credential_id,  # ID úspěšného profilu
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

