# backend/syslog.py — Strukturované systémové logy do DB
#
# Zapisuje klíčové události do tabulky system_logs.
# Používá se explicitně v backup.py, scheduler.py, poller.py, main.py.
# Retence: INFO=100 dní, WARNING/ERROR/CRITICAL=365 dní.

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime, timezone
from typing import Optional, Any

log = logging.getLogger("netpulse.syslog")

# Globální pool — nastaví se při startu aplikace
_pool = None


def init(pool) -> None:
    """Inicializuje syslog modul s DB poolem."""
    global _pool
    _pool = pool


# ---------------------------------------------------------------------------
# Hlavní funkce pro zápis
# ---------------------------------------------------------------------------

async def write(
    level:      str,
    module:     str,
    event_type: str,
    message:    str,
    device_id:  Optional[int]  = None,
    user_name:  Optional[str]  = None,
    meta:       Optional[dict] = None,
    pool        = None,
) -> None:
    """
    Zapíše jeden záznam do system_logs.
    pool — přijme explicitní pool nebo použije globální _pool.
    Selhání logu nikdy nevyvolá výjimku (pouze loguje warning).
    """
    _p = pool or _pool
    if _p is None:
        return

    try:
        async with _p.acquire() as conn:
            await conn.execute(
                """
                INSERT INTO system_logs
                    (level, module, event_type, message, device_id, user_name, meta)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                """,
                level.upper(),
                module,
                event_type,
                message,
                device_id,
                user_name,
                json.dumps(meta) if meta else None,
            )
    except Exception as e:
        log.warning(f"syslog.write selhal: {e}")


def write_bg(
    level: str, module: str, event_type: str, message: str,
    device_id: int = None, user_name: str = None, meta: dict = None,
    pool=None,
) -> None:
    """
    Fire-and-forget verze write() — vytvoří asyncio task.
    Použij když jsi v synchronním kontextu nebo nechceš čekat.
    """
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.create_task(write(
                level=level, module=module, event_type=event_type,
                message=message, device_id=device_id, user_name=user_name,
                meta=meta, pool=pool,
            ))
    except Exception as e:
        log.warning(f"syslog.write_bg selhal: {e}")


# ---------------------------------------------------------------------------
# Zkratky pro jednotlivé levely
# ---------------------------------------------------------------------------

async def info(module: str, event_type: str, message: str, **kwargs) -> None:
    await write("INFO", module, event_type, message, **kwargs)


async def warning(module: str, event_type: str, message: str, **kwargs) -> None:
    await write("WARNING", module, event_type, message, **kwargs)


async def error(module: str, event_type: str, message: str, **kwargs) -> None:
    await write("ERROR", module, event_type, message, **kwargs)


async def critical(module: str, event_type: str, message: str, **kwargs) -> None:
    await write("CRITICAL", module, event_type, message, **kwargs)


# ---------------------------------------------------------------------------
# Čtení logů (pro API endpoint)
# ---------------------------------------------------------------------------

