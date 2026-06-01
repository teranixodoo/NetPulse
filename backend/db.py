# backend/db.py — PostgreSQL přístup přes asyncpg
from __future__ import annotations
import asyncpg
from typing import Optional, List, Any
import hashlib
import uuid
from datetime import datetime, timedelta, timezone
from models import (
    PingResultModel, HostStatsModel, RttTrendPoint,
    AppConfigModel, IpRangeModel, OutageEvent,
    DeviceCreate, Credential,
)


# ---------------------------------------------------------------------------
# Pool
# ---------------------------------------------------------------------------

_pool: Optional[asyncpg.Pool] = None


async def init_pool(db_url: str) -> asyncpg.Pool:
    global _pool
    _pool = await asyncpg.create_pool(
        db_url,
        min_size=2,
        max_size=10,
        command_timeout=30,
    )
    return _pool


async def get_pool() -> asyncpg.Pool:
    """FastAPI dependency."""
    if _pool is None:
        raise RuntimeError("DB pool není inicializován")
    return _pool


async def close_pool():
    if _pool:
        await _pool.close()


# ---------------------------------------------------------------------------
# Ping výsledky
# ---------------------------------------------------------------------------

async def save_results(pool: asyncpg.Pool, results: list) -> None:
    """Hromadný INSERT ping výsledků."""
    rows = [
        (
            str(r.ip), r.is_alive, r.rtt_ms,
            r.packet_loss, r.jitter_ms, r.scanned_at,
        )
        for r in results
    ]
    async with pool.acquire() as conn:
        await conn.executemany(
            """
            INSERT INTO ping_results (ip, is_alive, rtt_ms, packet_loss, jitter_ms, scanned_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            """,
            rows,
        )


async def get_host_stats(pool: asyncpg.Pool) -> List[HostStatsModel]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM host_stats_24h ORDER BY uptime_pct ASC")
    return [
        HostStatsModel(
            ip              = r["ip"],
            checks          = r["checks"],
            uptime_pct      = float(r["uptime_pct"] or 0),
            avg_rtt_ms      = float(r["avg_rtt_ms"]) if r["avg_rtt_ms"] else None,
            min_rtt_ms      = float(r["min_rtt_ms"]) if r["min_rtt_ms"] else None,
            max_rtt_ms      = float(r["max_rtt_ms"]) if r["max_rtt_ms"] else None,
            avg_loss_pct    = float(r["avg_loss_pct"] or 0),
            last_check      = r["last_check"],
            currently_alive = bool(r["currently_alive"]),
        )
        for r in rows
    ]


async def get_rtt_trend(
    pool:    asyncpg.Pool,
    ip:      str,
    hours:   int = 24,
    limit:   int = 1000,
) -> List[RttTrendPoint]:
    """
    Vrátí RTT trend pro danou IP.
    Pro krátké periody (<=48h): raw data.
    Pro delší periody: agregace do intervalů pro přehlednost.
    """
    since = datetime.now(timezone.utc) - timedelta(hours=hours)

    # Pro dlouhé periody agregujeme do intervalů
    if hours > 48:
        # Počet bodů = limit, interval = hours/limit minut
        interval_min = max(1, int((hours * 60) / limit))
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                f"""
                SELECT
                    date_trunc('minute', scanned_at) -
                        (EXTRACT(MINUTE FROM scanned_at)::int % {interval_min}) * interval '1 minute'
                        AS bucket,
                    AVG(rtt_ms)      AS rtt_ms,
                    AVG(packet_loss) AS packet_loss,
                    BOOL_AND(is_alive) AS is_alive
                FROM ping_results
                WHERE ip = $1::inet AND scanned_at > $2
                GROUP BY bucket
                ORDER BY bucket ASC
                LIMIT $3
                """,
                ip, since, limit,
            )
    else:
        async with pool.acquire() as conn:
            rows = await conn.fetch(
                """
                SELECT scanned_at AS bucket, rtt_ms, packet_loss, is_alive
                FROM ping_results
                WHERE ip = $1::inet AND scanned_at > $2
                ORDER BY scanned_at ASC
                LIMIT $3
                """,
                ip, since, limit,
            )

    return [
        RttTrendPoint(
            ts          = r["bucket"],
            rtt_ms      = float(r["rtt_ms"]) if r["rtt_ms"] is not None else None,
            alive       = bool(r["is_alive"]),
            packet_loss = float(r["packet_loss"]) if r["packet_loss"] is not None else 0.0,
        )
        for r in rows
    ]


async def get_recent_results(pool: asyncpg.Pool, limit: int = 1000) -> List[PingResultModel]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (ip) ip::text, is_alive, rtt_ms, packet_loss, jitter_ms, scanned_at
            FROM ping_results
            ORDER BY ip, scanned_at DESC
            LIMIT $1
            """,
            limit,
        )
    return [
        PingResultModel(
            ip          = r["ip"],
            is_alive    = r["is_alive"],
            rtt_ms      = r["rtt_ms"],
            packet_loss = r["packet_loss"] or 0.0,
            jitter_ms   = r["jitter_ms"],
            scanned_at  = r["scanned_at"],
        )
        for r in rows
    ]


async def get_outages(pool: asyncpg.Pool, hours: int = 24) -> List[OutageEvent]:
    hours = min(hours, 6)  # max 6h okno pro výkon
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    try:
        async with pool.acquire(timeout=10.0) as conn:
            rows = await conn.fetch(
                """
                SELECT ip::text, scanned_at
                FROM (
                    SELECT ip::text, scanned_at, is_alive,
                           LAG(is_alive) OVER (PARTITION BY ip ORDER BY scanned_at) AS prev_alive
                    FROM ping_results
                    WHERE scanned_at > $1
                ) sub
                WHERE is_alive = FALSE AND prev_alive = TRUE
                ORDER BY scanned_at DESC
                LIMIT 100
                """,
                since,
                timeout=15.0,
            )
        return [
            OutageEvent(ip=r["ip"], started_at=r["scanned_at"], ended_at=None, duration_s=None)
            for r in rows
        ]
    except Exception:
        return []


async def cleanup_old_data(pool: asyncpg.Pool, retention_days: int) -> int:
    async with pool.acquire() as conn:
        result = await conn.execute(
            "DELETE FROM ping_results WHERE scanned_at < NOW() - ($1 || ' days')::interval",
            str(retention_days),
        )
    deleted = int(result.split()[-1])
    return deleted


# ---------------------------------------------------------------------------
# Konfigurace
# ---------------------------------------------------------------------------

async def get_config_db(pool: asyncpg.Pool) -> dict:
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT key, value FROM app_config")
    return {r["key"]: r["value"] for r in rows}


async def set_config_value(pool: asyncpg.Pool, key: str, value: str) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO app_config (key, value, updated_at)
            VALUES ($1, $2, NOW())
            ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = NOW()
            """,
            key, value,
        )


# ---------------------------------------------------------------------------
# IP rozsahy
# ---------------------------------------------------------------------------

async def get_ip_ranges(pool: asyncpg.Pool) -> List[IpRangeModel]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, label, network::text, active FROM ip_ranges ORDER BY id"
        )
    return [IpRangeModel(id=r["id"], label=r["label"], network=r["network"], active=r["active"])
            for r in rows]


async def upsert_ip_range(pool: asyncpg.Pool, rng: IpRangeModel) -> IpRangeModel:
    async with pool.acquire() as conn:
        if rng.id:
            await conn.execute(
                "UPDATE ip_ranges SET label=$1, network=$2::cidr, active=$3, description=$5, site_id=$6 WHERE id=$4",
                rng.label, rng.network, rng.active, rng.id, rng.description, rng.site_id,
            )
            return rng
        else:
            row = await conn.fetchrow(
                "INSERT INTO ip_ranges (label, network, active, description, site_id) VALUES ($1, $2::cidr, $3, $4, $5) RETURNING id",
                rng.label, rng.network, rng.active, rng.description, rng.site_id,
            )
            return rng.model_copy(update={"id": row["id"]})


