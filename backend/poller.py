# backend/poller.py — Čtení dat ze zařízení pomocí přihlašovacích profilů
#
# Priorita: api → snmp → ssh → http
#
# Každá metoda vrací PollerResult se zjištěnými daty:
#   - hostname, uptime, firmware, model, vendor
#   - interfaces (seznam rozhraní s IP/MAC/stavem)
#   - system_info (volný dict s dalšími daty)
#   - raw_output (surový výstup pro debug)

from __future__ import annotations
import asyncio
import json
import logging
import socket
import re
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger("netpulse.poller")


# ---------------------------------------------------------------------------
# Výsledek pollingu
# ---------------------------------------------------------------------------
@dataclass
class PollerResult:
    ip:           str
    method:       str                      # api | snmp | ssh | http | failed
    success:      bool = False
    hostname:     Optional[str] = None
    model:        Optional[str] = None
    vendor:       Optional[str] = None
    firmware:     Optional[str] = None
    uptime:       Optional[str] = None     # human-readable
    uptime_s:     Optional[int] = None     # sekundy
    serial:       Optional[str] = None
    software_id:  Optional[str] = None
    device_type_detected: Optional[str] = None
    interfaces:   list         = field(default_factory=list)
    ports:        list         = field(default_factory=list)
    system_info:  dict         = field(default_factory=dict)
    raw_output:   Optional[str] = None
    error:        Optional[str] = None
    credential_id:   Optional[int]  = None   # ID úspěšného credential profilu
    successful_auth: Optional[dict] = None   # Kompletní parametry úspěšného přihlášení


# ---------------------------------------------------------------------------
# Helper — dešifrování hesla
# ---------------------------------------------------------------------------
def _decrypt(password_cipher: str, cipher_obj) -> str:
    if cipher_obj is None:
        return password_cipher
    try:
        return cipher_obj.decrypt(password_cipher.encode()).decode()
    except Exception:
        return password_cipher



def _collect_mikrotik_extended(api) -> dict:
    """Sbírá ARP, DHCP leases a interfaces přes MikroTik API."""
    result = {}

    # Interfaces + statistiky
    try:
        ifaces = api.get_resource("/interface").get()
        result["interfaces"] = [
            {
                "name":      f.get("name", ""),
                "type":      f.get("type", ""),
                "running":   f.get("running", "false") == "true",
                "disabled":  f.get("disabled", "false") == "true",
                "comment":   f.get("comment", ""),
                "mac":       f.get("mac-address", ""),
                "mtu":       str(f.get("mtu", "")),
                "rx_byte":   int(f.get("rx-byte", 0) or 0),
                "tx_byte":   int(f.get("tx-byte", 0) or 0),
                "rx_packet": int(f.get("rx-packet", 0) or 0),
                "tx_packet": int(f.get("tx-packet", 0) or 0),
                "rx_error":  int(f.get("rx-error", 0) or 0),
                "tx_error":  int(f.get("tx-error", 0) or 0),
            }
            for f in ifaces if not f.get("name", "").startswith("*")
        ]
    except Exception as e:
        log.debug(f"Interfaces sběr: {e}")

    # ARP tabulka
    try:
        result["arp"] = [
            {
                "ip":        e.get("address", ""),
                "mac":       e.get("mac-address", ""),
                "interface": e.get("interface", ""),
                "status":    "dynamic" if e.get("dynamic") == "true" else "static",
                "complete":  e.get("complete", "false") == "true",
                "invalid":   e.get("invalid", "false") == "true",
            }
            for e in api.get_resource("/ip/arp").get()
            if e.get("address")
        ]
    except Exception as e:
        log.debug(f"ARP sběr: {e}")

    # Vlastní IP adresy na interfacech
    try:
        addrs = api.get_resource("/ip/address").get()
        result["own_ips"] = [
            {
                "ip":        a.get("address", "").split("/")[0],  # bez prefixu
                "network":   a.get("network", ""),
                "interface": a.get("interface", ""),
                "mac":       None,  # vlastní IP nemají MAC v /ip/address
                "source":    "api_address",
            }
            for a in addrs
            if a.get("address") and a.get("disabled", "false") != "true"
        ]
    except Exception as e:
        log.debug(f"Own IPs sběr: {e}")

    # ARP s MAC — přidáme source pro device_ips
    if "arp" in result:
        for entry in result["arp"]:
            entry["source"] = "api_arp"

    # DHCP s MAC — přidáme source
    if "dhcp" in result:
        for lease in result.get("dhcp", []):
            lease["source"] = "api_dhcp"

    # DHCP leases
    try:
        result["dhcp"] = [
            {
                "ip":         l.get("address", ""),
                "mac":        l.get("mac-address", ""),
                "hostname":   l.get("host-name", ""),
                "server":     l.get("server", ""),
                "status":     l.get("status", ""),
                "expires_at": l.get("expires-after", ""),
                "dynamic":    l.get("dynamic", "false") == "true",
                "blocked":    l.get("blocked", "false") == "true",
                "comment":    l.get("comment", ""),
            }
            for l in api.get_resource("/ip/dhcp-server/lease").get()
            if l.get("address")
        ]
    except Exception as e:
        log.debug(f"DHCP sběr: {e}")

    return result


# ---------------------------------------------------------------------------
# Metoda 1: MikroTik RouterOS API (routeros_api knihovna)
# Podporuje: plaintext login (ROS 6.43+), SSL (port 8729/58729)
# ---------------------------------------------------------------------------

def _is_ssl_port(port: int) -> bool:
    """SSL porty: 8729, 58729 a jiné nestandardní SSL varianty."""
    return port in (8729, 58729)


def _parse_mikrotik_uptime(s: str) -> int | None:
    """Převede MikroTik uptime '1w2d3h4m5s' na sekundy."""
    if not s:
        return None
    import re as _re
    total = 0
    for val, unit in _re.findall(r"(\d+)([wdhms])", s):
        v = int(val)
        if unit == "w":   total += v * 604800
        elif unit == "d": total += v * 86400
        elif unit == "h": total += v * 3600
        elif unit == "m": total += v * 60
        elif unit == "s": total += v
    return total if total > 0 else None


def _normalize_speed(raw: str) -> str:
    """Normalizuje rychlost portu z RouterOS formátu."""
    if not raw:
        return "—"
    raw = raw.lower()
    if "100g" in raw or "100000" in raw:
        return "100G"
    if "40g"  in raw or "40000"  in raw:
        return "40G"
    if "25g"  in raw or "25000"  in raw:
        return "25G"
    if "10g"  in raw or "10000"  in raw:
        return "10G"
    if "2.5g" in raw or "2500"   in raw:
        return "2.5G"
    if "1g"   in raw or "1000"   in raw or "1gbps" in raw:
        return "1G"
    if "100m" in raw or "100mbps" in raw:
        return "100M"
    if "10m"  in raw or "10mbps"  in raw:
        return "10M"
    return raw.upper()



