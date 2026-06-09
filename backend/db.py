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


async def update_ip_addresses_alive(pool: asyncpg.Pool, results: list) -> None:
    """Aktualizuje is_alive v ip_addresses z výsledků ping scanu."""
    if not results:
        return
    alive_ips   = [str(r.ip) for r in results if r.is_alive]
    offline_ips = [str(r.ip) for r in results if not r.is_alive]
    async with pool.acquire() as conn:
        if alive_ips:
            await conn.execute(
                "UPDATE ip_addresses SET is_alive=TRUE, updated_at=NOW() WHERE host(ip)=ANY($1::text[])",
                alive_ips,
            )
        if offline_ips:
            await conn.execute(
                "UPDATE ip_addresses SET is_alive=FALSE, updated_at=NOW() WHERE host(ip)=ANY($1::text[])",
                offline_ips,
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
    since = datetime.now(timezone.utc) - timedelta(hours=hours)
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT ip::text, scanned_at, is_alive, prev_alive
            FROM outage_events
            WHERE scanned_at > $1
              AND is_alive = FALSE AND prev_alive = TRUE
            ORDER BY scanned_at DESC
            LIMIT 200
            """,
            since,
        )
    return [
        OutageEvent(ip=r["ip"], started_at=r["scanned_at"], ended_at=None, duration_s=None)
        for r in rows
    ]


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
            "SELECT id, label, network::text, active, scan_enabled, description, site_id FROM ip_ranges ORDER BY network::inet"
        )
    return [IpRangeModel(id=r["id"], label=r["label"], network=r["network"], active=r["active"])
            for r in rows]


async def upsert_ip_range(pool: asyncpg.Pool, rng: IpRangeModel) -> IpRangeModel:
    async with pool.acquire() as conn:
        if rng.id:
            # Zjistíme starý rozsah pro porovnání
            old_row = await conn.fetchrow(
                "SELECT network::text FROM ip_ranges WHERE id=$1", rng.id
            )
            await conn.execute(
                "UPDATE ip_ranges SET label=$1, network=$2::cidr, active=$3 WHERE id=$4",
                rng.label, rng.network, rng.active, rng.id,
            )
            # Pokud se změnil rozsah — smažeme ping_results mimo nový rozsah
            if old_row and old_row["network"] != rng.network:
                await conn.execute(
                    "DELETE FROM ping_results WHERE NOT (ip << $1::cidr)",
                    rng.network,
                )
            return rng
        else:
            row = await conn.fetchrow(
                "INSERT INTO ip_ranges (label, network, active) VALUES ($1, $2::cidr, $3) RETURNING id",
                rng.label, rng.network, rng.active,
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
            INSERT INTO devices (device_uuid, ip, mac, hostname, device_type, description, alias,
                                 ownership, vendor, serial_number, location_id)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            ON CONFLICT (device_uuid) DO UPDATE
            SET ip            = EXCLUDED.ip,
                mac           = COALESCE(devices.mac, EXCLUDED.mac),
                hostname      = EXCLUDED.hostname,
                device_type   = EXCLUDED.device_type,
                description   = EXCLUDED.description,
                alias         = EXCLUDED.alias,
                ownership     = COALESCE(devices.ownership, EXCLUDED.ownership),
                vendor        = COALESCE(EXCLUDED.vendor, devices.vendor),
                serial_number = COALESCE(EXCLUDED.serial_number, devices.serial_number),
                location_id   = COALESCE(EXCLUDED.location_id, devices.location_id)
            RETURNING *
        """, device_uuid, dev.ip, dev.mac, dev.hostname, dev.device_type, dev.description, dev.alias,
             getattr(dev, "ownership", "isp") or "isp",
             getattr(dev, "vendor", None),
             getattr(dev, "serial_number", None),
             getattr(dev, "location_id", None))
        
        return dict(row)

# ---------------------------------------------------------------------------
# Credentials — trezor přihlašovacích profilů
# ---------------------------------------------------------------------------

async def get_credentials(pool: asyncpg.Pool) -> list[dict]:
    """Seznam všech profilů BEZ hesla."""
    import json as _j
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT id, name, auth_type, username, port, extra_params FROM credentials ORDER BY name"
        )
    result = []
    for r in rows:
        d = dict(r)
        ep = d.get("extra_params")
        if isinstance(ep, str):
            try: d["extra_params"] = _j.loads(ep)
            except: d["extra_params"] = {}
        elif ep is None:
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
                d.device_type,
                d.ownership, d.description, d.alias,
                d.vendor, d.serial_number,
                d.firmware, d.model, d.last_uptime_s, d.last_uptime_str, d.last_polled_at, d.last_poll_method, d.last_successful_credential_id, d.last_successful_auth, d.backup_enabled, d.backup_schedule,
                d.created_at, d.updated_at, d.cron_poll, d.location_id,
                l.name AS location_name,
                COALESCE(
                    json_agg(
                        json_build_object(
                            'id', c.id, 'name', c.name,
                            'auth_type', c.auth_type, 'username', c.username,
                            'port', c.port,
                            'password_cipher', c.password_cipher
                        )
                    ) FILTER (WHERE c.id IS NOT NULL),
                    '[]'
                ) AS credentials
            FROM devices d
            LEFT JOIN device_credentials dc ON dc.device_id = d.id
            LEFT JOIN credentials c ON c.id = dc.credential_id
            LEFT JOIN locations l ON l.id = d.location_id
            GROUP BY d.id, l.name
            ORDER BY d.hostname
            """
        )
    result = []
    for r in rows:
        d = dict(r)
        import json as _json
        d["credentials"] = _json.loads(d["credentials"]) if isinstance(d["credentials"], str) else d["credentials"]
        # Deserializujeme extra_params v credentials
        for cred in d["credentials"]:
            ep = cred.get("extra_params")
            if isinstance(ep, str):
                try: cred["extra_params"] = _json.loads(ep)
                except: cred["extra_params"] = {}
            elif ep is None:
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
                ownership     = $10,
                location_id   = $11,
                updated_at    = NOW()
            WHERE id = $1
            RETURNING id, device_uuid, ip::text, hostname, mac::text,
                      device_type, description, alias, vendor, serial_number,
                      ownership, location_id, created_at, updated_at
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
            getattr(dev, "ownership", "isp") or "isp",
            getattr(dev, "location_id", None),
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


# ===========================================================================
# config_lists — uživatelsky definovatelné číselníky
# ===========================================================================

async def get_config_list(pool, category: str, active_only: bool = True) -> list[dict]:
    """Vrátí položky daného číselníku."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, category, value, label, color, sort_order, active
            FROM config_lists
            WHERE category = $1
              AND ($2 = FALSE OR active = TRUE)
            ORDER BY sort_order, label
            """,
            category, active_only,
        )
    return [dict(r) for r in rows]


async def get_all_config_lists(pool) -> dict[str, list[dict]]:
    """Vrátí všechny číselníky seskupené podle kategorie."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT id, category, value, label, color, sort_order, active
            FROM config_lists
            ORDER BY category, sort_order, label
            """
        )
    result: dict[str, list] = {}
    for r in rows:
        d = dict(r)
        result.setdefault(d["category"], []).append(d)
    return result


async def create_config_list_item(
    pool, category: str, value: str, label: str,
    color: str | None = None, sort_order: int = 0
) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO config_lists (category, value, label, color, sort_order)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, category, value, label, color, sort_order, active
            """,
            category, value, label, color, sort_order,
        )
    return dict(row)