async def delete_ip_range(pool: asyncpg.Pool, range_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM ip_ranges WHERE id=$1", range_id)


# ---------------------------------------------------------------------------
# Uživatelé
# ---------------------------------------------------------------------------

async def get_user_by_username(pool: asyncpg.Pool, username: str) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, username, password_hash, role FROM api_users WHERE username=$1",
            username,
        )
    return dict(row) if row else None


async def create_user(pool: asyncpg.Pool, username: str, password_hash: str, role: str) -> int:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO api_users (username, password_hash, role) VALUES ($1, $2, $3) RETURNING id",
            username, password_hash, role,
        )
    return row["id"]


async def verify_api_key_db(pool: asyncpg.Pool, key_hash: str) -> Optional[dict]:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT u.id, u.username, u.role
            FROM api_keys k JOIN api_users u ON k.user_id = u.id
            WHERE k.key_hash = $1 AND k.active = TRUE
            """,
            key_hash,
        )
        if row:
            await conn.execute(
                "UPDATE api_keys SET last_used=NOW() WHERE key_hash=$1", key_hash
            )
    return dict(row) if row else None

async def get_devices(pool) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM devices ORDER BY hostname ASC")
        return [dict(r) for r in rows]

async def add_device(pool, dev: DeviceCreate) -> dict:
    async with pool.acquire() as conn:
        # 1. Pokus o nalezení existujícího zařízení (Priorita: MAC -> Hostname)
        existing = None
        if dev.mac:
            existing = await conn.fetchrow("SELECT * FROM devices WHERE mac = $1", dev.mac)
        
        if not existing and dev.hostname and dev.hostname != "unknown":
            existing = await conn.fetchrow(
                "SELECT * FROM devices WHERE hostname = $1 AND mac IS NULL", 
                dev.hostname
            )

        # 2. Generování nebo použití UUID
        if existing:
            device_uuid = existing["device_uuid"]
        else:
            # Vytvoření unikátního otisku (Fingerprint) pro nové zařízení
            fingerprint_raw = f"{dev.mac or ''}-{dev.hostname or ''}-{uuid.uuid4()}"
            device_uuid = hashlib.sha256(fingerprint_raw.encode()).hexdigest()[:16]

        # 3. UPSERT do databáze
        row = await conn.fetchrow("""
            INSERT INTO devices (device_uuid, ip, mac, hostname, device_type, description, alias)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (device_uuid) DO UPDATE 
            SET ip = EXCLUDED.ip,
                mac = COALESCE(devices.mac, EXCLUDED.mac),
                hostname = EXCLUDED.hostname,
                device_type = EXCLUDED.device_type,
                description = EXCLUDED.description,
                alias = EXCLUDED.alias
            RETURNING *
        """, device_uuid, dev.ip, dev.mac, dev.hostname, dev.device_type, dev.description, dev.alias)
        
        return dict(row)

# ---------------------------------------------------------------------------
# Credentials — trezor přihlašovacích profilů
# ---------------------------------------------------------------------------

async def get_credentials(pool: asyncpg.Pool) -> list[dict]:
    """Seznam všech profilů BEZ hesla."""
    import json as _json
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, auth_type, username, port, extra_params FROM credentials ORDER BY name"
        )
    result = []
    for r in rows:
        d = dict(r)
        # extra_params může přijít jako string — deserializujeme
        if isinstance(d.get("extra_params"), str):
            try:
                d["extra_params"] = _json.loads(d["extra_params"] or "{}")
            except Exception:
                d["extra_params"] = {}
        elif d.get("extra_params") is None:
            d["extra_params"] = {}
        result.append(d)
    return result


async def create_credential(
    pool: asyncpg.Pool,
    name: str,
    auth_type: str,
    username: Optional[str],
    password_cipher: str,
    port: Optional[int],
    extra_params: str,
) -> int:
    async with pool.acquire() as conn:
        return await conn.fetchval(
            """
            INSERT INTO credentials (name, auth_type, username, password_cipher, port, extra_params)
            VALUES ($1, $2, $3, $4, $5, $6::jsonb)
            RETURNING id
            """,
            name, auth_type, username, password_cipher, port, extra_params,
        )


async def delete_credential(pool: asyncpg.Pool, credential_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM credentials WHERE id=$1", credential_id)


async def link_device_credential(pool: asyncpg.Pool, device_id: int, credential_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "INSERT INTO device_credentials (device_id, credential_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
            device_id, credential_id,
        )


async def unlink_device_credential(pool: asyncpg.Pool, device_id: int, credential_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM device_credentials WHERE device_id=$1 AND credential_id=$2",
            device_id, credential_id,
        )


async def get_devices_with_credentials(pool: asyncpg.Pool) -> list[dict]:
    """Zařízení včetně přiřazených profilů (bez hesel)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                d.id, d.device_uuid, d.ip::text, d.hostname, d.mac::text,
                d.device_type, d.description, d.alias,
                d.vendor, d.serial_number,
                d.firmware, d.model, d.last_uptime_s, d.last_uptime_str, d.last_polled_at, d.last_poll_method, d.last_successful_credential_id, d.last_successful_auth, d.backup_enabled, d.backup_schedule, d.cron_poll,
                d.created_at, d.updated_at,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', c.id, 'name', c.name,
                            'auth_type', c.auth_type, 'username', c.username,
                            'port', c.port,
                            'password_cipher', c.password_cipher,
                            'extra_params', c.extra_params
                        )
                    ) FILTER (WHERE c.id IS NOT NULL),
                    '[]'
                ) AS credentials
            FROM devices d
            LEFT JOIN device_credentials dc ON dc.device_id = d.id
            LEFT JOIN credentials c ON c.id = dc.credential_id
            GROUP BY d.id
            ORDER BY d.hostname
            """
        )
    result = []
    for r in rows:
        d = dict(r)
        import json as _json
        d["credentials"] = _json.loads(d["credentials"]) if isinstance(d["credentials"], str) else d["credentials"]
        # Deserializujeme extra_params v každém credentialu
        for cred in (d["credentials"] or []):
            if isinstance(cred.get("extra_params"), str):
                try:
                    cred["extra_params"] = _json.loads(cred["extra_params"] or "{}")
                except Exception:
                    cred["extra_params"] = {}
            elif cred.get("extra_params") is None:
                cred["extra_params"] = {}
        # Deserializujeme JSONB last_successful_auth — asyncpg může vrátit string nebo dict
        auth = d.get("last_successful_auth")
        if isinstance(auth, str):
            try:
                parsed = _json.loads(auth)
                if isinstance(parsed, str):
                    parsed = _json.loads(parsed)
                d["last_successful_auth"] = parsed if isinstance(parsed, dict) else None
            except Exception:
                d["last_successful_auth"] = None
        result.append(d)
    return result


async def update_device(pool: asyncpg.Pool, device_id: int, dev: "DeviceCreate") -> dict:
    """Aktualizuje existující zařízení dle ID."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE devices
            SET ip            = $2,
                hostname      = $3,
                mac           = $4,
                device_type   = $5,
                description   = $6,
                alias         = $7,
                vendor        = $8,
                serial_number = $9,
                updated_at    = NOW()
            WHERE id = $1
            RETURNING id, device_uuid, ip::text, hostname, mac::text,
                      device_type, description, alias, vendor, serial_number,
                      created_at, updated_at
            """,
            device_id,
            str(dev.ip),
            dev.hostname,
            dev.mac,
            dev.device_type,
            dev.description,
            dev.alias,
            dev.vendor,
            dev.serial_number,
        )
        if not row:
            raise ValueError(f"Zařízení id={device_id} nenalezeno")
        return dict(row)


async def delete_device(pool: asyncpg.Pool, device_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM devices WHERE id = $1", device_id)


async def patch_device(pool: asyncpg.Pool, device_id: int, patch: dict) -> None:
    """
    Aktualizuje jen pole která jsou v patch dict.
    Pole s hodnotou None přeskočí — zachová původní hodnotu.
    Bezpečný pro částečný update (discovery výsledky).
    """
    allowed = {"hostname", "mac", "device_type", "description", "alias", "ip"}
    fields  = {k: v for k, v in patch.items() if k in allowed and v is not None}
    if not fields:
        return

    # Dynamicky sestavíme SET klauzuli
    assignments = []
    values      = [device_id]
    for i, (col, val) in enumerate(fields.items(), start=2):
        if col == "mac":
            assignments.append(f"mac = ${i}::macaddr")
        else:
            assignments.append(f"{col} = ${i}")
        values.append(val)

    sql = f"""
        UPDATE devices
        SET {', '.join(assignments)}, updated_at = NOW()
        WHERE id = $1
    """
    async with pool.acquire() as conn:
        await conn.execute(sql, *values)


# ---------------------------------------------------------------------------
# Discovery logy
# ---------------------------------------------------------------------------

async def save_discovery_log(
    pool:          asyncpg.Pool,
    device_id:     int,
    ip:            str,
    layers:        list[dict],   # [{layer, status, result, note}]
    open_ports:    list[int],
    services:      dict,
    patch_applied: dict,
) -> int:
    """Uloží výsledek discovery testu jako log záznam."""
    import json as _json
    async with pool.acquire() as conn:
        row_id = await conn.fetchval(
            """
            INSERT INTO device_discovery_logs
                (device_id, ip, layers, open_ports, services, patch_applied)
            VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)
            RETURNING id
            """,
            device_id,
            ip,
            _json.dumps(layers, ensure_ascii=False),
            open_ports,
            _json.dumps(services, ensure_ascii=False),
            _json.dumps(patch_applied, ensure_ascii=False),
        )
    return row_id


async def get_discovery_logs(
    pool:      asyncpg.Pool,
    device_id: int,
    limit:     int = 20,
) -> list[dict]:
    """Vrátí discovery logy pro zařízení, nejnovější první."""
    import json as _json
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, device_id, tested_at, ip,
                   layers::text, open_ports,
                   services::text, patch_applied::text
            FROM device_discovery_logs
            WHERE device_id = $1
            ORDER BY tested_at DESC
            LIMIT $2
            """,
            device_id, limit,
        )
    result = []
    for r in rows:
        d = dict(r)
        d["layers"]        = _json.loads(d["layers"])
        d["services"]      = _json.loads(d["services"])
        d["patch_applied"] = _json.loads(d["patch_applied"])
        result.append(d)
    return result


