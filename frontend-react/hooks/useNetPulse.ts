// hooks/useNetPulse.ts — React Query hooks pro všechny API volání

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { systemLogsApi } from '@/lib/api';
import { outagesApi, changeLogApi, scanExclusionsApi, deviceDataApi, deviceIpsApi, hostsApi, ipAddressesApi, presenceApi, unknownNetworksApi, sitesApi, hostsEnrichedApi, configListsApi, locationsApi } from '@/lib/api';
import api, {
  scanApi, dataApi, rangesApi, credentialsApi,
  devicesApi, configApi, healthApi, backupApi, getErrorMessage,
} from "@/lib/api";
import type { DeviceCreate, CredentialCreate, IpRange, ScanJob, ScanJobStats,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Keys
// ---------------------------------------------------------------------------
export const QK = {
  backups:       ["backups"] as const,
  backupStats:   ["backup-stats"] as const,
  health:        ["health"]           as const,
  scanStatus:    ["scan-status"]      as const,
  hosts:         (rid?: number) => ["hosts", rid] as const,
  hostStats:     (ip: string) => ["host-stats", ip] as const,
  rttTrend:      (ip: string) => ["rtt-trend", ip] as const,
  outages:       ["outages"]          as const,
  latest:        ["latest"]           as const,
  ranges:        ["ranges"]           as const,
  credentials:   ["credentials"]      as const,
  devices:       ["devices"]          as const,
  discoveryLogs: (id: number) => ["discovery-logs", id] as const,
  config:        ["config"]           as const,
};

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
export function useHealth() {
  return useQuery({
    queryKey: QK.health,
    queryFn:  healthApi.check,
    refetchInterval: 10_000,
    staleTime: 0,
  });
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
export function useScanStatus() {
  return useQuery({
    queryKey: QK.scanStatus,
    queryFn:  scanApi.getStatus,
    refetchInterval: 5_000,
    staleTime: 0,
  });
}

export function useTriggerScan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: scanApi.trigger,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: QK.scanStatus });
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["hosts"] });
      }, 5_000);
    },
  });
}

// ---------------------------------------------------------------------------
// Hosts
// ---------------------------------------------------------------------------
export function useHosts(rangeId?: number) {
  return useQuery({
    queryKey: QK.hosts(rangeId),
    queryFn:  () => dataApi.getHosts(rangeId),
    refetchInterval: 60_000,
  });
}

export function useRttTrend(ip: string, hours = 24, limit = 1000) {
  return useQuery({
    queryKey: [...QK.rttTrend(ip), hours, limit],
    queryFn:  () => dataApi.getRttTrend(ip, { hours, limit }),
    enabled:  !!ip,
    staleTime: 0,
  });
}

export function useOutages(limit = 50, hours = 24) {
  return useQuery({
    queryKey: [...QK.outages, limit, hours],
    queryFn:  () => dataApi.getOutages(limit, hours),
    refetchInterval: 60_000,
  });
}

// ---------------------------------------------------------------------------
// Ranges
// ---------------------------------------------------------------------------
export function useRanges() {
  return useQuery<any[]>({
    queryKey: QK.ranges,
    queryFn:  rangesApi.getAll,
  });
}

export function useCreateRange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: import("@/lib/types").IpRange) =>
      rangesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.ranges }),
  });
}

export function useUpdateRange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & Omit<IpRange, "id">) =>
      rangesApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.ranges }),
  });
}

export function useDeleteRange() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, deleteData }: { id: number; deleteData: boolean }) =>
      rangesApi.delete(id, deleteData),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.ranges }),
  });
}

export function useRangeImpact(rangeId: number | null) {
  return useQuery({
    queryKey: ["range-impact", rangeId],
    queryFn:  () => rangesApi.getImpact(rangeId!),
    enabled:  rangeId != null,
    staleTime: 0,  // vždy čerstvá data
  });
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------
export function useCredentials() {
  return useQuery({
    queryKey: QK.credentials,
    queryFn:  credentialsApi.getAll,
  });
}

export function useCreateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CredentialCreate) => credentialsApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.credentials }),
  });
}

export function useDeleteCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => credentialsApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.credentials }),
  });
}

// ---------------------------------------------------------------------------
// Devices
// ---------------------------------------------------------------------------
export function useDevices() {
  return useQuery({
    queryKey: QK.devices,
    queryFn:  devicesApi.getAll,
    refetchInterval: 30_000,
  });
}

export function useCreateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: DeviceCreate) => devicesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.devices }),
  });
}