# alias pro zpětnou kompatibilitu
create_config_item = create_config_list_item


async def update_config_list_item(
    pool, item_id: int, label: str, color: str | None,
    sort_order: int, active: bool
) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            UPDATE config_lists
            SET label=$2, color=$3, sort_order=$4, active=$5
            WHERE id=$1
            RETURNING id, category, value, label, color, sort_order, active
            """,
            item_id, label, color, sort_order, active,
        )
    return dict(row)

# alias pro zpětnou kompatibilitu
update_config_item = update_config_list_item


async def delete_config_list_item(pool, item_id: int) -> bool:
    """Smaže položku — pouze pokud se nepoužívá v zařízeních."""
    async with pool.acquire() as conn:
        item = await conn.fetchrow(
            "SELECT category, value FROM config_lists WHERE id=$1", item_id
        )
        if not item:
            return False
        if item["category"] == "device_type":
            count = await conn.fetchval(
                "SELECT COUNT(*) FROM devices WHERE device_type=$1", item["value"]
            )
            if count > 0:
                raise ValueError(f"Typ se používá u {count} zařízení, nelze smazat")
        await conn.execute("DELETE FROM config_lists WHERE id=$1", item_id)
    return True

# alias pro zpětnou kompatibilitu
delete_config_item = delete_config_list_item


async def get_excluded_ips(pool) -> set[str]:
    """Vrátí množinu IP adres vyloučených ze scanu."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT ip::text FROM scan_exclusions"
        )
    return {r["ip"] for r in rows}


async def cleanup_zombie_jobs(pool) -> int:
    """Označí jako zombie joby které se zasekly (heartbeat starší než 10 minut)."""
    async with pool.acquire() as conn:
        result = await conn.execute(
            """
            UPDATE scan_jobs
            SET status = 'zombie', updated_at = NOW()
            WHERE status IN ('running', 'pending')
              AND (
                heartbeat_at IS NULL AND started_at < NOW() - INTERVAL '10 minutes'
                OR
                heartbeat_at < NOW() - INTERVAL '10 minutes'
              )
            """
        )
    return int(result.split()[-1]) if result else 0


# ===========================================================================
# DOPLNĚNÉ FUNKCE — ip_addresses, sites, presence, enriched, config
# ===========================================================================

async def bulk_upsert_ip_addresses(pool, results: list[dict]) -> None:
    if not results: return
    async with pool.acquire() as conn:
        await conn.executemany("""
            INSERT INTO ip_addresses (ip, is_alive, rtt_ms, last_check, last_seen, alive_source, updated_at)
            VALUES ($1::inet, $2, $3, NOW(), CASE WHEN $2 IS TRUE THEN NOW() ELSE NULL END,
                    CASE WHEN $2 IS TRUE THEN 'ping' ELSE NULL END, NOW())
            ON CONFLICT (ip) DO UPDATE SET
                is_alive=EXCLUDED.is_alive, rtt_ms=EXCLUDED.rtt_ms, last_check=NOW(),
                last_seen=CASE WHEN EXCLUDED.is_alive THEN NOW() ELSE ip_addresses.last_seen END,
                alive_source=CASE WHEN EXCLUDED.is_alive IS TRUE THEN 'ping' ELSE NULL END,
                updated_at=NOW()
        """, [(r["ip"], r["is_alive"], r.get("rtt_ms")) for r in results])


async def bulk_log_ip_presence(pool, entries: list[dict]) -> int:
    if not entries: return 0
    async with pool.acquire() as conn:
        await conn.executemany("""
            INSERT INTO ip_presence_log (ip, source, seen_at, expires_at)
            VALUES ($1::inet, $2, NOW(), $3) ON CONFLICT DO NOTHING
        """, [(e["ip"], e["source"], e.get("expires_at")) for e in entries])
    return len(entries)


async def refresh_alive_from_presence(pool) -> int:
    async with pool.acquire() as conn:
        result = await conn.execute("""
            UPDATE ip_addresses ia SET is_alive=TRUE, alive_source=pl.best_source, updated_at=NOW()
            FROM (SELECT DISTINCT ON (ip) ip, source AS best_source FROM ip_presence_log
                  WHERE (source='dhcp' AND seen_at > NOW()-INTERVAL '20 minutes')
                     OR (source='arp'  AND seen_at > NOW()-INTERVAL '12 minutes')
                  ORDER BY ip, CASE source WHEN 'dhcp' THEN 1 WHEN 'arp' THEN 2 ELSE 3 END) pl
            WHERE ia.ip=pl.ip AND (ia.is_alive=FALSE OR ia.is_alive IS NULL)
        """)
    return int(result.split()[-1]) if result else 0


async def refresh_ip_stats_24h(pool) -> None:
    pass


async def refresh_ip_range_map(pool) -> int:
    return await sync_ip_range_assignments(pool)


async def sync_ip_range_assignments(pool, ips=None, network=None) -> int:
    filters = []
    params: list = []
    n = 1
    if ips:
        filters.append(f"ia.ip = ANY(${n}::inet[])"); params.append(ips); n += 1
    if network:
        filters.append(f"ia.ip << ${n}::cidr"); params.append(network); n += 1
    ia_where = (" AND " + " AND ".join(filters)) if filters else ""
    async with pool.acquire() as conn:
        result = await conn.execute(f"""
            WITH best_range AS (
                SELECT DISTINCT ON (ia.ip) ia.ip, ir.id AS range_id
                FROM ip_addresses ia JOIN ip_ranges ir ON ia.ip<<ir.network AND ir.active
                WHERE 1=1{ia_where}
                ORDER BY ia.ip, masklen(ir.network::cidr) DESC
            )
            UPDATE ip_addresses ia SET range_id=br.range_id, updated_at=NOW()
            FROM best_range br
            WHERE ia.ip=br.ip AND ia.range_id IS DISTINCT FROM br.range_id
        """, *params)
    return int(result.split()[-1]) if result else 0