# ---------------------------------------------------------------------------
# Správa uživatelů (admin)
# ---------------------------------------------------------------------------

async def get_all_users(pool: asyncpg.Pool) -> list:
    """Vrátí seznam všech uživatelů (bez password_hash)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, username, role, email, active, created_at
               FROM api_users ORDER BY id"""
        )
    return [dict(r) for r in rows]


async def update_user(pool: asyncpg.Pool, user_id: int,
                      role: str = None, email: str = None,
                      active: bool = None, new_password_hash: str = None) -> dict:
    """Aktualizuje uživatele — jen zadané pole."""
    async with pool.acquire() as conn:
        if role is not None:
            await conn.execute(
                "UPDATE api_users SET role=$1 WHERE id=$2", role, user_id)
        if email is not None:
            await conn.execute(
                "UPDATE api_users SET email=$1 WHERE id=$2", email, user_id)
        if active is not None:
            await conn.execute(
                "UPDATE api_users SET active=$1 WHERE id=$2", active, user_id)
        if new_password_hash is not None:
            await conn.execute(
                "UPDATE api_users SET password_hash=$1 WHERE id=$2",
                new_password_hash, user_id)
        row = await conn.fetchrow(
            "SELECT id, username, role, email, active, created_at FROM api_users WHERE id=$1",
            user_id)
    return dict(row) if row else {}


async def delete_user(pool: asyncpg.Pool, user_id: int) -> bool:
    """Smaže uživatele."""
    async with pool.acquire() as conn:
        result = await conn.execute("DELETE FROM api_users WHERE id=$1", user_id)
    return result == "DELETE 1"


async def get_user_api_keys(pool: asyncpg.Pool, user_id: int) -> list:
    """Vrátí API klíče uživatele (bez hash)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """SELECT id, description, created_at, last_used, active
               FROM api_keys WHERE user_id=$1 ORDER BY created_at DESC""",
            user_id)
    return [dict(r) for r in rows]


async def deactivate_api_key(pool: asyncpg.Pool, key_id: int) -> bool:
    """Deaktivuje API klíč."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            "UPDATE api_keys SET active=FALSE WHERE id=$1", key_id)
    return result == "UPDATE 1"


# ---------------------------------------------------------------------------
# Scan jobs — log scanování
# ---------------------------------------------------------------------------

async def scan_job_start(
    pool: asyncpg.Pool,
    job_type:     str,
    trigger_type: str,
    triggered_by: str = "scheduler",
    total_targets: int = 0,
    meta: dict = None,
) -> int:
    """Zapíše začátek scanu, vrátí ID jobu."""
    import json as _json
    async with pool.acquire() as conn:
        job_id = await conn.fetchval(
            """
            INSERT INTO scan_jobs
                (job_type, trigger_type, triggered_by, started_at, status, total_targets, meta)
            VALUES ($1, $2, $3, NOW(), 'running', $4, $5)
            RETURNING id
            """,
            job_type, trigger_type, triggered_by,
            total_targets,
            _json.dumps(meta or {}),
        )
    return job_id


async def scan_job_finish(
    pool: asyncpg.Pool,
    job_id:       int,
    status:       str  = "done",
    ok_count:     int  = 0,
    fail_count:   int  = 0,
    changed_count:int  = 0,
    error_msg:    str  = None,
) -> None:
    """Ukončí scan job — zapíše výsledky a dobu trvání."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE scan_jobs SET
                finished_at   = NOW(),
                duration_s    = EXTRACT(EPOCH FROM (NOW() - started_at)),
                status        = $2,
                ok_count      = $3,
                fail_count    = $4,
                changed_count = $5,
                error_msg     = $6
            WHERE id = $1
            """,
            job_id, status, ok_count, fail_count, changed_count, error_msg,
        )


async def scan_job_heartbeat(pool, job_id: int) -> None:
    """Aktualizuje heartbeat timestamp pro běžící job."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE scan_jobs SET heartbeat_at = NOW() WHERE id = $1 AND status = 'running'",
            job_id,
        )


async def cleanup_zombie_jobs(pool) -> int:
    """
    Označí jako error joby které přestaly posílat heartbeat (> 2 minuty)
    nebo jsou running déle než 30 minut bez heartbeatu.
    Vrátí počet opravených jobů.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE scan_jobs
            SET status    = 'error',
                finished_at = NOW(),
                error_msg  = 'Zombie — ztráta heartbeatu'
            WHERE status = 'running'
              AND (
                  -- Má heartbeat ale přestal aktualizovat > 2 min
                  (heartbeat_at IS NOT NULL AND heartbeat_at < NOW() - INTERVAL '2 minutes')
                  OR
                  -- Nikdy neposlal heartbeat a běží > 10 min
                  (heartbeat_at IS NULL AND started_at < NOW() - INTERVAL '10 minutes')
              )
            """,
        )
        # asyncpg vrátí "UPDATE N"
        count = int(result.split()[-1]) if result else 0
        return count


async def mark_startup_zombies(pool) -> int:
    """Při startu backendu opraví všechny running joby → error."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE scan_jobs
            SET status = 'error',
                finished_at = NOW(),
                error_msg = 'Zombie — backend restart'
            WHERE status = 'running'
            """
        )
        count = int(result.split()[-1]) if result else 0
        return count


async def get_scan_jobs(
    pool:     asyncpg.Pool,
    job_type: str  = None,
    limit:    int  = 100,
    offset:   int  = 0,
) -> list[dict]:
    """Vrátí historii scan jobů."""
    import json as _json
    where = "WHERE job_type = $3" if job_type else ""
    params = [limit, offset]
    if job_type:
        params.append(job_type)

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT id, job_type, trigger_type, triggered_by,
                   started_at, finished_at,
                   ROUND(duration_s::numeric, 1) AS duration_s,
                   status, total_targets, ok_count, fail_count,
                   changed_count, error_msg, meta::text
            FROM scan_jobs
            {where}
            ORDER BY started_at DESC
            LIMIT $1 OFFSET $2
            """,
            *params,
        )

    result = []
    for r in rows:
        d = dict(r)
        d["meta"] = _json.loads(d["meta"] or "{}")
        result.append(d)
    return result