export function useUpdateDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: { id: number } & DeviceCreate) =>
      devicesApi.update(id, data),
    onSuccess: async () => {
      await qc.refetchQueries({ queryKey: QK.devices, type: "active" });
    },
  });
}

export function useDeleteDevice() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => devicesApi.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.devices }),
  });
}

export function useLinkCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, credentialId }: { deviceId: number; credentialId: number }) =>
      devicesApi.linkCredential(deviceId, credentialId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.devices }),
  });
}

export function useUnlinkCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, credentialId }: { deviceId: number; credentialId: number }) =>
      devicesApi.unlinkCredential(deviceId, credentialId),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.devices }),
  });
}

export function useRunDiscovery() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: number) => devicesApi.runDiscovery(deviceId),
    onSuccess: (_, deviceId) => {
      qc.invalidateQueries({ queryKey: QK.devices });
      qc.invalidateQueries({ queryKey: QK.discoveryLogs(deviceId) });
    },
  });
}

export function useDiscoveryLogs(deviceId: number) {
  return useQuery({
    queryKey:       QK.discoveryLogs(deviceId),
    queryFn:        () => devicesApi.getDiscoveryLogs(deviceId, 20),
    enabled:        !!deviceId,
    staleTime:      0,          // vždy považuj za stale
    refetchInterval: false,     // manuální refresh přes invalidate
  });
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
export function useConfig() {
  return useQuery({
    queryKey: QK.config,
    queryFn:  configApi.get,
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: configApi.update,
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.config }),
  });
}

// ---------------------------------------------------------------------------
// Error helper
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Scan Jobs
// ---------------------------------------------------------------------------
export function useScanJobs(jobType?: string, limit = 100) {
  return useQuery<ScanJob[]>({
    queryKey: ["scan-jobs", jobType, limit],
    queryFn:  () => {
      const params = new URLSearchParams({ limit: String(limit) });
      if (jobType) params.append("job_type", jobType);
      return api.get<ScanJob[]>(`/scan/jobs?${params}`).then((r) => r.data);
    },
    refetchInterval: 10_000,
    staleTime: 0,
  });
}

export function useScanJobsStats() {
  return useQuery<ScanJobStats>({
    queryKey: ["scan-jobs-stats"],
    queryFn:  () => api.get<ScanJobStats>("/scan/jobs/stats").then((r) => r.data),
    refetchInterval: 15_000,
    staleTime: 0,
  });
}


export function useUpdateCredential() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }: { id: number; data: CredentialCreate }) =>
      credentialsApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.credentials }),
  });
}

// ---------------------------------------------------------------------------
// Backup hooks
// ---------------------------------------------------------------------------

export function useDeviceBackups(deviceId: number, limit = 50) {
  return useQuery({
    queryKey: [...QK.backups, deviceId],
    queryFn:  () => backupApi.getDeviceBackups(deviceId, limit),
    enabled:  !!deviceId,
    refetchInterval: false,
  });
}

export function useAllBackups(status?: string) {
  return useQuery({
    queryKey: [...QK.backups, "all", status],
    queryFn:  () => backupApi.getAllBackups(200, status),
    refetchInterval: 30_000,
  });
}

export function useBackupStats() {
  return useQuery({
    queryKey: QK.backupStats,
    queryFn:  () => backupApi.getStats(),
    refetchInterval: 30_000,
  });
}

export function useRunBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (deviceId: number) => backupApi.runBackup(deviceId),
    onSuccess: async (_data, deviceId) => {
      // Invalidujeme zálohy tohoto zařízení i celkový přehled
      await qc.invalidateQueries({ queryKey: [...QK.backups, deviceId] });
      await qc.invalidateQueries({ queryKey: [...QK.backups, "all"] });
      await qc.invalidateQueries({ queryKey: QK.backupStats });
    },
  });
}

export function useUpdateDeviceCronPoll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, cron_poll }: { deviceId: number; cron_poll: boolean }) =>
      api.patch(`/devices/${deviceId}/cron-poll`, { cron_poll }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.devices }),
  });
}

export function useUpdateDeviceBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ deviceId, backup_enabled }: { deviceId: number; backup_enabled: boolean }) =>
      api.patch(`/devices/${deviceId}/backup-settings`, { backup_enabled }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: QK.devices }),
  });
}

export function useTriggerBackupScan() {
  return useMutation({
    mutationFn: () => api.post("/scan/trigger-backup").then(r => r.data),
  });
}

