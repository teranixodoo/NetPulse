# backend/discovery.py — Rozšířený vrstvený discovery engine
#
# Vrstva 1:  Reverzní DNS (rDNS)
# Vrstva 2:  ARP → MAC adresa
# Vrstva 3:  OUI lookup → výrobce
# Vrstva 4:  TCP port scan
# Vrstva 5:  Banner grabbing (SSH, FTP, SMTP, Telnet...)
# Vrstva 6:  HTTP/HTTPS fingerprinting
# Vrstva 7:  TLS certifikát (CN, SAN, org, platnost)
# Vrstva 8:  SNMP public (sysDescr, sysName, sysUpTime...)
# Vrstva 9:  NetBIOS/SMB (Windows hostname, workgroup)
# Vrstva 10: mDNS/Bonjour (Apple, IoT, tiskárny)

from __future__ import annotations
import asyncio
import logging
import re
import socket
import ssl
import struct
from dataclasses import dataclass, field
from typing import Optional

log = logging.getLogger("netpulse.discovery")


# ---------------------------------------------------------------------------
# Výsledek discovery
# ---------------------------------------------------------------------------
@dataclass
class DiscoveryResult:
    ip:           str
    hostname:     Optional[str] = None
    mac:          Optional[str] = None
    vendor:       Optional[str] = None
    device_type:  Optional[str] = None
    description:  Optional[str] = None
    open_ports:   list          = field(default_factory=list)
    services:     dict          = field(default_factory=dict)
    notes:        list          = field(default_factory=list)

    # TLS
    tls_cn:       Optional[str] = None
    tls_org:      Optional[str] = None
    tls_sans:     list          = field(default_factory=list)
    tls_expiry:   Optional[str] = None
    tls_issuer:   Optional[str] = None

    # SNMP
    snmp_sysname:   Optional[str] = None
    snmp_sysdescr:  Optional[str] = None
    snmp_uptime:    Optional[str] = None
    snmp_contact:   Optional[str] = None
    snmp_location:  Optional[str] = None

    # NetBIOS
    netbios_name:   Optional[str] = None
    netbios_domain: Optional[str] = None

    # mDNS
    mdns_name:      Optional[str] = None
    mdns_services:  list          = field(default_factory=list)

    # HTTP
    http_title:      Optional[str] = None
    http_server:     Optional[str] = None
    http_powered_by: Optional[str] = None
    http_status:     Optional[int] = None

    def to_device_patch(self) -> dict:
        """Vrátí jen pole která se mají přepsat v devices tabulce.
        Hostname se záměrně nepřepisuje — uživatel ho zadal ručně."""
        patch = {}
        # Hostname nepřepisujeme — discovery zjišťuje rDNS/NetBIOS/SNMP sysname,
        # ale ty jsou pouze informativní a neměly by přepisovat uživatelský název.
        # Hodnoty jsou viditelné v discovery logu (layers).
        if self.mac:
            patch["mac"] = self.mac
        if self.vendor:
            patch["vendor"] = self.vendor
        if self.device_type and self.device_type != "unknown":
            patch["device_type"] = self.device_type
        desc_parts = []
        if self.snmp_sysdescr:
            desc_parts.append(self.snmp_sysdescr[:80])
        elif self.http_server:
            desc_parts.append(f"HTTP: {self.http_server}")
        if self.snmp_location:
            desc_parts.append(f"Umístění: {self.snmp_location}")
        if self.tls_cn:
            desc_parts.append(f"TLS: {self.tls_cn}")
        if desc_parts:
            patch["description"] = " | ".join(desc_parts)
        return patch

    def to_layers_list(self) -> list:
        return [
            {"layer": "rDNS",     "ok": bool(self.hostname),
             "result": self.hostname or "",
             "note": "Reverzní DNS záznam"},
            {"layer": "ARP",      "ok": bool(self.mac),
             "result": self.mac or "",
             "note": "MAC adresa z ARP cache"},
            {"layer": "OUI",      "ok": bool(self.vendor),
             "result": self.vendor or "",
             "note": "Výrobce z MAC prefixu"},
            {"layer": "Port scan","ok": bool(self.open_ports),
             "result": str(self.open_ports),
             "note": f"{len(self.open_ports)} otevřených portů"},
            {"layer": "Banner",   "ok": bool(self.services),
             "result": "; ".join(f":{p} {v}" for p, v in self.services.items()),
             "note": "Bannery služeb"},
            {"layer": "HTTP",     "ok": bool(self.http_server or self.http_title),
             "result": self.http_server or self.http_title or "",
             "note": f"HTTP {self.http_status or ''} | {self.http_title or ''}"},
            {"layer": "TLS",      "ok": bool(self.tls_cn),
             "result": self.tls_cn or "",
             "note": f"Org: {self.tls_org or '—'} | Expiry: {self.tls_expiry or '—'}"},
            {"layer": "SNMP",     "ok": bool(self.snmp_sysname or self.snmp_sysdescr),
             "result": self.snmp_sysname or "",
             "note": (self.snmp_sysdescr or "")[:100]},
            {"layer": "NetBIOS",  "ok": bool(self.netbios_name),
             "result": self.netbios_name or "",
             "note": f"Domain: {self.netbios_domain or '—'}"},
            {"layer": "mDNS",     "ok": bool(self.mdns_name),
             "result": self.mdns_name or "",
             "note": ", ".join(self.mdns_services)},
        ]