async def get_scan_jobs_stats(pool: asyncpg.Pool) -> dict:
    """Statistiky scan jobů."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                            AS total,
                COUNT(*) FILTER (WHERE status = 'done')            AS done,
                COUNT(*) FILTER (WHERE status = 'error')           AS errors,
                COUNT(*) FILTER (WHERE status = 'running')         AS running,
                COUNT(*) FILTER (WHERE job_type = 'ping_scan')     AS ping_scans,
                COUNT(*) FILTER (WHERE job_type = 'discovery')     AS discoveries,
                COUNT(*) FILTER (WHERE job_type = 'backup')        AS backups,
                ROUND(AVG(duration_s)::numeric, 1)                 AS avg_duration_s,
                ROUND(MIN(duration_s)::numeric, 1)                 AS min_duration_s,
                ROUND(MAX(duration_s)::numeric, 1)                 AS max_duration_s,
                MAX(started_at)                                     AS last_scan_at
            FROM scan_jobs
            WHERE started_at > NOW() - INTERVAL '30 days'
            """
        )
    return dict(row) if row else {}


# ---------------------------------------------------------------------------
# Device polling — ukládání výsledků
# ---------------------------------------------------------------------------

async def save_poll_result(
    pool:       asyncpg.Pool,
    device_id:  int,
    ip:         str,
    method:     str,
    success:    bool,
    hostname:   str = None,
    model:      str = None,
    vendor:     str = None,
    firmware:   str = None,
    serial:     str = None,
    uptime_s:             int = None,
    uptime_str:           str = None,   # originální textový uptime ze zařízení (např. "3w4d1h30m")
    successful_credential_id: int  = None,  # ID credential profilu který uspěl
    successful_auth:          dict = None,  # Kompletní snapshot úspěšného přihlášení
    interfaces: list = None,
    ports:      list = None,
    system_info:dict = None,
    error:      str = None,
) -> int:
    """Uloží výsledek device pollingu."""
    import json as _json

    def _clean(s):
        if not isinstance(s, str): return s
        return "".join(ch for ch in s if ch != "\x00" and (ord(ch) >= 32 or ch in "\t\n")).strip() or None

    hostname = _clean(hostname)
    model    = _clean(model)
    vendor   = _clean(vendor)
    firmware = _clean(firmware)
    error    = _clean(error)

    async with pool.acquire() as conn:
        row_id = await conn.fetchval(
            """
            INSERT INTO device_poll_results
                (device_id, ip, method, success, hostname, model, vendor,
                 firmware, uptime_s, uptime_str, interfaces, ports, system_info, error, polled_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,NOW())
            RETURNING id
            """,
            device_id, ip, method, success,
            hostname, model, vendor, firmware, uptime_s, uptime_str,
            _json.dumps(interfaces or []),
            _json.dumps(ports or []),
            _json.dumps(system_info or {}),
            error,
        )
        # Aktualizujeme device - zapíšeme všechna dostupná data z pollingu
        # Pozn: přepisujeme jen pole která poll vrátil (not None)
        # Zapíšeme všechna dostupná data z pollingu do zařízení
        updates = {}
        if hostname:   updates["hostname"]       = hostname
        if vendor:     updates["vendor"]         = vendor
        if model:      updates["device_type"]    = model
        if serial:     updates["serial_number"]  = serial
        if firmware:   updates["firmware"]       = firmware
        if model:      updates["model"]          = model
        if uptime_s:   updates["last_uptime_s"]   = uptime_s
        if uptime_str:             updates["last_uptime_str"]              = uptime_str[:40]
        if successful_credential_id: updates["last_successful_credential_id"] = successful_credential_id
        if successful_auth:          updates["last_successful_auth"]          = successful_auth  # uloží se přes ::jsonb cast
        if method and success and method != "failed":
            updates["last_poll_method"] = method
        updates["last_polled_at"] = "NOW()"

        if updates:
            # last_polled_at je funkce, ne parametr
            normal = {k: v for k, v in updates.items() if v != "NOW()"}
            _JSONB_COLS = {"last_successful_auth"}
            set_parts = []
            vals = [device_id]
            for i, (k, v) in enumerate(normal.items(), start=2):
                if k in _JSONB_COLS and isinstance(v, dict):
                    set_parts.append(f"{k} = ${i}::jsonb")
                    vals.append(_json.dumps(v))
                else:
                    set_parts.append(f"{k} = ${i}")
                    vals.append(v)
            set_parts.append("last_polled_at = NOW()")
            set_parts.append("updated_at = NOW()")
            await conn.execute(
                f"UPDATE devices SET {', '.join(set_parts)} WHERE id = $1",
                *vals,
            )
    return row_id


async def get_poll_results(
    pool:      asyncpg.Pool,
    device_id: int,
    limit:     int = 20,
) -> list[dict]:
    """Vrátí historii poll výsledků pro zařízení."""
    import json as _json
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, device_id, ip, method, success,
                   hostname, model, vendor, firmware, uptime_s,
                   interfaces::text, ports::text, system_info::text,
                   error, polled_at
            FROM device_poll_results
            WHERE device_id = $1
            ORDER BY polled_at DESC
            LIMIT $2
            """,
            device_id, limit,
        )
    result = []
    for r in rows:
        d = dict(r)
        d["interfaces"]  = _json.loads(d["interfaces"]  or "[]")
        d["ports"]       = _json.loads(d["ports"]       or "[]")
        d["system_info"] = _json.loads(d["system_info"] or "{}")
        result.append(d)
    return result


# ---------------------------------------------------------------------------
# Credentials — načtení včetně šifrovaného hesla (pro backup engine)
# ---------------------------------------------------------------------------

async def get_credential_raw(pool, credential_id: int) -> dict | None:
    """Načte credential včetně password_cipher (pro backup engine)."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT id, name, auth_type, username, password_cipher, port, extra_params
            FROM credentials WHERE id = $1
            """,
            credential_id,
        )
    if not row:
        return None
    import json as _json
    d = dict(row)
    if isinstance(d.get("extra_params"), str):
        d["extra_params"] = _json.loads(d["extra_params"] or "{}")
    return d


# ---------------------------------------------------------------------------
# Zálohy zařízení (device_backups)
# ---------------------------------------------------------------------------

async def create_backup_record(
    pool, device_id: int, backup_type: str,
    filename: str, filepath: str, triggered_by: str = "manual",
) -> int:
    """Vytvoří záznam zálohy se stavem 'running'. Vrátí ID."""
    async with pool.acquire() as conn:
        row_id = await conn.fetchval(
            """
            INSERT INTO device_backups
                (device_id, backup_type, filename, filepath, status, triggered_by)
            VALUES ($1, $2, $3, $4, 'running', $5)
            RETURNING id
            """,
            device_id, backup_type, filename, filepath, triggered_by,
        )
    return row_id


async def finish_backup_record(
    pool, backup_id: int, success: bool,
    file_size_bytes: int = None, mikrotik_version: str = None,
    duration_ms: int = None, error_msg: str = None,
) -> None:
    """Aktualizuje záznam zálohy po dokončení."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE device_backups SET
                status           = $2,
                file_size_bytes  = $3,
                mikrotik_version = $4,
                duration_ms      = $5,
                error_msg        = $6
            WHERE id = $1
            """,
            backup_id, "ok" if success else "failed",
            file_size_bytes, mikrotik_version, duration_ms, error_msg,
        )


async def get_device_backups(pool, device_id: int, limit: int = 50) -> list[dict]:
    """Vrátí zálohy zařízení seřazené od nejnovější."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, device_id, backup_type, filename, filepath,
                   file_size_bytes, status, error_msg, triggered_by,
                   mikrotik_version, duration_ms, created_at
            FROM device_backups
            WHERE device_id = $1
            ORDER BY created_at DESC LIMIT $2
            """,
            device_id, limit,
        )
    return [dict(r) for r in rows]


async def get_all_backups(pool, limit: int = 200, status_filter: str = None) -> list[dict]:
    """Vrátí zálohy přes všechna zařízení."""
    async with pool.acquire() as conn:
        if status_filter:
            rows = await conn.fetch(
                """
                SELECT b.*, d.hostname, d.alias, d.ip::text AS ip, d.vendor
                FROM device_backups b JOIN devices d ON d.id = b.device_id
                WHERE b.status = $1 ORDER BY b.created_at DESC LIMIT $2
                """,
                status_filter, limit,
            )
        else:
            rows = await conn.fetch(
                """
                SELECT b.*, d.hostname, d.alias, d.ip::text AS ip, d.vendor
                FROM device_backups b JOIN devices d ON d.id = b.device_id
                ORDER BY b.created_at DESC LIMIT $1
                """,
                limit,
            )
    return [dict(r) for r in rows]


async def get_backup_by_id(pool, backup_id: int) -> dict | None:
    """Vrátí jeden záznam zálohy."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT b.*, d.hostname, d.alias, d.ip::text AS ip
            FROM device_backups b JOIN devices d ON d.id = b.device_id
            WHERE b.id = $1
            """,
            backup_id,
        )
    return dict(row) if row else None


async def delete_backup_record(pool, backup_id: int) -> str | None:
    """Smaže záznam zálohy z DB. Vrátí filepath."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "DELETE FROM device_backups WHERE id = $1 RETURNING filepath",
            backup_id,
        )
    return row["filepath"] if row else None


