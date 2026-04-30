# backend/backup.py — MikroTik backup engine
#
# Podporuje dva typy zálohy:
#   binary  — /system backup save  → .backup soubor (kompletní obnova)
#   export  — /export              → .rsc skript   (čitelný, diffovatelný)
#
# Přenos probíhá přes RouterOS API (FTP-like fetch) nebo SSH (cat souboru).
# Zálohy se ukládají do /backups/{device_uuid}/{timestamp}_{hostname}_{type}.{ext}

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
    """Výsledek jedné zálohovací operace."""

    def __init__(self, backup_type: str):
        self.backup_type:     str            = backup_type   # 'binary' | 'export'
        self.success:         bool           = False
        self.filepath:        Optional[Path] = None          # absolutní cesta k souboru
        self.filename:        str            = ""
        self.file_size_bytes: Optional[int]  = None
        self.mikrotik_version: Optional[str] = None          # verze ROS
        self.duration_ms:     Optional[int]  = None
        self.error:           Optional[str]  = None

    def __repr__(self) -> str:
        return (f"BackupResult(type={self.backup_type}, success={self.success}, "
                f"size={self.file_size_bytes}, error={self.error})")


# ---------------------------------------------------------------------------
# Pomocné funkce
# ---------------------------------------------------------------------------

def _ensure_backup_dir(device_uuid: str) -> Path:
    """Vytvoří adresář pro zálohy zařízení pokud neexistuje."""
    backup_dir = BACKUP_ROOT / device_uuid
    backup_dir.mkdir(parents=True, exist_ok=True)
    return backup_dir


def _make_filename(hostname: str, backup_type: str) -> str:
    """Sestaví název souboru zálohy: hostname_YYYYMMDD_HHMM_type.ext"""
    ts  = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M")
    # Sanitizace hostname — odstraníme znaky nevhodné pro název souboru
    safe_host = "".join(c if c.isalnum() or c in "-_." else "_" for c in (hostname or "device"))
    ext = "backup" if backup_type == "binary" else "rsc"
    return f"{safe_host}_{ts}_{backup_type}.{ext}"


def _decrypt(password_cipher: str, cipher_obj) -> str:
    """Rozšifruje heslo Fernetem."""
    if not cipher_obj or not password_cipher:
        return password_cipher or ""
    try:
        return cipher_obj.decrypt(password_cipher.encode()).decode()
    except Exception:
        return password_cipher


# ---------------------------------------------------------------------------
# Záloha přes RouterOS API
# ---------------------------------------------------------------------------

