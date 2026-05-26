// lib/api.ts — Centrální API client pro NetPulse backend

import axios, { AxiosInstance, AxiosError } from "axios";
import Cookies from "js-cookie";
import type {
  LoginRequest, TokenResponse, User,
  ScanStatus, TriggerScanResponse,
  HostStats, RttTrendResponse, PingResult, OutageEvent,
  IpRange, Credential, CredentialCreate,
  Device, DeviceCreate, DiscoveryResult, DiscoveryLog,
  AppConfig, DeviceBackup, BackupStats, BackupRunResult,
} from "./types";

// ---------------------------------------------------------------------------
// Base URL:
//   - Prohlížeč → /api/backend  (Next.js rewrite proxy → backend:8000)
//   - Server (SSR/build) → http://backend:8000 přímo
// ---------------------------------------------------------------------------
function getBaseUrl(): string {
  if (typeof window !== "undefined") {
    // Klient (prohlížeč) — přes Next.js proxy
    return "/api/backend";
  }
  // Server — přímé spojení s backendem
  return process.env.API_URL ||
         process.env.NEXT_PUBLIC_API_URL ||
         "http://backend:8000";
}

const api: AxiosInstance = axios.create({
  baseURL: getBaseUrl(),
  timeout: 30_000,
  headers: { "Content-Type": "application/json" },
});

// Request interceptor — přidá JWT token (jen v prohlížeči)
api.interceptors.request.use((config) => {
  if (typeof window !== "undefined") {
    const token = Cookies.get("np_token");
    if (token) {
      config.headers.Authorization = `Bearer ${token}`;
    }
  }
  return config;
});

// Response interceptor — zpracuje 401
api.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401 && typeof window !== "undefined") {
      Cookies.remove("np_token");
      Cookies.remove("np_user");
      window.location.href = "/login";
    }
    return Promise.reject(err);
  }
);