async def get_backup_stats(pool) -> dict:
    """Celkové statistiky záloh."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                              AS total,
                COUNT(*) FILTER (WHERE status = 'ok')                AS ok_count,
                COUNT(*) FILTER (WHERE status = 'failed')            AS failed_count,
                COUNT(*) FILTER (WHERE status = 'running')           AS running_count,
                COUNT(DISTINCT device_id)                            AS device_count,
                COALESCE(SUM(file_size_bytes) FILTER (WHERE status = 'ok'), 0) AS total_bytes,
                MAX(created_at)                                      AS last_backup_at
            FROM device_backups
            """
        )
    return dict(row) if row else {}


# ---------------------------------------------------------------------------
# Scan exclusions — IP adresy vyloučené ze scanování
# ---------------------------------------------------------------------------

async def get_scan_exclusions(pool) -> list:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, ip::text, reason, created_by, created_at FROM scan_exclusions ORDER BY created_at DESC"
        )
    return [dict(r) for r in rows]


async def add_scan_exclusion(pool, ip: str, reason: str, created_by: str) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "INSERT INTO scan_exclusions (ip, reason, created_by) VALUES ($1::inet, $2, $3) "
            "ON CONFLICT (ip) DO UPDATE SET reason=$2, created_by=$3 "
            "RETURNING id, ip::text, reason, created_by, created_at",
            ip, reason, created_by,
        )
    return dict(row)


async def remove_scan_exclusion(pool, exclusion_id: int) -> bool:
    async with pool.acquire() as conn:
        r = await conn.execute("DELETE FROM scan_exclusions WHERE id=$1", exclusion_id)
    return r == "DELETE 1"


async def get_excluded_ips(pool) -> set:
    """Vrátí set vyloučených IP adres pro rychlé filtrování při scanu."""
    try:
        async with pool.acquire() as conn:
            rows = await conn.fetch("SELECT ip::text FROM scan_exclusions")
        return {r["ip"] for r in rows}
    except Exception:
        return set()


# ---------------------------------------------------------------------------
# Device Data — rozšířená data ze zařízení (interfaces, ARP, DHCP)
# ---------------------------------------------------------------------------

async def save_device_data(
    pool, device_id: int, data_type: str, data: list, source: str = "api"
) -> None:
    """Uloží rozšířená data zařízení do device_data tabulky."""
    import json as _json
    # Sanitizujeme null bytes které PostgreSQL neumí uložit do textu
    def _clean(obj):
        if isinstance(obj, str):
            return obj.replace("\x00", "").replace("\u0000", "")
        if isinstance(obj, dict):
            return {k: _clean(v) for k, v in obj.items()}
        if isinstance(obj, list):
            return [_clean(i) for i in obj]
        return obj
    clean_data = _clean(data)
    async with pool.acquire() as conn:
        await conn.execute(
            """
            INSERT INTO device_data (device_id, data_type, data, source)
            VALUES ($1, $2, $3::jsonb, $4)
            """,
            device_id, data_type, _json.dumps(clean_data), source,
        )


async def get_device_data(
    pool, device_id: int, data_type: str
) -> dict | None:
    """Vrátí nejnovější záznam daného typu pro zařízení."""
    import json as _json
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT data, collected_at, source
            FROM device_data
            WHERE device_id = $1 AND data_type = $2
            ORDER BY collected_at DESC
            LIMIT 1
            """,
            device_id, data_type,
        )
    if not row:
        return None
    data = row["data"]
    if isinstance(data, str):
        data = _json.loads(data)
    return {
        "data":         data,
        "collected_at": row["collected_at"].isoformat(),
        "source":       row["source"],
    }


async def get_all_device_data(pool, device_id: int) -> dict:
    """Vrátí nejnovější data všech typů pro zařízení."""
    import json as _json
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (data_type)
                data_type, data, collected_at, source
            FROM device_data
            WHERE device_id = $1
            ORDER BY data_type, collected_at DESC
            """,
            device_id,
        )
    result = {}
    for r in rows:
        data = r["data"]
        if isinstance(data, str):
            data = _json.loads(data)
        result[r["data_type"]] = {
            "data":         data,
            "collected_at": r["collected_at"].isoformat(),
            "source":       r["source"],
        }
    return result


# ===========================================================================
# Device IPs — aktuální IP adresy a jejich historie
# ===========================================================================

import json as _json_mod