# ---------------------------------------------------------------------------
# Vrstva 1: Reverzní DNS
# ---------------------------------------------------------------------------
async def layer_rdns(ip: str, result: DiscoveryResult) -> None:
    try:
        loop = asyncio.get_event_loop()
        hostname = await asyncio.wait_for(
            loop.run_in_executor(None, lambda: socket.gethostbyaddr(ip)[0]),
            timeout=3.0,
        )
        if hostname and hostname != ip:
            result.hostname = hostname
            result.notes.append(f"rDNS: {hostname}")
    except Exception:
        result.notes.append("rDNS: žádný záznam")


# ---------------------------------------------------------------------------
# Vrstva 2: ARP
# ---------------------------------------------------------------------------
def _read_arp_cache(ip: str) -> Optional[str]:
    try:
        with open("/proc/net/arp") as f:
            for line in f:
                parts = line.split()
                if len(parts) >= 4 and parts[0] == ip:
                    mac = parts[3].upper()
                    if mac not in ("00:00:00:00:00:00", ""):
                        return mac
    except Exception:
        pass
    return None


async def layer_arp(ip: str, result: DiscoveryResult) -> None:
    mac = _read_arp_cache(ip)
    if not mac:
        try:
            proc = await asyncio.create_subprocess_exec(
                "ping", "-c", "1", "-W", "1", ip,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
            )
            await asyncio.wait_for(proc.wait(), timeout=2.0)
        except Exception:
            pass
        await asyncio.sleep(0.3)
        mac = _read_arp_cache(ip)
    if mac:
        result.mac = mac
        result.notes.append(f"ARP MAC: {mac}")
    else:
        result.notes.append("ARP: MAC nenalezena")


