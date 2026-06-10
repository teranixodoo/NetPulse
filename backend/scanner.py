# backend/scanner.py — Hybridní scanner: fping pro hromadný scan, icmplib pro live ping
#
# STRATEGIE:
#   scan_range()  → fping  (-i 10ms mezi pakety, paralelní příjem odpovědí)
#                   rychlý + přesný, žádná congestion
#   ping_host()   → icmplib (async_ping, pro live ping jedné IP)

from __future__ import annotations
import asyncio
import logging
import os
import re
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional, Callable, List

log = logging.getLogger("netpulse.scanner")

# ---------------------------------------------------------------------------
# Detekce privilegií
# ---------------------------------------------------------------------------
def _is_privileged() -> bool:
    if os.getuid() == 0:
        return True
    try:
        import socket
        s = socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_ICMP)
        s.close()
        return True
    except PermissionError:
        return False

PRIVILEGED = _is_privileged()
FPING_BIN  = shutil.which("fping")

log.info(f"Scanner init: privileged={PRIVILEGED}, fping={FPING_BIN}")


# ---------------------------------------------------------------------------
# Výsledek pingu
# ---------------------------------------------------------------------------
@dataclass
class PingResult:
    ip:          str
    is_alive:    bool
    rtt_ms:      Optional[float]
    packet_loss: float
    jitter_ms:   Optional[float]
    scanned_at:  datetime


# ---------------------------------------------------------------------------
# fping parser
# ---------------------------------------------------------------------------
def _parse_fping_output(stderr: str, sent: int, scanned_at: datetime) -> dict[str, PingResult]:
    """
    Parsuje výstup fping -C N -q.
    Formát: "IP : rtt1 rtt2 rtt3 ..." nebo "IP : - - -" (timeout)
    """
    results: dict[str, PingResult] = {}

    for line in stderr.splitlines():
        line = line.strip()
        if not line or " : " not in line:
            continue
        try:
            ip_part, rtt_part = line.split(" : ", 1)
            ip   = ip_part.strip()
            rtts_raw = rtt_part.strip().split()
            rtts = [float(r) for r in rtts_raw if r != "-"]

            if rtts:
                avg_rtt  = sum(rtts) / len(rtts)
                min_rtt  = min(rtts)
                max_rtt  = max(rtts)
                # Jitter = průměrná odchylka od průměru
                jitter   = sum(abs(r - avg_rtt) for r in rtts) / len(rtts)
                loss     = (sent - len(rtts)) / sent if sent > 0 else 0.0
                results[ip] = PingResult(
                    ip          = ip,
                    is_alive    = True,
                    rtt_ms      = round(avg_rtt, 3),
                    packet_loss = max(0.0, round(loss, 4)),
                    jitter_ms   = round(jitter, 3),
                    scanned_at  = scanned_at,
                )
            else:
                results[ip] = PingResult(
                    ip          = ip,
                    is_alive    = False,
                    rtt_ms      = None,
                    packet_loss = 1.0,
                    jitter_ms   = None,
                    scanned_at  = scanned_at,
                )
        except Exception as e:
            log.debug(f"fping parse error pro '{line}': {e}")

    return results


# ---------------------------------------------------------------------------
# Hromadný scan — fping
# ---------------------------------------------------------------------------
async def _scan_fping(
    target_ips:  List[str],
    count:       int = 3,
    timeout_ms:  int = 1000,
    interval_ms: int = 10,     # ms mezi pakety — klíčový parametr pro přesnost
    on_progress: Optional[Callable] = None,
) -> List[PingResult]:
    """
    Použije fping pro hromadný scan.
    -C count   = počet paketů per IP
    -p ms      = interval mezi pakety téže IP
    -i ms      = interval mezi pakety různých IP (spread)
    -q         = quiet (výsledky na stderr)
    -t ms      = timeout per packet
    """
    timeout_s = max(1.0, timeout_ms / 1000 * count + 1)
    scanned_at = datetime.now(timezone.utc)

    cmd = [
        FPING_BIN,
        "-C", str(count),          # N paketů per IP
        "-p", "200",               # 200ms mezi pakety stejné IP
        "-i", str(interval_ms),    # Xms mezi pakety různých IP (spread)
        "-t", str(timeout_ms),     # timeout per paket
        "-q",                      # výsledky na stderr
        "-r", "0",                 # žádný retry
    ] + target_ips

    log.info(
        f"fping scan: {len(target_ips)} IP, count={count}, "
        f"interval={interval_ms}ms, timeout={timeout_ms}ms"
    )

    try:
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        _, stderr_bytes = await asyncio.wait_for(
            proc.communicate(),
            timeout=timeout_s + count * len(target_ips) * interval_ms / 1000 + 10,
        )
        stderr = stderr_bytes.decode("utf-8", errors="ignore")

    except asyncio.TimeoutError:
        log.error("fping timeout!")
        proc.kill()
        return [
            PingResult(ip, False, None, 1.0, None, scanned_at)
            for ip in target_ips
        ]
    except Exception as e:
        log.error(f"fping chyba: {e}")
        return []

    parsed = _parse_fping_output(stderr, count, scanned_at)

    # Sestavíme výsledky pro všechny IP (i ty co fping nevypsal = offline)
    results = []
    for ip in target_ips:
        if ip in parsed:
            results.append(parsed[ip])
        else:
            results.append(PingResult(ip, False, None, 1.0, None, scanned_at))

    alive = sum(1 for r in results if r.is_alive)
    log.info(f"fping dokončen: {alive}/{len(results)} online")

    if on_progress:
        on_progress(len(results), len(results))

    return results