// ---------------------------------------------------------------------------
// Pomocná funkce pro error message
// ---------------------------------------------------------------------------
function getErrorMessage(err: unknown): string {
  if (axios.isAxiosError(err)) {
    return (err.response?.data as { detail?: string })?.detail ?? err.message;
  }
  return String(err);
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------
export const authApi = {
  async login(credentials: LoginRequest): Promise<TokenResponse> {
    const { data } = await api.post<TokenResponse>("/auth/login", credentials);
    Cookies.set("np_token", data.access_token, {
      expires: data.expires_in / 86400,
      sameSite: "lax",
    });
    return data;
  },

  logout() {
    Cookies.remove("np_token");
    Cookies.remove("np_user");
  },

  isLoggedIn(): boolean {
    return !!Cookies.get("np_token");
  },

  async createUser(username: string, password: string, role: string): Promise<User> {
    const { data } = await api.post<User>("/auth/users", { username, password, role });
    return data;
  },

  async generateApiKey(description: string): Promise<{ api_key: string; warning: string }> {
    const { data } = await api.post("/auth/api-keys", { description });
    return data;
  },
};

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
export const scanApi = {
  async getStatus(): Promise<ScanStatus> {
    const { data } = await api.get<ScanStatus>("/scan/status");
    return data;
  },
  async trigger(): Promise<TriggerScanResponse> {
    const { data } = await api.post<TriggerScanResponse>("/scan/trigger");
    return data;
  },
};

// ---------------------------------------------------------------------------
// Data (hosts)
// ---------------------------------------------------------------------------
export const dataApi = {
  async getHosts(rangeId?: number): Promise<HostStats[]> {
    const params = rangeId ? { range_id: rangeId } : {};
    const { data } = await api.get<HostStats[]>("/hosts", { params });
    return data;
  },
  async getRttTrend(ip: string, options?: { days?: number; hours?: number; limit?: number }): Promise<RttTrendResponse> {
    const { data } = await api.get<RttTrendResponse>(
      `/hosts/${encodeURIComponent(ip)}/rtt-trend`,
      { params: options }
    );
    return data;
  },
  async getLatest(limit = 100): Promise<PingResult[]> {
    const { data } = await api.get<PingResult[]>("/results/latest", { params: { limit } });
    return data;
  },
  async getOutages(limit = 50, hours = 24): Promise<OutageEvent[]> {
    const { data } = await api.get<OutageEvent[]>("/outages", { params: { limit, hours } });
    return data;
  },
  async deleteOrphanedLogs(): Promise<{ deleted: number }> {
    const { data } = await api.delete("/results/orphaned");
    return data;
  },
};

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------
export const rangesApi = {
  async getAll(): Promise<IpRange[]> {
    const { data } = await api.get<IpRange[]>("/ranges");
    return data;
  },
  async create(label: string, network: string, active = true): Promise<IpRange> {
    const { data } = await api.post<IpRange>("/ranges", { label, network, active });
    return data;
  },
  async update(id: number, range: Omit<IpRange, "id">): Promise<IpRange> {
    const { data } = await api.put<IpRange>(`/ranges/${id}`, range);
    return data;
  },
  async getImpact(id: number): Promise<import('./types').RangeImpact> {
    const { data } = await api.get<import('./types').RangeImpact>(`/ranges/${id}/impact`);
    return data;
  },
  async delete(id: number, deleteData = false): Promise<void> {
    await api.delete(`/ranges/${id}`, { params: { delete_data: deleteData } });
  },
};

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export const credentialsApi = {
  async getAll(): Promise<Credential[]> {
    const { data } = await api.get<Credential[]>("/credentials");
    return data;
  },
  async create(credential: CredentialCreate): Promise<Credential> {
    const { data } = await api.post<Credential>("/credentials", credential);
    return data;
  },
  async delete(id: number): Promise<void> {
    await api.delete(`/credentials/${id}`);
  },
  async update(id: number, data: CredentialCreate): Promise<void> {
    await api.put(`/credentials/${id}`, data);
  },
};

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
export const devicesApi = {
  async getAll(): Promise<Device[]> {
    const { data } = await api.get<Device[]>("/devices");
    return data;
  },
  async create(device: DeviceCreate): Promise<Device> {
    const { data } = await api.post<Device>("/devices", device);
    return data;
  },
  async update(id: number, device: DeviceCreate): Promise<Device> {
    const { data } = await api.put<Device>(`/devices/${id}`, device);
    return data;
  },
  async delete(id: number): Promise<void> {
    await api.delete(`/devices/${id}`);
  },
  async linkCredential(deviceId: number, credentialId: number): Promise<void> {
    await api.post(`/devices/${deviceId}/credentials/${credentialId}`);
  },
  async unlinkCredential(deviceId: number, credentialId: number): Promise<void> {
    await api.delete(`/devices/${deviceId}/credentials/${credentialId}`);
  },
  async runDiscovery(deviceId: number): Promise<DiscoveryResult> {
    const { data } = await api.post<DiscoveryResult>(
      `/devices/${deviceId}/discovery`,
      {},
      { timeout: 60_000 }
    );
    return data;
  },
  async getDiscoveryLogs(deviceId: number, limit = 20): Promise<DiscoveryLog[]> {
    const { data } = await api.get<DiscoveryLog[]>(
      `/devices/${deviceId}/discovery-logs`,
      { params: { limit } }
    );
    return data;
  },
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export const configApi = {
  async get(): Promise<AppConfig> {
    const { data } = await api.get<AppConfig>("/config");
    return data;
  },
  async update(config: Partial<AppConfig>): Promise<AppConfig> {
    const { data } = await api.put<AppConfig>("/config", config);
    return data;
  },
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
export const healthApi = {
  async check(): Promise<boolean> {
    try {
      await api.get("/health", { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  },
};

// ---------------------------------------------------------------------------
// Backup
// ---------------------------------------------------------------------------
export const backupApi = {
  async runBackup(deviceId: number): Promise<BackupRunResult> {
    const { data } = await api.post<BackupRunResult>(
      `/devices/${deviceId}/backup`,
      {},
      { timeout: 120_000 }  // záloha může trvat déle
    );
    return data;
  },

  async getDeviceBackups(deviceId: number, limit = 50): Promise<DeviceBackup[]> {
    const { data } = await api.get<DeviceBackup[]>(
      `/devices/${deviceId}/backups`,
      { params: { limit } }
    );
    return data;
  },

  async getAllBackups(limit = 200, status?: string): Promise<DeviceBackup[]> {
    const params: Record<string, unknown> = { limit };
    if (status) params.status = status;
    const { data } = await api.get<DeviceBackup[]>("/backups", { params });
    return data;
  },

  async getStats(): Promise<BackupStats> {
    const { data } = await api.get<BackupStats>("/backups/stats");
    return data;
  },

  getDownloadUrl(backupId: number): string {
    // Stahování přes proxy — token se přidá automaticky interceptorem
    return `/api/backend/backups/${backupId}/download`;
  },

  async deleteBackup(backupId: number): Promise<void> {
    await api.delete(`/backups/${backupId}`);
  },
};


// ---------------------------------------------------------------------------
// System Logs
// ---------------------------------------------------------------------------
export const systemLogsApi = {
  async getLogs(params: {
    limit?: number; level?: string; module?: string;
    event_type?: string; device_id?: number;
    search?: string; hours?: number;
  } = {}): Promise<import('./types').SystemLog[]> {
    const { data } = await api.get('/system-logs', { params });
    return data;
  },
  async getStats(): Promise<import('./types').SystemLogMeta> {
    const { data } = await api.get('/system-logs/stats');
    return data;
  },
  async cleanup(): Promise<{ deleted: Record<string, number>; total: number }> {
    const { data } = await api.delete('/system-logs/cleanup');
    return data;
  },
};

export { getErrorMessage };
export default api;

// ---------------------------------------------------------------------------
// Scan Exclusions
// ---------------------------------------------------------------------------
export const scanExclusionsApi = {
  async list(): Promise<import('./types').ScanExclusion[]> {
    const { data } = await api.get('/scan-exclusions');
    return data;
  },
  async add(ip: string, reason: string): Promise<import('./types').ScanExclusion> {
    const { data } = await api.post('/scan-exclusions', { ip, reason });
    return data;
  },
  async remove(id: number): Promise<void> {
    await api.delete(`/scan-exclusions/${id}`);
  },
};

// ---------------------------------------------------------------------------
// Device Extended Data
// ---------------------------------------------------------------------------
export const deviceDataApi = {
  async getAll(deviceId: number): Promise<import('./types').DeviceAllData> {
    const { data } = await api.get(`/devices/${deviceId}/data`);
    return data;
  },
  async getType(deviceId: number, type: string) {
    const { data } = await api.get(`/devices/${deviceId}/data/${type}`);
    return data;
  },
};

// ---------------------------------------------------------------------------
// Device IPs API
// ---------------------------------------------------------------------------
export const deviceIpsApi = {
  async getAll(deviceId: number): Promise<import('./types').DeviceIp[]> {
    const { data } = await api.get(`/devices/${deviceId}/ips`);
    return data;
  },
  async getHistory(deviceId: number, limit = 200): Promise<import('./types').DeviceIpHistory[]> {
    const { data } = await api.get(`/devices/${deviceId}/ips/history`, { params: { limit } });
    return data;
  },
  async getStats(deviceId: number, hours = 24) {
    const { data } = await api.get(`/devices/${deviceId}/ips/stats`, { params: { hours } });
    return data;
  },
  async getOwner(ip: string): Promise<import('./types').IpOwner | null> {
    try {
      const { data } = await api.get(`/ips/${encodeURIComponent(ip)}/owner`);
      return data;
    } catch { return null; }
  },
};