# ---------------------------------------------------------------------------
# Vrstva 3: OUI lookup
# ---------------------------------------------------------------------------
_OUI_TABLE: dict = {
    "00:00:0C": "Cisco",        "00:1A:A1": "Cisco",       "58:97:BD": "Cisco",
    "00:17:94": "Cisco",        "B8:27:EB": "Raspberry Pi","DC:A6:32": "Raspberry Pi",
    "E4:5F:01": "Raspberry Pi", "D8:3A:DD": "Raspberry Pi","00:50:56": "VMware",
    "00:0C:29": "VMware",       "08:00:27": "VirtualBox",  "52:54:00": "QEMU/KVM",
    "00:1B:21": "Intel",        "8C:8D:28": "Intel",       "00:E0:4C": "Realtek",
    "00:23:24": "Apple",        "3C:22:FB": "Apple",       "A4:C3:F0": "Apple",
    "F0:18:98": "Apple",        "00:26:B9": "Dell",        "18:DB:F2": "Dell",
    "14:18:77": "Dell",         "FC:F8:AE": "Ubiquiti",    "00:27:22": "Ubiquiti",
    "24:A4:3C": "Ubiquiti",     "DC:9F:DB": "Ubiquiti",    "00:15:6D": "Ubiquiti",
    "80:2A:A8": "Ubiquiti",     "B4:FB:E4": "MikroTik",   "CC:2D:E0": "MikroTik",
    "6C:3B:6B": "MikroTik",     "2C:C8:1B": "MikroTik",   "E4:8D:8C": "MikroTik",
    "48:8F:5A": "MikroTik",     "D4:CA:6D": "MikroTik",   "74:4D:28": "MikroTik",
    "00:0D:B9": "PC Engines",   "00:08:A2": "TP-Link",     "54:C8:0F": "TP-Link",
    "EC:08:6B": "TP-Link",      "50:C7:BF": "TP-Link",     "A0:F3:C1": "TP-Link",
    "00:1D:0F": "NETGEAR",      "C0:3F:0E": "NETGEAR",     "00:90:4C": "HP",
    "3C:D9:2B": "HP",           "00:30:C1": "Synology",    "00:11:32": "Synology",
    "00:08:9B": "D-Link",       "1C:7E:E5": "D-Link",      "AC:22:0B": "ASRock",
    "00:1C:42": "Parallels",    "00:50:43": "Hikvision",   "BC:AD:28": "Hikvision",
    "44:19:B6": "Dahua",        "3C:EF:8C": "Dahua",       "00:40:8C": "Axis",
    "00:06:61": "Hanwha",       "00:09:18": "HP/Aruba",    "00:1A:1E": "Aruba",
    "70:3A:CB": "Huawei",       "6C:92:BF": "Huawei",      "00:E0:FC": "Huawei",
    "00:18:E7": "Juniper",      "2C:6B:F5": "Juniper",
}


def _lookup_oui(mac: str) -> Optional[str]:
    if not mac:
        return None
    prefix = mac[:8].upper()
    if prefix in _OUI_TABLE:
        return _OUI_TABLE[prefix]
    raw = mac.replace(":", "").replace("-", "").upper()[:6]
    for key, vendor in _OUI_TABLE.items():
        if key.replace(":", "").upper() == raw:
            return vendor
    return None


async def layer_oui(ip: str, result: DiscoveryResult) -> None:
    if not result.mac:
        return
    vendor = _lookup_oui(result.mac)
    if vendor:
        result.vendor = vendor
        result.notes.append(f"OUI: {vendor}")
    else:
        result.notes.append(f"OUI: neznámý ({result.mac[:8]})")


# ---------------------------------------------------------------------------
# Vrstva 4: TCP port scan
# ---------------------------------------------------------------------------
_SCAN_PORTS = [
    21, 22, 23, 25, 53, 80, 110, 143, 161, 389, 443,
    445, 465, 587, 631, 993, 995, 2049, 3306, 3389,
    5432, 5900, 554, 8000, 8080, 8291, 8443, 8728, 8729,
    9100, 34567, 37777, 49152,
]

_PORT_SIGNATURES = [
    ({8728, 8291},   "Router",        "MikroTik"),
    ({8728, 8729},   "Router",        "MikroTik API"),
    ({23},           "Router/Switch", "Telnet"),
    ({554},          "IP Kamera",     "RTSP"),
    ({37777},        "IP Kamera",     "Dahua"),
    ({9100},         "Tiskárna",      "RAW print"),
    ({631},          "Tiskárna",      "IPP"),
    ({3389},         "Počítač",       "RDP"),
    ({5900},         "Počítač",       "VNC"),
    ({445, 3389},    "Počítač",       "Windows"),
    ({445},          "Počítač/NAS",   "SMB"),
    ({2049},         "NAS/Server",    "NFS"),
    ({3306},         "Server",        "MySQL"),
    ({5432},         "Server",        "PostgreSQL"),
    ({25, 587},      "Mail server",   "SMTP"),
    ({22},           "Server",        "SSH"),
]


