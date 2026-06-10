// lib/types.ts — TypeScript typy odpovídající FastAPI modelům

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export interface LoginRequest {
  username: string;
  password: string;
}

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export interface User {
  id: number;
  username: string;
  role: "admin" | "viewer";
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
export interface ScanStatus {
  running: boolean;
  is_scanning: boolean;
  progress: number | null;
  total_ips: number | null;
  done_ips: number | null;
  last_scan: string | null;
  scan_count: number;
}

export interface TriggerScanResponse {
  status: string;
  message: string;
}

// ---------------------------------------------------------------------------
// Hosts / ping výsledky
// ---------------------------------------------------------------------------
export interface HostStats {
  ip: string;
  checks: number;
  uptime_pct: number;
  avg_rtt_ms: number | null;
  min_rtt_ms: number | null;
  max_rtt_ms: number | null;
  avg_loss_pct: number | null;
  last_check: string | null;
  currently_alive: boolean;
}

export interface RttTrendPoint {
  ts:          string;
  rtt_ms:      number | null;
  alive:       boolean;
  packet_loss: number;
}

export interface RttTrendResponse {
  ip: string;
  points: RttTrendPoint[];
}

export interface PingResult {
  ip: string;
  is_alive: boolean;
  rtt_ms: number | null;
  packet_loss: number;
  jitter_ms: number | null;
  scanned_at: string;
}

export interface OutageEvent {
  ip: string;
  started_at: string;
  ended_at: string | null;
  duration_s: number | null;
}

// ---------------------------------------------------------------------------
// IP Rozsahy
// ---------------------------------------------------------------------------
export interface IpRange {
  id:           number | null;
  label:        string;
  network:      string;
  active:       boolean;
  scan_enabled: boolean;
  description:  string | null;
  site_id:      number | null;
  site_name:    string | null;
  site_color:   string | null;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export interface Credential {
  id:           number;
  name:         string;
  auth_type:    "ssh" | "snmp" | "api" | "http";
  username:     string | null;
  port:         number | null;
  extra_params: Record<string, unknown>;
}

export interface CredentialCreate {
  name: string;
  auth_type: "ssh" | "snmp" | "api" | "http";
  username?: string;
  password: string;
  port?: number;
  extra_params?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Zařízení
// ---------------------------------------------------------------------------
export interface Device {
  id: number;
  device_uuid: string;
  ip: string;
  hostname: string;
  mac: string | null;
  device_type: string;
  description: string | null;
  alias: string | null;
  vendor: string | null;
  serial_number: string | null;
  firmware: string | null;
  model: string | null;
  last_uptime_s: number | null;
  last_uptime_str: string | null;   // originální textový uptime ze zařízení
  last_polled_at: string | null;
  last_poll_method: string | null;
  created_at: string;
  updated_at: string | null;
  credentials: Credential[];
  backup_enabled: boolean;          // individuální nastavení zálohy
  last_successful_credential_id: number | null;
  last_successful_auth: Record<string, unknown> | null;
  is_alive: boolean | null;
  cron_poll:  boolean;
  ownership:   "isp" | "client" | "unknown";
  location_id:   number | null;
  location_name: string | null;
}

export interface DeviceCreate {
  ip: string;
  hostname: string;
  device_type?: string;
  description?: string;
  alias?: string;
  mac?: string;
  vendor?: string;
  serial_number?: string;
  ownership?:   "isp" | "client" | "unknown";
  location_id?: number | null;
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------
export interface DiscoveryLayer {
  layer: string;
  ok: boolean;
  result: string;
  note: string;
}

export interface DiscoveryResult {
  device_id: number;
  ip: string;
  patch_applied: Record<string, string>;
  hostname: string | null;
  mac: string | null;
  vendor: string | null;
  device_type: string | null;
  description: string | null;
  open_ports: number[];
  services: Record<string, string>;
  notes: string[];
  layers: DiscoveryLayer[];
}

export interface DiscoveryLog {
  id: number;
  device_id: number;
  tested_at: string;
  ip: string;
  layers: DiscoveryLayer[];
  open_ports: number[];
  services: Record<string, string>;
  patch_applied: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Konfigurace
// ---------------------------------------------------------------------------
export interface AppConfig {
  scan_interval_s:           number;
  ping_count:                number;
  ping_timeout_ms:           number;
  max_concurrent:            number;
  alert_rtt_ms:              number;
  alert_email:               string;
  retention_days:            number;
  discovery_enabled:         string;
  discovery_interval_s:      number;
  discovery_only_online:     string;
  discovery_skip_polled:     string;
  poll_scheduler_enabled:    string;
  poll_scheduler_interval_s: number;
  backup_enabled:            string;
  backup_interval_s:         number;
  backup_only_online:        string;
  backup_only_successful:    string;
  [key: string]:             unknown;
}

// ---------------------------------------------------------------------------
// Pomocné typy pro UI
// ---------------------------------------------------------------------------
export type DeviceStatus = "online" | "offline" | "unknown";

export interface DeviceWithStatus extends Device {
  status: DeviceStatus;
  uptime_pct: number;
  avg_rtt_ms: number | null;
  last_check: string | null;
}

export interface ApiError {
  detail: string;
  status: number;
}

// ---------------------------------------------------------------------------
// Scan Jobs
// ---------------------------------------------------------------------------
export interface ScanJob {
  id:            number;
  job_type:      string;
  trigger_type:  "cron" | "manual";
  triggered_by:  string | null;
  started_at:    string;
  finished_at:   string | null;
  duration_s:    number | null;
  status:        "running" | "done" | "error";
  total_targets: number;
  ok_count:      number;
  fail_count:    number;
  changed_count: number;
  error_msg:     string | null;
  meta:          Record<string, unknown>;
}

export interface ScanJobStats {
  total:          number;
  done:           number;
  errors:         number;
  running:        number;
  ping_scans:     number;
  discoveries:    number;
  backups:        number;
  avg_duration_s: number | null;
  min_duration_s: number | null;
  max_duration_s: number | null;
  last_scan_at:   string | null;
}

// ---------------------------------------------------------------------------
// Zálohy zařízení
// ---------------------------------------------------------------------------
export interface DeviceBackup {
  id:               number;
  device_id:        number;
  backup_type:      "binary" | "export";
  filename:         string;
  filepath:         string;
  file_size_bytes:  number | null;
  file_size_human:  string;
  status:           "running" | "ok" | "failed";
  error_msg:        string | null;
  triggered_by:     string;
  mikrotik_version: string | null;
  duration_ms:      number | null;
  created_at:       string;
  // z JOIN s devices (v /backups přehledu)
  hostname?:        string;
  alias?:           string | null;
  ip?:              string;
  vendor?:          string | null;
}

export interface BackupStats {
  total:           number;
  ok_count:        number;
  failed_count:    number;
  running_count:   number;
  device_count:    number;
  total_bytes:     number;
  total_size_human: string;
  last_backup_at:  string | null;
}

export interface BackupRunResult {
  backup_id:        number;
  device_id:        number;
  hostname:         string;
  success:          boolean;
  filename:         string;
  file_size_bytes:  number | null;
  file_size_human:  string;
  mikrotik_version: string | null;
  duration_ms:      number | null;
  error:            string | null;
}

// ---------------------------------------------------------------------------
// Device IPs
// ---------------------------------------------------------------------------

export interface DeviceIp {
  ip:           string;
  mac:          string | null;
  interface:    string | null;
  is_primary:   boolean;
  source:       string;
  first_seen:   string;
  last_seen:    string;
  change_count: number;
}

export interface DeviceIpHistory {
  ip:         string;
  mac:        string | null;
  interface:  string | null;
  source:     string;
  event:      "assigned" | "released" | "changed_mac" | "changed_ip" | "seen";
  old_value:  Record<string, string> | null;
  new_value:  Record<string, string> | null;
  changed_at: string;
}

export interface IpOwner {
  device_id: number;
  ip:        string;
  mac:       string | null;
  interface: string | null;
  source:    string;
  last_seen: string;
  hostname:  string;
  alias:     string | null;
  vendor:    string | null;
  model:     string | null;
  firmware:  string | null;
}


export interface SystemLog {
  id:         number;
  created_at: string;
  level:      "INFO" | "WARNING" | "ERROR" | "CRITICAL";
  module:     string;
  event_type: string;
  message:    string;
  device_id:  number | null;
  user_name:  string | null;
  meta:       Record<string, unknown> | null;
  hostname?:  string | null;
  alias?:     string | null;
}
export interface SystemLogStats {
  total: number; info_count: number; warning_count: number;
  error_count: number; last_24h: number;
  oldest_at: string | null; newest_at: string | null;
}
export interface SystemLogMeta {
  stats: SystemLogStats; modules: string[]; event_types: string[];
}


export interface RangeImpact {
  range_id: number; label: string; network: string;
  ping_total: number; ping_30d: number; device_count: number;
  devices: { id: number; hostname: string; alias: string | null; ip: string }[];
  outage_count: number;
}


export interface ScanExclusion {
  id: number; ip: string; reason: string | null;
  created_by: string | null; created_at: string;
}


export interface DeviceInterface {
  name: string; type: string; running: boolean; disabled: boolean;
  comment: string; mac: string; mtu: string;
  rx_byte: number; tx_byte: number; rx_packet: number; tx_packet: number;
  rx_error: number; tx_error: number;
}
export interface ArpEntry {
  ip: string; mac: string; interface: string;
  status: string; complete: boolean; invalid: boolean;
}
export interface DhcpLease {
  ip: string; mac: string; hostname: string; server: string;
  status: string; expires_at: string; dynamic: boolean;
  blocked: boolean; comment: string;
}
export interface DeviceDataResult<T> {
  data: T[]; collected_at: string; source: string;
}
export interface DeviceAllData {
  interfaces?: DeviceDataResult<DeviceInterface>;
  arp?:        DeviceDataResult<ArpEntry>;
  dhcp?:       DeviceDataResult<DhcpLease>;
}


export interface PresenceBlock {
  from:   string;
  to:     string;
  source: "arp" | "dhcp" | "ping";
  online: boolean;
}

export interface IpAddress {
  ip:              string;
  range_id:        number | null;
  is_alive:        boolean | null;
  rtt_ms:          number | null;
  last_check:      string | null;
  last_seen:       string | null;
  first_seen:      string | null;
  uptime_pct_24h:  number | null;
  avg_rtt_24h:     number | null;
  min_rtt_24h:     number | null;
  max_rtt_24h:     number | null;
  checks_24h:      number;
  online_24h:      number;
  device_id:       number | null;
  device_source:   string | null;
  device_hostname: string | null;
  device_alias:    string | null;
  device_vendor:   string | null;
  device_model:    string | null;
}

export interface UnknownNetwork {
  subnet:    string;
  ip_count:  number;
  sources:   string[];
  last_seen: string | null;
}

export interface UnknownNetworkIp {
  ip:        string;
  last_seen: string | null;
  sources:   string[];
  mac:       string | null;
}

export interface Site {
  id:          number;
  name:        string;
  description: string | null;
  color:       string;
  active:      boolean;
  created_at:  string;
  range_count: number;
}

export interface ConfigItem {
  id:         number;
  category:   string;
  value:      string;
  label:      string;
  color:      string | null;
  icon:       string | null;
  sort_order: number;
  active:     boolean;
}

export interface LocationMapPoint {
  id:             number;
  name:           string;
  type:           string;
  parent_id:      number | null;
  parent_name:    string | null;
  street:         string | null;
  city:           string | null;
  zip:            string | null;
  country:        string | null;
  lat:            number;
  lng:            number;
  active:         boolean;
  total_devices:  number;
  online_count:   number;
  offline_count:  number;
  direct_devices: number;
  children_count: number;
}

export interface Location {
  id:           number;
  name:         string;
  type:         string;
  parent_id:    number | null;
  street:       string | null;
  city:         string | null;
  zip:          string | null;
  country:      string;
  ruian_id:     number | null;
  lat:          number | null;
  lng:          number | null;
  description:  string | null;
  active:       boolean;
  created_at:   string;
  breadcrumb:   string[];
  device_count: number;
}

export interface Outage {
  id:          number;
  ip:          string;
  device_id:   number | null;
  hostname:    string | null;
  alias:       string | null;
  started_at:  string;
  ended_at:    string | null;
  duration_s:  number | null;
  resolution:  string | null;
  source:      string;
  is_active:   boolean;
  last_online: string | null;
  mac:         string | null;
  range_label: string | null;
  site_name:   string | null;
}

export interface ChangeEvent {
  log_type:    "ip" | "device";
  id:          number;
  ip:          string | null;
  device_id:   number | null;
  hostname:    string | null;
  alias:       string | null;
  event_type:  string;
  source:      string | null;
  occurred_at: string;
  meta:        Record<string, unknown> | null;
  old_value:   Record<string, unknown> | null;
  new_value:   Record<string, unknown> | null;
  last_online: string | null;
  mac:         string | null;
  range_label: string | null;
  site_name:   string | null;
}

export interface OutageStats {
  active:       number;
  recovered:    number;
  ip_changes:   number;
  avg_duration_s: number | null;
  max_duration_s: number | null;
}