async def sync_ip_addresses_after_ping(pool, results: list) -> None:
    if not results: return
    rows = [(str(r.ip), r.is_alive, r.rtt_ms, r.scanned_at) for r in results]
    async with pool.acquire() as conn:
        await conn.executemany("""
            INSERT INTO ip_addresses (ip, is_alive, rtt_ms, last_check, last_seen, alive_source, updated_at)
            VALUES ($1::inet, $2, $3, $4, $4,
                    CASE WHEN $2 IS TRUE THEN 'ping' ELSE NULL END, NOW())
            ON CONFLICT (ip) DO UPDATE SET
                is_alive=EXCLUDED.is_alive, rtt_ms=EXCLUDED.rtt_ms,
                last_check=EXCLUDED.last_check, last_seen=EXCLUDED.last_seen,
                alive_source=CASE WHEN EXCLUDED.is_alive IS TRUE THEN 'ping' ELSE NULL END,
                updated_at=NOW()
        """, rows)
    await sync_ip_range_assignments(pool, ips=[str(r.ip) for r in results])


async def get_ip_addresses(pool, alive_only=False, range_id=None, limit=5000) -> list[dict]:
    conds = ["1=1"]
    params: list = []
    n = 1
    if alive_only: conds.append("ia.is_alive IS TRUE")
    if range_id is not None:
        conds.append(f"ia.range_id=${n}"); params.append(range_id); n += 1
    params.append(limit)
    async with pool.acquire() as conn:
        rows = await conn.fetch(f"""
            SELECT host(ia.ip)||'/32' AS ip, ia.is_alive, ia.alive_source, ia.rtt_ms,
                   ia.range_id, ia.device_id, ia.updated_at,
                   r.label AS range_label, s.id AS site_id, s.name AS site_name, s.color AS site_color,
                   d.hostname AS device_hostname, d.alias AS device_alias
            FROM ip_addresses ia
            LEFT JOIN ip_ranges r ON r.id=ia.range_id
            LEFT JOIN sites s ON s.id=r.site_id
            LEFT JOIN devices d ON d.id=ia.device_id
            WHERE {' AND '.join(conds)}
            ORDER BY ia.ip LIMIT ${n}
        """, *params)
    result = []
    for r in rows:
        d = dict(r)
        if d.get("updated_at"): d["updated_at"] = d["updated_at"].isoformat()
        result.append(d)
    return result


async def refresh_ip_addresses(pool) -> None:
    await sync_ip_range_assignments(pool)
    await refresh_alive_from_presence(pool)


async def get_ip_presence(pool, ip: str, hours: int = 24) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT ip::text, source, seen_at, expires_at FROM ip_presence_log
            WHERE ip=$1::inet AND seen_at > NOW()-make_interval(hours=>$2)
            ORDER BY seen_at DESC LIMIT 500
        """, ip, hours)
    return [dict(r) | {"seen_at": r["seen_at"].isoformat(),
            "expires_at": r["expires_at"].isoformat() if r.get("expires_at") else None} for r in rows]


async def get_ip_device_map(pool) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT ia.ip::text, ia.device_id, d.hostname, d.alias, d.vendor, d.model
            FROM ip_addresses ia JOIN devices d ON d.id=ia.device_id WHERE ia.device_id IS NOT NULL
        """)
    return [dict(r) for r in rows]


async def get_ip_owner(pool, ip: str) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT ia.device_id, d.hostname, d.alias FROM ip_addresses ia
            JOIN devices d ON d.id=ia.device_id WHERE ia.ip=$1::inet
        """, ip)
    return dict(row) if row else None


async def get_ip_changes_stats(pool, device_id: int | None = None, hours: int = 24) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT COUNT(*) FILTER (WHERE is_alive=TRUE) AS came_online,
                   COUNT(*) FILTER (WHERE is_alive=FALSE) AS went_offline
            FROM ip_addresses WHERE updated_at > NOW()-make_interval(hours=>$1)
        """, hours)
    return dict(row) if row else {"came_online": 0, "went_offline": 0}


async def add_scan_exclusion(pool, ip: str, reason: str | None = None,
                             added_by: str | None = None) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO scan_exclusions (ip, reason) VALUES ($1::inet, $2)
            ON CONFLICT (ip) DO UPDATE SET reason=$2 RETURNING *
        """, ip, reason)
    return dict(row)


async def remove_scan_exclusion(pool, exclusion_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("DELETE FROM scan_exclusions WHERE id=$1", exclusion_id)


async def mark_startup_zombies(pool) -> int:
    async with pool.acquire() as conn:
        result = await conn.execute("""
            UPDATE scan_jobs SET status='zombie', updated_at=NOW()
            WHERE status IN ('running','pending') AND started_at < NOW()-INTERVAL '1 hour'
        """)
    return int(result.split()[-1]) if result else 0


async def scan_job_heartbeat(pool, job_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("UPDATE scan_jobs SET heartbeat_at=NOW() WHERE id=$1", job_id)


async def update_device_poll_result(pool, device_id: int, result) -> None:
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE devices SET
                hostname=COALESCE($2,hostname), firmware=COALESCE($3,firmware),
                model=COALESCE($4,model), last_polled_at=NOW(), last_poll_method=$5
            WHERE id=$1
        """, device_id, getattr(result,"hostname",None), getattr(result,"firmware",None),
            getattr(result,"model",None), getattr(result,"method",None))


async def get_device_ips(pool, device_id: int) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, device_id, ip::text, mac, interface, source,
                   is_primary, first_seen, last_seen, change_count
            FROM device_ips WHERE device_id=$1 ORDER BY last_seen DESC
        """, device_id)
    return [dict(r) | {
        "last_seen":  r["last_seen"].isoformat()  if r.get("last_seen")  else None,
        "first_seen": r["first_seen"].isoformat() if r.get("first_seen") else None,
    } for r in rows]


async def update_device_ips(pool, device_id: int, ips: list[dict], src_pfx: str = "arp") -> dict:
    """Uloží device_ips a vrátí statistiky změn."""
    if not ips:
        return {"inserted": 0, "changes": False}
    async with pool.acquire() as conn:
        await conn.executemany("""
            INSERT INTO device_ips (device_id, ip, mac, interface, source, last_seen)
            VALUES ($1, $2::inet, $3, $4, $5, NOW())
            ON CONFLICT (device_id, ip, source) DO UPDATE SET
                mac=COALESCE(EXCLUDED.mac, device_ips.mac),
                interface=EXCLUDED.interface,
                last_seen=NOW(),
                change_count=device_ips.change_count+1
        """, [(device_id, e["ip"], e.get("mac"), e.get("interface"),
               e.get("source", src_pfx)) for e in ips])
    return {"inserted": len(ips), "changes": len(ips) > 0}


async def get_device_ip_history(pool, device_id: int, limit: int = 100) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, device_id, ip::text, mac, interface, source, event,
                   old_value, new_value, changed_at
            FROM device_ip_history WHERE device_id=$1 ORDER BY changed_at DESC LIMIT $2
        """, device_id, limit)
    return [
        dict(r) | {
            "seen_at":    r["changed_at"].isoformat() if r.get("changed_at") else None,
            "changed_at": r["changed_at"].isoformat() if r.get("changed_at") else None,
        } for r in rows
    ]