async def _try_port(ip: str, port: int, timeout: float = 0.8) -> bool:
    try:
        _, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=timeout
        )
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        return True
    except Exception:
        return False


async def layer_portscan(ip: str, result: DiscoveryResult) -> None:
    tasks  = [_try_port(ip, port) for port in _SCAN_PORTS]
    status = await asyncio.gather(*tasks, return_exceptions=True)
    result.open_ports = [p for p, ok in zip(_SCAN_PORTS, status) if ok is True]

    if not result.open_ports:
        result.notes.append("Port scan: žádné otevřené porty")
        return
    result.notes.append(f"Porty: {result.open_ports}")

    open_set = set(result.open_ports)
    best_type, best_score = None, 0
    for sig_ports, dev_type, hint in _PORT_SIGNATURES:
        score = len(sig_ports & open_set)
        if score > 0 and score >= len(sig_ports) and score > best_score:
            best_score = score
            best_type  = dev_type
    if best_type and (not result.device_type or result.device_type == "unknown"):
        result.device_type = best_type
        result.notes.append(f"Typ dle portů: {best_type}")


# ---------------------------------------------------------------------------
# Vrstva 5: Banner grabbing
# ---------------------------------------------------------------------------
_BANNER_PORTS = [22, 21, 23, 25, 110, 143, 8728]


async def _grab_banner_raw(ip: str, port: int, timeout: float = 2.0) -> Optional[str]:
    try:
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(ip, port), timeout=timeout
        )
        data = await asyncio.wait_for(reader.read(1024), timeout=timeout)
        writer.close()
        text = data.decode("utf-8", errors="ignore").strip()
        return text[:200] if text else None
    except Exception:
        return None


async def layer_banner(ip: str, result: DiscoveryResult) -> None:
    tasks = {
        port: _grab_banner_raw(ip, port)
        for port in result.open_ports
        if port in _BANNER_PORTS
    }
    if not tasks:
        return
    banners = await asyncio.gather(*tasks.values(), return_exceptions=True)
    for port, banner in zip(tasks.keys(), banners):
        if not isinstance(banner, str) or not banner:
            continue
        first = banner.split("\n")[0].strip()[:80]
        result.services[port] = first
        result.notes.append(f"Banner :{port} → {first}")
        low = first.lower()
        if port == 22:
            if "mikrotik" in low:
                result.vendor      = result.vendor or "MikroTik"
                result.device_type = result.device_type or "Router"
            elif "dropbear" in low:
                result.notes.append("SSH: Dropbear (embedded Linux)")
        elif port == 21 and "proftpd" in low:
            result.services[port] = first


# ---------------------------------------------------------------------------
# Vrstva 6: HTTP/HTTPS fingerprinting
# ---------------------------------------------------------------------------
async def _http_get(ip: str, port: int, use_ssl: bool = False,
                    timeout: float = 4.0) -> Optional[str]:
    try:
        if use_ssl:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode    = ssl.CERT_NONE
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port, ssl=ctx), timeout=timeout
            )
        else:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(ip, port), timeout=timeout
            )
        host = f"{ip}:{port}" if port not in (80, 443) else ip
        req  = (
            f"GET / HTTP/1.1\r\nHost: {host}\r\n"
            f"User-Agent: NetPulse-Discovery/2.0\r\n"
            f"Accept: text/html,*/*\r\nConnection: close\r\n\r\n"
        ).encode()
        writer.write(req)
        await writer.drain()
        data = await asyncio.wait_for(reader.read(8192), timeout=timeout)
        writer.close()
        return data.decode("utf-8", errors="ignore")
    except Exception:
        return None


