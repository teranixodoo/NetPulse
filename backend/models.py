# backend/models.py — Pydantic datové modely

from __future__ import annotations
from pydantic import BaseModel, Field, validator, IPvAnyAddress
from datetime import datetime
from typing import Optional, List, Any
from uuid import uuid4
import re
# ---------------------------------------------------------------------------
# Konfigurace
# ---------------------------------------------------------------------------
class DeviceBase(BaseModel):
    ip: Any
    hostname: Optional[str] = "unknown"
    device_type: Optional[str] = "unknown"
    description: Optional[str] = ""
    alias: Optional[str] = None
    mac: Optional[str] = None
    vendor:        Optional[str] = None
    serial_number: Optional[str] = None
    ownership:     Optional[str] = "isp"
    location_id:   Optional[int] = None
    created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None
    @validator("mac")
    def validate_mac(cls, v):
        if not v: return None
        v = v.upper().replace("-", ":")
        if not re.match(r"^([0-9A-F]{2}:){5}[0-9A-F]{2}$", v):
            raise ValueError("Neplatný formát MAC adresy")
        return v

class DeviceCreate(DeviceBase):
    pass

class Device(DeviceBase):
    id: int
    device_uuid: str  # DŮLEŽITÉ: musí tu být, aby se mohl vrátit v odpovědi
    created_at: datetime
    updated_at: Optional[datetime] = None

    class Config:
        from_attributes = True

class IpRangeModel(BaseModel):
    id:           Optional[int] = None
    label:        str
    network:      str
    active:       bool = True
    scan_enabled: bool = True
    description:  Optional[str] = None
    site_id:      Optional[int] = None


class AppConfigModel(BaseModel):
    # Ping scan
    scan_interval_s: int   = Field(300,  ge=10,    description="Interval ping scanu (s)")
    ping_count:      int   = Field(3,    ge=1, le=10)
    ping_timeout_ms: int   = Field(1000, ge=100, le=10000)
    max_concurrent:  int   = Field(128,  ge=1, le=1000)
    alert_rtt_ms:    float = Field(100.0, ge=0)
    alert_email:     str   = ""
    retention_days:  int   = Field(30, ge=1)
    db_url:          str   = "postgresql://user:pass@localhost/netpulse"
    ranges:          List[IpRangeModel] = []
    # Cleanup scheduler
    cleanup_enabled:        bool = Field(True,  description="Automatické mazání starých dat")
    cleanup_retention_days: int  = Field(30, ge=1, le=365, description="Počet dní pro zachování ping_results")
    cleanup_time:           str  = Field("02:00", description="Čas spuštění cleanup (HH:MM)")
    # Discovery scheduler
    discovery_enabled:    bool = Field(False, description="Discovery scheduler zapnutý")
    discovery_interval_s: int  = Field(3600, ge=60, description="Interval discovery (s)")
    discovery_only_online:bool = Field(True,  description="Jen online zařízení")


# ---------------------------------------------------------------------------
# Výsledky pingů
# ---------------------------------------------------------------------------

class PingResultModel(BaseModel):
    ip:          str
    is_alive:    bool
    rtt_ms:      Optional[float]
    packet_loss: float
    jitter_ms:   Optional[float]
    scanned_at:  datetime


class HostStatsModel(BaseModel):
    ip:            str
    checks:        int
    uptime_pct:    float
    avg_rtt_ms:    Optional[float]
    min_rtt_ms:    Optional[float]
    max_rtt_ms:    Optional[float]
    avg_loss_pct:  float
    last_check:    Optional[datetime]
    currently_alive: bool


class RttTrendPoint(BaseModel):
    ts:          datetime
    rtt_ms:      Optional[float]
    alive:       bool
    packet_loss: float = 0.0


class RttTrendResponse(BaseModel):
    ip:     str
    points: List[RttTrendPoint]


# ---------------------------------------------------------------------------
# Scan
# ---------------------------------------------------------------------------

class ScanStatusModel(BaseModel):
    running:      bool
    is_scanning:  bool = False   # alias pro running — kompatibilita se staršími skripty
    progress:     Optional[int]   # 0–100
    total_ips:    Optional[int]
    done_ips:     Optional[int]
    last_scan:    Optional[datetime]
    scan_count:   int


class TriggerScanResponse(BaseModel):
    status:  str
    message: str


# ---------------------------------------------------------------------------
# Auth
# ---------------------------------------------------------------------------

class LoginRequest(BaseModel):
    username: str
    password: str


class TokenResponse(BaseModel):
    access_token: str
    token_type:   str = "bearer"
    expires_in:   int


class UserModel(BaseModel):
    id:         int
    username:   str
    role:       str
    email:      Optional[str] = None
    active:     bool = True
    created_at: Optional[datetime] = None


class CreateUserRequest(BaseModel):
    username: str
    password: str = Field(min_length=8)
    role:     str = "viewer"
    email:    Optional[str] = None


class UpdateUserRequest(BaseModel):
    role:         Optional[str] = None
    email:        Optional[str] = None
    active:       Optional[bool] = None
    new_password: Optional[str] = None


# ---------------------------------------------------------------------------
# Výpadky
# ---------------------------------------------------------------------------

class OutageEvent(BaseModel):
    ip:         str
    started_at: datetime
    ended_at:   Optional[datetime]
    duration_s: Optional[float]