async def get_device_data(pool, device_id: int, data_type: str) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT * FROM device_data WHERE device_id=$1 AND data_type=$2
            ORDER BY collected_at DESC LIMIT 1
        """, device_id, data_type)
    if not row: return None
    d = dict(row)
    if d.get("collected_at"): d["collected_at"] = d["collected_at"].isoformat()
    return d


async def get_all_device_data(pool, device_id: int) -> dict:
    """Vrátí data zařízení jako dict {data_type: {data, collected_at, source}}."""
    import json as _j
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT DISTINCT ON (data_type) data_type, data, collected_at, source
            FROM device_data
            WHERE device_id=$1 ORDER BY data_type, collected_at DESC
        """, device_id)
    result = {}
    for r in rows:
        data = r["data"]
        if isinstance(data, str):
            try: data = _j.loads(data)
            except: pass
        result[r["data_type"]] = {
            "data": data,
            "collected_at": r["collected_at"].isoformat() if r.get("collected_at") else None,
            "source": r.get("source"),
        }
    return result


async def save_device_data(pool, device_id: int, data_type: str, data: dict,
                           source: str | None = None) -> None:
    import json
    async with pool.acquire() as conn:
        await conn.execute("""
            INSERT INTO device_data (device_id, data_type, data, collected_at)
            VALUES ($1, $2, $3, NOW())
        """, device_id, data_type, json.dumps(data))


async def sync_ip_addresses_from_device_ips(pool, device_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("""
            UPDATE ip_addresses SET device_id=$1
            WHERE ip IN (SELECT ip FROM device_ips WHERE device_id=$1)
              AND (device_id IS NULL OR device_id=$1)
        """, device_id)


async def backfill_ip_range_assignments(pool) -> int:
    return await sync_ip_range_assignments(pool)


def _enriched_where(site_id, range_id, status, device, search):
    conds = ["1=1"]
    params: list = []
    n = 1
    if site_id is not None:
        conds.append(f"r.site_id=${n}"); params.append(site_id); n += 1
    if range_id is not None:
        conds.append(f"ia.range_id=${n}"); params.append(range_id); n += 1
    if status == "online": conds.append("ia.is_alive IS TRUE")
    elif status == "offline": conds.append("ia.is_alive IS NOT TRUE")
    if device == "assigned": conds.append("ia.device_id IS NOT NULL")
    elif device == "free": conds.append("ia.device_id IS NULL")
    if search:
        # Detekujeme jestli search vypadá jako CIDR (10.1.1.0/24), IP prefix nebo text
        import re as _re
        if _re.match(r'^\d+\.\d+\.\d+\.\d+/\d+$', search):
            # Přesná CIDR notace - hledáme IP patřící do sítě
            conds.append(f"ia.ip <<= ${n}::inet")
            params.append(search); n += 1
        elif _re.match(r'^[\d.]+$', search) and search.count('.') < 4:
            # IP prefix (10.1 nebo 10.1.1) - použijeme inet operátory
            conds.append(f"(host(ia.ip) LIKE ${n} OR d.hostname ILIKE ${n+1} OR d.alias ILIKE ${n+1})")
            params.append(f"{search}%"); params.append(f"%{search}%"); n += 2
        else:
            # Textové vyhledávání
            conds.append(f"(host(ia.ip) ILIKE ${n} OR d.hostname ILIKE ${n} OR d.alias ILIKE ${n})")
            params.append(f"%{search}%"); n += 1
    return " AND ".join(conds), params, n


async def get_hosts_enriched(pool, site_id=None, range_id=None, status=None,
                              device=None, search=None, limit=2000, offset=0,
                              sort_by: str = "ip", sort_dir: str = "asc") -> dict:
    where, params, n = _enriched_where(site_id, range_id, status, device, search)
    # Whitelist pro sort_by - bezpečné vložení do SQL
    _sort_map = {
        "ip":          "ia.ip",
        "hostname":    "d.hostname",
        "device_hostname": "d.hostname",
        "device_type": "d.device_type",
        "mac":         "d.mac::text",
        "uptime_pct":  "ia.uptime_pct_24h",
        "avg_rtt_ms":  "ia.avg_rtt_24h",
        "avg_loss_pct":"ia.packet_loss_24h",
        "is_alive":    "ia.is_alive",
        "site_name":   "s.name",
        "range_label": "r.label",
        "measurements":"ia.checks_24h",
    }
    _dir = "DESC" if sort_dir.lower() == "desc" else "ASC"
    # NULLS LAST musí být za směrem: "col ASC NULLS LAST"
    _col = _sort_map.get(sort_by, "ia.ip")
    _nulls = "" if sort_by == "ip" else " NULLS LAST"
    order_clause = f"{_col} {_dir}{_nulls}"
    # Vždy přidáme ia.ip jako sekundární řazení
    if sort_by != "ip":
        order_clause += ", ia.ip ASC"

    async with pool.acquire() as conn:
        stats_row = await conn.fetchrow(f"""
            SELECT COUNT(*) AS total,
                   COUNT(*) FILTER (WHERE ia.is_alive=TRUE) AS alive,
                   COUNT(*) FILTER (WHERE ia.device_id IS NOT NULL) AS assigned,
                   ROUND(AVG(ia.avg_rtt_24h)::numeric,1) AS avg_rtt,
                   ROUND(AVG(ia.uptime_pct_24h)::numeric,1) AS avg_uptime
            FROM ip_addresses ia
            LEFT JOIN ip_ranges r ON r.id=ia.range_id
            LEFT JOIN sites s ON s.id=r.site_id
            LEFT JOIN devices d ON d.id=ia.device_id
            WHERE {where}
        """, *params)
        rows = await conn.fetch(f"""
            SELECT host(ia.ip)||'/32' AS ip, ia.is_alive AS currently_alive, ia.alive_source,
                   ia.range_id, r.label AS range_label, r.site_id,
                   s.name AS site_name, s.color AS site_color,
                   ia.device_id, d.hostname AS device_hostname, d.alias AS device_alias,
                   d.vendor AS device_vendor, d.device_type, d.mac::text AS mac,
                   ia.avg_rtt_24h AS avg_rtt_ms, ia.min_rtt_24h AS min_rtt_ms,
                   ia.max_rtt_24h AS max_rtt_ms, ia.packet_loss_24h AS avg_loss_pct,
                   ia.checks_24h AS measurements, ia.uptime_pct_24h AS uptime_pct,
                   ia.last_check AS last_check
            FROM ip_addresses ia
            LEFT JOIN ip_ranges r ON r.id=ia.range_id
            LEFT JOIN sites s ON s.id=r.site_id
            LEFT JOIN devices d ON d.id=ia.device_id
            WHERE {where}
            ORDER BY {order_clause}
            LIMIT ${n} OFFSET ${n+1}
        """, *params, limit, offset)
    return {
        "stats": {
            "total": stats_row["total"], "alive": stats_row["alive"],
            "offline": stats_row["total"]-stats_row["alive"],
            "assigned": stats_row["assigned"],
            "avg_rtt": float(stats_row["avg_rtt"]) if stats_row["avg_rtt"] else None,
            "avg_uptime": float(stats_row["avg_uptime"]) if stats_row["avg_uptime"] else None,
        },
        "rows": [dict(r) | {"last_check": r["last_check"].isoformat() if r.get("last_check") else None}
                 for r in rows],
    }


async def get_unknown_networks(pool) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            WITH unknown_ips AS (
                SELECT DISTINCT pl.ip FROM ip_presence_log pl
                WHERE (pl.ip<<'10.0.0.0/8'::inet OR pl.ip<<'172.16.0.0/12'::inet OR pl.ip<<'192.168.0.0/16'::inet)
                  AND NOT EXISTS (SELECT 1 FROM ip_ranges r WHERE r.active=TRUE AND pl.ip<<r.network)
            ),
            grouped AS (
                SELECT network(set_masklen(ui.ip,24)) AS subnet,
                       COUNT(DISTINCT ui.ip) AS ip_count,
                       array_agg(DISTINCT pl.source) AS sources,
                       MAX(pl.seen_at) AS last_seen
                FROM unknown_ips ui JOIN ip_presence_log pl ON pl.ip=ui.ip
                GROUP BY network(set_masklen(ui.ip,24))
            )
            SELECT subnet::text, ip_count, sources, last_seen FROM grouped ORDER BY ip_count DESC, subnet
        """)
    return [dict(r) | {"last_seen": r["last_seen"].isoformat() if r.get("last_seen") else None,
                       "sources": list(r["sources"])} for r in rows]


async def get_unknown_network_ips(pool, subnet: str) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT pl.ip::text AS ip, MAX(pl.seen_at) AS last_seen,
                   array_agg(DISTINCT pl.source) AS sources,
                   (SELECT di.mac FROM device_ips di
                    WHERE split_part(di.ip::text,'/',1)=host(pl.ip) AND di.mac IS NOT NULL
                    ORDER BY di.last_seen DESC LIMIT 1) AS mac
            FROM ip_presence_log pl
            WHERE pl.ip<<$1::inet
              AND NOT EXISTS (SELECT 1 FROM ip_ranges r WHERE r.active=TRUE AND pl.ip<<r.network)
            GROUP BY pl.ip ORDER BY pl.ip
        """, subnet)
    return [dict(r) | {"last_seen": r["last_seen"].isoformat() if r.get("last_seen") else None,
                       "sources": list(r["sources"])} for r in rows]