def _parse_http(raw: str, result: DiscoveryResult) -> None:
    if not raw:
        return
    lines = raw.split("\r\n")
    # Status
    if lines and lines[0].startswith("HTTP"):
        try:
            result.http_status = int(lines[0].split()[1])
        except Exception:
            pass
    # Headers
    for line in lines[1:]:
        if not line:
            break
        low = line.lower()
        if low.startswith("server:"):
            result.http_server = line.split(":", 1)[1].strip()[:80]
        elif low.startswith("x-powered-by:"):
            result.http_powered_by = line.split(":", 1)[1].strip()[:60]
    # Title
    body = raw[raw.find("\r\n\r\n")+4:] if "\r\n\r\n" in raw else ""
    m = re.search(r"<title[^>]*>([^<]{1,120})</title>", body, re.IGNORECASE)
    if m:
        result.http_title = m.group(1).strip()
    # Fingerprint
    srv = (result.http_server or "").lower()
    ttl = (result.http_title   or "").lower()
    for keyword, vendor, dtype in [
        ("mikrotik",  "MikroTik",  "Router"),
        ("routeros",  "MikroTik",  "Router"),
        ("openwrt",   "OpenWrt",   "Router"),
        ("dd-wrt",    "DD-WRT",    "Router"),
        ("hikvision", "Hikvision", "IP Kamera"),
        ("dahua",     "Dahua",     "IP Kamera"),
        ("axis",      "Axis",      "IP Kamera"),
        ("synology",  "Synology",  "NAS/Server"),
        ("qnap",      "QNAP",      "NAS/Server"),
        ("ubiquiti",  "Ubiquiti",  "AP"),
        ("unifi",     "Ubiquiti",  "AP"),
        ("cisco",     "Cisco",     "Router"),
        ("fortigate", "Fortinet",  "Router"),
        ("pfsense",   "pfSense",   "Router"),
        ("proxmox",   "Proxmox",   "Server"),
        ("vmware",    "VMware",    "Server"),
    ]:
        if keyword in srv or keyword in ttl:
            result.vendor      = result.vendor      or vendor
            result.device_type = result.device_type or dtype


async def layer_http(ip: str, result: DiscoveryResult) -> None:
    http_ports  = [p for p in result.open_ports if p in (80, 8080, 8000, 8888)]
    https_ports = [p for p in result.open_ports if p in (443, 8443)]

    for port in http_ports:
        raw = await _http_get(ip, port, use_ssl=False)
        if raw:
            _parse_http(raw, result)
            result.notes.append(
                f"HTTP :{port} → {result.http_status} | "
                f"Server: {result.http_server or '—'} | "
                f"Title: {result.http_title or '—'}"
            )
            break
    for port in https_ports:
        raw = await _http_get(ip, port, use_ssl=True)
        if raw:
            _parse_http(raw, result)
            result.notes.append(
                f"HTTPS :{port} → {result.http_status} | "
                f"Server: {result.http_server or '—'}"
            )
            break


# ---------------------------------------------------------------------------
# Vrstva 7: TLS certifikát
# ---------------------------------------------------------------------------
async def layer_tls(ip: str, result: DiscoveryResult) -> None:
    tls_ports = [p for p in result.open_ports if p in (443, 8443, 993, 995, 465)]
    if not tls_ports:
        return

    for port in tls_ports:
        try:
            ctx = ssl.create_default_context()
            ctx.check_hostname = False
            ctx.verify_mode    = ssl.CERT_NONE
            loop = asyncio.get_event_loop()

            def _get_cert():
                sock  = socket.create_connection((ip, port), timeout=3)
                ssock = ctx.wrap_socket(sock, server_hostname=ip)
                cert  = ssock.getpeercert()
                ssock.close()
                return cert

            cert = await asyncio.wait_for(
                loop.run_in_executor(None, _get_cert), timeout=5.0
            )
            if not cert:
                continue

            for fl in cert.get("subject", []):
                for k, v in fl:
                    if k == "commonName":
                        result.tls_cn = v
                    elif k == "organizationName":
                        result.tls_org = v

            for fl in cert.get("issuer", []):
                for k, v in fl:
                    if k == "organizationName":
                        result.tls_issuer = v

            result.tls_sans   = [f"{t}:{v}" for t, v in cert.get("subjectAltName", [])]
            result.tls_expiry = cert.get("notAfter")

            if result.tls_cn and not result.hostname and not result.tls_cn.startswith("*"):
                result.hostname = result.tls_cn

            result.notes.append(
                f"TLS CN: {result.tls_cn or '—'} | "
                f"Org: {result.tls_org or '—'} | "
                f"Expiry: {result.tls_expiry or '—'}"
            )
            break
        except Exception as e:
            result.notes.append(f"TLS :{port} → {str(e)[:50]}")


