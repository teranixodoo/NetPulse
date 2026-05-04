# backend/backup.py — MikroTik backup engine (export .rsc)
#
# Záloha probíhá jako /export přes RouterOS API nebo SSH.
# Pokud je k dispozici last_successful_auth (snapshot z posledního pollu),
# použijeme přesně ty parametry které vedly k úspěchu — bez zkoušení variant.

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("netpulse.backup")

BACKUP_ROOT = Path(os.getenv("BACKUP_DIR", "/backups"))


# ---------------------------------------------------------------------------
# Výsledek zálohy
# ---------------------------------------------------------------------------
class BackupResult:
    def __init__(self):
        self.backup_type:      str            = "export"
        self.success:          bool           = False
        self.filepath:         Optional[Path] = None
        self.filename:         str            = ""
        self.file_size_bytes:  Optional[int]  = None
        self.mikrotik_version: Optional[str]  = None
        self.duration_ms:      Optional[int]  = None
        self.error:            Optional[str]  = None


# ---------------------------------------------------------------------------
# Pomocné funkce
# ---------------------------------------------------------------------------

def _ensure_backup_dir(device_uuid: str) -> Path:
    d = BACKUP_ROOT / device_uuid
    d.mkdir(parents=True, exist_ok=True)
    return d


def _make_filename(hostname: str) -> str:
    ts        = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    safe_host = "".join(c if c.isalnum() or c in "-_." else "_" for c in (hostname or "device"))
    return f"{safe_host}_{ts}.rsc"


def _decrypt(password_cipher: str, cipher_obj) -> str:
    if not cipher_obj or not password_cipher:
        return password_cipher or ""
    try:
        return cipher_obj.decrypt(password_cipher.encode()).decode()
    except Exception:
        return password_cipher


def _save_export(export_text: str, hostname: str, device_uuid: str) -> tuple[Path, str]:
    """Uloží export text na disk. Vrátí (filepath, filename)."""
    backup_dir = _ensure_backup_dir(device_uuid)
    filename   = _make_filename(hostname)
    filepath   = backup_dir / filename
    filepath.write_text(export_text, encoding="utf-8")
    return filepath, filename


def _extract_ros_version(export_text: str) -> Optional[str]:
    """Extrahuje verzi ROS ze záhlaví exportu."""
    import re
    for line in export_text.splitlines()[:5]:
        m = re.search(r"v(\d+\.\d+[\.\d]*)", line)
        if m:
            return m.group(1)
    return None


# ---------------------------------------------------------------------------
# Export přes RouterOS API — s přesnými parametry z last_successful_auth
# ---------------------------------------------------------------------------