async def get_sites(pool) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT s.id, s.name, s.description, s.color, s.active, s.created_at,
                   COUNT(r.id) AS range_count
            FROM sites s LEFT JOIN ip_ranges r ON r.site_id=s.id
            GROUP BY s.id ORDER BY s.id
        """)
    result = []
    for r in rows:
        d = dict(r)
        d["range_count"] = int(d.get("range_count") or 0)
        if d.get("created_at"): d["created_at"] = d["created_at"].isoformat()
        result.append(d)
    return result


async def create_site(pool, name: str, description, color: str) -> dict:
    async with pool.acquire() as conn:
        await conn.execute("SELECT setval('sites_id_seq', GREATEST((SELECT MAX(id) FROM sites),1))")
        row = await conn.fetchrow("""
            INSERT INTO sites (name, description, color) VALUES ($1,$2,$3)
            RETURNING id, name, description, color, active, created_at
        """, name, description, color)
        rc = await conn.fetchval("SELECT COUNT(*) FROM ip_ranges WHERE site_id=$1", row["id"])
    d = dict(row)
    d["range_count"] = int(rc or 0)
    if d.get("created_at"): d["created_at"] = d["created_at"].isoformat()
    return d


async def update_site(pool, site_id: int, name: str, description, color: str, active: bool) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            UPDATE sites SET name=$2, description=$3, color=$4, active=$5 WHERE id=$1
            RETURNING id, name, description, color, active, created_at
        """, site_id, name, description, color, active)
    d = dict(row)
    if d.get("created_at"): d["created_at"] = d["created_at"].isoformat()
    d["range_count"] = 0
    return d


async def delete_site(pool, site_id: int) -> None:
    async with pool.acquire() as conn:
        await conn.execute("UPDATE ip_ranges SET site_id=NULL WHERE site_id=$1", site_id)
        await conn.execute("DELETE FROM sites WHERE id=$1 AND id!=1", site_id)


async def get_ip_ranges_with_site(pool) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT r.id, r.label, r.network::text, r.active, r.scan_enabled,
                   r.description, r.site_id, s.name AS site_name, s.color AS site_color
            FROM ip_ranges r LEFT JOIN sites s ON s.id=r.site_id ORDER BY r.network::inet
        """)
    return [dict(r) for r in rows]


async def get_scan_exclusions(pool) -> list[dict]:
    async with pool.acquire() as conn:
        rows = await conn.fetch("SELECT * FROM scan_exclusions ORDER BY created_at DESC")
    return [dict(r) for r in rows]


# ===========================================================================
# locations — fyzická umístění zařízení
# ===========================================================================

def _loc_row(r: dict) -> dict:
    """Normalizuje časová razítka v lokaci."""
    d = dict(r)
    if d.get("created_at"):
        d["created_at"] = d["created_at"].isoformat()
    return d


async def get_locations(pool, active_only: bool = False) -> list[dict]:
    """Vrátí všechny lokace včetně breadcrumb cesty a počtu zařízení."""
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            WITH RECURSIVE loc_path AS (
                SELECT id, name, parent_id, ARRAY[name] AS path
                FROM locations WHERE parent_id IS NULL
                UNION ALL
                SELECT l.id, l.name, l.parent_id, lp.path || l.name
                FROM locations l JOIN loc_path lp ON l.parent_id = lp.id
            )
            SELECT
                l.id, l.name, l.type, l.parent_id,
                l.street, l.city, l.zip, l.country, l.ruian_id,
                l.lat, l.lng, l.description, l.active, l.created_at,
                lp.path AS breadcrumb,
                COUNT(d.id) AS device_count
            FROM locations l
            LEFT JOIN loc_path lp ON lp.id = l.id
            LEFT JOIN devices d ON d.location_id = l.id
            WHERE ($1 = FALSE OR l.active = TRUE)
            GROUP BY l.id, l.name, l.type, l.parent_id,
                     l.street, l.city, l.zip, l.country, l.ruian_id,
                     l.lat, l.lng, l.description, l.active, l.created_at,
                     lp.path
            ORDER BY lp.path
        """, active_only)
    result = []
    for r in rows:
        d = _loc_row(r)
        d["breadcrumb"] = list(r["breadcrumb"]) if r.get("breadcrumb") else [r["name"]]
        d["device_count"] = int(d.get("device_count") or 0)
        result.append(d)
    return result