async def update_device_ips(
    pool,
    device_id: int,
    entries: list[dict],   # [{ip, mac, interface, source, is_primary}]
    source_prefix: str,    # 'api' | 'snmp'
) -> dict:
    """
    Aktualizuje device_ips pro zařízení.
    Detekuje změny a zapisuje je do device_ip_history.
    Vrátí statistiky: {inserted, updated, released, changes}.
    """
    stats = {"inserted": 0, "updated": 0, "released": 0, "changes": []}

    async with pool.acquire() as conn:
        # Načteme aktuální stav pro toto zařízení a prefix zdroje
        existing = await conn.fetch(
            """
            SELECT id, ip::text, mac, interface, source, last_seen, change_count
            FROM device_ips
            WHERE device_id = $1 AND source LIKE $2
            """,
            device_id, f"{source_prefix}%",
        )
        existing_map = {(r["ip"], r["source"]): dict(r) for r in existing}
        seen_keys = set()

        for entry in entries:
            ip       = entry.get("ip", "")
            mac      = entry.get("mac") or None
            iface    = entry.get("interface") or None
            source   = entry.get("source", source_prefix)
            is_prim  = entry.get("is_primary", False)

            # Validace IP adresy — přeskočíme binární garbage z SNMP
            if not ip:
                continue
            import re as _re
            ip_clean = ip.split("/")[0].strip()
            if not _re.match(r'^(\d{1,3}\.){3}\d{1,3}$', ip_clean):
                continue  # přeskočíme nevalidní IP (binární data z SNMP)
            ip = ip_clean

            key = (ip, source)
            seen_keys.add(key)
            existing_rec = existing_map.get(key)

            if existing_rec is None:
                # Nový záznam — INSERT + event 'assigned'
                await conn.execute(
                    """
                    INSERT INTO device_ips
                        (device_id, ip, mac, interface, is_primary, source, first_seen, last_seen, change_count)
                    VALUES ($1, $2::inet, $3, $4, $5, $6, NOW(), NOW(), 0)
                    ON CONFLICT (device_id, ip, source) DO UPDATE
                        SET mac=EXCLUDED.mac, interface=EXCLUDED.interface,
                            is_primary=EXCLUDED.is_primary, last_seen=NOW()
                        -- change_count se NEZAHRNUJE — zachováváme historický počet
                    """,
                    device_id, ip, mac, iface, is_prim, source,
                )
                await conn.execute(
                    """
                    INSERT INTO device_ip_history
                        (device_id, ip, mac, interface, source, event, new_value, changed_at)
                    VALUES ($1, $2::inet, $3, $4, $5, 'assigned',
                            $6::jsonb, NOW())
                    """,
                    device_id, ip, mac, iface, source,
                    _json_mod.dumps({"ip": ip, "mac": mac, "interface": iface}),
                )
                stats["inserted"] += 1
                stats["changes"].append({"event": "assigned", "ip": ip, "mac": mac, "interface": iface})

            else:
                old_mac   = existing_rec["mac"]
                old_iface = existing_rec.get("interface")
                changed   = False

                # Detekce změny MAC
                if mac and old_mac and mac != old_mac:
                    await conn.execute(
                        """
                        INSERT INTO device_ip_history
                            (device_id, ip, mac, interface, source, event, old_value, new_value, changed_at)
                        VALUES ($1, $2::inet, $3, $4, $5, 'changed_mac', $6::jsonb, $7::jsonb, NOW())
                        """,
                        device_id, ip, mac, iface, source,
                        _json_mod.dumps({"mac": old_mac}),
                        _json_mod.dumps({"mac": mac}),
                    )
                    # Inkrementujeme change_count při změně MAC
                    await conn.execute(
                        "UPDATE device_ips SET change_count = change_count + 1 "
                        "WHERE device_id=$1 AND ip=$2::inet AND source=$3",
                        device_id, ip, source,
                    )
                    stats["changes"].append({"event": "changed_mac", "ip": ip, "old_mac": old_mac, "new_mac": mac})
                    changed = True

                # Aktualizujeme last_seen + případné změny
                await conn.execute(
                    """
                    UPDATE device_ips
                    SET mac=$3, interface=$4, is_primary=$5, last_seen=NOW()
                    WHERE device_id=$1 AND ip=$2::inet AND source=$6
                    """,
                    device_id, ip, mac, iface, is_prim, source,
                )
                stats["updated"] += 1

                # Event "seen" pokud IP nebyla viděna více než 1 hodinu
                # Slouží pro sledování kdy byl klient naposledy online
                last_seen = existing_rec.get("last_seen")
                if last_seen:
                    from datetime import timezone as _tz
                    age = (last_seen.replace(tzinfo=_tz.utc)
                           if last_seen.tzinfo is None
                           else last_seen)
                    import datetime as _dt
                    diff = _dt.datetime.now(_tz.utc) - age
                    if diff.total_seconds() > 3600:  # více než 1 hodina
                        await conn.execute(
                            """
                            INSERT INTO device_ip_history
                                (device_id, ip, mac, interface, source, event,
                                 new_value, changed_at)
                            VALUES ($1, $2::inet, $3, $4, $5, 'seen',
                                    $6::jsonb, NOW())
                            """,
                            device_id, ip, mac, iface, source,
                            _json_mod.dumps({"last_seen_ago_hours":
                                round(diff.total_seconds() / 3600, 1)}),
                        )
                        # seen se nepočítá jako změna — neinkrementujeme change_count
                        stats["changes"].append({
                            "event": "seen", "ip": ip, "mac": mac,
                            "gap_hours": round(diff.total_seconds() / 3600, 1)
                        })

        # Záznamy které jsme neviděli → event 'released'
        for key, rec in existing_map.items():
            if key not in seen_keys:
                ip, source = key
                await conn.execute(
                    """
                    INSERT INTO device_ip_history
                        (device_id, ip, mac, interface, source, event, old_value, changed_at)
                    VALUES ($1, $2::inet, $3, $4, $5, 'released', $6::jsonb, NOW())
                    """,
                    device_id, ip, rec["mac"], rec.get("interface"), source,
                    _json_mod.dumps({"ip": ip, "mac": rec["mac"]}),
                )
                # Inkrementujeme change_count při released (DHCP rotace)
                if source in ("api_dhcp", "api_arp", "snmp_arp"):
                    await conn.execute(
                        "UPDATE device_ips SET change_count = change_count + 1 "
                        "WHERE device_id=$1 AND ip=$2::inet AND source=$3",
                        device_id, ip, source,
                    )
                stats["released"] += 1

    return stats


async def get_device_ips(pool, device_id: int) -> list[dict]:
    """Vrátí aktuální IP adresy zařízení (viděné v posledních 7 dnech)."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ip::text, mac, interface, is_primary, source,
                   first_seen, last_seen, change_count
            FROM device_ips
            WHERE device_id = $1
              AND last_seen > NOW() - INTERVAL '7 days'
            ORDER BY is_primary DESC, source, ip
            """,
            device_id,
        )
    return [dict(r) for r in rows]


async def get_device_ip_history(
    pool, device_id: int, limit: int = 200
) -> list[dict]:
    """Vrátí historii změn IP adres zařízení."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ip::text, mac, interface, source, event,
                   old_value, new_value, changed_at
            FROM device_ip_history
            WHERE device_id = $1
            ORDER BY changed_at DESC
            LIMIT $2
            """,
            device_id, limit,
        )
    result = []
    for r in rows:
        d = dict(r)
        if isinstance(d.get("old_value"), str):
            try: d["old_value"] = _json_mod.loads(d["old_value"])
            except: pass
        if isinstance(d.get("new_value"), str):
            try: d["new_value"] = _json_mod.loads(d["new_value"])
            except: pass
        d["changed_at"] = d["changed_at"].isoformat()
        result.append(d)
    return result


async def get_ip_owner(pool, ip: str) -> dict | None:
    """Vrátí zařízení které vlastní danou IP (aktuálně nebo nedávno)."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT di.device_id, di.ip::text, di.mac, di.interface,
                   di.source, di.last_seen,
                   d.hostname, d.alias, d.vendor, d.model, d.firmware
            FROM device_ips di
            JOIN devices d ON d.id = di.device_id
            WHERE di.ip = $1::inet
              AND di.last_seen > NOW() - INTERVAL '24 hours'
            ORDER BY di.last_seen DESC
            LIMIT 1
            """,
            ip,
        )
    if not row:
        return None
    r = dict(row)
    r["last_seen"] = r["last_seen"].isoformat()
    return r


async def get_ip_changes_stats(pool, device_id: int, hours: int = 24) -> dict:
    """Vrátí statistiky změn IP pro zařízení za posledních N hodin."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT event, COUNT(*) as cnt
            FROM device_ip_history
            WHERE device_id = $1
              AND changed_at > NOW() - ($2 || ' hours')::INTERVAL
            GROUP BY event
            """,
            device_id, str(hours),
        )
    return {r["event"]: r["cnt"] for r in rows}


# ---------------------------------------------------------------------------
# Hosts enriched — IP adresy s vazbou na zařízení
# ---------------------------------------------------------------------------

async def get_ip_device_map(pool) -> dict:
    """
    Vrátí mapu IP → zařízení z device_ips tabulky.
    Zahrnuje všechny IP (vlastní + ARP + DHCP) naposledy viděné za 24h.
    Jedna IP může patřit více zdrojům — vrátíme nejrelevantnější.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT DISTINCT ON (di.ip)
                di.ip::text,
                di.mac,
                di.interface,
                di.source,
                di.last_seen,
                d.id          AS device_id,
                d.hostname,
                d.alias,
                d.vendor,
                d.model
            FROM device_ips di
            JOIN devices d ON d.id = di.device_id
            WHERE di.last_seen > NOW() - INTERVAL '24 hours'
            ORDER BY di.ip,
                     -- Priorita: vlastní IP > ARP > DHCP
                     CASE di.source
                         WHEN 'api_address'  THEN 1
                         WHEN 'snmp_address' THEN 2
                         WHEN 'api_arp'      THEN 3
                         WHEN 'snmp_arp'     THEN 4
                         WHEN 'api_dhcp'     THEN 5
                         ELSE 6
                     END,
                     di.last_seen DESC
            """
        )
    result = {}
    for r in rows:
        r_dict = dict(r)
        if r_dict.get("last_seen"):
            r_dict["last_seen"] = r_dict["last_seen"].isoformat()
        result[r_dict["ip"]] = r_dict
    return result