async def _export_via_api(
    ip: str, cred: dict, cipher,
    hostname: str, device_uuid: str,
    auth_snapshot: dict = None,  # snapshot z posledního úspěšného pollu
    timeout: float = 60.0,
) -> BackupResult:
    result = BackupResult()
    t0     = time.monotonic()

    try:
        import routeros_api
        import ssl as _ssl
    except ImportError:
        result.error = "routeros_api není nainstalován"
        return result

    port     = int(cred.get("port") or 8728)
    username = cred.get("username") or "admin"
    password = _decrypt(cred.get("password_cipher", ""), cipher)

    def _connect_and_export():
        # Pokud máme snapshot z posledního pollu — použijeme přesně ty parametry
        if auth_snapshot:
            use_ssl         = auth_snapshot.get("use_ssl", False)
            has_ssl_context = auth_snapshot.get("has_ssl_context", False)
            if use_ssl and has_ssl_context:
                ctx = _ssl.create_default_context()
                ctx.check_hostname = False
                ctx.verify_mode    = _ssl.CERT_NONE
                ssl_variants = [{"use_ssl": True, "ssl_verify": False,
                                 "ssl_verify_hostname": False, "ssl_context": ctx}]
            elif use_ssl:
                ssl_variants = [{"use_ssl": True, "ssl_verify": False,
                                 "ssl_verify_hostname": False, "ssl_context": None}]
            else:
                ssl_variants = [{"use_ssl": False, "ssl_verify": False,
                                 "ssl_verify_hostname": False, "ssl_context": None}]
            log.info(
                f"Backup API {ip}:{port} — použiji snapshot: "
                f"use_ssl={use_ssl} has_ctx={has_ssl_context}"
            )
        else:
            # Bez snapshotu — zkoušíme všechny varianty (stejná logika jako poller)
            use_ssl = port in (8729, 443) or port >= 8700
            ssl_variants = []
            if use_ssl:
                ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                     "ssl_verify_hostname": False, "ssl_context": None})
                try:
                    ctx_adh = _ssl.create_default_context()
                    ctx_adh.check_hostname = False
                    ctx_adh.verify_mode    = _ssl.CERT_NONE
                    ctx_adh.set_ciphers("ADH:@SECLEVEL=0")
                    ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                         "ssl_verify_hostname": False, "ssl_context": ctx_adh})
                except Exception:
                    pass
                try:
                    ctx_all = _ssl.create_default_context()
                    ctx_all.check_hostname = False
                    ctx_all.verify_mode    = _ssl.CERT_NONE
                    ctx_all.set_ciphers("ALL:@SECLEVEL=0")
                    ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                         "ssl_verify_hostname": False, "ssl_context": ctx_all})
                except Exception:
                    pass
            else:
                ssl_variants.append({"use_ssl": False, "ssl_verify": False,
                                     "ssl_verify_hostname": False, "ssl_context": None})

        # Připojení
        api            = None
        last_err       = None
        for ssl_opt in ssl_variants:
            try:
                api = routeros_api.RouterOsApiPool(
                    ip, username=username, password=password,
                    port=port, plaintext_login=True, **ssl_opt,
                ).get_api()
                log.info(f"Backup API {ip}:{port} připojen (ssl={ssl_opt['use_ssl']})")
                break
            except Exception as e:
                last_err = e
                continue

        if api is None:
            raise ConnectionError(
                f"Nelze se připojit k RouterOS API {ip}:{port}: {last_err}"
            )

        # Verze ROS
        version = None
        try:
            res     = api.get_resource("/system/resource").get()
            version = res[0].get("version") if res else None
        except Exception:
            pass

        # Export konfigurace — použijeme get_resource (správná metoda pro textový výstup)
        export_text = ""
        try:
            res   = api.get_resource("/")
            lines = res.call("export", {"verbose": ""})
            if isinstance(lines, list):
                parts = []
                for line in lines:
                    if isinstance(line, bytes):
                        parts.append(line.decode("utf-8", errors="replace"))
                    elif isinstance(line, str):
                        parts.append(line)
                    elif isinstance(line, dict):
                        val = line.get("ret", line.get(".tag", ""))
                        if val:
                            parts.append(str(val))
                export_text = "\n".join(parts)
            elif isinstance(lines, str):
                export_text = lines
        except Exception as _e1:
            log.debug(f"Export verbose selhal: {_e1}, zkouším bez verbose")
            try:
                lines = api.get_resource("/").call("export")
                if isinstance(lines, list):
                    export_text = "\n".join(
                        l.decode("utf-8", errors="replace") if isinstance(l, bytes)
                        else str(l) for l in lines
                    )
                else:
                    export_text = str(lines) if lines else ""
            except Exception as _e2:
                raise RuntimeError(f"Export selhal: {_e1} / {_e2}")

        return export_text, version

    try:
        loop = asyncio.get_event_loop()
        export_text, version = await asyncio.wait_for(
            loop.run_in_executor(None, _connect_and_export),
            timeout=timeout
        )

        if not export_text.strip():
            result.error = "Export vrátil prázdný výstup"
            return result

        filepath, filename = _save_export(export_text, hostname, device_uuid)

        result.success          = True
        result.filepath         = filepath
        result.filename         = filename
        result.file_size_bytes  = filepath.stat().st_size
        result.mikrotik_version = version or _extract_ros_version(export_text)
        result.duration_ms      = int((time.monotonic() - t0) * 1000)

    except asyncio.TimeoutError:
        result.error = f"Timeout API exportu ({timeout}s)"
    except Exception as e:
        result.error = str(e)[:400]
        log.warning(f"Backup API {ip} chyba: {result.error}")

    return result


# ---------------------------------------------------------------------------
# Export přes SSH — s přesnými parametry z last_successful_auth
# ---------------------------------------------------------------------------