async def _poll_mikrotik_api(
    ip: str, cred: dict, timeout: float = 15.0
) -> PollerResult:
    """
    MikroTik RouterOS API polling přes routeros_api knihovnu.
    Použije přesně parametry z přihlašovacího profilu.
    """
    result   = PollerResult(ip=ip, method="api")
    username = cred.get("username", "admin")
    password = cred.get("_password", "")
    port     = int(cred.get("port") or 8728)
    use_ssl  = _is_ssl_port(port)

    try:
        import routeros_api
    except ImportError:
        result.error = "RouterOS-api není nainstalován (pip install RouterOS-api)"
        return result

    log.info(f"MikroTik API connecting: {ip}:{port} user={username} ssl={use_ssl}")
    log.info(f"MikroTik API password len={len(password)} first={password[:1]!r} last={password[-1:]!r}")
    loop = asyncio.get_event_loop()

    def _connect_and_fetch():
        """Synchronní připojení — spouštíme v executoru."""
        # SSL strategie — zkoušíme postupně dokud jedna nezafunguje
        # Různá zařízení / firmware verze vyžadují různé SSL nastavení
        conn = None
        last_ssl_error = None

        ssl_variants = []
        if use_ssl:
            import ssl as _ssl
            # Varianta 1: bez vlastního kontextu (routeros_api default) — funguje pro ROS s certifikátem
            ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                  "ssl_verify_hostname": False, "ssl_context": None})
            # Varianta 2: ADH cipher — ROS bez certifikátu (starší firmware)
            try:
                ctx_adh = _ssl.create_default_context()
                ctx_adh.check_hostname = False
                ctx_adh.verify_mode    = _ssl.CERT_NONE
                ctx_adh.set_ciphers("ADH:@SECLEVEL=0")
                ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                     "ssl_verify_hostname": False, "ssl_context": ctx_adh})
            except Exception:
                pass
            # Varianta 3: ALL ciphers SECLEVEL=0 — velmi starý firmware
            try:
                ctx_all = _ssl.create_default_context()
                ctx_all.check_hostname = False
                ctx_all.verify_mode    = _ssl.CERT_NONE
                ctx_all.set_ciphers("ALL:@SECLEVEL=0")
                ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                     "ssl_verify_hostname": False, "ssl_context": ctx_all})
            except Exception:
                pass
            # Varianta 4: TLS 1.2 only + relaxed ciphers — Python 3.12 fix
            try:
                ctx_tls12 = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
                ctx_tls12.check_hostname = False
                ctx_tls12.verify_mode    = _ssl.CERT_NONE
                ctx_tls12.maximum_version = _ssl.TLSVersion.TLSv1_2
                ctx_tls12.set_ciphers("ALL:@SECLEVEL=0")
                ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                     "ssl_verify_hostname": False, "ssl_context": ctx_tls12})
            except Exception:
                pass
            # Varianta 5: TLS 1.1 — velmi starý ROS
            try:
                ctx_tls11 = _ssl.SSLContext(_ssl.PROTOCOL_TLS_CLIENT)
                ctx_tls11.check_hostname = False
                ctx_tls11.verify_mode    = _ssl.CERT_NONE
                ctx_tls11.minimum_version = _ssl.TLSVersion.TLSv1
                ctx_tls11.maximum_version = _ssl.TLSVersion.TLSv1_2
                ctx_tls11.set_ciphers("ALL:@SECLEVEL=0")
                ssl_variants.append({"use_ssl": True, "ssl_verify": False,
                                     "ssl_verify_hostname": False, "ssl_context": ctx_tls11})
            except Exception:
                pass
        else:
            # Plaintext — žádné SSL
            ssl_variants.append({"use_ssl": False, "ssl_verify": False,
                                  "ssl_verify_hostname": False, "ssl_context": None})

        api = None
        successful_ssl_opt = None
        for ssl_opt in ssl_variants:
            try:
                _conn = routeros_api.RouterOsApiPool(
                    ip,
                    username            = username,
                    password            = password,
                    port                = port,
                    plaintext_login     = True,
                    **ssl_opt,
                )
                api = _conn.get_api()
                conn = _conn
                successful_ssl_opt = ssl_opt  # zapamatujeme variantu která fungovala
                log.debug(f"MikroTik API {ip}:{port} SSL varianta OK: ssl={ssl_opt['use_ssl']} ctx={ssl_opt['ssl_context'] is not None}")
                break
            except Exception as e:
                last_ssl_error = e
                log.debug(f"MikroTik API {ip}:{port} SSL varianta selhala: {e}")
                continue

        if api is None:
            raise last_ssl_error or RuntimeError("Všechny SSL varianty selhaly")
        data = {}

        try:
            # System identity — hostname
            identity = api.get_resource("/system/identity").get()
            if identity:
                data["hostname"] = identity[0].get("name")

            # System resource — hardware, uptime, resources
            resource = api.get_resource("/system/resource").get()
            if resource:
                r = resource[0]
                data["vendor"]        = r.get("platform", "MikroTik")
                data["model"]         = r.get("board-name")
                data["firmware"]      = r.get("version")
                data["uptime"]        = r.get("uptime", "")
                data["system_info"]   = {
                    "cpu-load":             r.get("cpu-load"),
                    "free-memory":          r.get("free-memory"),
                    "total-memory":         r.get("total-memory"),
                    "free-hdd-space":       r.get("free-hdd-space"),
                    "total-hdd-space":      r.get("total-hdd-space"),
                    "architecture-name":    r.get("architecture-name"),
                    "cpu-count":            r.get("cpu-count"),
                    "cpu-frequency":        r.get("cpu-frequency"),
                }
                # Vyčistíme None hodnoty
                data["system_info"] = {
                    k: v for k, v in data["system_info"].items() if v is not None
                }

            # Rozhraní
            try:
                ifaces = api.get_resource("/interface").get()
                data["interfaces"] = [
                    {
                        "name":     i.get("name"),
                        "type":     i.get("type"),
                        "mac":      i.get("mac-address"),
                        "running":  i.get("running") == "true",
                        "disabled": i.get("disabled") == "true",
                        "comment":  i.get("comment", ""),
                        "rx-byte":  i.get("rx-byte"),
                        "tx-byte":  i.get("tx-byte"),
                    }
                    for i in ifaces
                ]
            except Exception:
                data["interfaces"] = []

            # IP adresy na rozhraních
            try:
                ip_addrs = api.get_resource("/ip/address").get()
                data["system_info"]["ip_addresses"] = [
                    f"{a.get('address')} ({a.get('interface')})"
                    for a in ip_addrs
                    if not a.get("disabled") == "true"
                ]
            except Exception:
                pass

            # Ethernet porty — typ, rychlost, duplex, stav linky
            try:
                eth_ports = api.get_resource("/interface/ethernet").get()
                ports = []
                for e in eth_ports:
                    speed_raw = e.get("rate", "") or e.get("speed", "") or ""
                    # Normalizace rychlosti
                    speed = _normalize_speed(speed_raw)
                    ports.append({
                        "name":        e.get("name"),
                        "mac":         e.get("mac-address"),
                        "speed":       speed,
                        "duplex":      e.get("full-duplex", "true") == "true" and "full" or "half",
                        "link":        e.get("running", "false") == "true",
                        "disabled":    e.get("disabled", "false") == "true",
                        "advertise":   e.get("advertise", ""),
                        "comment":     e.get("comment", ""),
                        "sfp":         "sfp" in e.get("name", "").lower() or
                                       "qsfp" in e.get("name", "").lower() or
                                       e.get("sfp-type", "") != "",
                        "sfp_type":    e.get("sfp-type", "") or e.get("sfp-vendor-name", ""),
                    })
                data["ports"] = ports
                data["system_info"]["port_count"]   = len(ports)
                data["system_info"]["ports_up"]     = sum(1 for p in ports if p["link"] and not p["disabled"])
                data["system_info"]["ports_sfp"]    = sum(1 for p in ports if p["sfp"])
            except Exception:
                pass

            # RouterBOARD info (sériové číslo)
            try:
                rb = api.get_resource("/system/routerboard").get()
                if rb:
                    data["serial"]           = rb[0].get("serial-number")
                    data["system_info"]["model"]           = rb[0].get("model")
                    data["system_info"]["firmware-type"]   = rb[0].get("firmware-type")
                    data["system_info"]["factory-firmware"] = rb[0].get("factory-firmware")
                    data["system_info"]["current-firmware"] = rb[0].get("current-firmware")
                    data["system_info"]["upgrade-firmware"]  = rb[0].get("upgrade-firmware")
            except Exception:
                pass

            # Software ID z licence
            try:
                lic = api.get_resource("/system/license").get()
                if lic:
                    data["software_id"] = lic[0].get("software-id")
                    data["system_info"]["license-level"] = lic[0].get("nlevel") or lic[0].get("level")
            except Exception:
                pass

            # Balíčky a detekce typu zařízení
            try:
                pkgs = api.get_resource("/system/package").get()
                pkg_names = {p.get("name", "") for p in pkgs if p.get("disabled") != "true"}
                data["system_info"]["packages"] = ", ".join(sorted(pkg_names))
            except Exception:
                pkg_names = set()

            # Rozšířená data — interfaces, ARP, DHCP
            try:
                data["extended"] = _collect_mikrotik_extended(api)
            except Exception as _ee:
                log.debug(f"Rozšířená data {ip}: {_ee}")

            # Detekce typu — board-name má VŽDY prioritu
            board = data.get("model", "") or ""
            SWITCH_PREFIXES   = ("CRS", "CSS")
            ROUTER_PREFIXES   = ("CCR", "RB4011", "RB1100", "RB3011", "RB2011", "CHR")
            WIRELESS_PREFIXES = ("hAP", "cAP", "wAP", "SXT", "LHG", "QRT",
                                 "mANTBox", "OmniTIK", "Audience", "NetMetal")

            if any(board.startswith(p) for p in SWITCH_PREFIXES):
                data["device_type"] = "Switch"
            elif any(board.startswith(p) for p in ROUTER_PREFIXES):
                data["device_type"] = "Router"
            elif any(board.startswith(p) for p in WIRELESS_PREFIXES):
                data["device_type"] = "Wireless"
            else:
                # Fallback — balíčky jen pokud board není jasný
                if "wifiwave2" in pkg_names:
                    data["device_type"] = "Wireless"
                elif "switch" in pkg_names and "wireless" not in pkg_names:
                    data["device_type"] = "Switch"
                else:
                    data["device_type"] = "Router"

        finally:
            try:
                if conn:
                    conn.disconnect()
            except Exception:
                pass

        return data, successful_ssl_opt

    try:
        data, _ssl_opt = await asyncio.wait_for(
            loop.run_in_executor(None, _connect_and_fetch),
            timeout=timeout,
        )

        result.hostname    = data.get("hostname")
        result.vendor      = data.get("vendor", "MikroTik")
        result.model       = data.get("model")
        result.firmware    = data.get("firmware")
        result.serial      = data.get("serial")
        result.software_id = data.get("software_id")
        result.device_type_detected = data.get("device_type")
        result.interfaces  = data.get("interfaces", [])
        result.ports       = data.get("ports", [])
        result.system_info = data.get("system_info", {})
        result.extended    = data.get("extended", {})
        # Přidáme klíčové hodnoty do system_info
        if result.software_id:
            result.system_info["software-id"] = result.software_id
        if result.device_type_detected:
            result.system_info["detected-type"] = result.device_type_detected

        uptime_str = data.get("uptime", "")
        if uptime_str:
            result.uptime   = uptime_str
            result.uptime_s = _parse_mikrotik_uptime(uptime_str)

        # Uložíme snapshot úspěšného přihlášení pro backup engine
        result.successful_auth = {
            "auth_type":        "api",
            "credential_id":    cred.get("id"),
            "credential_name":  cred.get("name"),
            "username":         username,
            "port":             port,
            "use_ssl":          _ssl_opt.get("use_ssl", False) if _ssl_opt else False,
            "ssl_verify":       _ssl_opt.get("ssl_verify", False) if _ssl_opt else False,
            "has_ssl_context":  _ssl_opt.get("ssl_context") is not None if _ssl_opt else False,
        }

        result.success = True
        log.info(
            f"MikroTik API {ip}:{port} OK — "
            f"hostname={result.hostname} model={result.model} "
            f"fw={result.firmware} serial={result.serial}"
        )

    except asyncio.TimeoutError:
        result.error = f"Timeout ({timeout}s) — zařízení neodpovídá na port {port}"
        log.warning(f"MikroTik API {ip}:{port} timeout")
    except Exception as e:
        import traceback
        err_msg = str(e) or repr(e) or traceback.format_exc().splitlines()[-1]
        result.error = err_msg[:300]
        log.warning(f"MikroTik API {ip}:{port} chyba: {err_msg}")

    return result