# ===========================================================================
# ip_presence_log — timeline přítomnosti IP z ARP/DHCP
# ===========================================================================

async def bulk_log_ip_presence(
    pool,
    entries: list[dict],  # [{ip, source, expires_at}]
) -> None:
    """
    Hromadně zapíše přítomnost IP z ARP/DHCP pollu.
    Každý poll = nový záznam se seen_at=NOW().
    """
    if not entries:
        return
    async with pool.acquire() as conn:
        await conn.executemany(
            """
            INSERT INTO ip_presence_log (ip, source, seen_at, expires_at)
            VALUES (split_part($1,'/',1)::inet, $2, NOW(), $3)
            ON CONFLICT DO NOTHING
            """,
            [(e["ip"], e["source"], e.get("expires_at")) for e in entries],
        )


async def get_ip_presence(
    pool,
    ip: str,
    hours: int = 24,
) -> list[dict]:
    """
    Vrátí timeline přítomnosti IP za posledních N hodin.
    Výsledek: [{seen_at, expires_at, source}] seřazené dle času.
    """
    import datetime as _dt
    since = _dt.datetime.now(_dt.timezone.utc) - _dt.timedelta(hours=hours)
    ip_clean = ip.split("/")[0]

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT seen_at, expires_at, source
            FROM ip_presence_log
            WHERE ip = $1::inet
              AND seen_at > $2
            ORDER BY seen_at ASC
            """,
            ip_clean, since,
        )

    result = []
    for r in rows:
        d = dict(r)
        d["seen_at"] = d["seen_at"].isoformat()
        if d.get("expires_at"):
            d["expires_at"] = d["expires_at"].isoformat()
        result.append(d)
    return result


async def get_ip_presence_timeline(
    pool,
    ip: str,
    hours: int = 24,
    gap_minutes: int = 15,
) -> list[dict]:
    """
    Vrátí komprimovanou timeline — sloučí po sobě jdoucí záznamy
    do bloků [online_from, online_to, source].
    gap_minutes: mezera větší než N minut = výpadek.
    """
    import datetime as _dt
    rows = await get_ip_presence(pool, ip, hours)
    if not rows:
        return []

    gap = _dt.timedelta(minutes=gap_minutes)
    blocks = []
    block_start = None
    block_end   = None
    block_src   = None

    for row in rows:
        ts = _dt.datetime.fromisoformat(row["seen_at"])
        expires = (_dt.datetime.fromisoformat(row["expires_at"])
                   if row.get("expires_at") else ts + gap)

        if block_start is None:
            block_start = ts
            block_end   = expires
            block_src   = row["source"]
        elif ts - block_end <= gap:
            # Prodloužíme blok
            block_end = max(block_end, expires)
        else:
            # Mezera = nový blok
            blocks.append({
                "from":   block_start.isoformat(),
                "to":     block_end.isoformat(),
                "source": block_src,
                "online": True,
            })
            block_start = ts
            block_end   = expires
            block_src   = row["source"]

    if block_start:
        blocks.append({
            "from":   block_start.isoformat(),
            "to":     block_end.isoformat(),
            "source": block_src,
            "online": True,
        })

    return blocks


async def cleanup_ip_presence(pool, days: int = 30) -> None:
    """Smaže staré záznamy z ip_presence_log."""
    async with pool.acquire() as conn:
        await conn.execute(
            "DELETE FROM ip_presence_log WHERE seen_at < NOW() - ($1 || ' days')::INTERVAL",
            str(days),
        )


# ===========================================================================
# ip_addresses — živý stav IP adres
# ===========================================================================

async def bulk_upsert_ip_addresses(pool, results: list[dict]) -> None:
    """
    Hromadný UPSERT výsledků ping scanu do ip_addresses.
    Ping má nejvyšší prioritu:
      - alive=TRUE  → alive_source='ping'
      - alive=FALSE → alive_source=NULL (reset - bude doplněno z ARP/DHCP)
    """
    if not results:
        return
    async with pool.acquire() as conn:
        await conn.executemany(
            """
            INSERT INTO ip_addresses (ip, is_alive, rtt_ms, last_check, last_seen, first_seen,
                                      alive_source)
            VALUES (split_part($1,'/',1)::inet, $2, $3, NOW(),
                    CASE WHEN $2 THEN NOW() ELSE NULL END, NOW(),
                    CASE WHEN $2 THEN 'ping' ELSE NULL END)
            ON CONFLICT (ip) DO UPDATE SET
                is_alive     = EXCLUDED.is_alive,
                rtt_ms       = EXCLUDED.rtt_ms,
                last_check   = NOW(),
                last_seen    = CASE WHEN EXCLUDED.is_alive THEN NOW()
                                    ELSE ip_addresses.last_seen END,
                -- Ping TRUE → source=ping, Ping FALSE → reset na NULL
                -- (refresh_alive_from_presence pak doplní ARP/DHCP)
                alive_source = CASE WHEN EXCLUDED.is_alive THEN 'ping' ELSE NULL END,
                updated_at   = NOW()
            """,
            [(r["ip"], r["is_alive"], r.get("rtt_ms")) for r in results],
        )


async def refresh_ip_stats_24h(pool) -> None:
    """Aktualizuje předpočítané statistiky 24h v ip_addresses."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE ip_addresses ia
            SET
                checks_24h     = stats.checks,
                online_24h     = stats.online,
                uptime_pct_24h = ROUND((100.0 * stats.online / NULLIF(stats.checks,0))::numeric, 2),
                avg_rtt_24h    = ROUND(stats.avg_rtt::numeric, 2),
                min_rtt_24h    = ROUND(stats.min_rtt::numeric, 2),
                max_rtt_24h    = ROUND(stats.max_rtt::numeric, 2),
                updated_at     = NOW()
            FROM (
                SELECT ip::text AS ip,
                    COUNT(*)                                        AS checks,
                    SUM(is_alive::int)                              AS online,
                    AVG(rtt_ms) FILTER (WHERE is_alive)             AS avg_rtt,
                    MIN(rtt_ms) FILTER (WHERE is_alive)             AS min_rtt,
                    MAX(rtt_ms) FILTER (WHERE is_alive)             AS max_rtt
                FROM ping_results
                WHERE scanned_at > NOW() - INTERVAL '24 hours'
                GROUP BY ip
            ) stats
            WHERE split_part(ia.ip::text,'/',1) = stats.ip
            """
        )


async def refresh_ip_device_map(pool) -> int:
    """Aktualizuje device_id + device_source v ip_addresses. Vrátí počet řádků."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE ip_addresses ia
            SET device_id = dm.device_id, device_source = dm.device_source, updated_at = NOW()
            FROM (
                SELECT DISTINCT ON (match_ip) match_ip, device_id, device_source, prio
                FROM (
                    SELECT split_part(d.ip::text,'/',1) AS match_ip,
                           d.id AS device_id, 'primary' AS device_source, 1 AS prio
                    FROM devices d
                    UNION ALL
                    SELECT split_part(di.ip::text,'/',1),
                           di.device_id, di.source,
                           CASE di.source WHEN 'api_address' THEN 2
                               WHEN 'snmp_address' THEN 3 ELSE 9 END
                    FROM device_ips di
                    WHERE di.source IN ('api_address','snmp_address')
                      AND di.last_seen > NOW() - INTERVAL '30 days'
                ) sub
                ORDER BY match_ip, prio
            ) dm
            WHERE split_part(ia.ip::text,'/',1) = dm.match_ip
            """
        )
        return int(result.split()[-1]) if result else 0




async def refresh_alive_from_presence(pool) -> int:
    """
    Aktualizuje is_alive z ip_presence_log.
    Zdroje (dle spolehlivosti):
      - dhcp: DHCP lease (permanent+dhcp flag) → velmi spolehlivé
      - arp:  ARP status=reachable → spolehlivé (aktivně ověřeno)
    ARP status=permanent bez DHCP = cached, nespolehlivé → ignorujeme.
    """
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE ip_addresses ia
            SET
                is_alive     = TRUE,
                alive_source = pl.best_source,
                updated_at   = NOW()
            FROM (
                SELECT DISTINCT ON (ip)
                    ip,
                    source AS best_source
                FROM ip_presence_log
                WHERE (
                    (source = 'dhcp' AND seen_at > NOW() - INTERVAL '20 minutes')
                    OR
                    (source = 'arp'  AND seen_at > NOW() - INTERVAL '12 minutes')
                )
                ORDER BY ip,
                    CASE source
                        WHEN 'dhcp' THEN 1
                        WHEN 'arp'  THEN 2
                        ELSE 3
                    END
            ) pl
            WHERE ia.ip = pl.ip
              AND (ia.is_alive = FALSE OR ia.is_alive IS NULL)
            """
        )
        return int(result.split()[-1]) if result else 0