async def get_locations_table(pool) -> list[dict]:
    """
    Vrátí lokace pro tabulkový pohled se stats:
    - device_count: přímá zařízení
    - total_device_count: všechna zařízení včetně podřízených (rekurzivně)
    - online_count, offline_count: celkové (rekurzivně)
    - children_count: počet přímých potomků
    - parent_name: název nadřazené lokace
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            WITH RECURSIVE
            -- Strom lokací s breadcrumb
            loc_tree AS (
                SELECT id, name, parent_id, ARRAY[name] AS path, 0 AS depth
                FROM locations WHERE parent_id IS NULL
                UNION ALL
                SELECT l.id, l.name, l.parent_id, lt.path || l.name, lt.depth + 1
                FROM locations l JOIN loc_tree lt ON l.parent_id = lt.id
            ),
            -- Všichni potomci pro každou lokaci (včetně sebe)
            loc_descendants AS (
                SELECT l.id AS root_id, l.id AS desc_id
                FROM locations l
                UNION ALL
                SELECT ld.root_id, l.id
                FROM locations l JOIN loc_descendants ld ON l.parent_id = ld.desc_id
            ),
            -- Stats zařízení přes celý podstrom
            device_stats AS (
                SELECT
                    ld.root_id AS location_id,
                    COUNT(d.id)                                          AS total_devices,
                    COUNT(d.id) FILTER (WHERE ia.is_alive = TRUE)        AS online_devices,
                    COUNT(d.id) FILTER (WHERE ia.is_alive = FALSE)       AS offline_devices
                FROM loc_descendants ld
                LEFT JOIN devices d ON d.location_id = ld.desc_id
                LEFT JOIN LATERAL (
                    SELECT is_alive FROM ip_addresses
                    WHERE device_id = d.id
                    ORDER BY updated_at DESC NULLS LAST LIMIT 1
) ia ON TRUE
                GROUP BY ld.root_id
            ),
            -- Přímá zařízení (ne rekurzivně)
            direct_devices AS (
                SELECT location_id, COUNT(*) AS cnt
                FROM devices WHERE location_id IS NOT NULL
                GROUP BY location_id
            ),
            -- Počet přímých potomků
            children AS (
                SELECT parent_id, COUNT(*) AS cnt
                FROM locations WHERE parent_id IS NOT NULL
                GROUP BY parent_id
            )
            SELECT
                l.id, l.name, l.type, l.parent_id, l.active,
                l.street, l.city, l.lat, l.lng,
                lt.path AS breadcrumb,
                lt.depth,
                p.name AS parent_name,
                COALESCE(dd.cnt, 0)              AS device_count,
                COALESCE(ds.total_devices, 0)    AS total_device_count,
                COALESCE(ds.online_devices, 0)   AS online_count,
                COALESCE(ds.offline_devices, 0)  AS offline_count,
                COALESCE(ch.cnt, 0)              AS children_count
            FROM locations l
            LEFT JOIN loc_tree lt ON lt.id = l.id
            LEFT JOIN locations p ON p.id = l.parent_id
            LEFT JOIN device_stats ds ON ds.location_id = l.id
            LEFT JOIN direct_devices dd ON dd.location_id = l.id
            LEFT JOIN children ch ON ch.parent_id = l.id
            ORDER BY lt.path
        """)

    result = []
    for r in rows:
        result.append({
            "id":               r["id"],
            "name":             r["name"],
            "type":             r["type"],
            "parent_id":        r["parent_id"],
            "parent_name":      r["parent_name"],
            "active":           r["active"],
            "street":           r["street"],
            "city":             r["city"],
            "lat":              float(r["lat"]) if r["lat"] else None,
            "lng":              float(r["lng"]) if r["lng"] else None,
            "breadcrumb":       list(r["breadcrumb"]) if r["breadcrumb"] else [r["name"]],
            "depth":            r["depth"],
            "device_count":     int(r["device_count"]),
            "total_device_count": int(r["total_device_count"]),
            "online_count":     int(r["online_count"]),
            "offline_count":    int(r["offline_count"]),
            "children_count":   int(r["children_count"]),
        })
    return result

async def get_location(pool, location_id: int) -> dict | None:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT l.*,
                   COUNT(d.id) AS device_count
            FROM locations l
            LEFT JOIN devices d ON d.location_id = l.id
            WHERE l.id = $1
            GROUP BY l.id
        """, location_id)
    if not row:
        return None
    d = _loc_row(row)
    d["device_count"] = int(d.get("device_count") or 0)
    return d


async def create_location(pool, data: dict) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            INSERT INTO locations
                (name, type, parent_id, street, city, zip, country,
                 ruian_id, lat, lng, description, active)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *
        """,
        data["name"], data.get("type", "other"), data.get("parent_id"),
        data.get("street"), data.get("city"), data.get("zip"),
        data.get("country", "CZ"), data.get("ruian_id"),
        data.get("lat"), data.get("lng"),
        data.get("description"), data.get("active", True))
    d = _loc_row(row)
    d["device_count"] = 0
    d["breadcrumb"] = [d["name"]]
    return d


async def update_location(pool, location_id: int, data: dict) -> dict:
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            UPDATE locations SET
                name        = $2,
                type        = $3,
                parent_id   = $4,
                street      = $5,
                city        = $6,
                zip         = $7,
                country     = $8,
                ruian_id    = $9,
                lat         = $10,
                lng         = $11,
                description = $12,
                active      = $13
            WHERE id = $1
            RETURNING *
        """,
        location_id,
        data["name"], data.get("type", "other"), data.get("parent_id"),
        data.get("street"), data.get("city"), data.get("zip"),
        data.get("country", "CZ"), data.get("ruian_id"),
        data.get("lat"), data.get("lng"),
        data.get("description"), data.get("active", True))
    d = _loc_row(row)
    d["device_count"] = 0
    d["breadcrumb"] = [d["name"]]
    return d


async def delete_location(pool, location_id: int) -> None:
    async with pool.acquire() as conn:
        # Odpojíme podřízené lokace
        await conn.execute(
            "UPDATE locations SET parent_id=NULL WHERE parent_id=$1", location_id)
        # Odpojíme zařízení
        await conn.execute(
            "UPDATE devices SET location_id=NULL WHERE location_id=$1", location_id)
        await conn.execute("DELETE FROM locations WHERE id=$1", location_id)


async def get_location_devices(pool, location_id: int) -> list[dict]:
    """Zařízení přímo v dané lokaci."""
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT id, hostname, alias, ip::text, device_type, vendor, ownership
            FROM devices WHERE location_id=$1 ORDER BY hostname
        """, location_id)
    return [dict(r) for r in rows]


