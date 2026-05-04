# backend/backup.py — MikroTik backup engine (export .rsc)
#
# Typ zálohy: export — /export přes RouterOS API nebo SSH
# Výstup: čitelný .rsc skript, diffovatelný, přenositelný mezi verzemi ROS.
#
# Zálohy se ukládají do /backups/{device_uuid}/{timestamp}_{hostname}.rsc

from __future__ import annotations

import asyncio
import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

log = logging.getLogger("netpulse.backup")

# Kořenový adresář pro zálohy (docker volume /backups)
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

    def __repr__(self):
        return f"BackupResult(success={self.success}, size={self.file_size_bytes}, error={self.error})"


# ---------------------------------------------------------------------------
# Pomocné funkce
# ---------------------------------------------------------------------------

def _ensure_backup_dir(device_uuid: str) -> Path:
    backup_dir = BACKUP_ROOT / device_uuid
    backup_dir.mkdir(parents=True, exist_ok=True)
    return backup_dir


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


# ---------------------------------------------------------------------------
# Export přes RouterOS API
# ---------------------------------------------------------------------------

async def _export_via_api(ip, cred, cipher, hostname, device_uuid, timeout=60.0):
    result = BackupResult()
    t0     = time.monotonic()

    try:
        import routeros_api
    except ImportError:
        result.error = "routeros_api není nainstalován"
        return result

    port     = int(cred.get("port") or 8728)
    use_ssl  = port in (8729, 443)
    username = cred.get("username") or "admin"
    password = _decrypt(cred.get("password_cipher", ""), cipher)

    def _connect_and_export():
        import ssl
        ssl_variants = (
            [{"use_ssl": True, "ssl_context": ssl.create_default_context()},
             {"use_ssl": True, "ssl_context": None}]
            if use_ssl else [{"use_ssl": False, "ssl_context": None}]
        )
        if use_ssl:
            ssl_variants[0]["ssl_context"].check_hostname = False
            ssl_variants[0]["ssl_context"].verify_mode    = ssl.CERT_NONE

        api = None
        for ssl_opt in ssl_variants:
            try:
                api = routeros_api.RouterOsApiPool(
                    ip, username=username, password=password,
                    port=port, plaintext_login=True, **ssl_opt
                ).get_api()
                break
            except Exception:
                continue

        if api is None:
            raise ConnectionError(f"Nelze se připojit k RouterOS API {ip}:{port}")

        # Verze ROS
        version = None
        try:
            res     = api.get_resource("/system/resource").get()
            version = res[0].get("version") if res else None
        except Exception:
            pass

        # Export
        try:
            lines = api.get_binary_resource("/").call("export", {"verbose": ""})
            parts = []
            for line in lines:
                if isinstance(line, bytes):
                    parts.append(line.decode("utf-8", errors="replace"))
                elif isinstance(line, dict):
                    val = line.get("ret", line.get(".tag", ""))
                    if val:
                        parts.append(str(val))
            export_text = "\n".join(parts)
        except Exception:
            data = api.get_resource("/").call("export")
            export_text = "\n".join(str(d) for d in data) if isinstance(data, list) else str(data)

        return export_text, version

    try:
        loop = asyncio.get_event_loop()
        export_text, version = await asyncio.wait_for(
            loop.run_in_executor(None, _connect_and_export), timeout=timeout
        )

        if not export_text.strip():
            result.error = "Export vrátil prázdný výstup"
            return result

        backup_dir = _ensure_backup_dir(device_uuid)
        filename   = _make_filename(hostname)
        filepath   = backup_dir / filename
        filepath.write_text(export_text, encoding="utf-8")

        result.success          = True
        result.filepath         = filepath
        result.filename         = filename
        result.file_size_bytes  = filepath.stat().st_size
        result.mikrotik_version = version
        result.duration_ms      = int((time.monotonic() - t0) * 1000)

    except asyncio.TimeoutError:
        result.error = f"Timeout exportu přes API ({timeout}s)"
    except Exception as e:
        result.error = str(e)[:400]

    return result


# ---------------------------------------------------------------------------
# Export přes SSH
# ---------------------------------------------------------------------------

async def _export_via_ssh(ip, cred, cipher, hostname, device_uuid, timeout=60.0):
    result = BackupResult()
    t0     = time.monotonic()

    try:
        import asyncssh
    except ImportError:
        result.error = "asyncssh není nainstalován"
        return result

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

        # Verze ROS ze záhlaví exportu
        version = None
        import re
        for line in export_text.splitlines()[:5]:
            m = re.search(r"v(\d+\.\d+[\.\d]*)", line)
            if m:
                version = m.group(1)
                break

        backup_dir = _ensure_backup_dir(device_uuid)
        filename   = _make_filename(hostname)
        filepath   = backup_dir / filename
        filepath.write_text(export_text, encoding="utf-8")

        result.success          = True
        result.filepath         = filepath
        result.filename         = filename
        result.file_size_bytes  = filepath.stat().st_size
        result.mikrotik_version = version
        result.duration_ms      = int((time.monotonic() - t0) * 1000)

    except asyncio.TimeoutError:
        result.error = f"Timeout exportu přes SSH ({timeout}s)"
    except Exception as e:
        result.error = str(e)[:400]

    return result


# ---------------------------------------------------------------------------
# Hlavní funkce
# ---------------------------------------------------------------------------

async def backup_mikrotik(
    ip:                       str,
    creds:                    list,
    cipher,
    device_uuid:              str,
    hostname:                 str,
    triggered_by:             str   = "manual",
    timeout:                  float = 90.0,
    last_successful_cred_id:  int   = None,
) -> BackupResult:
    """
    Export záloha (.rsc) MikroTik zařízení.
    Pokud je known last_successful_cred_id, použijeme ho jako první.
    Fallback: všechny API credentials → všechny SSH credentials.
    """
    api_creds = [c for c in creds if c.get("auth_type") == "api"]
    ssh_creds = [c for c in creds if c.get("auth_type") == "ssh"]

    log.info(
        f"Backup zahájen: ip={ip} host={hostname} "
        f"api={len(api_creds)} ssh={len(ssh_creds)} "
        f"preferred_cred_id={last_successful_cred_id}"
    )

    # Seřadíme credentials — úspěšný při posledním pollu jde jako první
    def _sorted(cred_list: list) -> list:
        if not last_successful_cred_id:
            return cred_list
        return sorted(cred_list, key=lambda c: 0 if c.get("id") == last_successful_cred_id else 1)

    for cred in _sorted(api_creds):
        r = await _export_via_api(ip, cred, cipher, hostname, device_uuid, timeout)
        if r.success:
            log.info(f"Backup OK (API/{cred.get('name','?')}): ip={ip} size={r.file_size_bytes}B")
            return r
        log.warning(f"API export selhal ({cred.get('name','?')}): {r.error}")

    for cred in _sorted(ssh_creds):
        r = await _export_via_ssh(ip, cred, cipher, hostname, device_uuid, timeout)
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