# ---------------------------------------------------------------------------
# Fallback — icmplib (pokud fping není k dispozici)
# ---------------------------------------------------------------------------
async def _scan_icmplib(
    target_ips:  List[str],
    count:       int = 3,
    timeout_ms:  int = 1000,
    max_conc:    int = 50,
    on_progress: Optional[Callable] = None,
) -> List[PingResult]:
    """Fallback na icmplib pokud fping chybí."""
    from icmplib import async_ping

    sem     = asyncio.Semaphore(max_conc)
    results = []
    done    = 0
    total   = len(target_ips)

    async def _ping(ip: str) -> PingResult:
        async with sem:
            try:
                res = await async_ping(ip, count=count,
                                       timeout=timeout_ms/1000,
                                       privileged=PRIVILEGED)
                return PingResult(
                    ip          = ip,
                    is_alive    = res.is_alive,
                    rtt_ms      = round(res.avg_rtt, 3) if res.is_alive else None,
                    packet_loss = res.packet_loss,
                    jitter_ms   = round(res.jitter, 3) if res.is_alive else None,
                    scanned_at  = datetime.now(timezone.utc),
                )
            except Exception:
                return PingResult(ip, False, None, 1.0, None, datetime.now(timezone.utc))

    tasks = [_ping(ip) for ip in target_ips]
    for coro in asyncio.as_completed(tasks):
        r = await coro
        results.append(r)
        done += 1
        if on_progress:
            on_progress(done, total)

    return results


# ---------------------------------------------------------------------------
# Veřejné API
# ---------------------------------------------------------------------------
async def scan_range(
    target_ips:  List[str],
    count:       int = 3,
    timeout_ms:  int = 1000,
    max_conc:    int = 50,      # použije se jen pro icmplib fallback
    on_progress: Optional[Callable[[int, int], None]] = None,
) -> List[PingResult]:
    """
    Hlavní scan funkce. Použije fping pokud je dostupný, jinak icmplib.
    """
    if not target_ips:
        return []

    if FPING_BIN:
        return await _scan_fping(
            target_ips,
            count       = count,
            timeout_ms  = timeout_ms,
            interval_ms = 10,          # 10ms spread = 100 IP/s, žádná congestion
            on_progress = on_progress,
        )
    else:
        log.warning("fping není dostupný, používám icmplib fallback")
        return await _scan_icmplib(
            target_ips,
            count       = count,
            timeout_ms  = timeout_ms,
            max_conc    = max_conc,
            on_progress = on_progress,
        )


async def ping_host(
    ip:         str,
    sem:        asyncio.Semaphore,
    count:      int = 5,
    timeout_ms: int = 2000,
) -> PingResult:
    """
    Single-IP ping pro live graf.
    Vždy používá icmplib (přesný, bez soupeření).
    """
    from icmplib import async_ping

    async with sem:
        try:
            res = await async_ping(
                ip,
                count      = count,
                timeout    = timeout_ms / 1000,
                privileged = PRIVILEGED,
            )
            return PingResult(
                ip          = ip,
                is_alive    = res.is_alive,
                rtt_ms      = round(res.avg_rtt, 3) if res.is_alive else None,
                packet_loss = res.packet_loss,
                jitter_ms   = round(res.jitter, 3) if res.is_alive else None,
                scanned_at  = datetime.now(timezone.utc),
            )
        except Exception as e:
            log.debug(f"ping_host error {ip}: {e}")
            return PingResult(ip, False, None, 1.0, None, datetime.now(timezone.utc))


async def scan_range_with_proxy(
    target_ips:  list[str],
    proxy:       dict | None = None,
    count:       int = 3,
    timeout_ms:  int = 1000,
    max_conc:    int = 50,
    on_progress: Optional[Callable[[int, int], None]] = None,
    pool         = None,   # asyncpg pool pro DB cache ARP
) -> List[PingResult]:
    """
    Proxy-aware scan. Pokud je proxy zadán, pinguje přes MikroTik ARP.
    Jinak použije standardní scan_range (fping/icmplib).
    """
    if not proxy:
        return await scan_range(
            target_ips, count=count, timeout_ms=timeout_ms,
            max_conc=max_conc, on_progress=on_progress,
        )

    # Scan přes MikroTik ARP proxy — jedno spojení pro celý range
    from poller import proxy_scan_via_arp, ProxyPingResult
    from cryptography.fernet import Fernet as _Fernet
    import os as _os
    log.info(f"Proxy scan: {len(target_ips)} IP přes {proxy.get('ip')} ({proxy.get('hostname')})")

    _key = _os.environ.get("DB_ENCRYPTION_KEY", "") or _os.environ.get("FERNET_KEY", "")
    try:
        _cipher = _Fernet(_key.encode()) if _key else _Fernet(_Fernet.generate_key())
    except Exception:
        _cipher = _Fernet(_Fernet.generate_key())

    proxy_results = await proxy_scan_via_arp(
        proxy, target_ips, _cipher, pool=pool, timeout=15.0
    )

    now = datetime.now(timezone.utc)
    results = []
    for ip in target_ips:
        r = proxy_results.get(ip)
        if r and r.alive:
            results.append(PingResult(
                ip          = ip,
                is_alive    = True,
                rtt_ms      = r.rtt_ms,
                packet_loss = r.packet_loss / 100.0,
                jitter_ms   = None,
                scanned_at  = now,
            ))
        else:
            results.append(PingResult(ip, False, None, 1.0, None, now))

        if on_progress:
            on_progress(len(results), len(target_ips))

    return results
