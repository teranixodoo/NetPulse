"use client";

import { useState, useMemo } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useOutages, useHosts, useDevices } from "@/hooks/useNetPulse";
import { DataTable, TableSearch } from "@/components/table/DataTable";
import { StatusDot, MetricCard, EmptyState, Select } from "@/components/ui";
import { formatDateTime, cn } from "@/lib/utils";
import type { ColumnDef } from "@tanstack/react-table";
import type { OutageEvent } from "@/lib/types";
import { useQueryClient } from "@tanstack/react-query";
import { QK } from "@/hooks/useNetPulse";

// ---------------------------------------------------------------------------
// Rozšířený výpadek s názvem zařízení
// ---------------------------------------------------------------------------
interface OutageRow extends OutageEvent {
  deviceName?: string;
  durationStr: string;
}

// ---------------------------------------------------------------------------
// Sloupce
// ---------------------------------------------------------------------------
const columns: ColumnDef<OutageRow, unknown>[] = [
  {
    accessorKey: "ip",
    header: "IP adresa",
    size: 140,
    cell: ({ getValue }) => (
      <span className="font-mono text-sm">{getValue() as string}</span>
    ),
  },
  {
    accessorKey: "deviceName",
    header: "Zařízení",
    size: 160,
    cell: ({ getValue }) => {
      const v = getValue() as string | undefined;
      return v
        ? <span className="font-medium">{v}</span>
        : <span className="text-muted-foreground">—</span>;
    },
  },
  {
    accessorKey: "started_at",
    header: "Začátek výpadku",
    size: 150,
    cell: ({ getValue }) => (
      <span className="text-sm">{formatDateTime(getValue() as string)}</span>
    ),
  },
  {
    accessorKey: "ended_at",
    header: "Konec",
    size: 150,
    cell: ({ getValue }) => {
      const v = getValue() as string | null;
      return v
        ? <span className="text-sm">{formatDateTime(v)}</span>
        : (
          <span className="flex items-center gap-1.5 text-red-600 dark:text-red-400 text-sm">
            <StatusDot status="offline" />
            probíhá
          </span>
        );
    },
  },
  {
    accessorKey: "durationStr",
    header: "Trvání",
    size: 100,
    cell: ({ getValue }) => (
      <span className="tabular-nums text-sm">{getValue() as string}</span>
    ),
  },
];

// ---------------------------------------------------------------------------
// Formátování doby trvání
// ---------------------------------------------------------------------------
function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60)   return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}min`;
  return `${(seconds / 3600).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
const HOURS_OPTIONS = [
  { label: "Posledních 1h",  value: 1   },
  { label: "Posledních 6h",  value: 6   },
  { label: "Posledních 24h", value: 24  },
  { label: "Posledních 48h", value: 48  },
  { label: "Posledních 7d",  value: 168 },
];

export default function LogsPage() {
  const [hours,        setHours]        = useState(24);
  const [globalFilter, setGlobalFilter] = useState("");
  const qc = useQueryClient();

  const { data: outages = [], isLoading } = useOutages(200, hours);
  const { data: devices = [] }            = useDevices();
  const { data: hosts   = [] }            = useHosts();

  // Mapa IP → hostname
  const ipToDevice = useMemo(() => {
    const m = new Map<string, string>();
    for (const d of devices) {
      m.set(d.ip.split("/")[0], d.alias ?? d.hostname);
    }
    return m;
  }, [devices]);

  const rows = useMemo<OutageRow[]>(() =>
    outages.map((o) => ({
      ...o,
      deviceName:  ipToDevice.get(o.ip.split("/")[0]),
      durationStr: formatDuration(o.duration_s),
    })),
    [outages, ipToDevice]
  );

  // Statistiky
  const stats = useMemo(() => {
    const ongoing  = rows.filter((r) => !r.ended_at).length;
    const resolved = rows.filter((r) => r.ended_at).length;
    const durations = rows.filter((r) => r.duration_s != null).map((r) => r.duration_s!);
    const avgDur = durations.length
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : null;
    return { total: rows.length, ongoing, resolved, avgDur };
  }, [rows]);

  return (
    <div className="space-y-4">
      {/* Metriky */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <MetricCard label="Celkem výpadků" value={stats.total} />
        <MetricCard
          label="Probíhající"
          value={stats.ongoing}
          color={stats.ongoing > 0 ? "red" : "default"}
        />
        <MetricCard label="Vyřešené"    value={stats.resolved} color="green" />
        <MetricCard
          label="Průměrná délka"
          value={formatDuration(stats.avgDur)}
        />
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <TableSearch
          value={globalFilter}
          onChange={setGlobalFilter}
          placeholder="Hledat IP, zařízení…"
          className="w-64"
        />
        <Select
          value={String(hours)}
          onChange={(e) => setHours(Number(e.target.value))}
          className="w-44"
        >
          {HOURS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
        <button
          onClick={() => qc.invalidateQueries({ queryKey: [...QK.outages, hours] })}
          className="flex items-center gap-1.5 rounded-md border border-border
                     px-3 py-1.5 text-sm text-muted-foreground
                     hover:bg-accent hover:text-foreground transition-colors"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Obnovit
        </button>
        <span className="ml-auto text-xs text-muted-foreground">
          {rows.length} výpadků
        </span>
      </div>

      {/* Tabulka */}
      <DataTable<OutageRow>
        data={rows}
        columns={columns}
        isLoading={isLoading}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        getRowId={(row) => `${row.ip}-${row.started_at}`}
        emptyMessage="Žádné výpadky v zadaném období."
      />
    </div>
  );
}
