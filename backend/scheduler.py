# backend/scheduler.py — APScheduler pro ping scan + discovery

from __future__ import annotations
import asyncio
import logging
from datetime import datetime, timezone
from typing import Optional

from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.interval import IntervalTrigger

import db
import discovery as disc
import scanner as sc

log = logging.getLogger("netpulse.scheduler")

_scheduler: Optional[AsyncIOScheduler] = None

scan_state = {
    "running":    False,
    "progress":   0,
    "total_ips":  0,
    "done_ips":   0,
    "last_scan":  None,
    "scan_count": 0,
}

discovery_state = {
    "running":          False,
    "progress":         0,
    "total_devices":    0,
    "done_devices":     0,
    "last_discovery":   None,
    "discovery_count":  0,
}


def get_scan_state() -> dict:
    return dict(scan_state)


def get_discovery_state() -> dict:
    return dict(discovery_state)


# ---------------------------------------------------------------------------
# Ping scan
# ---------------------------------------------------------------------------
async def run_scan(
    pool,
    config:       dict,
    trigger_type: str = "cron",
    triggered_by: str = "scheduler",
) -> None:
    if scan_state["running"]:
        log.info("Ping scan již probíhá, přeskakuji.")
        return

    scan_state["running"]  = True
    scan_state["progress"] = 0
    scan_state["done_ips"] = 0
    job_id = None

    try:
        ranges = await db.get_ip_ranges(pool)
        active = [r for r in ranges if r.active]

        import ipaddress
        target_ips = []
        for rng in active:
            try:
                net = ipaddress.ip_network(rng.network, strict=False)
                target_ips.extend(str(ip) for ip in net.hosts())
            except ValueError as e:
                log.warning(f"Neplatný rozsah {rng.network}: {e}")

        scan_state["total_ips"] = len(target_ips)

        if not target_ips:
            log.info("Ping scan: žádné IP adresy.")
            scan_state["running"] = False
            return

        job_id = await db.scan_job_start(
            pool,
            job_type      = "ping_scan",
            trigger_type  = trigger_type,
            triggered_by  = triggered_by,
            total_targets = len(target_ips),
            meta          = {"ranges": [r.label for r in active]},
        )
        log.info(
            f"Spouštím scan {len(target_ips)} IP adres "
            f"(max_concurrent={int(config.get('max_concurrent', 128))}, job_id={job_id})"
        )

        total = len(target_ips)
        done  = 0

        def on_progress(n: int, t: int):
            nonlocal done
            done += 1
            scan_state["done_ips"] = done
            scan_state["progress"] = int((done / total) * 100) if total > 0 else 0

        results = await sc.scan_range(
            target_ips,
            count      = int(config.get("ping_count",     3)),
            timeout_ms = int(config.get("ping_timeout_ms",1000)),
            max_conc   = int(config.get("max_concurrent", 128)),
            on_progress= on_progress,
        )

        await db.save_results(pool, results)

        scan_state["last_scan"]  = datetime.now(timezone.utc).isoformat()
        scan_state["scan_count"] += 1

        ok_count   = sum(1 for r in results if r.is_alive)
        fail_count = sum(1 for r in results if not r.is_alive)

        await db.scan_job_finish(
            pool, job_id,
            status        = "done",
            ok_count      = ok_count,
            fail_count    = fail_count,
            changed_count = 0,
        )
        log.info(
            f"Scan dokončen: {len(results)} výsledků — "
            f"{ok_count} online, {fail_count} offline"
        )

    except Exception as e:
        log.error(f"Chyba scanu: {e}", exc_info=True)
        if job_id:
            try:
                await db.scan_job_finish(
                    pool, job_id, status="error", error_msg=str(e)[:500]
                )
            except Exception:
                pass
    finally:
        scan_state["running"] = False