# ---------------------------------------------------------------------------
# Metoda 2: SNMP (pysnmp)
# ---------------------------------------------------------------------------

# MikroTik OIDs — MIB-2 + MIKROTIK-MIB
_SNMP_OIDS = {
    # MIB-2 System
    "sysDescr":          "1.3.6.1.2.1.1.1.0",
    "sysName":           "1.3.6.1.2.1.1.5.0",
    "sysUpTime":         "1.3.6.1.2.1.1.3.0",
    "sysContact":        "1.3.6.1.2.1.1.4.0",
    "sysLocation":       "1.3.6.1.2.1.1.6.0",
    # MikroTik proprietární (MIKROTIK-MIB)
    "mtBoardName":       "1.3.6.1.4.1.14988.1.1.4.1.0",
    "mtSerialNumber":    "1.3.6.1.4.1.14988.1.1.4.2.0",
    "mtSoftwareId":      "1.3.6.1.4.1.14988.1.1.4.3.0",
    "mtFirmwareVersion": "1.3.6.1.4.1.14988.1.1.4.4.0",
    "mtCpuLoad":         "1.3.6.1.4.1.14988.1.1.3.6.0",
    "mtCpuCount":        "1.3.6.1.4.1.14988.1.1.3.8.0",
    "mtCpuFrequency":    "1.3.6.1.4.1.14988.1.1.3.14.0",
    "mtTotalMemory":     "1.3.6.1.4.1.14988.1.1.3.1.0",
    "mtFreeMemory":      "1.3.6.1.4.1.14988.1.1.3.2.0",
    "mtTotalHdd":        "1.3.6.1.4.1.14988.1.1.3.3.0",
    "mtFreeHdd":         "1.3.6.1.4.1.14988.1.1.3.4.0",
    "mtVoltage":         "1.3.6.1.4.1.14988.1.1.3.5.0",
    "mtTemperature":     "1.3.6.1.4.1.14988.1.1.3.10.0",
    "mtArchitecture":    "1.3.6.1.4.1.14988.1.1.3.9.0",
    # HOST-RESOURCES-MIB — funguje na všech verzích
    "hrMemorySize":      "1.3.6.1.2.1.25.2.2.0",
    "hrProcessorLoad":   "1.3.6.1.2.1.25.3.3.1.2.1",
}