# ---------------------------------------------------------------------------
# Vrstva 8: SNMP (vlastní UDP implementace, bez pysnmp)
# ---------------------------------------------------------------------------
def _encode_oid(oid_str: str) -> bytes:
    parts   = [int(x) for x in oid_str.split(".")]
    encoded = bytes([40 * parts[0] + parts[1]])
    for part in parts[2:]:
        if part < 128:
            encoded += bytes([part])
        else:
            chunks = []
            while part:
                chunks.append(part & 0x7F)
                part >>= 7
            chunks.reverse()
            for i, c in enumerate(chunks):
                encoded += bytes([c | (0x80 if i < len(chunks) - 1 else 0)])
    return encoded


def _build_snmp_get(community: str, oid_str: str) -> bytes:
    oid_bytes    = _encode_oid(oid_str)
    oid_tlv      = b"\x06" + bytes([len(oid_bytes)]) + oid_bytes
    varbind      = b"\x30" + bytes([len(oid_tlv) + 2]) + oid_tlv + b"\x05\x00"
    varbind_list = b"\x30" + bytes([len(varbind)]) + varbind
    pdu_inner    = b"\x02\x04\x00\x00\x00\x01\x02\x01\x00\x02\x01\x00" + varbind_list
    pdu          = b"\xa0" + bytes([len(pdu_inner)]) + pdu_inner
    comm         = community.encode()
    comm_tlv     = b"\x04" + bytes([len(comm)]) + comm
    msg          = b"\x02\x01\x01" + comm_tlv + pdu
    return b"\x30" + bytes([len(msg)]) + msg


def _parse_snmp_octet(data: bytes) -> Optional[str]:
    try:
        # Hledáme OctetString (0x04) v odpovědi
        for i in range(len(data) - 2):
            if data[i] == 0x04:
                length = data[i + 1]
                if length & 0x80:
                    nb     = length & 0x7F
                    length = int.from_bytes(data[i+2:i+2+nb], "big")
                    val    = data[i+2+nb:i+2+nb+length]
                else:
                    val = data[i+2:i+2+length]
                text = val.decode("utf-8", errors="ignore").strip()
                if text and len(text) > 1:
                    return text
    except Exception:
        pass
    return None


async def _snmp_get(ip: str, community: str, oid: str,
                    timeout: float = 2.0) -> Optional[str]:
    try:
        loop   = asyncio.get_event_loop()
        packet = _build_snmp_get(community, oid)

        def _udp():
            sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            sock.settimeout(timeout)
            try:
                sock.sendto(packet, (ip, 161))
                data, _ = sock.recvfrom(4096)
                return data
            finally:
                sock.close()

        data = await asyncio.wait_for(
            loop.run_in_executor(None, _udp), timeout=timeout + 0.5
        )
        return _parse_snmp_octet(data)
    except Exception:
        return None