async def _backup_via_api(
    ip: str,
    cred: dict,
    cipher,
    backup_type: str,
    hostname: str,
    device_uuid: str,
    timeout: float = 60.0,
) -> BackupResult:
    """
    Záloha přes RouterOS API:
      binary → /system/backup/save + stažení přes /file
      export → /export (vrátí text přímo)
    """
    result = BackupResult(backup_type)
    t0 = time.monotonic()

    try:
        import routeros_api  # type: ignore
    except ImportError:
        result.error = "routeros_api není nainstalován"
        return result

    port     = int(cred.get("port") or 8728)
    use_ssl  = port in (8729, 443)
    username = cred.get("username") or "admin"
    password = _decrypt(cred.get("password_cipher", ""), cipher)

    def _connect_and_backup():
        """Synchronní blok — spouštíme v executoru."""
        import ssl

        ssl_variants = []
        if use_ssl:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode    = ssl.CERT_NONE
            ssl_variants = [
                {"use_ssl": True,  "ssl_context": ctx},
                {"use_ssl": True,  "ssl_context": None},
            ]
        else:
            ssl_variants = [{"use_ssl": False, "ssl_context": None}]

        api = None
        for ssl_opt in ssl_variants:
            try:
                _conn = routeros_api.RouterOsApiPool(
                    ip, username=username, password=password,
                    port=port, plaintext_login=True, **ssl_opt
                )
                api = _conn.get_api()
                break
            except Exception:
                continue

        if api is None:
            raise ConnectionError(f"Nelze se připojit k RouterOS API {ip}:{port}")

        if backup_type == "export":
            # Export vrací konfiguraci jako text
            # Použijeme /export přes raw command
            try:
                cmd   = api.get_binary_resource("/")
                lines = cmd.call("export", {"verbose": ""})
                # lines je list bytových objektů nebo stringů
                text_parts = []
                for line in lines:
                    if isinstance(line, bytes):
                        text_parts.append(line.decode("utf-8", errors="replace"))
                    elif isinstance(line, dict):
                        # RouterOS API může vrátit dict s klíčem 'ret'
                        val = line.get("ret", line.get(".tag", ""))
                        if val:
                            text_parts.append(str(val))
                export_text = "\n".join(text_parts)
                return ("export_text", export_text)
            except Exception:
                # Fallback: zkusíme /export jako resource
                res  = api.get_resource("/")
                data = res.call("export")
                if isinstance(data, list):
                    text = "\n".join(str(d) for d in data)
                else:
                    text = str(data)
                return ("export_text", text)

        else:
            # Binary backup:
            # 1. Vytvoříme zálohu na RouterOS
            backup_name = f"netpulse_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
            backup_res  = api.get_resource("/system/backup")
            backup_res.call("save", {"name": backup_name, "dont-encrypt": "yes"})

            # 2. Počkáme až se soubor objeví v /file
            import time as _time
            file_res  = api.get_resource("/file")
            found     = None
            for _ in range(20):
                _time.sleep(1)
                files = file_res.get()
                for f in files:
                    if f.get("name", "").startswith(backup_name):
                        found = f
                        break
                if found:
                    break

            if not found:
                raise RuntimeError(f"Backup soubor '{backup_name}' se neobjevil v /file")

            # 3. Stáhneme obsah souboru přes /file/print — RouterOS API
            # Pozn: RouterOS API neumí stahovat binární soubory přímo.
            # Musíme použít FTP nebo SFTP, ale to vyžaduje otevřený port.
            # Alternativa: vrátíme jen metadata a přeneseme soubor přes SSH SCP.
            return ("binary_meta", {
                "ros_filename": found.get("name"),
                "ros_size":     found.get("size"),
            })

    try:
        loop    = asyncio.get_event_loop()
        outcome = await asyncio.wait_for(
            loop.run_in_executor(None, _connect_and_backup),
            timeout=timeout
        )

        backup_dir = _ensure_backup_dir(device_uuid)
        filename   = _make_filename(hostname, backup_type)
        filepath   = backup_dir / filename

        if outcome[0] == "export_text":
            export_text = outcome[1]
            filepath.write_text(export_text, encoding="utf-8")
            result.success         = True
            result.filepath        = filepath
            result.filename        = filename
            result.file_size_bytes = filepath.stat().st_size

        elif outcome[0] == "binary_meta":
            # Binary přes API nelze stáhnout přímo — fallback na SSH SCP
            result.error = "binary_via_api_needs_ssh"  # speciální signál

        result.duration_ms = int((time.monotonic() - t0) * 1000)

    except asyncio.TimeoutError:
        result.error = f"Timeout zálohy přes API ({timeout}s)"
    except Exception as e:
        result.error = str(e)[:400]

    return result


# ---------------------------------------------------------------------------
# Záloha přes SSH
# ---------------------------------------------------------------------------

