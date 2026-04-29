"use client";

import { useState, useMemo, useCallback } from "react";
import { Download } from "lucide-react";
import { useHosts, useDevices } from "@/hooks/useNetPulse";
import { DataTable, TableSearch } from "@/components/table/DataTable";
import { getHostColumns, type HostRow } from "@/components/hosts/HostColumns";
import { HostPanel } from "@/components/hosts/HostPanel";
import { Button, Select, MetricCard, Spinner } from "@/components/ui";
import type { Row } from "@tanstack/react-table";
import type { Device } from "@/lib/types";

export default function HostsPage() {
  const { data: hosts   = [], isLoading: hostsLoading   } = useHosts();
  const { data: devices = [], isLoading: devicesLoading } = useDevices();

  const [globalFilter,  setGlobalFilter]  = useState("");
  const [statusFilter,  setStatusFilter]  = useState("");
  const [deviceFilter,  setDeviceFilter]  = useState("");
  const [expandedRowIp, setExpandedRowIp] = useState<string | null>(null);

  // Mapa IP → zařízení
  const deviceByIp = useMemo(() => {
    const m = new Map<string, Device>();
    for (const d of devices) m.set(d.ip.split("/")[0], d);
    return m;
  }, [devices]);

  // Sloučená data
  const rows = useMemo<HostRow[]>(() => {
    return hosts.map((h) => ({
      ...h,
      device: deviceByIp.get(h.ip.split("/")[0]),
    }));
  }, [hosts, deviceByIp]);

  // Filtrace
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (statusFilter === "online"   && !r.currently_alive)  return false;
      if (statusFilter === "offline"  &&  r.currently_alive)  return false;
      if (statusFilter === "assigned" && !r.device)           return false;
      if (statusFilter === "free"     &&  r.device)           return false;
      if (deviceFilter === "assigned" && !r.device)           return false;
      if (deviceFilter === "free"     &&  r.device)           return false;
      return true;
    });
  }, [rows, statusFilter, deviceFilter]);

  // Statistiky
  const stats = useMemo(() => {
    const alive    = rows.filter((r) => r.currently_alive).length;
    const assigned = rows.filter((r) => !!r.device).length;
    const rtts     = rows.filter((r) => r.avg_rtt_ms != null).map((r) => r.avg_rtt_ms!);
    const avgRtt   = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
    const ups      = rows.map((r) => r.uptime_pct);
    const avgUp    = ups.length ? ups.reduce((a, b) => a + b, 0) / ups.length : null;
    return { total: rows.length, alive, assigned, avgRtt, avgUp };
  }, [rows]);

  // Sloupce
  const columns = useMemo(() => getHostColumns(), []);

  // Sub-row — detail panel
  const renderSubRow = useCallback(
    (row: Row<HostRow>) => <HostPanel host={row.original} />,
    []
  );

  // Klik na řádek — toggle expand
  const handleRowClick = useCallback((row: HostRow) => {
    setExpandedRowIp((prev) => (prev === row.ip ? null : row.ip));
  }, []);

  // Export CSV
  function exportCsv(data: HostRow[]) {
    const headers = [
      "IP","Stav","Hostname","Alias","Typ","Výrobce","MAC",
      "Uptime%","Avg_RTT_ms","Min_RTT_ms","Max_RTT_ms",
      "Packet_loss%","Měření","Poslední_scan",
    ];
    const csvRows = data.map((r) => [
      r.ip,
      r.currently_alive ? "online" : "offline",
      r.device?.hostname ?? "",
      r.device?.alias ?? "",
      r.device?.device_type ?? "",
      r.device?.vendor ?? "",
      r.device?.mac ?? "",
      r.uptime_pct.toFixed(2),
      r.avg_rtt_ms?.toFixed(2) ?? "",
      r.min_rtt_ms?.toFixed(2) ?? "",
      r.max_rtt_ms?.toFixed(2) ?? "",
      r.avg_loss_pct.toFixed(2),
      r.checks,
      r.last_check ?? "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csv  = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a"); a.href = url;
    a.download = "netpulse_ip_adresy.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  // Toolbar
  const renderToolbar = useCallback(() => (
    <div className="flex flex-wrap items-center gap-2">
      <TableSearch
        value={globalFilter}
        onChange={setGlobalFilter}
        placeholder="IP adresa, hostname, MAC, výrobce…"
        className="w-72"
      />
      <Select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        className="w-36"
      >
        <option value="">Vše — stav</option>
        <option value="online">🟢 Online</option>
        <option value="offline">🔴 Offline</option>
      </Select>
      <Select
        value={deviceFilter}
        onChange={(e) => setDeviceFilter(e.target.value)}
        className="w-40"
      >
        <option value="">Vše — zařízení</option>
        <option value="assigned">S zařízením</option>
        <option value="free">Bez zařízení</option>
      </Select>
      <div className="flex-1" />
      <Button size="sm" variant="outline" onClick={() => exportCsv(filteredRows)}>
        <Download className="h-3.5 w-3.5" />
        Export CSV
      </Button>
    </div>
  ), [globalFilter, statusFilter, deviceFilter, filteredRows]);

  if (hostsLoading || devicesLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Metriky */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
        <MetricCard label="Celkem IP"   value={stats.total} />
        <MetricCard label="Online"      value={stats.alive}
          color={stats.alive > 0 ? "green" : "default"}
          sub={`${stats.total - stats.alive} offline`} />
        <MetricCard label="S zařízením" value={stats.assigned}
          sub={`${stats.total - stats.assigned} volných`} />
        <MetricCard label="Avg RTT"
          value={stats.avgRtt != null ? `${stats.avgRtt.toFixed(1)} ms` : "—"}
          color={stats.avgRtt && stats.avgRtt > 50 ? "amber" : "default"} />
        <MetricCard label="Avg uptime"
          value={stats.avgUp != null ? `${stats.avgUp.toFixed(1)} %` : "—"}
          color={
            !stats.avgUp ? "default" :
            stats.avgUp >= 99 ? "green" :
            stats.avgUp >= 90 ? "amber" : "red"
          } />
      </div>

      {/* Tabulka */}
      <DataTable<HostRow>
        data={filteredRows}
        columns={columns}
        isLoading={false}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        getRowId={(row) => row.ip}
        renderSubRow={renderSubRow}
        renderToolbar={renderToolbar}
        onRowClick={handleRowClick}
        selectedRowId={expandedRowIp}
        emptyMessage="Žádné IP adresy — spusťte scan."
      />
    </div>
  );
}