# ---------------------------------------------------------------------------
# Discovery scheduler
# ---------------------------------------------------------------------------
async def run_discovery_scan(
    pool,
    config:       dict,
    trigger_type: str = "cron",
    triggered_by: str = "scheduler",
) -> None:
    """
    Automatický discovery scan:
    - Načte všechna registrovaná zařízení
    - Filtruje jen online (pokud discovery_only_online=True)
    - Pro každé spustí discovery a uloží výsledky
    """
    if discovery_state["running"]:
        log.info("Discovery scan již probíhá, přeskakuji.")
        return

    discovery_state["running"]       = True
    discovery_state["progress"]      = 0
    discovery_state["done_devices"]  = 0
    job_id = None

    try:
        # Načteme zařízení
        devices = await db.get_devices_with_credentials(pool)
        if not devices:
            log.info("Discovery: žádná registrovaná zařízení.")
            discovery_state["running"] = False
            return

        # Filtrujeme dle online statusu
        only_online = str(config.get("discovery_only_online", "true")).lower() == "true"
        if only_online:
            # Načteme aktuální host stats pro filtrování
            hosts = await db.get_host_stats(pool)
            online_ips = {str(h.ip).split("/")[0] for h in hosts if h.currently_alive}
            targets = [d for d in devices if str(d["ip"]).split("/")[0] in online_ips]
            log.info(
                f"Discovery: {len(targets)}/{len(devices)} zařízení online "
                f"(filtr: pouze online)"
            )
        else:
            targets = devices

        if not targets:
            log.info("Discovery: žádná online zařízení.")
            discovery_state["running"] = False
            return

        # Přeskočíme zařízení u kterých někdy proběhl poll (last_polled_at IS NOT NULL).
        # Zařízení s pollem má aktivní sběr dat — discovery není potřeba.
        skip_polled = str(config.get("discovery_skip_polled", "true")).lower() == "true"
        if skip_polled:
            before_filter = len(targets)
            targets = [d for d in targets if d.get("last_polled_at") is None]
            skipped = before_filter - len(targets)
            if skipped:
                log.info(f"Discovery: přeskočeno {skipped} zařízení s nastaveným pollem (last_polled_at IS NOT NULL)")

        if not targets:
            log.info("Discovery: všechna zařízení mají čerstvý poll, přeskakuji.")
            discovery_state["running"] = False
            return

        discovery_state["total_devices"] = len(targets)

        job_id = await db.scan_job_start(
            pool,
            job_type      = "discovery",
            trigger_type  = trigger_type,
            triggered_by  = triggered_by,
            total_targets = len(targets),
            meta          = {
                "only_online": only_online,
                "total_registered": len(devices),
            },
        )
        log.info(
            f"Discovery scheduler: {len(targets)} zařízení "
            f"(job_id={job_id}, trigger={trigger_type})"
        )

        ok_count      = 0
        fail_count    = 0
        changed_count = 0

        for i, device in enumerate(targets, 1):
            device_id = device["id"]
            ip_str    = str(device["ip"]).split("/")[0]

            try:
                result = await disc.run_discovery(ip_str)
                layers = result.to_layers_list()
                patch  = result.to_device_patch()

                # Aplikujeme patch pokud jsou nějaké změny
                if patch:
                    await db.patch_device(pool, device_id, patch)
                    changed_count += 1
                    log.info(
                        f"Discovery [{i}/{len(targets)}] {ip_str} "
                        f"({device.get('hostname','?')}): patch={patch}"
                    )
                else:
                    log.debug(
                        f"Discovery [{i}/{len(targets)}] {ip_str}: žádné změny"
                    )

                # Uložíme log
                await db.save_discovery_log(
                    pool          = pool,
                    device_id     = device_id,
                    ip            = ip_str,
                    layers        = layers,
                    open_ports    = result.open_ports,
                    services      = {str(k): v for k, v in result.services.items()},
                    patch_applied = patch,
                )
                ok_count += 1

            except Exception as e:
                log.error(
                    f"Discovery [{i}/{len(targets)}] {ip_str} selhalo: {e}"
                )
                fail_count += 1

            # Aktualizujeme progress
            discovery_state["done_devices"] = i
            discovery_state["progress"]     = int((i / len(targets)) * 100)

            # Krátká pauza mezi zařízeními aby nepřetěžovalo síť
            await asyncio.sleep(0.5)

        discovery_state["last_discovery"]  = datetime.now(timezone.utc).isoformat()
        discovery_state["discovery_count"] += 1

        await db.scan_job_finish(
            pool, job_id,
            status        = "done",
            ok_count      = ok_count,
            fail_count    = fail_count,
            changed_count = changed_count,
        )
        log.info(
            f"Discovery dokončen: {ok_count} OK, {fail_count} chyb, "
            f"{changed_count} změn"
        )

    except Exception as e:
        log.error(f"Chyba discovery scheduleru: {e}", exc_info=True)
        if job_id:
            try:
                await db.scan_job_finish(
                    pool, job_id, status="error", error_msg=str(e)[:500]
                )
            except Exception:
                pass
    finally:
        discovery_state["running"] = False