async def _backup_via_ssh(
    ip: str,
    cred: dict,
    cipher,
    backup_type: str,
    hostname: str,
    device_uuid: str,
    timeout: float = 60.0,
) -> BackupResult:
    """
    Záloha přes SSH (asyncssh):
      binary → /system backup save; přenos přes SCP (asyncssh.scp)
      export → /export; čteme stdout
    """
    result = BackupResult(backup_type)
    t0 = time.monotonic()

    try:
        import asyncssh  # type: ignore
    except ImportError:
        result.error = "asyncssh není nainstalován"
        return result

    port     = int(cred.get("port") or 22)
    username = cred.get("username") or "admin"
    password = _decrypt(cred.get("password_cipher", ""), cipher)

    # Parametry SSH pro MikroTik (slabé algoritmy, bez ověření hostitele)
    ssh_opts = dict(
        host              = ip,
        port              = port,
        username          = username,
        password          = password,
        known_hosts       = None,
        connect_timeout   = 15,
        server_host_key_algs = [
            "ssh-rsa", "ssh-dss", "ecdsa-sha2-nistp256",
            "ecdsa-sha2-nistp384", "ecdsa-sha2-nistp521",
        ],
        encryption_algs   = asyncssh.encryption_algs,
        mac_algs          = asyncssh.mac_algs,
        kex_algs          = asyncssh.kex_algs,
    )

    try:
        async with asyncssh.connect(**ssh_opts) as conn:

            if backup_type == "export":
                # Spustíme /export a přečteme výstup
                r = await conn.run("/export", timeout=timeout - 5)
                export_text = r.stdout or ""
                if not export_text.strip():
                    # Zkusíme bez lomítka (starší ROS)
                    r = await conn.run("export", timeout=timeout - 5)
                    export_text = r.stdout or ""

                backup_dir = _ensure_backup_dir(device_uuid)
                filename   = _make_filename(hostname, "export")
                filepath   = backup_dir / filename
                filepath.write_text(export_text, encoding="utf-8")

                result.success         = True
                result.filepath        = filepath
                result.filename        = filename
                result.file_size_bytes = filepath.stat().st_size

            else:  # binary
                # 1. Vytvoříme zálohu na zařízení
                backup_name = f"netpulse_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}"
                await conn.run(
                    f"/system backup save name={backup_name} dont-encrypt=yes",
                    timeout=30
                )
                # 2. Chvíli počkáme než ROS soubor dokončí
                await asyncio.sleep(3)

                # 3. Stáhneme přes SCP
                backup_dir = _ensure_backup_dir(device_uuid)
                filename   = _make_filename(hostname, "binary")
                filepath   = backup_dir / filename

                await asyncssh.scp(
                    (conn, f"{backup_name}.backup"),
                    str(filepath),
                    recurse=False
                )

                # 4. Smažeme zálohu ze zařízení (šetříme místo na flash)
                try:
                    await conn.run(f"/file remove {backup_name}.backup", timeout=10)
                except Exception:
                    pass  # nevadí pokud smazání selže

                result.success         = True
                result.filepath        = filepath
                result.filename        = filename
                result.file_size_bytes = filepath.stat().st_size if filepath.exists() else None

        result.duration_ms = int((time.monotonic() - t0) * 1000)

    except asyncio.TimeoutError:
        result.error = f"Timeout zálohy přes SSH ({timeout}s)"
    except Exception as e:
        result.error = str(e)[:400]

    return result


# ---------------------------------------------------------------------------
# Zjistíme verzi RouterOS (pro evidenci)
# ---------------------------------------------------------------------------

async def _get_ros_version(ip: str, creds: list[dict], cipher, timeout: float = 10.0) -> Optional[str]:
    """Pokusí se zjistit verzi RouterOS přes API nebo SSH."""
    for cred in creds:
        auth_type = cred.get("auth_type", "")
        try:
            if auth_type == "api":
                import routeros_api  # type: ignore
                port     = int(cred.get("port") or 8728)
                username = cred.get("username") or "admin"
                password = _decrypt(cred.get("password_cipher", ""), cipher)
                def _get():
                    conn = routeros_api.RouterOsApiPool(
                        ip, username=username, password=password,
                        port=port, plaintext_login=True, use_ssl=False
                    )
                    a = conn.get_api()
                    res = a.get_resource("/system/resource").get()
                    return res[0].get("version") if res else None
                loop = asyncio.get_event_loop()
                ver  = await asyncio.wait_for(loop.run_in_executor(None, _get), timeout=timeout)
                if ver:
                    return ver
            elif auth_type == "ssh":
                import asyncssh  # type: ignore
                port     = int(cred.get("port") or 22)
                username = cred.get("username") or "admin"
                password = _decrypt(cred.get("password_cipher", ""), cipher)
                async with asyncssh.connect(
                    ip, port=port, username=username, password=password,
                    known_hosts=None, connect_timeout=8
                ) as conn:
                    r = await conn.run(":put [/system resource get version]", timeout=8)
                    ver = (r.stdout or "").strip()
                    if ver:
                        return ver
        except Exception:
            continue
    return None


