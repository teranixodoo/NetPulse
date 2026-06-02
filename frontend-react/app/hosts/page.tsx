"use client";

import { useState, useMemo, useCallback, useEffect } from "react";
import { Download } from "lucide-react";
import { useHostsEnriched, useDevices, useRanges, useSites } from "@/hooks/useNetPulse";
import { DataTable, TableSearch } from "@/components/table/DataTable";
import { getHostColumns, type HostRow } from "@/components/hosts/HostColumns";
import { HostPanel } from "@/components/hosts/HostPanel";
import { Button, Select, MetricCard, Spinner } from "@/components/ui";
import type { Row } from "@tanstack/react-table";
import type { Device, Site } from "@/lib/types";
import type { EnrichedRow } from "@/lib/api";
import { useReactTable } from "@tanstack/react-table";

const HOSTS_PAGE_SIZE = 100;

function useDebounce<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}

export default function HostsPage() {
  const [statusFilter, setStatusFilter] = useState("");
  const [siteFilter,   setSiteFilter]   = useState<number | null>(null);
  const [rangeFilter,  setRangeFilter]  = useState<number | null>(null);
  const [deviceFilter, setDeviceFilter] = useState("");
  const [searchInput,  setSearchInput]  = useState("");
  const [pageIndex,    setPageIndex]    = useState(0);
  const debouncedSearch = useDebounce(searchInput, 400);

  useEffect(() => {
    setPageIndex(0);
  }, [statusFilter, siteFilter, rangeFilter, deviceFilter, debouncedSearch]);

  const { data: enriched, isLoading } = useHostsEnriched({
    site_id:  siteFilter,
    range_id: rangeFilter,
    status:   statusFilter || undefined,
    device:   deviceFilter || undefined,
    search:   debouncedSearch || undefined,
    limit:    HOSTS_PAGE_SIZE,
    offset:   pageIndex * HOSTS_PAGE_SIZE,
  });

  const { data: devices = [] } = useDevices();
  const { data: ranges  = [] } = useRanges();
  const { data: sites   = [] } = useSites();

  const deviceMap = useMemo(() => {
    const m: Record<number, Device> = {};
    for (const d of devices) if (d.id) m[d.id] = d;
    return m;
  }, [devices]);

  const rows = useMemo<HostRow[]>(() => {
    if (!enriched?.rows) return [];
    return enriched.rows.map((r: EnrichedRow) => ({
      ip:              r.ip,
      currently_alive: r.currently_alive ?? false,
      alive_source:    r.alive_source,
      avg_rtt_ms:      r.avg_rtt_ms,
      min_rtt_ms:      r.min_rtt_ms,
      max_rtt_ms:      r.max_rtt_ms,
      avg_loss_pct:    r.avg_loss_pct,
      checks:          r.measurements ?? 0,
      uptime_pct:      r.uptime_pct ?? 0,
      last_check:      r.last_check ?? "",
      device_name:     r.device_alias ?? r.device_hostname ?? null,
      device_source:   null,
      range_label:     r.range_label,
      site_name:       r.site_name,
      site_color:      r.site_color,
      device:          r.device_id ? deviceMap[r.device_id] : undefined,
      ipOwner:         undefined,
    }));
  }, [enriched, deviceMap]);

  const stats = useMemo(() => enriched?.stats ?? {
    total: 0, alive: 0, offline: 0, assigned: 0, avg_rtt: null, avg_uptime: null,
  }, [enriched]);

  const columns  = useMemo(() => getHostColumns(), []);

  const renderSubRow = useCallback(
    (row: Row<HostRow>) => <HostPanel host={row.original} />,
    []
  );

  const filteredRanges = useMemo(() =>
    siteFilter
      ? (ranges as any[]).filter((r: any) => r.site_id === siteFilter)
      : ranges,
    [ranges, siteFilter]
  );

  function exportCsv(data: HostRow[]) {
    const headers = [
      "IP", "Stav", "Síť", "Rozsah", "Hostname", "Alias",
      "Uptime%", "Avg_RTT_ms", "Min_RTT_ms", "Max_RTT_ms", "Loss%", "Měření", "Poslední scan",
    ];
    const csvRows = data.map((r) => [
      r.ip,
      r.currently_alive ? "online" : "offline",
      r.site_name ?? "",
      r.range_label ?? "",
      r.device?.hostname ?? "",
      r.device?.alias ?? "",
      r.uptime_pct?.toFixed(2) ?? "",
      r.avg_rtt_ms?.toFixed(2) ?? "",
      r.min_rtt_ms?.toFixed(2) ?? "",
      r.max_rtt_ms?.toFixed(2) ?? "",
      r.avg_loss_pct?.toFixed(2) ?? "",
      r.checks,
      r.last_check ?? "",
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const blob = new Blob([headers.join(",") + "\n" + csvRows.join("\n")],
      { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a   = document.createElement("a");
    a.href = url; a.download = "ip-adresy.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  // renderToolbar přijímá table parametr dle DataTableProps
  const renderToolbar = useCallback(
    (_table: ReturnType<typeof useReactTable<HostRow>>) => (
      <div className="flex flex-wrap items-center gap-2">
        <TableSearch
          value={searchInput}
          onChange={setSearchInput}
          placeholder="IP adresa, hostname…"
          className="w-64"
        />
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-36">
          <option value="">Vše — stav</option>
          <option value="online">🟢 Online</option>
          <option value="offline">🔴 Offline</option>
        </Select>
        <Select
          value={siteFilter ?? ""}
          onChange={(e) => {
            setSiteFilter(e.target.value ? Number(e.target.value) : null);
            setRangeFilter(null);
          }}
          className="w-36"
        >
          <option value="">Vše — síť</option>
          {(sites as Site[]).filter((s) => s.name !== "Default").map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
        <Select
          value={rangeFilter ?? ""}
          onChange={(e) => setRangeFilter(e.target.value ? Number(e.target.value) : null)}
          className="w-44"
        >
          <option value="">Vše — rozsah</option>
          {(filteredRanges as any[]).map((r: any) => (
            <option key={r.id} value={r.id}>{r.label}</option>
          ))}
        </Select>
        <Select value={deviceFilter} onChange={(e) => setDeviceFilter(e.target.value)} className="w-40">
          <option value="">Vše — zařízení</option>
          <option value="assigned">S zařízením</option>
          <option value="free">Bez zařízení</option>
        </Select>
        <div className="flex-1" />
        <Button size="sm" variant="outline" onClick={() => exportCsv(rows)}>
          <Download className="h-3.5 w-3.5 mr-1" />Export CSV
        </Button>
      </div>
    ),
    [searchInput, statusFilter, siteFilter, rangeFilter, deviceFilter,
     sites, filteredRanges, rows]
  );

  if (isLoading && !enriched) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4">
      <h1 className="text-xl font-semibold">Detailní výpis IP adres</h1>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <MetricCard label="Celkem IP"   value={stats.total} />
        <MetricCard label="Online"      value={stats.alive}
          sub={`${stats.offline} offline`} color="green" />
        <MetricCard label="S zařízením" value={stats.assigned}
          sub={`${stats.total - stats.assigned} volných`} />
        <MetricCard label="Avg RTT"
          value={stats.avg_rtt != null ? `${stats.avg_rtt} ms` : "—"} />
        <MetricCard label="Avg uptime"
          value={stats.avg_uptime != null ? `${stats.avg_uptime} %` : "—"}
          color="red" />
      </div>

      <DataTable
        data={rows}
        columns={columns}
        renderSubRow={renderSubRow}
        onRowClick={(row) => {}}
        renderToolbar={renderToolbar}
        getRowId={(r) => r.ip}
        isLoading={isLoading}
        pageSize={0}
        serverPagination={{
          pageIndex,
          pageCount: enriched?.page_count ?? Math.max(1, Math.ceil(stats.total / HOSTS_PAGE_SIZE)),
          total:     stats.total,
          onPageChange: setPageIndex,
        }}
      />
    </div>
  );
}