# ---------------------------------------------------------------------------
# Scheduler management
# ---------------------------------------------------------------------------
def start_scheduler(pool, config: dict) -> AsyncIOScheduler:
    global _scheduler

    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)

    _scheduler = AsyncIOScheduler()

    # Ping scan job
    ping_interval = int(config.get("scan_interval_s", 300))
    _scheduler.add_job(
        run_scan,
        IntervalTrigger(seconds=ping_interval),
        args             = [pool, config, "cron", "scheduler"],
        id               = "ping_scan",
        name             = "Network scan",
        replace_existing = True,
        next_run_time    = datetime.now(timezone.utc),
    )
    log.info(f"Ping scan scheduler: interval {ping_interval}s")

    # Discovery job (jen pokud je zapnutý)
    discovery_enabled = str(config.get("discovery_enabled", "false")).lower() == "true"
    if discovery_enabled:
        disc_interval = int(config.get("discovery_interval_s", 3600))
        _scheduler.add_job(
            run_discovery_scan,
            IntervalTrigger(seconds=disc_interval),
            args             = [pool, config, "cron", "scheduler"],
            id               = "discovery_scan",
            name             = "Discovery scan",
            replace_existing = True,
        )
        log.info(f"Discovery scheduler: interval {disc_interval}s, zapnutý")
    else:
        log.info("Discovery scheduler: vypnutý")

    # Backup scheduler (jen pokud je zapnutý)
    backup_enabled  = str(config.get("backup_enabled", "false")).lower() == "true"
    if backup_enabled:
        backup_interval = max(3600, int(config.get("backup_interval_s", 86400)))

        async def _backup_job_startup():
            cfg = await _load_config(pool)
            await run_backup_scan(pool, cfg, trigger_type="scheduler")

        _scheduler.add_job(
            _backup_job_startup,
            IntervalTrigger(seconds=backup_interval),
            id               = "backup_scan",
            name             = f"Backup scan",
            replace_existing = True,
        )
        log.info(f"Backup scheduler: interval {backup_interval}s, zapnutý")
    else:
        log.info("Backup scheduler: vypnutý")

    _scheduler.start()
    log.info("Scheduler spuštěn")
    return _scheduler


def restart_scheduler(pool, config: dict) -> None:
    """Restartuje oba schedulery s novou konfigurací."""
    global _scheduler

    if not _scheduler or not _scheduler.running:
        start_scheduler(pool, config)
        return

    # Ping scan — vždy přeplánovat
    ping_interval = int(config.get("scan_interval_s", 300))
    try:
        _scheduler.reschedule_job(
            "ping_scan",
            trigger=IntervalTrigger(seconds=ping_interval),
        )
        log.info(f"Ping scan přeplánován: interval {ping_interval}s")
    except Exception:
        _scheduler.add_job(
            run_scan,
            IntervalTrigger(seconds=ping_interval),
            args=[pool, config, "cron", "scheduler"],
            id="ping_scan", name="Network scan", replace_existing=True,
        )

    # Discovery — přidat/odebrat dle nastavení
    discovery_enabled = str(config.get("discovery_enabled", "false")).lower() == "true"
    disc_interval     = int(config.get("discovery_interval_s", 3600))

    if discovery_enabled:
        try:
            _scheduler.reschedule_job(
                "discovery_scan",
                trigger=IntervalTrigger(seconds=disc_interval),
            )
            log.info(f"Discovery přeplánován: interval {disc_interval}s")
        except Exception:
            _scheduler.add_job(
                run_discovery_scan,
                IntervalTrigger(seconds=disc_interval),
                args=[pool, config, "cron", "scheduler"],
                id="discovery_scan", name="Discovery scan", replace_existing=True,
            )
            log.info(f"Discovery přidán: interval {disc_interval}s")
    else:
        try:
            _scheduler.remove_job("discovery_scan")
            log.info("Discovery scheduler odstraněn (vypnutý)")
        except Exception:
            pass

    # Backup — přidat/odebrat dle nastavení
    setup_backup_scheduler(pool, config)