def _parse_sysdescr(desc: str, result) -> None:
    """Detekuje vendor a firmware ze sysDescr stringu."""
    import re as _re
    d = desc.lower()
    for kw, vendor, model_re in [
        ("routeros",  "MikroTik", r"RouterOS\s+([\d\.]+)"),
        ("mikrotik",  "MikroTik", None),
        ("cisco ios", "Cisco",    r"Version\s+([\S]+)"),
        ("cisco",     "Cisco",    None),
        ("linux",     "Linux",    r"Linux\s+([\S]+)"),
        ("windows",   "Windows",  None),
        ("synology",  "Synology", None),
        ("junos",     "Juniper",  r"JUNOS\s+([\S]+)"),
        ("fortios",   "Fortinet", r"FortiOS\s+([\S]+)"),
    ]:
        if kw in d:
            result.vendor = result.vendor or vendor
            if model_re:
                m = _re.search(model_re, desc, _re.IGNORECASE)
                if m:
                    result.firmware = result.firmware or m.group(1)
            break



async def _snmp_get_multi(
    ip: str, community: str, oids: dict[str, str],
    port: int = 161, timeout: float = 5.0,
) -> dict[str, str | int | None]:
    """
    Načte více OIDs přes pysnmp 7.x (asyncio).
    Vrátí dict {name: value}.
    """
    from pysnmp.hlapi.v3arch.asyncio import (
        SnmpEngine, CommunityData, UdpTransportTarget,
        ContextData, ObjectType, ObjectIdentity, get_cmd,
    )
    getCmd = get_cmd

    results: dict[str, str | int | None] = {k: None for k in oids}

    def _parse_val(val) -> str | int | None:
        cls = type(val).__name__
        if "OctetString" in cls or "DisplayString" in cls:
            try:
                raw = val.asOctets()
                if not raw:
                    return None
                # Zkusíme dekódovat jako UTF-8 / ASCII
                try:
                    s = raw.decode("utf-8")
                    # Zkontrolujeme zda jsou všechny znaky printable
                    clean = "".join(
                        ch for ch in s
                        if ch != "\x00" and (ord(ch) >= 32 or ch in "\t\n")
                    ).strip()
                    if clean:
                        return clean
                    # Pokud čistý string je prázdný - jsou tam jen control chars
                    # → vrátíme hex reprezentaci (binární data)
                    return raw.hex().upper()
                except UnicodeDecodeError:
                    # Binární data → hex string
                    return raw.hex().upper()
            except Exception:
                s = str(val).strip()
                return s or None
        elif any(x.lower() in cls.lower() for x in ("Integer","Counter","Gauge","Timetick","Unsigned","Gauge32")):
            return int(val)
        elif any(x in cls for x in ("NoSuch","EndOfMib")):
            return None
        else:
            s = str(val).strip()
            return s or None

    try:
        engine = SnmpEngine()
        items  = list(oids.items())

        for i in range(0, len(items), 10):
            batch     = items[i:i+10]
            obj_types = [ObjectType(ObjectIdentity(oid)) for _, oid in batch]

            errorInd, errorStatus, errorIndex, varBinds = await getCmd(
                engine,
                CommunityData(community, mpModel=1),
                await UdpTransportTarget.create(
                    (ip, port), timeout=timeout, retries=1
                ),
                ContextData(),
                *obj_types,
            )

            if errorInd:
                log.debug(f"SNMP {ip} batch {i}: {errorInd}")
                continue
            if errorStatus:
                log.debug(f"SNMP {ip} batch {i}: {errorStatus.prettyPrint()}")
                continue

            for (name, _), vb in zip(batch, varBinds):
                results[name] = _parse_val(vb[1])

        engine.closeDispatcher()

    except Exception as e:
        log.debug(f"SNMP {ip} error: {e}")

    return results