async def _export_via_ssh(
    ip: str, cred: dict, cipher,
    hostname: str, device_uuid: str,
    auth_snapshot: dict = None,
    timeout: float = 60.0,
) -> BackupResult:
    result = BackupResult()
    t0     = time.monotonic()

    try:
        import asyncssh
    except ImportError:
        result.error = "asyncssh není nainstalován"
        return result

    # Pokud máme snapshot — použijeme přesný port a username z něj
    if auth_snapshot:
        port     = int(auth_snapshot.get("port") or cred.get("port") or 22)
        username = auth_snapshot.get("username") or cred.get("username") or "admin"
        log.info(f"Backup SSH {ip}:{port} — použiji snapshot: user={username}")
    else:
        port     = int(cred.get("port") or 22)
        username = cred.get("username") or "admin"

    password = _decrypt(cred.get("password_cipher", ""), cipher)

    try:
        async with asyncssh.connect(
            host=ip, port=port, username=username, password=password,
            known_hosts=None, connect_timeout=15,
        ) as conn:
            r           = await conn.run("/export verbose", timeout=timeout - 5)
            export_text = r.stdout or ""
            if not export_text.strip():
                r           = await conn.run("/export", timeout=timeout - 5)
                export_text = r.stdout or ""

        if not export_text.strip():
            result.error = "SSH export vrátil prázdný výstup"
            return result

        filepath, filename = _save_export(export_text, hostname, device_uuid)

        result.success          = True
        result.filepath         = filepath
        result.filename         = filename
        result.file_size_bytes  = filepath.stat().st_size
        result.mikrotik_version = _extract_ros_version(export_text)
        result.duration_ms      = int((time.monotonic() - t0) * 1000)

    except asyncio.TimeoutError:
        result.error = f"Timeout SSH exportu ({timeout}s)"
    except Exception as e:
        result.error = str(e)[:400]
        log.warning(f"Backup SSH {ip} chyba: {result.error}")

    return result


# ---------------------------------------------------------------------------
# Hlavní funkce
# ---------------------------------------------------------------------------

async def backup_mikrotik(
    ip:                      str,
    creds:                   list,
    cipher,
    device_uuid:             str,
    hostname:                str,
    triggered_by:            str   = "manual",
    timeout:                 float = 90.0,
    last_successful_cred_id: int   = None,
    last_successful_auth:    dict  = None,  # kompletní snapshot z posledního pollu
) -> BackupResult:
    """
    Export záloha (.rsc) MikroTik zařízení.
    Pokud je k dispozici last_successful_auth, použijeme přesně ty parametry.
    Fallback: všechny API credentials → všechny SSH credentials.
    """
    api_creds = [c for c in creds if c.get("auth_type") == "api"]
    ssh_creds = [c for c in creds if c.get("auth_type") == "ssh"]

    log.info(
        f"Backup zahájen: ip={ip} host={hostname} "
        f"api={len(api_creds)} ssh={len(ssh_creds)} "
        f"snapshot={'ano' if last_successful_auth else 'ne'} "
        f"preferred_cred_id={last_successful_cred_id}"
    )

    def _sorted(cred_list: list) -> list:
        """Úspěšný credential při posledním pollu jde první."""
        if not last_successful_cred_id:
            return cred_list
        return sorted(cred_list, key=lambda c: 0 if c.get("id") == last_successful_cred_id else 1)

    def _snapshot_for(cred: dict) -> dict | None:
        """Vrátí snapshot jen pokud patří tomuto credentialu."""
        if last_successful_auth and last_successful_auth.get("credential_id") == cred.get("id"):
            return last_successful_auth
        return None

    for cred in _sorted(api_creds):
        r = await _export_via_api(
            ip, cred, cipher, hostname, device_uuid,
            auth_snapshot=_snapshot_for(cred), timeout=timeout
        )
        if r.success:
            log.info(f"Backup OK (API/{cred.get('name','?')}): ip={ip} size={r.file_size_bytes}B")
            return r
        log.warning(f"API export selhal ({cred.get('name','?')}): {r.error}")

    for cred in _sorted(ssh_creds):
        r = await _export_via_ssh(
            ip, cred, cipher, hostname, device_uuid,
            auth_snapshot=_snapshot_for(cred), timeout=timeout
        )
        if r.success:
            log.info(f"Backup OK (SSH/{cred.get('name','?')}): ip={ip} size={r.file_size_bytes}B")
            return r
        log.warning(f"SSH export selhal ({cred.get('name','?')}): {r.error}")

    result       = BackupResult()
    result.error = "Export selhal přes všechny dostupné profily"
    log.warning(f"Backup FAIL: ip={ip} — {result.error}")
    return result


# ---------------------------------------------------------------------------
# Formátování velikosti
# ---------------------------------------------------------------------------

def format_file_size(size_bytes: Optional[int]) -> str:
    if size_bytes is None:
        return "—"
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.2f} MB"