async def trigger_scan_now(pool, config: dict, triggered_by: str = "manual") -> None:
    asyncio.create_task(
        run_scan(pool, config, trigger_type="manual", triggered_by=triggered_by)
    )


async def trigger_discovery_now(
    pool, config: dict, triggered_by: str = "manual"
) -> None:
    asyncio.create_task(
        run_discovery_scan(pool, config, trigger_type="manual", triggered_by=triggered_by)
    )


# Zpětná kompatibilita
async def trigger_now(pool, config: dict, triggered_by: str = "manual") -> None:
    await trigger_scan_now(pool, config, triggered_by)


def stop_scheduler() -> None:
    global _scheduler
    if _scheduler and _scheduler.running:
        _scheduler.shutdown(wait=False)
        log.info("Scheduler zastaven")


# ===========================================================================
# BACKUP SCHEDULER
# ===========================================================================

async def run_backup_scan(pool, config: dict, trigger_type: str = "scheduler") -> None:
    """
    Spustí backup pro všechna zařízení která:
    - mají backup_enabled = true
    - jsou online (pokud backup_only_online = true)
    - mají last_polled_at (pokud backup_only_successful = true)
    - mají SSH credentials
    """
    import backup as bkp
    import db as _db

    only_online     = str(config.get("backup_only_online", "true")).lower() == "true"
    only_successful = str(config.get("backup_only_successful", "true")).lower() == "true"

    log.info(
        f"Backup scheduler zahájen: only_online={only_online} "
        f"only_successful={only_successful}"
    )

    try:
        devices = await _db.get_devices_with_credentials(pool)
    except Exception as e:
        log.error(f"Backup scheduler: chyba načítání zařízení: {e}")
        return

    # Načteme aktuální online stav ze scan výsledků
    try:
        online_ips: set[str] = set()
        async with pool.acquire() as _conn:
            rows = await _conn.fetch(
                """
                SELECT DISTINCT ON (ip) ip::text, is_alive
                FROM ping_results ORDER BY ip, scanned_at DESC
                """
            )
            # online_ips obsahuje IP ve formátu "93.91.156.130/32" i "93.91.156.130"
            online_ips = set()
            for r in rows:
                if r["is_alive"]:
                    ip_str = str(r["ip"])
                    online_ips.add(ip_str)              # s prefixem: 1.2.3.4/32
                    online_ips.add(ip_str.split("/")[0]) # bez prefixu: 1.2.3.4
    except Exception as _e:
        log.warning(f"Backup scheduler: nelze načíst online stav: {_e}")
        online_ips = set()

    # Filtrujeme zařízení
    targets = []
    for d in devices:
        # Individuální nastavení — přeskočit pokud backup_enabled = false
        if not d.get("backup_enabled", True):
            continue
        # Pouze online — kontrolujeme přes ping_results
        if only_online:
            raw_ip    = str(d.get("ip", "") or "")
            device_ip = raw_ip.split("/")[0].strip()
            log.info(f"Backup filter: {d.get('hostname')} ip={device_ip!r} in_online={device_ip in online_ips}")
            if device_ip not in online_ips:
                continue
        # Pouze s úspěšným pollem
        if only_successful and not d.get("last_polled_at"):
            continue
        # Musí mít SSH credential
        ssh_creds = [c for c in d.get("credentials", []) if c.get("auth_type") == "ssh"]
        if not ssh_creds:
            continue
        targets.append(d)

    log.info(
        f"Backup scheduler: {len(targets)} zařízení ke zálohování "
        f"(celkem {len(devices)}, online_ips={len(online_ips)})"
    )

    # Spustíme zálohy sekvenčně (nechceme zahltit síť)
    for device in targets:
        ip_str      = str(device["ip"]).split("/")[0]
        hostname    = device.get("hostname") or device.get("alias") or ip_str
        device_uuid = device["device_uuid"]

        log.info(f"Backup scheduler: zálohuji {hostname} ({ip_str})")

        try:
            # Načteme credentials s hesly
            usable_creds = [c for c in device["credentials"] if c.get("auth_type") in ("api", "ssh")]
            creds_with_pass = []
            for c in usable_creds:
                raw = await _db.get_credential_raw(pool, c["id"])
                if raw:
                    creds_with_pass.append(raw)

            # Záznam v DB
            from cryptography.fernet import Fernet
            import os
            _key    = os.getenv("FERNET_KEY", "")
            _cipher = Fernet(_key.encode()) if _key else None

            backup_db_id = await _db.create_backup_record(
                pool, device["id"], "export",
                filename     = f"pending_{device_uuid}",
                filepath     = f"/backups/{device_uuid}/pending",
                triggered_by = trigger_type,
            )

            result = await bkp.backup_mikrotik(
                ip                      = ip_str,
                creds                   = creds_with_pass,
                cipher                  = _cipher,
                device_uuid             = device_uuid,
                hostname                = hostname,
                triggered_by            = trigger_type,
                timeout                 = 90.0,
                last_successful_cred_id = device.get("last_successful_credential_id"),
                last_successful_auth    = device.get("last_successful_auth"),
            )

            await _db.finish_backup_record(
                pool, backup_db_id,
                success          = result.success,
                file_size_bytes  = result.file_size_bytes,
                mikrotik_version = result.mikrotik_version,
                duration_ms      = result.duration_ms,
                error_msg        = result.error if not result.success else None,
            )

            if result.success and result.filepath:
                async with pool.acquire() as conn:
                    await conn.execute(
                        "UPDATE device_backups SET filename=$2, filepath=$3 WHERE id=$1",
                        backup_db_id, result.filename, str(result.filepath),
                    )

            log.info(
                f"Backup scheduler: {hostname} "
                f"{'OK' if result.success else 'FAIL'} "
                f"({result.file_size_bytes or 0}B)"
            )

        except Exception as e:
            log.error(f"Backup scheduler: chyba zálohy {hostname}: {e}")