async def layer_snmp(ip: str, result: DiscoveryResult) -> None:
    OIDS = {
        "sysName":    "1.3.6.1.2.1.1.5.0",
        "sysDescr":   "1.3.6.1.2.1.1.1.0",
        "sysContact": "1.3.6.1.2.1.1.4.0",
        "sysLocation":"1.3.6.1.2.1.1.6.0",
    }
    for community in ("public", "private", "community"):
        sysname = await _snmp_get(ip, community, OIDS["sysName"])
        if not sysname:
            continue
        result.snmp_sysname = sysname
        if not result.hostname:
            result.hostname = sysname

        vals = await asyncio.gather(
            _snmp_get(ip, community, OIDS["sysDescr"]),
            _snmp_get(ip, community, OIDS["sysContact"]),
            _snmp_get(ip, community, OIDS["sysLocation"]),
            return_exceptions=True,
        )
        if isinstance(vals[0], str):
            result.snmp_sysdescr = vals[0][:120]
            sd = result.snmp_sysdescr.lower()
            for kw, v, t in [
                ("mikrotik",  "MikroTik",  "Router"),
                ("routeros",  "MikroTik",  "Router"),
                ("cisco",     "Cisco",     "Router"),
                ("linux",     None,        "Server"),
                ("windows",   None,        "Počítač"),
                ("synology",  "Synology",  "NAS/Server"),
                ("fortinet",  "Fortinet",  "Router"),
                ("juniper",   "Juniper",   "Router"),
            ]:
                if kw in sd:
                    if v: result.vendor = result.vendor or v
                    result.device_type  = result.device_type or t
                    break
        if isinstance(vals[1], str): result.snmp_contact  = vals[1]
        if isinstance(vals[2], str): result.snmp_location = vals[2]

        result.notes.append(
            f"SNMP ({community}): sysName={sysname} | "
            f"sysDescr={result.snmp_sysdescr or '—'} | "
            f"Location={result.snmp_location or '—'}"
        )
        break


# ---------------------------------------------------------------------------
# Vrstva 9: NetBIOS (UDP 137)
# ---------------------------------------------------------------------------
def _build_netbios_ns_query() -> bytes:
    tid    = b"\xAB\xCD"
    flags  = b"\x00\x00"
    qdcnt  = b"\x00\x01"
    rest   = b"\x00\x00\x00\x00\x00\x00"
    # Wildcard name "*" v NetBIOS encoding (32 bajtů)
    name   = b"\x20" + b"CKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" + b"\x00"
    qtype  = b"\x00\x21"   # NBSTAT
    qclass = b"\x00\x01"   # IN
    return tid + flags + qdcnt + rest + name + qtype + qclass


def _parse_netbios_resp(data: bytes):
    try:
        if len(data) < 57:
            return None, None
        num   = data[56]
        off   = 57
        hostname = domain = None
        for _ in range(num):
            if off + 18 > len(data):
                break
            raw   = data[off:off+15].decode("ascii", errors="ignore").strip()
            ntype = data[off+15]
            flags = int.from_bytes(data[off+16:off+18], "big")
            if ntype == 0x00 and not (flags & 0x8000) and raw:
                hostname = raw
            elif ntype == 0x1E and raw:
                domain = raw
            off += 18
        return hostname, domain
    except Exception:
        return None, None


async def layer_netbios(ip: str, result: DiscoveryResult) -> None:
    try:
        loop   = asyncio.get_event_loop()
        packet = _build_netbios_ns_query()

        def _udp():
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(2.0)
            try:
                s.sendto(packet, (ip, 137))
                data, _ = s.recvfrom(1024)
                return data
            finally:
                s.close()

        data = await asyncio.wait_for(
            loop.run_in_executor(None, _udp), timeout=3.0
        )
        hostname, domain = _parse_netbios_resp(data)
        if hostname:
            result.netbios_name   = hostname
            result.netbios_domain = domain
            result.device_type    = result.device_type or "Počítač"
            if not result.hostname:
                result.hostname = hostname
            result.notes.append(
                f"NetBIOS: {hostname}"
                + (f" (doména: {domain})" if domain else "")
            )
        else:
            result.notes.append("NetBIOS: žádná odpověď")
    except Exception:
        result.notes.append("NetBIOS: timeout nebo filtrováno")


