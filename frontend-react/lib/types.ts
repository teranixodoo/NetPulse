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
  avg_loss_pct: number;
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
  id: number | null;
  label: string;
  network: string;
  active: boolean;
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export interface Credential {
  id: number;
  name: string;
  auth_type: "ssh" | "snmp" | "api" | "http";
  username: string | null;
  port: number | null;
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
  scan_interval_s: number;
  ping_count: number;
  ping_timeout_ms: number;
  max_concurrent: number;
  alert_rtt_ms: number;
  alert_email: string;
  retention_days: number;
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
// System Logs
// ---------------------------------------------------------------------------
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
  // z JOIN s devices
  hostname?:  string | null;
  alias?:     string | null;
}

export interface SystemLogStats {
  total:         number;
  info_count:    number;
  warning_count: number;
  error_count:   number;
  last_24h:      number;
  oldest_at:     string | null;
  newest_at:     string | null;
}

export interface SystemLogMeta {
  stats:       SystemLogStats;
  modules:     string[];
  event_types: string[];
}