def setup_backup_scheduler(pool, config: dict) -> None:
    """Nastaví nebo odstraní backup scheduler job dle konfigurace."""
    global _scheduler
    if not _scheduler or not _scheduler.running:
        return

    enabled  = str(config.get("backup_enabled", "false")).lower() == "true"
    interval = max(3600, int(config.get("backup_interval_s", 86400)))

    if enabled:
        from apscheduler.triggers.interval import IntervalTrigger

        async def _backup_job():
            cfg = await _load_config(pool)
            await run_backup_scan(pool, cfg, trigger_type="scheduler")

        if _scheduler.get_job("backup_scan"):
            _scheduler.remove_job("backup_scan")

        _scheduler.add_job(
            _backup_job,
            trigger  = IntervalTrigger(seconds=interval),
            id       = "backup_scan",
            name     = f"Backup scan (interval: {interval}s)",
            max_instances = 1,
            replace_existing = True,
        )
        log.info(f"Backup scheduler nastaven: interval={interval}s")
    else:
        try:
            _scheduler.remove_job("backup_scan")
            log.info("Backup scheduler odstraněn (vypnutý)")
        except Exception:
            pass


async def trigger_backup_now(pool, config: dict, triggered_by: str = "manual") -> None:
    """Spustí backup okamžitě jako background task."""
    asyncio.create_task(
        run_backup_scan(pool, config, trigger_type=triggered_by)
    )