# ---------------------------------------------------------------------------
# Vrstva 10: mDNS (unicast na port 5353)
# ---------------------------------------------------------------------------
def _build_mdns_query(name: str) -> bytes:
    header  = b"\x00\x00\x00\x00\x00\x01\x00\x00\x00\x00\x00\x00"
    encoded = b""
    for part in name.split("."):
        if part:
            encoded += bytes([len(part)]) + part.encode()
    encoded += b"\x00"
    return header + encoded + b"\x00\x0c\x80\x01"  # PTR, QU


async def layer_mdns(ip: str, result: DiscoveryResult) -> None:
    queries = [
        _build_mdns_query("_services._dns-sd._udp.local"),
        _build_mdns_query("_http._tcp.local"),
        _build_mdns_query("_ssh._tcp.local"),
        _build_mdns_query("_workstation._tcp.local"),
        _build_mdns_query("_printer._tcp.local"),
        _build_mdns_query("_ipp._tcp.local"),
        _build_mdns_query("_smb._tcp.local"),
    ]
    try:
        loop     = asyncio.get_event_loop()
        received = []

        def _udp():
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(1.5)
            try:
                for q in queries:
                    try:
                        s.sendto(q, (ip, 5353))
                    except Exception:
                        pass
                for _ in range(10):
                    try:
                        data, _ = s.recvfrom(2048)
                        received.append(data)
                    except Exception:
                        break
            finally:
                s.close()

        await asyncio.wait_for(
            loop.run_in_executor(None, _udp), timeout=4.0
        )

        if not received:
            result.notes.append("mDNS: žádná odpověď")
            return

        name_found = None
        svcs       = []
        for data in received:
            text = data.decode("ascii", errors="ignore")
            for n in re.findall(r"([a-zA-Z0-9][a-zA-Z0-9\-]{1,30}\.local)", text):
                if n not in ("services.local", "dns-sd.local"):
                    name_found = n.replace(".local", "")
                    break
            for svc in re.findall(r"_[a-z][a-z0-9\-]+\._tcp", text):
                if svc not in svcs:
                    svcs.append(svc)

        if name_found:
            result.mdns_name = name_found
            if not result.hostname:
                result.hostname = name_found
        result.mdns_services = svcs

        # Detekce dle služeb
        svc_str = " ".join(svcs)
        if "_printer._tcp" in svc_str or "_ipp._tcp" in svc_str:
            result.device_type = result.device_type or "Tiskárna"
        if "_afpovertcp._tcp" in svc_str or "_adisk._tcp" in svc_str:
            result.vendor      = result.vendor or "Apple"
            result.device_type = result.device_type or "NAS/Server"
        if "_smb._tcp" in svc_str:
            result.device_type = result.device_type or "Počítač/NAS"

        result.notes.append(
            f"mDNS: {name_found or '—'} | Služby: {', '.join(svcs) or '—'}"
        )
    except Exception as e:
        result.notes.append(f"mDNS: {str(e)[:40]}")


# ---------------------------------------------------------------------------
# Hlavní entry point
# ---------------------------------------------------------------------------
async def run_discovery(ip: str) -> DiscoveryResult:
    log.info(f"Discovery zahájen: {ip}")
    result = DiscoveryResult(ip=ip)

    # 1-3: sekvenčně (každá závisí na předchozí)
    await layer_rdns(ip, result)
    await layer_arp(ip, result)
    await layer_oui(ip, result)

    # 4: port scan (nutný před 5-7)
    await layer_portscan(ip, result)

    # 5-7: paralelně (závisejí na portech)
    await asyncio.gather(
        layer_banner(ip, result),
        layer_http(ip, result),
        layer_tls(ip, result),
        return_exceptions=True,
    )

    # 8-10: paralelně (nezávislé)
    await asyncio.gather(
        layer_snmp(ip, result),
        layer_netbios(ip, result),
        layer_mdns(ip, result),
        return_exceptions=True,
    )

    log.info(
        f"Discovery hotov: {ip} | hostname={result.hostname} "
        f"mac={result.mac} vendor={result.vendor} "
        f"type={result.device_type} ports={result.open_ports}"
    )
    return result