# ---------------------------------------------------------------------------
# Credentials (trezor přihlašovacích profilů)
# ---------------------------------------------------------------------------

class CredentialCreate(BaseModel):
    name:        str
    auth_type:   str   # ssh | snmp | api | http
    username:    Optional[str] = None
    password:    str
    port:        Optional[int] = None
    extra_params: dict = {}


class Credential(BaseModel):
    id:           int
    name:         str
    auth_type:    str
    username:     Optional[str]
    port:         Optional[int]
    extra_params: dict = {}   # snmp_host, snmp_version atd. — BEZ hesla
    # password_cipher se NIKDY neposílá klientovi

    class Config:
        from_attributes = True


class DeviceWithCredentials(BaseModel):
    """Zařízení včetně přiřazených přihlašovacích profilů."""
    id:            int
    device_uuid:   str
    ip:            Any
    hostname:      str
    mac:           Optional[str]
    device_type:   str
    description:   Optional[str]
    alias:         Optional[str]
    vendor:          Optional[str] = None
    serial_number:   Optional[str] = None
    firmware:        Optional[str] = None
    model:           Optional[str] = None
    last_uptime_s:   Optional[int] = None
    last_uptime_str: Optional[str] = None  # originální textový uptime ze zařízení
    last_polled_at:  Optional[datetime] = None
    last_poll_method: Optional[str] = None
    created_at:      Optional[datetime] = None
    updated_at:      Optional[datetime] = None
    credentials:              List[Credential] = []
    backup_enabled:           Optional[bool] = True
    backup_schedule:          Optional[str]  = None
    last_successful_credential_id: Optional[int] = None
    cron_poll:                Optional[bool]  = False
    ownership:                Optional[str]   = "isp"
    location_id:              Optional[int]   = None
    location_name:            Optional[str]   = None
    location_path:            Optional[str]   = None  # plná cesta hierarchií: "Budova > Patro > Místnost"
    is_alive:                 Optional[bool]  = None

    class Config:
        from_attributes = True

# ===========================================================================
# Topologie — kabely, vlákna, sváry, spoje
# ===========================================================================

class ConnectionTypeModel(BaseModel):
    id:         Optional[int]  = None
    name:       str
    category:   str            = "cable"   # cable | wireless
    color:      str            = "#3b82f6"
    dash_style: str            = "solid"
    icon:       Optional[str]  = None
    sort_order: int            = 0
    active:     bool           = True

class CableModel(BaseModel):
    id:             Optional[int]   = None
    name:           str
    cable_type:     str             # fiber | utp | coax
    medium:         Optional[str]   = None
    fiber_count:    Optional[int]   = None
    length_m:       Optional[float] = None
    route:          Optional[Any]   = None  # JSONB [[lng,lat],...]
    location_a_id:  Optional[int]   = None
    location_b_id:  Optional[int]   = None
    installed_at:   Optional[str]   = None
    status:         str             = "active"
    notes:          Optional[str]   = None
    external_id:    Optional[str]   = None
    created_at:     Optional[datetime] = None
    date_modified:  Optional[datetime] = None

class FiberModel(BaseModel):
    id:           Optional[int]  = None
    cable_id:     int
    fiber_number: int
    color:        Optional[str]  = None
    status:       str            = "free"
    notes:        Optional[str]  = None

class SpliceModel(BaseModel):
    id:             Optional[int]   = None
    fiber_a_id:     Optional[int]   = None
    fiber_b_id:     Optional[int]   = None
    splice_type:    str             = "fusion"
    location_id:    Optional[int]   = None
    attenuation_db: Optional[float] = None
    orl_db:         Optional[float] = None
    test_date:      Optional[str]   = None
    otdr_notes:     Optional[str]   = None
    notes:          Optional[str]   = None
    created_at:     Optional[datetime] = None
    date_modified:  Optional[datetime] = None

class ConnectionModel(BaseModel):
    id:                 Optional[int]   = None
    name:               Optional[str]   = None
    connection_type_id: Optional[int]   = None
    cable_id:           Optional[int]   = None
    fiber_id:           Optional[int]   = None
    device_a_id:        Optional[int]   = None
    interface_a:        Optional[str]   = None
    location_a_id:      Optional[int]   = None
    device_b_id:        Optional[int]   = None
    interface_b:        Optional[str]   = None
    location_b_id:      Optional[int]   = None
    # Wireless
    frequency_ghz:      Optional[float] = None
    technology:         Optional[str]   = None
    ssid:               Optional[str]   = None
    azimuth_a:          Optional[float] = None
    azimuth_b:          Optional[float] = None
    height_a_m:         Optional[float] = None
    height_b_m:         Optional[float] = None
    tx_power_dbm:       Optional[float] = None
    rx_sensitivity_dbm: Optional[float] = None
    antenna_gain_dbi:   Optional[float] = None
    distance_m:         Optional[float] = None
    # Live
    current_signal_dbm: Optional[float] = None
    current_snr_db:     Optional[float] = None
    last_polled_at:     Optional[datetime] = None
    # Meta
    status:             str             = "active"
    installed_at:       Optional[str]   = None
    notes:              Optional[str]   = None
    external_id:        Optional[str]   = None
    created_at:         Optional[datetime] = None
    date_modified:      Optional[datetime] = None