async def get_logs(
    pool,
    limit:       int           = 200,
    level:       Optional[str] = None,
    module:      Optional[str] = None,
    event_type:  Optional[str] = None,
    device_id:   Optional[int] = None,
    search:      Optional[str] = None,
    hours:       Optional[int] = None,   # posledních N hodin
) -> list[dict]:
    """Vrátí záznamy system_logs dle filtrů."""
    conditions = []
    params     = []
    i          = 1

    if level:
        conditions.append(f"level = ${i}")
        params.append(level.upper())
        i += 1
    if module:
        conditions.append(f"module ILIKE ${i}")
        params.append(f"%{module}%")
        i += 1
    if event_type:
        conditions.append(f"event_type = ${i}")
        params.append(event_type)
        i += 1
    if device_id:
        conditions.append(f"device_id = ${i}")
        params.append(device_id)
        i += 1
    if search:
        conditions.append(f"(message ILIKE ${i} OR event_type ILIKE ${i})")
        params.append(f"%{search}%")
        i += 1
    if hours:
        conditions.append(f"s.created_at >= NOW() - INTERVAL '{int(hours)} hours'")

    where = f"WHERE {' AND '.join(conditions)}" if conditions else ""

    params.append(limit)
    query = f"""
        SELECT
            s.id, s.created_at, s.level, s.module, s.event_type,
            s.message, s.device_id, s.user_name, s.meta,
            d.hostname, d.alias
        FROM system_logs s
        LEFT JOIN devices d ON d.id = s.device_id
        {where}
        ORDER BY s.created_at DESC
        LIMIT ${i}
    """

    async with pool.acquire() as conn:
        rows = await conn.fetch(query, *params)

    result = []
    for r in rows:
        d = dict(r)
        # Meta je JSONB — asyncpg vrací string nebo dict
        if isinstance(d.get("meta"), str):
            try:
                d["meta"] = json.loads(d["meta"])
            except Exception:
                d["meta"] = None
        result.append(d)
    return result


async def get_log_stats(pool) -> dict:
    """Celkové statistiky system_logs."""
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                COUNT(*)                                               AS total,
                COUNT(*) FILTER (WHERE level = 'INFO')                AS info_count,
                COUNT(*) FILTER (WHERE level = 'WARNING')             AS warning_count,
                COUNT(*) FILTER (WHERE level IN ('ERROR','CRITICAL'))  AS error_count,
                COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '24 hours') AS last_24h,
                MIN(created_at)                                        AS oldest_at,
                MAX(created_at)                                        AS newest_at
            FROM system_logs
            """
        )
    return dict(row) if row else {}


async def get_distinct_modules(pool) -> list[str]:
    """Vrátí seznam unikátních modulů pro filtr."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT module FROM system_logs ORDER BY module"
        )
    return [r["module"] for r in rows]


async def get_distinct_event_types(pool) -> list[str]:
    """Vrátí seznam unikátních typů událostí pro filtr."""
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            "SELECT DISTINCT event_type FROM system_logs ORDER BY event_type"
        )
    return [r["event_type"] for r in rows]


# ---------------------------------------------------------------------------
# Čištění starých záznamů (volá scheduler jednou denně)
# ---------------------------------------------------------------------------

async def cleanup_old_logs(pool, config: dict) -> dict:
    """
    Smaže záznamy starší než retence dle levelu.
    Vrátí počty smazaných záznamů.
    """
    retention_info    = int(config.get("syslog_retention_days_info",    100))
    retention_warning = int(config.get("syslog_retention_days_warning", 365))
    retention_error   = int(config.get("syslog_retention_days_error",   365))

    deleted = {}
    async with pool.acquire() as conn:
        # INFO
        r = await conn.fetchval(
            f"DELETE FROM system_logs WHERE level = 'INFO' "
            f"AND created_at < NOW() - INTERVAL '{retention_info} days' "
            f"RETURNING COUNT(*)"
        )
        deleted["info"] = r or 0

        # WARNING
        r = await conn.fetchval(
            f"DELETE FROM system_logs WHERE level = 'WARNING' "
            f"AND created_at < NOW() - INTERVAL '{retention_warning} days' "
            f"RETURNING COUNT(*)"
        )
        deleted["warning"] = r or 0

        # ERROR / CRITICAL
        r = await conn.fetchval(
            f"DELETE FROM system_logs WHERE level IN ('ERROR','CRITICAL') "
            f"AND created_at < NOW() - INTERVAL '{retention_error} days' "
            f"RETURNING COUNT(*)"
        )
        deleted["error"] = r or 0

    total = sum(deleted.values())
    if total > 0:
        log.info(
            f"Syslog cleanup: smazáno {total} záznamů "
            f"(info={deleted['info']} warning={deleted['warning']} error={deleted['error']})"
        )
    return deleted