async def _snmp_walk(
    ip: str, community: str, base_oid: str,
    port: int = 161, timeout: float = 10.0, max_rows: int = 500,
) -> list[tuple[str, any]]:
    """
    SNMP GETNEXT walk — prochází celou tabulku od base_oid.
    Vrátí list (oid_suffix, value).
    Kompatibilní s pysnmp 7.x.
    """
    from pysnmp.hlapi.v3arch.asyncio import (
        SnmpEngine, CommunityData, UdpTransportTarget,
        ContextData, ObjectType, ObjectIdentity, get_cmd,
    )

    results  = []
    engine   = SnmpEngine()
    base_dot = base_oid.rstrip(".") + "."

    try:
        transport = await UdpTransportTarget.create((ip, port), timeout=timeout, retries=1)
        current_oid = base_oid

        for _ in range(max_rows):
            # Použijeme get_cmd s GETNEXT semantikou přes OID inkrementaci
            # pysnmp 7.x: ObjectIdentity s explicitním OID
            from pysnmp.proto.rfc1902 import ObjectName
            from pysnmp.hlapi.v3arch.asyncio import next_cmd as _next

            try:
                errInd, errStat, errIdx, varBinds = await _next(
                    engine,
                    CommunityData(community, mpModel=1),
                    transport,
                    ContextData(),
                    ObjectType(ObjectIdentity(current_oid)),
                    lexicographicMode=False,
                )
            except TypeError:
                # pysnmp 7.x vrací async generátor
                gen = _next(
                    engine,
                    CommunityData(community, mpModel=1),
                    transport,
                    ContextData(),
                    ObjectType(ObjectIdentity(current_oid)),
                    lexicographicMode=False,
                )
                errInd, errStat, errIdx, varBinds = await gen.__anext__()

            if errInd or errStat:
                break
            if not varBinds:
                break

            for vb in varBinds:
                oid_str = str(vb[0])
                val     = vb[1]
                # Zastavíme pokud jsme mimo rozsah
                if not oid_str.startswith(base_dot):
                    return results
                suffix = oid_str[len(base_dot):]
                results.append((suffix, val))
                current_oid = oid_str

    except Exception as e:
        log.debug(f"SNMP walk {ip} {base_oid}: {e}")
    finally:
        try:
            engine.close_dispatcher()
        except Exception:
            pass

    return results


def _mac_from_snmp(val) -> str:
    """Převede SNMP OctetString na MAC adresu formátu AA:BB:CC:DD:EE:FF."""
    try:
        raw = val.asOctets()
        if len(raw) == 6:
            return ":".join(f"{b:02X}" for b in raw)
    except Exception:
        pass
    # Odstraníme null bytes a neprintovatelné znaky
    return str(val).replace("\x00", "").replace("\u0000", "")


def _sanitize_str(val: str) -> str:
    """Odstraní null bytes a neprintovatelné znaky z řetězce."""
    if not isinstance(val, str):
        return val
    return val.replace("\x00", "").replace("\u0000", "")


async def _collect_snmp_extended(
    ip: str, community: str, port: int = 161, timeout: float = 10.0
) -> dict:
    """
    Sbírá interfaces a ARP tabulku přes standardní SNMP MIBs.

    IF-MIB:
      ifIndex      1.3.6.1.2.1.2.2.1.1
      ifDescr      1.3.6.1.2.1.2.2.1.2   — název rozhraní
      ifType       1.3.6.1.2.1.2.2.1.3
      ifOperStatus 1.3.6.1.2.1.2.2.1.8   — 1=up, 2=down
      ifInOctets   1.3.6.1.2.1.2.2.1.10
      ifOutOctets  1.3.6.1.2.1.2.2.1.16
      ifInErrors   1.3.6.1.2.1.2.2.1.14
      ifOutErrors  1.3.6.1.2.1.2.2.1.20
      ifPhysAddress 1.3.6.1.2.1.2.2.1.6  — MAC

    IP-MIB ARP:
      ipNetToMediaNetAddress  1.3.6.1.2.1.4.22.1.3
      ipNetToMediaPhysAddress 1.3.6.1.2.1.4.22.1.2
      ipNetToMediaType        1.3.6.1.2.1.4.22.1.4  — 3=dynamic, 4=static
    """
    result = {}

    # --- INTERFACES ---
    try:
        # Načteme jednotlivé sloupce tabulky
        descr_rows   = await _snmp_walk(ip, community, "1.3.6.1.2.1.2.2.1.2",  port, timeout)
        status_rows  = await _snmp_walk(ip, community, "1.3.6.1.2.1.2.2.1.8",  port, timeout)
        mac_rows     = await _snmp_walk(ip, community, "1.3.6.1.2.1.2.2.1.6",  port, timeout)
        rxbyte_rows  = await _snmp_walk(ip, community, "1.3.6.1.2.1.2.2.1.10", port, timeout)
        txbyte_rows  = await _snmp_walk(ip, community, "1.3.6.1.2.1.2.2.1.16", port, timeout)
        rxerr_rows   = await _snmp_walk(ip, community, "1.3.6.1.2.1.2.2.1.14", port, timeout)
        txerr_rows   = await _snmp_walk(ip, community, "1.3.6.1.2.1.2.2.1.20", port, timeout)

        # Sestavíme slovníky idx → hodnota
        descr   = {idx: str(v)  for idx, v in descr_rows}
        status  = {idx: int(v)  for idx, v in status_rows  if str(v).isdigit()}
        mac     = {idx: _mac_from_snmp(v) for idx, v in mac_rows}
        rxbyte  = {idx: int(v)  for idx, v in rxbyte_rows  if str(v).isdigit()}
        txbyte  = {idx: int(v)  for idx, v in txbyte_rows  if str(v).isdigit()}
        rxerr   = {idx: int(v)  for idx, v in rxerr_rows   if str(v).isdigit()}
        txerr   = {idx: int(v)  for idx, v in txerr_rows   if str(v).isdigit()}

        result["interfaces"] = [
            {
                "name":      _sanitize_str(descr.get(idx, f"if{idx}")),
                "type":      "",
                "running":   status.get(idx, 2) == 1,
                "disabled":  False,
                "comment":   "",
                "mac":       _sanitize_str(mac.get(idx, "")),
                "mtu":       "",
                "rx_byte":   rxbyte.get(idx, 0),
                "tx_byte":   txbyte.get(idx, 0),
                "rx_packet": 0,
                "tx_packet": 0,
                "rx_error":  rxerr.get(idx, 0),
                "tx_error":  txerr.get(idx, 0),
            }
            for idx in descr
        ]
        log.debug(f"SNMP interfaces {ip}: {len(result['interfaces'])} záznamů")
    except Exception as e:
        log.warning(f"SNMP interfaces {ip}: {e}")

    # --- Vlastní IP adresy (ipAddrTable) ---
    # OID: ipAdEntAddr 1.3.6.1.2.1.4.20.1.1
    try:
        addr_rows  = await _snmp_walk(ip, community, "1.3.6.1.2.1.4.20.1.1", port, timeout)
        iface_rows = await _snmp_walk(ip, community, "1.3.6.1.2.1.4.20.1.2", port, timeout)  # ifIndex
        # Mapujeme ifIndex na název interface
        if_map = {idx: name for idx, name in descr.items()} if "descr" in dir() else {}
        # Sestavíme ifIndex ze suffixu adresy
        addr_iface = {idx: str(v) for idx, v in iface_rows}
        result["own_ips"] = [
            {
                "ip":        str(v),
                "interface": if_map.get(addr_iface.get(idx, ""), addr_iface.get(idx, "")),
                "mac":       None,
                "source":    "snmp_address",
            }
            for idx, v in addr_rows
            if str(v) and not str(v).startswith("127.")
        ]
    except Exception as e:
        log.debug(f"SNMP own IPs: {e}")

    # Přidáme source do ARP záznamů
    # --- ARP tabulka ---
    try:
        mac_rows = await _snmp_walk(ip, community, "1.3.6.1.2.1.4.22.1.2", port, timeout)
        type_rows= await _snmp_walk(ip, community, "1.3.6.1.2.1.4.22.1.4", port, timeout)

        # ARP tabulka — index je "ifIndex.a.b.c.d"
        # IP adresu čteme přímo ze suffixu OID (poslední 4 čísla)
        # Příklad: suffix "16.10.30.30.1" → ifIndex=16, IP=10.30.30.1
        arp_macs = {idx: _mac_from_snmp(v) for idx, v in mac_rows}
        arp_type = {idx: int(v) for idx, v in type_rows if str(v).isdigit()}

        def _suffix_to_ip(suffix: str) -> tuple[str, str]:
            """Převede OID suffix "ifIdx.a.b.c.d" na (ifIdx, "a.b.c.d")."""
            parts = suffix.split(".")
            if len(parts) == 5:  # ifIndex + 4 oktety IP
                return parts[0], ".".join(parts[1:])
            return parts[0] if parts else "", ""

        result["arp"] = []
        for idx in arp_macs:
            if_idx, ip_addr = _suffix_to_ip(idx)
            if not ip_addr:
                continue
            result["arp"].append({
                "ip":        ip_addr,
                "mac":       _sanitize_str(arp_macs.get(idx, "")),
                "interface": if_idx,
                "status":    "dynamic" if arp_type.get(idx, 3) == 3 else "static",
                "complete":  True,
                "invalid":   False,
            })
        log.debug(f"SNMP ARP {ip}: {len(result['arp'])} záznamů")
    except Exception as e:
        log.warning(f"SNMP ARP {ip}: {e}")

    return result