export function useDeleteBackup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (backupId: number) => backupApi.deleteBackup(backupId),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: QK.backups });
      await qc.invalidateQueries({ queryKey: QK.backupStats });
    },
  });
}


// ---------------------------------------------------------------------------
// System Logs (pouze admin)
// ---------------------------------------------------------------------------

export function useSystemLogs(params: {
  limit?: number; level?: string; module?: string;
  event_type?: string; device_id?: number;
  search?: string; hours?: number;
} = {}) {
  return useQuery({
    queryKey: ["system-logs", params],
    queryFn:  () => systemLogsApi.getLogs(params),
    refetchInterval: 15_000,
  });
}

export function useSystemLogStats() {
  return useQuery({
    queryKey: ["system-log-stats"],
    queryFn:  () => systemLogsApi.getStats(),
    refetchInterval: 30_000,
  });
}

export function useCleanupSystemLogs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => systemLogsApi.cleanup(),
    onSuccess:  () => {
      qc.invalidateQueries({ queryKey: ["system-logs"] });
      qc.invalidateQueries({ queryKey: ["system-log-stats"] });
    },
  });
}

// ---------------------------------------------------------------------------
// Scan Exclusions
// ---------------------------------------------------------------------------

export function useScanExclusions() {
  return useQuery({
    queryKey: ["scan-exclusions"],
    queryFn:  () => scanExclusionsApi.list(),
  });
}

export function useAddScanExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ ip, reason }: { ip: string; reason: string }) =>
      scanExclusionsApi.add(ip, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scan-exclusions"] }),
  });
}

export function useRemoveScanExclusion() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => scanExclusionsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["scan-exclusions"] }),
  });
}

// ---------------------------------------------------------------------------
// Device Extended Data
// ---------------------------------------------------------------------------

export function useDeviceAllData(deviceId: number | null) {
  return useQuery({
    queryKey: ["device-data", deviceId],
    queryFn:  () => deviceDataApi.getAll(deviceId!),
    enabled:  deviceId != null,
    staleTime: 30_000,
  });
}

// ---------------------------------------------------------------------------
// Device IPs
// ---------------------------------------------------------------------------

export function useDeviceIps(deviceId: number | null) {
  return useQuery({
    queryKey: ["device-ips", deviceId],
    queryFn:  () => deviceIpsApi.getAll(deviceId!),
    enabled:  deviceId != null,
    staleTime: 30_000,
  });
}

export function useDeviceIpHistory(deviceId: number | null, limit = 200) {
  return useQuery({
    queryKey: ["device-ip-history", deviceId],
    queryFn:  () => deviceIpsApi.getHistory(deviceId!, limit),
    enabled:  deviceId != null,
    staleTime: 30_000,
  });
}

export function useIpDeviceMap() {
  return useQuery({
    queryKey: ["ip-device-map"],
    queryFn:  () => hostsApi.getIpDeviceMap(),
    staleTime: 60_000,  // 1 minuta cache
  });
}