async def get_locations_with_gps(pool) -> list[dict]:
    """Jen lokace s GPS souřadnicemi — pro mapu."""
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT l.id, l.name, l.type, l.lat, l.lng,
                   l.street, l.city, l.zip,
                   COUNT(d.id) AS device_count
            FROM locations l
            LEFT JOIN devices d ON d.location_id = l.id
            WHERE l.lat IS NOT NULL AND l.lng IS NOT NULL AND l.active = TRUE
            GROUP BY l.id ORDER BY l.name
        """)
    return [dict(r) | {"device_count": int(r["device_count"] or 0)} for r in rows]


# ===========================================================================
# OUTAGES — výpadky a log změn
# ===========================================================================

async def open_outage(pool, ip: str, device_id: int | None, source: str = "ping") -> int:
    """Otevře nový výpadek. Vrátí ID."""
    async with pool.acquire() as conn:
        # Nezakládáme duplicitní otevřený výpadek pro stejnou IP
        existing = await conn.fetchval(
            "SELECT id FROM outages WHERE ip=$1::inet AND ended_at IS NULL", ip
        )
        if existing:
            return existing
        return await conn.fetchval(
            "INSERT INTO outages (ip, device_id, source) VALUES ($1::inet,$2,$3) RETURNING id",
            ip, device_id, source
        )


async def close_outage(pool, ip: str, resolution: str = "recovered") -> int | None:
    """Uzavře otevřený výpadek. Vrátí duration_s nebo None."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            "SELECT id, started_at FROM outages WHERE ip=$1::inet AND ended_at IS NULL",
            ip
        )
        if not row:
            return None
        duration = int((
            __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
            - row["started_at"]
        ).total_seconds())
        await conn.execute(
            """UPDATE outages SET ended_at=NOW(), duration_s=$2, resolution=$3
               WHERE id=$1""",
            row["id"], duration, resolution
        )
        return duration


async def check_device_has_other_ip(pool, device_id: int, exclude_ip: str) -> str | None:
    """
    Vrátí jinou IP stejného zařízení (stejná síť/range) viděnou v posledních 10 min.
    Filtrujeme podle range_id aby nedošlo k záměně stejných IP v různých sítích.
    """
    if not device_id:
        return None
    async with pool.acquire() as conn:
        # Zjistíme range_id původní IP
        orig_range = await conn.fetchval(
            "SELECT range_id FROM ip_addresses WHERE ip=$1::inet", exclude_ip
        )
        row = await conn.fetchrow(
            """SELECT ia.ip::text FROM ip_addresses ia
               WHERE ia.device_id = $1
                 AND ia.ip != $2::inet
                 AND ia.is_alive = TRUE
                 AND ia.updated_at > NOW() - INTERVAL '10 minutes'
                 AND ($3::int IS NULL OR ia.range_id = $3)
               ORDER BY ia.updated_at DESC LIMIT 1""",
            device_id, exclude_ip, orig_range
        )
    return row["ip"] if row else None


async def log_ip_event(pool, ip: str, event_type: str, device_id: int | None = None,
                       source: str | None = None, meta: dict | None = None) -> None:
    import json as _j
    async with pool.acquire() as conn:
        # Přidáme snapshot last_online do meta
        lo = await conn.fetchval(
            "SELECT last_online FROM ip_addresses WHERE ip=$1::inet", ip
        )
        full_meta = meta or {}
        if lo:
            full_meta["snap_last_online"] = lo.isoformat()
        await conn.execute(
            """INSERT INTO ip_events (ip, device_id, event_type, source, meta)
               VALUES ($1::inet, $2, $3, $4, $5)""",
            ip, device_id, event_type, source,
            _j.dumps(full_meta) if full_meta else None
        )


async def log_device_event(pool, device_id: int, event_type: str,
                           old_value: dict | None = None,
                           new_value: dict | None = None) -> None:
    import json as _j
    async with pool.acquire() as conn:
        await conn.execute(
            """INSERT INTO device_events (device_id, event_type, old_value, new_value)
               VALUES ($1, $2, $3, $4)""",
            device_id, event_type,
            _j.dumps(old_value) if old_value else None,
            _j.dumps(new_value) if new_value else None
        )


async def process_ip_state_change(pool, ip: str, is_alive: bool,
                                  device_id: int | None, source: str = "ping") -> None:
    """
    Hlavní funkce volaná při každé změně stavu IP.
    Rozhoduje: výpadek vs změna IP, zapisuje události.
    """
    if is_alive:
        # IP se vrátila online
        duration = await close_outage(pool, ip, resolution="recovered")
        await log_ip_event(pool, ip, "online", device_id, source)
        # Aktualizujeme last_online
        async with pool.acquire() as conn:
            await conn.execute(
                "UPDATE ip_addresses SET last_online=NOW() WHERE ip=$1::inet", ip
            )
            if device_id:
                await conn.execute(
                    "UPDATE devices SET last_online=NOW() WHERE id=$1", device_id
                )
    else:
        # IP přestala pingovat — je to výpadek nebo změna IP?
        other_ip = await check_device_has_other_ip(pool, device_id, ip)

        if other_ip:
            # Zařízení je vidět na jiné IP → změna IP, ne výpadek
            await close_outage(pool, ip, resolution="ip_changed")
            await log_ip_event(pool, ip, "ip_changed", device_id, source,
                               meta={"new_ip": other_ip})
            if device_id:
                await log_device_event(pool, device_id, "ip_changed",
                                       old_value={"ip": ip},
                                       new_value={"ip": other_ip})
                # last_online se aktualizuje — zařízení je stále online
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE devices SET last_online=NOW() WHERE id=$1", device_id
                    )
        else:
            # Skutečný výpadek
            await open_outage(pool, ip, device_id, source)
            await log_ip_event(pool, ip, "offline", device_id, source)