async def get_ip_addresses(pool, alive_only=False, range_id=None, limit=10000, offset=0) -> list[dict]:
    """Vrátí IP adresy s live stats a vazbou na zařízení."""
    conditions = []
    params: list = []
    if alive_only:
        conditions.append("ia.is_alive = TRUE")
    if range_id:
        params.append(range_id)
        conditions.append(f"ia.range_id = ${len(params)}")
    where = ("WHERE " + " AND ".join(conditions)) if conditions else ""
    params += [limit, offset]
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT split_part(ia.ip::text,'/',1) AS ip,
                ia.range_id, ia.is_alive, ia.rtt_ms,
                ia.last_check, ia.last_seen, ia.first_seen,
                ia.uptime_pct_24h, ia.avg_rtt_24h, ia.min_rtt_24h,
                ia.max_rtt_24h, ia.checks_24h, ia.online_24h,
                ia.device_id, ia.device_source, ia.alive_source,
                d.hostname AS device_hostname, d.alias AS device_alias,
                d.vendor AS device_vendor, d.model AS device_model
            FROM ip_addresses ia
            LEFT JOIN devices d ON d.id = ia.device_id
            {where}
            ORDER BY ia.ip
            LIMIT ${len(params)-1} OFFSET ${len(params)}
            """,
            *params,
        )
    result = []
    for r in rows:
        d = dict(r)
        for k in ("last_check", "last_seen", "first_seen"):
            if d.get(k):
                d[k] = d[k].isoformat()
        result.append(d)
    return result


async def get_ip_address_count(pool) -> int:
    async with pool.acquire() as conn:
        return await conn.fetchval("SELECT COUNT(*) FROM ip_addresses")


async def update_device_poll_result(pool, device_id: int, result) -> None:
    """Aktualizuje výsledek pollu v tabulce devices."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE devices SET
                hostname         = COALESCE($2, hostname),
                firmware         = COALESCE($3, firmware),
                model            = COALESCE($4, model),
                last_polled_at   = NOW(),
                last_poll_method = $5
            WHERE id = $1
            """,
            device_id,
            getattr(result, "hostname", None),
            getattr(result, "firmware", None),
            getattr(result, "model",    None),
            getattr(result, "method",   None),
        )


async def refresh_ip_range_map(pool) -> None:
    """Přiřadí range_id k IP adresám podle ip_ranges (CIDR)."""
    async with pool.acquire() as conn:
        await conn.execute(
            """
            UPDATE ip_addresses ia
            SET range_id = r.id
            FROM ip_ranges r
            WHERE ia.ip << r.network
              AND r.active = TRUE
              AND ia.range_id IS NULL
            """
        )


async def get_unknown_networks(pool) -> list[dict]:
    """Privátní sítě z ARP/DHCP mimo ip_ranges, seskupené po /24."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            WITH unknown_ips AS (
                SELECT DISTINCT pl.ip AS ip
                FROM ip_presence_log pl
                WHERE (pl.ip << '10.0.0.0/8'::inet
                       OR pl.ip << '172.16.0.0/12'::inet
                       OR pl.ip << '192.168.0.0/16'::inet)
                  AND NOT EXISTS (
                      SELECT 1 FROM ip_ranges r
                      WHERE r.active = TRUE AND pl.ip << r.network
                  )
            ),
            grouped AS (
                SELECT
                    network(set_masklen(ui.ip, 24))  AS subnet,
                    COUNT(DISTINCT ui.ip)             AS ip_count,
                    array_agg(DISTINCT pl.source)     AS sources,
                    MAX(pl.seen_at)                   AS last_seen
                FROM unknown_ips ui
                JOIN ip_presence_log pl ON pl.ip = ui.ip
                GROUP BY network(set_masklen(ui.ip, 24))
            )
            SELECT subnet::text, ip_count, sources, last_seen
            FROM grouped
            ORDER BY ip_count DESC, subnet
            """
        )
    result = []
    for r in rows:
        d = dict(r)
        d["last_seen"] = d["last_seen"].isoformat() if d.get("last_seen") else None
        d["sources"] = list(d["sources"]) if d.get("sources") else []
        result.append(d)
    return result


async def get_unknown_network_ips(pool, subnet: str) -> list[dict]:
    """Detail IP v dané neznámé síti s MAC adresami."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                pl.ip::text                          AS ip,
                MAX(pl.seen_at)                      AS last_seen,
                array_agg(DISTINCT pl.source)        AS sources,
                (SELECT di.mac FROM device_ips di
                 WHERE split_part(di.ip::text,'/',1) = host(pl.ip)
                   AND di.mac IS NOT NULL
                 ORDER BY di.last_seen DESC LIMIT 1) AS mac
            FROM ip_presence_log pl
            WHERE pl.ip << $1::inet
              AND NOT EXISTS (
                  SELECT 1 FROM ip_ranges r
                  WHERE r.active = TRUE AND pl.ip << r.network
              )
            GROUP BY pl.ip
            ORDER BY pl.ip
            """,
            subnet,
        )
    result = []
    for r in rows:
        d = dict(r)
        d["last_seen"] = d["last_seen"].isoformat() if d.get("last_seen") else None
        d["sources"] = list(d["sources"]) if d.get("sources") else []
        result.append(d)
    return result


# ===========================================================================
# sites — logické sítě / infrastruktury
# ===========================================================================

async def get_sites(pool) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT s.id, s.name, s.description, s.color, s.active, s.created_at,
                   COUNT(r.id) AS range_count
            FROM sites s
            LEFT JOIN ip_ranges r ON r.site_id = s.id
            GROUP BY s.id
            ORDER BY s.id
            """
        )
    return [dict(r) | {"created_at": r["created_at"].isoformat()} for r in rows]


async def create_site(pool, name: str, description: str | None, color: str) -> dict:
    async with pool.acquire() as conn:
        # Resetujeme sekvenci aby nedošlo ke konfliktu s manuálně vloženým id=1
        await conn.execute(
            "SELECT setval('sites_id_seq', GREATEST((SELECT MAX(id) FROM sites), 1))"
        )
        row = await conn.fetchrow(
            """
            INSERT INTO sites (name, description, color)
            VALUES ($1, $2, $3)
            RETURNING id, name, description, color, active, created_at
            """,
            name, description, color,
        )
    return dict(row) | {"created_at": row["created_at"].isoformat()}


async def update_site(pool, site_id: int, name: str, description: str | None, color: str, active: bool) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE sites SET name=$2, description=$3, color=$4, active=$5
            WHERE id=$1
            RETURNING id, name, description, color, active, created_at
            """,
            site_id, name, description, color, active,
        )
    return dict(row) | {"created_at": row["created_at"].isoformat()}


async def delete_site(pool, site_id: int) -> None:
    """Smaže síť — rozsahy zůstanou ale site_id = NULL."""
    async with pool.acquire() as conn:
        await conn.execute(
            "UPDATE ip_ranges SET site_id = NULL WHERE site_id = $1",
            site_id,
        )
        await conn.execute("DELETE FROM sites WHERE id = $1 AND id != 1", site_id)


async def get_ip_ranges_with_site(pool) -> list[dict]:
    """Vrátí ip_ranges s informací o síti."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT r.id, r.label, r.network::text, r.active, r.scan_enabled,
                   r.description, r.site_id,
                   s.name  AS site_name,
                   s.color AS site_color
            FROM ip_ranges r
            LEFT JOIN sites s ON s.id = r.site_id
            ORDER BY r.id
            """
        )
    return [dict(r) for r in rows]