async def _poll_snmp(ip: str, cred: dict, timeout: float = 5.0) -> PollerResult:
    community  = cred.get("_password", "public")
    port       = int(cred.get("port") or 161)
    result     = PollerResult(ip=ip, method="snmp")

    # snmp_host v extra_params — alternativní IP/hostname pro SNMP dotaz
    # Použití: zařízení má WAN IP ale SNMP je dostupné jen přes LAN IP
    extra      = cred.get("extra_params") or {}
    snmp_host  = extra.get("snmp_host", "").strip() if isinstance(extra, dict) else ""
    snmp_host  = snmp_host or ip
    if snmp_host != ip:
        log.info(f"SNMP {ip}: použiji snmp_host={snmp_host} (z extra_params)")

    snmp_timeout = min(timeout, 5.0)
    try:
        vals = await _snmp_get_multi(snmp_host, community, _SNMP_OIDS, port, snmp_timeout)

        # Základní dostupnost
        sysname = vals.get("sysName")
        if not sysname:
            result.error = "SNMP: žádná odpověď nebo špatná community"
            return result

        result.hostname = str(sysname)

        # MIB-2
        if vals.get("sysDescr"):
            result.system_info["sysDescr"] = str(vals["sysDescr"])
            _parse_sysdescr(str(vals["sysDescr"]), result)
        if vals.get("sysContact"):  result.system_info["sysContact"]  = str(vals["sysContact"])
        if vals.get("sysLocation"): result.system_info["sysLocation"] = str(vals["sysLocation"])
        if vals.get("sysUpTime"):
            # TimeTicks = 1/100 sekundy
            ticks = vals["sysUpTime"]
            if isinstance(ticks, int):
                total_s = ticks // 100
                w = total_s // 604800
                d = (total_s % 604800) // 86400
                h = (total_s % 86400) // 3600
                m = (total_s % 3600) // 60
                s = total_s % 60
                if w:
                    uptime_str = f"{w}t {d}d {h}h {m}m"
                elif d:
                    uptime_str = f"{d}d {h}h {m}m"
                else:
                    uptime_str = f"{h}h {m}m {s}s"
            else:
                uptime_str = str(ticks)
            result.uptime   = uptime_str
            result.uptime_s = ticks // 100 if isinstance(ticks, int) else None
            result.system_info["sysUpTime"] = uptime_str

        # MikroTik proprietární
        if vals.get("mtBoardName"):
            result.model = str(vals["mtBoardName"])
        if vals.get("mtFirmwareVersion"):
            result.firmware = str(vals["mtFirmwareVersion"])
        if vals.get("mtSerialNumber"):
            s = vals["mtSerialNumber"]
            # Sériové číslo je hex string z binárních dat
            result.serial = str(s) if s else None
            result.system_info["serial-number"] = result.serial
        if vals.get("mtSoftwareId"):
            result.software_id = str(vals["mtSoftwareId"])
            result.system_info["software-id"] = result.software_id
        if vals.get("mtArchitecture"):
            result.system_info["architecture"] = str(vals["mtArchitecture"])

        # CPU
        if vals.get("mtCpuLoad") is not None:
            result.system_info["cpu-load"] = f"{vals['mtCpuLoad']} %"
        if vals.get("mtCpuFrequency"):
            result.system_info["cpu-frequency"] = f"{vals['mtCpuFrequency']} MHz"
        if vals.get("mtCpuCount"):
            result.system_info["cpu-count"] = str(vals["mtCpuCount"])

        # Paměť
        total_mem = vals.get("mtTotalMemory")
        free_mem  = vals.get("mtFreeMemory")
        if isinstance(total_mem, int) and isinstance(free_mem, int):
            used = total_mem - free_mem
            result.system_info["memory"] = (
                f"{used//1024//1024} MB / {total_mem//1024//1024} MB"
            )
            result.system_info["free-memory"]  = f"{free_mem//1024//1024} MB"
            result.system_info["total-memory"] = f"{total_mem//1024//1024} MB"

        # Storage
        total_hdd = vals.get("mtTotalHdd")
        free_hdd  = vals.get("mtFreeHdd")
        if isinstance(total_hdd, int) and isinstance(free_hdd, int) and total_hdd > 0:
            result.system_info["storage"] = (
                f"{free_hdd//1024//1024} MB volných / {total_hdd//1024//1024} MB"
            )

        # Napětí a teplota
        if isinstance(vals.get("mtVoltage"), int):
            result.system_info["voltage"] = f"{vals['mtVoltage']/10:.1f} V"
        if vals.get("mtTemperature") is not None:
            result.system_info["temperature"] = f"{vals['mtTemperature']} °C"

        # Vendor a typ zařízení
        if result.model:
            result.vendor = "MikroTik"
            dt = _detect_type_from_board(result.model)
            result.device_type_detected = dt
            result.system_info["detected-type"] = dt

        result.success = True
        log.info(
            f"SNMP {ip} OK — hostname={result.hostname} "
            f"model={result.model} fw={result.firmware} serial={result.serial}"
        )

        # Rozšířená data přes SNMP — interfaces + ARP
        try:
            result.extended = await _collect_snmp_extended(
                snmp_host, community, port, timeout=min(timeout, 15.0)
            )
            log.info(
                f"SNMP extended {ip}: "
                f"ifaces={len(result.extended.get('interfaces', []))} "
                f"arp={len(result.extended.get('arp', []))}"
            )
        except Exception as _ee:
            log.warning(f"SNMP extended {ip}: {_ee}")

    except Exception as e:
        import traceback
        result.error = str(e) or traceback.format_exc().splitlines()[-1]
        log.warning(f"SNMP {ip} exception: {result.error}")

    return result