export function useIpAddresses(params?: { alive_only?: boolean; range_id?: number }) {
  return useQuery({
    queryKey: ['ip-addresses', params],
    queryFn:  () => ipAddressesApi.getAll(params),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
}

export function useIpPresence(ip: string | null, hours = 24) {
  return useQuery({
    queryKey: ['ip-presence', ip, hours],
    queryFn:  () => presenceApi.get(ip!, hours),
    enabled:  !!ip,
    staleTime: 60_000,
  });
}

export function useUnknownNetworks() {
  return useQuery({
    queryKey: ['unknown-networks'],
    queryFn:  () => unknownNetworksApi.getAll(),
    staleTime: 120_000,
    refetchInterval: 300_000,
  });
}

export function useUnknownNetworkIps(subnet: string | null) {
  return useQuery({
    queryKey: ['unknown-network-ips', subnet],
    queryFn:  () => unknownNetworksApi.getIps(subnet!),
    enabled:  !!subnet,
    staleTime: 60_000,
  });
}

export function useSites() {
  return useQuery<import("@/lib/types").Site[]>({
    queryKey: ['sites'],
    queryFn:  () => sitesApi.getAll(),
    staleTime: 60_000,
  });
}

export function useCreateSite() {
  const qc = useQueryClient();
  return useMutation<
    import("@/lib/types").Site,
    Error,
    { name: string; description?: string; color?: string }
  >({
    mutationFn: (data) => sitesApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
  });
}

export function useUpdateSite() {
  const qc = useQueryClient();
  return useMutation<
    import("@/lib/types").Site,
    Error,
    { id: number; name: string; description?: string; color?: string; active?: boolean }
  >({
    mutationFn: ({ id, name, description, color, active }) =>
      sitesApi.update(id, { name, description, color, active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sites'] }),
  });
}

export function useDeleteSite() {
  const qc = useQueryClient();
  return useMutation<void, Error, number>({
    mutationFn: (id: number) => sitesApi.remove(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sites'] });
      qc.invalidateQueries({ queryKey: ['ranges'] });
    },
  });
}

export function useHostsEnriched(params: {
  site_id?:  number | null;
  range_id?: number | null;
  status?:   string;
  device?:   string;
  search?:   string;
  limit?:    number;
  offset?:   number;
  sort_by?:  string;
  sort_dir?: string;
}) {
  return useQuery({
    queryKey: ['hosts-enriched', params.site_id, params.range_id, params.status, params.device, params.search, params.limit, params.offset, params.sort_by, params.sort_dir],
    queryFn:  () => hostsEnrichedApi.get(params),
    staleTime: 30_000,
    refetchInterval: 60_000,
    placeholderData: (prev: any) => prev,
  });
}

export function useConfigList(category: string, activeOnly = true) {
  return useQuery<import("@/lib/types").ConfigItem[]>({
    queryKey: ['config-list', category, activeOnly],
    queryFn:  () => configListsApi.getList(category, activeOnly),
    staleTime: 300_000,
  });
}

export function useAllConfigLists() {
  return useQuery<Record<string, import("@/lib/types").ConfigItem[]>>({
    queryKey: ['config-lists-all'],
    queryFn:  () => configListsApi.getAll(),
    staleTime: 300_000,
  });
}

export function useCreateConfigItem() {
  const qc = useQueryClient();
  return useMutation<
    import("@/lib/types").ConfigItem,
    Error,
    { category: string; value: string; label: string; color?: string; sort_order?: number }
  >({
    mutationFn: (data) => configListsApi.create(data),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['config-list', vars.category] });
      qc.invalidateQueries({ queryKey: ['config-lists-all'] });
    },
  });
}

export function useUpdateConfigItem() {
  const qc = useQueryClient();
  return useMutation<
    import("@/lib/types").ConfigItem,
    Error,
    { id: number; category: string; label: string; color?: string; sort_order?: number; active?: boolean }
  >({
    mutationFn: ({ id, label, color, sort_order, active }) =>
      configListsApi.update(id, { label, color, sort_order, active }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['config-list', vars.category] });
      qc.invalidateQueries({ queryKey: ['config-lists-all'] });
    },
  });
}

export function useDeleteConfigItem() {
  const qc = useQueryClient();
  return useMutation<void, Error, { id: number; category: string }>({
    mutationFn: ({ id }) => configListsApi.remove(id),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ['config-list', vars.category] });
      qc.invalidateQueries({ queryKey: ['config-lists-all'] });
    },
  });
}

export function useLocations(activeOnly = false) {
  return useQuery<import("@/lib/types").Location[]>({
    queryKey: ['locations', activeOnly],
    queryFn:  () => locationsApi.getAll(activeOnly),
    staleTime: 60_000,
  });
}

export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: Partial<import("@/lib/types").Location>) => locationsApi.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }: Partial<import("@/lib/types").Location> & { id: number }) =>
      locationsApi.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useDeleteLocation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => locationsApi.remove(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }),
  });
}

export function useOutagesNew(hours = 24, activeOnly = false, limit = 200, minDuration = 0) {
  return useQuery<import("@/lib/types").Outage[]>({
    queryKey: ['outages-new', hours, activeOnly, minDuration],
    queryFn:  () => outagesApi.getAll(hours, activeOnly, limit, minDuration),
    refetchInterval: 60_000,
    staleTime: 0,
  });
}

export function useOutageStats(hours = 24) {
  return useQuery<import("@/lib/types").OutageStats>({
    queryKey: ['outage-stats', hours],
    queryFn:  () => outagesApi.getStats(hours),
    refetchInterval: 60_000,
    staleTime: 0,
  });
}

export function useChangeLog(hours = 24, deviceId?: number, eventTypes?: string) {
  return useQuery<import("@/lib/types").ChangeEvent[]>({
    queryKey: ['change-log', hours, deviceId, eventTypes],
    queryFn:  () => changeLogApi.getAll(hours, deviceId, eventTypes),
    refetchInterval: 60_000,
    staleTime: 0,
  });
}

export { getErrorMessage };