# ---------------------------------------------------------------------------
# Hlavní funkce — spustí oba typy zálohy paralelně
# ---------------------------------------------------------------------------

async def backup_mikrotik(
    ip:          str,
    creds:       list[dict],
    cipher,
    device_uuid: str,
    hostname:    str,
    triggered_by: str = "manual",
    timeout:     float = 90.0,
) -> tuple[BackupResult, BackupResult]:
    """
    Spustí binary + export zálohu paralelně.
    Vrátí (binary_result, export_result).
    Priorita připojení: API pro export, SSH pro binary (SCP).
    """
    # Rozdělíme credentials podle typu
    api_creds = [c for c in creds if c.get("auth_type") == "api"]
    ssh_creds = [c for c in creds if c.get("auth_type") == "ssh"]

    log.info(
        f"Backup zahájen: ip={ip} host={hostname} "
        f"api_creds={len(api_creds)} ssh_creds={len(ssh_creds)}"
    )

    async def do_binary() -> BackupResult:
        """Binary záloha — preferuje SSH (SCP), fallback API."""
        for cred in ssh_creds:
            r = await _backup_via_ssh(ip, cred, cipher, "binary", hostname, device_uuid, timeout)
            if r.success:
                return r
        # API fallback (pro binary potřebujeme SSH pro SCP, takže API samo nestačí)
        r = BackupResult("binary")
        r.error = "Binary záloha vyžaduje SSH přihlašovací profil (SCP přenos)"
        return r

    async def do_export() -> BackupResult:
        """Export záloha — preferuje API (přímý výstup), fallback SSH."""
        for cred in api_creds:
            r = await _backup_via_api(ip, cred, cipher, "export", hostname, device_uuid, timeout)
            if r.success:
                return r
        for cred in ssh_creds:
            r = await _backup_via_ssh(ip, cred, cipher, "export", hostname, device_uuid, timeout)
            if r.success:
                return r
        r = BackupResult("export")
        r.error = "Export selhal přes všechny dostupné profily"
        return r

    # Spustíme oba typy paralelně
    binary_result, export_result = await asyncio.gather(
        do_binary(),
        do_export(),
        return_exceptions=False,
    )

    # Zjistíme verzi ROS a doplníme do výsledků
    try:
        ros_ver = await _get_ros_version(ip, creds, cipher, timeout=10.0)
        if ros_ver:
            binary_result.mikrotik_version = ros_ver
            export_result.mikrotik_version = ros_ver
    except Exception:
        pass

    log.info(
        f"Backup dokončen: ip={ip} "
        f"binary={'OK' if binary_result.success else 'FAIL'} "
        f"export={'OK' if export_result.success else 'FAIL'}"
    )

    return binary_result, export_result


# ---------------------------------------------------------------------------
# Pomocná funkce — formátování velikosti souboru
# ---------------------------------------------------------------------------

def format_file_size(size_bytes: Optional[int]) -> str:
    """Vrátí čitelnou velikost souboru (B / KB / MB)."""
    if size_bytes is None:
        return "—"
    if size_bytes < 1024:
        return f"{size_bytes} B"
    if size_bytes < 1024 * 1024:
        return f"{size_bytes / 1024:.1f} KB"
    return f"{size_bytes / (1024 * 1024):.2f} MB"