def _detect_type_from_board(board: str) -> str:
    SWITCH_P   = ("CRS", "CSS")
    ROUTER_P   = ("CCR", "RB4011", "RB1100", "RB3011", "RB2011", "CHR")
    WIRELESS_P = ("hAP", "cAP", "wAP", "SXT", "LHG", "QRT", "mANTBox", "OmniTIK")
    if any(board.startswith(p) for p in SWITCH_P):   return "Switch"
    if any(board.startswith(p) for p in ROUTER_P):   return "Router"
    if any(board.startswith(p) for p in WIRELESS_P): return "Wireless"
    return "Router"


# ---------------------------------------------------------------------------
# Metoda 3: SSH
# ---------------------------------------------------------------------------
async def _poll_ssh(ip: str, cred: dict, timeout: float = 15.0) -> PollerResult:
    """
    SSH polling — připojí se a spustí sadu příkazů.
    Detekuje OS a spustí příslušné příkazy.
    """
    result = PollerResult(ip=ip, method="ssh")

    try:
        import asyncssh  # type: ignore
    except ImportError:
        result.error = "asyncssh není nainstalován"
        return result

    username = cred.get("username", "admin")
    password = cred.get("_password", "")
    port     = cred.get("port") or 22

    try:
        conn = await asyncio.wait_for(
            asyncssh.connect(
                ip, port=port,
                username=username,
                password=password,
                known_hosts=None,
                connect_timeout=timeout,
            ),
            timeout=timeout + 2,
        )

        async with conn:
            # Detekce OS — uname
            # Nejdřív zkusíme MikroTik příkazy (nejčastější případ)
            try:
                r = await conn.run(":put [/system identity get name]", timeout=5)
                if r.exit_status == 0 and r.stdout.strip():
                    # Je to MikroTik
                    result.hostname = r.stdout.strip()
                    await _ssh_mikrotik(conn, result)
                else:
                    # Zkusíme uname (Linux)
                    r2 = await conn.run("uname -a", timeout=5)
                    raw = r2.stdout.strip()
                    if raw:
                        result.system_info["uname"] = raw
                        if "linux" in raw.lower():
                            await _ssh_linux(conn, result)
                        else:
                            await _ssh_generic(conn, result)
                    else:
                        # Poslední možnost - generic show version
                        await _ssh_generic(conn, result)
            except Exception as e2:
                result.error = f"SSH příkazy selhaly: {e2}"
                return result

        # Úspěch jen pokud jsme získali aspoň hostname
        if result.hostname:
            result.success = True
            # Snapshot úspěšného SSH přihlášení pro backup engine
            result.successful_auth = {
                "auth_type":       "ssh",
                "credential_id":   cred.get("id"),
                "credential_name": cred.get("name"),
                "username":        cred.get("username", "admin"),
                "port":            int(cred.get("port") or 22),
                "use_ssl":         False,
            }
        else:
            result.error = "SSH: přihlášení OK ale žádná data nezískána"

    except asyncio.TimeoutError:
        result.error = f"SSH timeout ({timeout}s)"
    except Exception as e:
        result.error = str(e)[:200]
        log.debug(f"SSH poll {ip}: {e}")

    return result


async def _ssh_mikrotik(conn, result: PollerResult) -> None:
    """MikroTik SSH příkazy."""
    cmds = [
        (":put [/system identity get name]",          "hostname"),
        (":put [/system resource get version]",       "firmware"),
        (":put [/system resource get board-name]",    "model"),
        (":put [/system resource get uptime]",        "uptime"),
        (":put [/system resource get cpu-load]",      "cpu_load"),
        (":put [/system resource get free-memory]",   "free_memory"),
        (":put [/system resource get total-memory]",  "total_memory"),
    ]
    result.vendor = "MikroTik"
    for cmd, key in cmds:
        try:
            r = await conn.run(cmd, timeout=5)
            val = r.stdout.strip()
            if not val:
                continue
            if key == "hostname": result.hostname = val
            elif key == "firmware": result.firmware = val
            elif key == "model":  result.model    = val
            elif key == "uptime":
                result.uptime   = val
                result.uptime_s = _parse_mikrotik_uptime(val)
            else:
                result.system_info[key] = val
        except Exception:
            pass


async def _ssh_linux(conn, result: PollerResult) -> None:
    """Linux SSH příkazy."""
    result.vendor = "Linux"
    cmds = [
        ("hostname",                         "hostname"),
        ("cat /etc/os-release | head -3",    "os_release"),
        ("uptime -p 2>/dev/null || uptime",  "uptime"),
        ("free -h | head -2",                "memory"),
        ("df -h / | tail -1",                "disk"),
    ]
    for cmd, key in cmds:
        try:
            r = await conn.run(cmd, timeout=5)
            val = r.stdout.strip()
            if not val: continue
            if key == "hostname": result.hostname = val.split(".")[0]
            elif key == "uptime": result.uptime   = val
            else: result.system_info[key] = val[:200]
        except Exception:
            pass