async def get_outages_new(pool, hours: int = 24, active_only: bool = False,
                          limit: int = 200, min_duration_s: int = 0) -> list[dict]:
    """Vrátí výpadky z nové tabulky — rychlé."""
    async with pool.acquire() as conn:
        rows = await conn.fetch("""
            SELECT o.id, o.ip::text, o.device_id, o.started_at, o.ended_at,
                   o.duration_s, o.resolution, o.source,
                   d.hostname, d.alias, d.mac::text AS mac,
                   CASE WHEN o.ended_at IS NULL THEN TRUE ELSE FALSE END AS is_active,
                   ia.last_online,
                   r.label AS range_label, s.name AS site_name
            FROM outages o
            LEFT JOIN devices d ON d.id = o.device_id
            LEFT JOIN ip_addresses ia ON ia.ip = o.ip
            LEFT JOIN ip_ranges r ON r.id = ia.range_id
            LEFT JOIN sites s ON s.id = r.site_id
            WHERE ($1 = FALSE OR o.ended_at IS NULL)
              AND o.started_at > NOW() - make_interval(hours=>$2)
              AND (o.duration_s IS NULL OR o.duration_s >= $4)
            ORDER BY o.started_at DESC
            LIMIT $3
        """, active_only, hours, limit, min_duration_s)
    return [
        dict(r) | {
            "started_at":  r["started_at"].isoformat(),
            "ended_at":    r["ended_at"].isoformat() if r["ended_at"] else None,
            "last_online": r["last_online"].isoformat() if r.get("last_online") else None,
            "mac":         r.get("mac"),
            "range_label": r.get("range_label"),
            "site_name":   r.get("site_name"),
        }
        for r in rows
    ]


async def get_change_log(pool, hours: int = 24, device_id: int | None = None,
                         event_types: list | None = None, limit: int = 200) -> list[dict]:
    """
    Unified log změn — IP události + Device události chronologicky.
    """
    import json as _j
    conds_ip  = ["occurred_at > NOW() - make_interval(hours=>$1)"]
    conds_dev = ["occurred_at > NOW() - make_interval(hours=>$1)"]
    params    = [hours]
    n = 2

    if device_id:
        conds_ip.append(f"device_id = ${n}")
        conds_dev.append(f"device_id = ${n}")
        params.append(device_id)
        n += 1

    if event_types:
        conds_ip.append(f"event_type = ANY(${n}::text[])")
        conds_dev.append(f"event_type = ANY(${n}::text[])")
        params.append(event_types)
        n += 1

    async with pool.acquire() as conn:
        rows = await conn.fetch(f"""
            SELECT 'ip' AS log_type, ie.id, ie.ip::text AS ip,
                   ie.device_id, ie.event_type, ie.source,
                   ie.occurred_at, ie.meta::text AS meta,
                   d.hostname, d.alias,
                   NULL::text AS old_value, NULL::text AS new_value,
                   ia.last_online, d.mac::text AS mac,
                   r.label AS range_label, s.name AS site_name
            FROM ip_events ie
            LEFT JOIN devices d ON d.id = ie.device_id
            LEFT JOIN ip_addresses ia ON ia.ip = ie.ip
            LEFT JOIN ip_ranges r ON r.id = ia.range_id
            LEFT JOIN sites s ON s.id = r.site_id
            WHERE {' AND '.join(conds_ip)}

            UNION ALL

            SELECT 'device' AS log_type, de.id, d.ip::text AS ip,
                   de.device_id, de.event_type, NULL AS source,
                   de.occurred_at, NULL AS meta,
                   d.hostname, d.alias,
                   de.old_value::text, de.new_value::text,
                   d.last_online, d.mac::text AS mac,
                   NULL::text AS range_label, NULL::text AS site_name
            FROM device_events de
            JOIN devices d ON d.id = de.device_id
            WHERE {' AND '.join(conds_dev)}

            ORDER BY occurred_at DESC
            LIMIT ${n}
        """, *params, limit)

    result = []
    for r in rows:
        d = dict(r)
        d["occurred_at"] = r["occurred_at"].isoformat()
        d["last_online"]  = r["last_online"].isoformat() if r.get("last_online") else None
        d["mac"]          = r.get("mac")
        d["range_label"]  = r.get("range_label")
        d["site_name"]    = r.get("site_name")
        # Použijeme snap_last_online z meta pokud je k dispozici
        if isinstance(d.get('meta'), dict) and d['meta'].get('snap_last_online'):
            d['last_online'] = d['meta']['snap_last_online']
        if d.get("meta"):
            try: d["meta"] = _j.loads(d["meta"])
            except: pass
        if d.get("old_value"):
            try: d["old_value"] = _j.loads(d["old_value"])
            except: pass
        if d.get("new_value"):
            try: d["new_value"] = _j.loads(d["new_value"])
            except: pass
        result.append(d)
    return result


async def get_outage_stats(pool, hours: int = 24) -> dict:
    """Statistiky výpadků."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow("""
            SELECT
                COUNT(*) FILTER (WHERE ended_at IS NULL)     AS active,
                COUNT(*) FILTER (WHERE ended_at IS NOT NULL
                    AND resolution = 'recovered')            AS recovered,
                COUNT(*) FILTER (WHERE resolution='ip_changed') AS ip_changes,
                ROUND(AVG(duration_s) FILTER (WHERE duration_s IS NOT NULL))::int AS avg_duration_s,
                MAX(duration_s)                              AS max_duration_s
            FROM outages
            WHERE started_at > NOW() - make_interval(hours=>$1)
        """, hours)
    return dict(row) if row else {}


# ===========================================================================
# CLEANUP — mazání starých ping_results
# ===========================================================================

async def cleanup_ping_results(pool, retention_days: int) -> dict:
    """Smaže ping_results starší než retention_days dní a provede VACUUM ANALYZE."""
    import logging as _log
    logger = _log.getLogger("netpulse.cleanup")

    async with pool.acquire() as conn:
        total_before = await conn.fetchval("SELECT COUNT(*) FROM ping_results")
        deleted = await conn.fetchval(
            "WITH deleted AS (DELETE FROM ping_results "
            "WHERE scanned_at < NOW() - $1::interval RETURNING 1) "
            "SELECT COUNT(*) FROM deleted",
            f"{retention_days} days"
        )
        total_after = await conn.fetchval("SELECT COUNT(*) FROM ping_results")

    logger.info(
        f"Cleanup ping_results: smazáno {deleted} záznamů "
        f"({total_before} → {total_after}), retence {retention_days} dní"
    )

    # VACUUM ANALYZE mimo transakci
    try:
        import os as _os, asyncpg as _apg
        db_url = _os.environ.get("DATABASE_URL") or _os.environ.get("NETPULSE_DB_URL", "")
        conn2 = await _apg.connect(db_url)
        try:
            await conn2.execute("VACUUM ANALYZE ping_results")
            logger.info("VACUUM ANALYZE ping_results dokončen")
        finally:
            await conn2.close()
    except Exception as e:
        logger.warning(f"VACUUM ANALYZE chyba: {e}")

    return {
        "deleted":        deleted,
        "total_before":   total_before,
        "total_after":    total_after,
        "retention_days": retention_days,
    }