async def _ssh_generic(conn, result: PollerResult) -> None:
    """Generické příkazy pro neznámý OS."""
    for cmd in ["show version", "show system", "display version"]:
        try:
            r = await conn.run(cmd, timeout=5)
            if r.stdout.strip():
                result.system_info["show_version"] = r.stdout.strip()[:500]
                result.raw_output = r.stdout.strip()[:500]
                break
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Metoda 4: HTTP
# ---------------------------------------------------------------------------
async def _poll_http(ip: str, cred: dict, timeout: float = 10.0) -> PollerResult:
    """HTTP/HTTPS polling — GET na konfigurovanou URL."""
    result  = PollerResult(ip=ip, method="http")
    port    = cred.get("port") or 80
    scheme  = "https" if port in (443, 8443) else "http"
    url     = cred.get("extra_params", {}).get("url", f"{scheme}://{ip}:{port}/")

    try:
        import urllib.request
        import ssl as _ssl

        username = cred.get("username", "")
        password = cred.get("_password", "")

        def _fetch():
            ctx = _ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode    = _ssl.CERT_NONE
            req = urllib.request.Request(url)
            if username:
                import base64
                auth = base64.b64encode(f"{username}:{password}".encode()).decode()
                req.add_header("Authorization", f"Basic {auth}")
            with urllib.request.urlopen(req, timeout=timeout, context=ctx) as r:
                return r.read()[:4096].decode("utf-8", errors="ignore"), r.status

        loop = asyncio.get_event_loop()
        body, status = await asyncio.wait_for(
            loop.run_in_executor(None, _fetch), timeout=timeout + 1
        )

        result.system_info["http_status"] = status
        result.system_info["url"]         = url

        # Hledáme title
        m = re.search(r"<title[^>]*>([^<]{1,100})</title>", body, re.IGNORECASE)
        if m:
            result.system_info["title"] = m.group(1).strip()
            result.hostname = m.group(1).strip()[:50]

        result.raw_output = body[:500]
        result.success    = True

    except Exception as e:
        result.error = str(e)[:200]

    return result


# ---------------------------------------------------------------------------
# Vendor routing — priorita metod dle výrobce
# ---------------------------------------------------------------------------

# Výchozí pořadí metod pokud vendor není znám nebo není v mapě
_DEFAULT_PRIORITY = ["api", "snmp", "ssh", "http"]

# Optimální pořadí metod pro konkrétní výrobce
# Klíče jsou lowercase substring — matchuje se v vendor stringu
_VENDOR_PRIORITY: dict[str, list[str]] = {
    "mikrotik":  ["api", "snmp", "ssh"],       # RouterOS API první
    "ubiquiti":  ["ssh", "http", "snmp"],      # Ubiquiti — SSH/UNMS
    "unifi":     ["http", "ssh", "snmp"],      # UniFi Controller
    "cisco":     ["ssh", "snmp"],              # Cisco IOS SSH
    "juniper":   ["ssh", "snmp"],
    "tp-link":   ["http", "ssh", "snmp"],
    "tplink":    ["http", "ssh", "snmp"],
    "asus":      ["http", "ssh", "snmp"],
    "synology":  ["http", "ssh", "snmp"],
    "qnap":      ["http", "ssh", "snmp"],
    "fortinet":  ["ssh", "http", "snmp"],
    "huawei":    ["ssh", "snmp"],
    "linux":     ["ssh", "snmp"],
    "windows":   ["snmp"],
    "hikvision": ["http", "snmp"],
    "dahua":     ["http", "snmp"],
}


def _get_vendor_priority(vendor: str | None) -> list[str]:
    """Vrátí optimální pořadí metod pro daného výrobce."""
    if not vendor:
        return _DEFAULT_PRIORITY
    v = vendor.lower()
    for key, priority in _VENDOR_PRIORITY.items():
        if key in v:
            return priority
    return _DEFAULT_PRIORITY


def _vendor_check(vendor: str | None) -> tuple[bool, str]:
    """
    Zkontroluje zda je vendor nastaven.
    Vrátí (ok, zpráva).
    """
    if not vendor or vendor.strip() == "":
        return False, (
            "Výrobce (vendor) zařízení není nastaven. "
            "Nastavte ho v záložce Základní údaje nebo spusťte Discovery."
        )
    return True, vendor.strip()


async def poll_device(
    ip:           str,
    creds:        list[dict],
    cipher,
    timeout:      float = 15.0,
    vendor:       str | None = None,
    force_single: bool = False,  # True = použij jen zadané creds bez vendor sorting
) -> PollerResult:
    """
    Čte data ze zařízení pomocí přihlašovacích profilů.
    force_single=True: ruční poll s konkrétním profilem — přeskočí vendor priority.
    Pořadí metod se jinak řídí výrobcem (vendor).
    Pokud vendor není nastaven a force_single=False, vrátí chybu s návodem.
    """
    # Kontrola výrobce — přeskočíme při force_single (ruční poll s konkrétním profilem)
    if not force_single:
        vendor_ok, vendor_msg = _vendor_check(vendor)
        if not vendor_ok:
            return PollerResult(
                ip=ip, method="failed",
                error=vendor_msg
            )

    if not creds:
        return PollerResult(ip=ip, method="failed",
                            error="Žádné přihlašovací profily")

    # Dešifrujeme hesla
    decrypted = []
    for cred in creds:
        d = dict(cred)
        d["_password"] = _decrypt(d.get("password_cipher", ""), cipher)
        decrypted.append(d)

    if force_single:
        # Ruční poll — použijeme profily přesně v zadaném pořadí bez sortování
        log.info(
            f"Poll {ip}: ruční poll → {[c['auth_type'] for c in decrypted]} "
            f"({len(decrypted)} profilů)"
        )
    else:
        # Seřadíme dle vendor-specific priority
        priority = _get_vendor_priority(vendor)
        log.info(
            f"Poll {ip}: vendor={vendor} → priorita metod: {priority} "
            f"({len(decrypted)} profilů)"
        )

        def _sort_key(cred: dict) -> int:
            auth = cred["auth_type"]
            return priority.index(auth) if auth in priority else 99

        decrypted.sort(key=_sort_key)

    for cred in decrypted:
        auth_type = cred["auth_type"]
        log.info(f"Poll {ip}: zkouším {auth_type} ({cred.get('name', '?')})")

        try:
            if auth_type == "api":
                result = await _poll_mikrotik_api(ip, cred, timeout)
            elif auth_type == "snmp":
                result = await _poll_snmp(ip, cred, timeout)
            elif auth_type == "ssh":
                result = await _poll_ssh(ip, cred, timeout)
            elif auth_type == "http":
                result = await _poll_http(ip, cred, timeout)
            else:
                continue

            if result.success:
                # Úspěch jen pokud máme aspoň hostname nebo model
                if result.hostname or result.model or result.firmware:
                    log.info(
                        f"Poll {ip}: {auth_type} OK — "
                        f"hostname={result.hostname} model={result.model} "
                        f"firmware={result.firmware}"
                    )
                    # Uložíme ID úspěšného credential profilu pro backup engine
                    result.credential_id = cred.get("id")
                    return result
                else:
                    log.warning(
                        f"Poll {ip}: {auth_type} přihlášení OK ale žádná data — zkouším další metodu"
                    )
                    result.success = False
                    result.error   = "Přihlášení OK ale žádná data nezískána"
            else:
                log.warning(f"Poll {ip}: {auth_type} failed — {result.error}")

        except Exception as e:
            log.error(f"Poll {ip}: {auth_type} exception — {e}")

    # Všechny metody selhaly
    return PollerResult(
        ip=ip, method="failed",
        error=f"Všechny metody selhaly ({len(decrypted)} profilů)"
    )
