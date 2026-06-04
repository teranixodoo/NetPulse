"use client";

import { type ColumnDef } from "@tanstack/react-table";
import type { Device, HostStats } from "@/lib/types";
import { cn, inetSortingFn, formatDateShort, getDeviceStatus } from "@/lib/utils";
import { StatusDot, Badge } from "@/components/ui";

// ---------------------------------------------------------------------------
// Sloučená data zařízení + host stats
// ---------------------------------------------------------------------------
export interface DeviceRow extends Device {
  hostInfo?: HostStats;
}

// ---------------------------------------------------------------------------
// Status cell
// ---------------------------------------------------------------------------
function StatusCell({ hostInfo }: { hostInfo?: HostStats }) {
  const status = getDeviceStatus(hostInfo?.currently_alive);
  return (
    <div className="flex items-center gap-2">
      <StatusDot status={status} />
      <span className={cn(
        "text-xs",
        status === "online"  && "text-green-700 dark:text-green-400",
        status === "offline" && "text-red-700 dark:text-red-400",
        status === "unknown" && "text-muted-foreground",
      )}>
        {status === "online" ? "online" : status === "offline" ? "offline" : "—"}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Uptime cell s barevným indikátorem
// ---------------------------------------------------------------------------
function UptimeCell({ value }: { value?: number | null }) {
  if (value == null) return <span className="text-muted-foreground">—</span>;
  const color =
    value >= 99 ? "text-green-700 dark:text-green-400" :
    value >= 90 ? "text-amber-700 dark:text-amber-400" :
                  "text-red-700 dark:text-red-400";
  return (
    <span className={cn("tabular-nums text-sm", color)}>
      {value.toFixed(1)} %
    </span>
  );
}

// ---------------------------------------------------------------------------
// Definice sloupců
// ---------------------------------------------------------------------------
export function getDeviceColumns(): ColumnDef<DeviceRow, unknown>[] {
  return [
    {
      id: "status",
      header: "Stav",
      size: 90,
      accessorFn: (row) => row.hostInfo?.currently_alive,
      cell: ({ row }) => <StatusCell hostInfo={row.original.hostInfo} />,
      sortingFn: (a, b) => {
        const av = a.original.hostInfo?.currently_alive;
        const bv = b.original.hostInfo?.currently_alive;
        if (av === bv) return 0;
        if (av === true) return -1;
        if (bv === true) return 1;
        if (av === false) return -1;
        return 1;
      },
    },
    {
      accessorKey: "hostname",
      header: "Hostname",
      size: 160,
      cell: ({ getValue, row }) => (
        <div>
          <p className="font-medium text-sm">{getValue() as string}</p>
          {row.original.alias && (
            <p className="text-xs text-muted-foreground">{row.original.alias}</p>
          )}
        </div>
      ),
    },
    {
      accessorKey: "ip",
      header: "IP adresa",
      sortingFn: inetSortingFn,
      size: 130,
      cell: ({ getValue }) => (
        <span className="font-mono text-xs">{getValue() as string}</span>
      ),
    },
    {
      accessorKey: "ownership",
      header: "Uživatel",
      size: 100,
      cell: ({ row }) => {
        const o = (row.original.ownership ?? "isp") as string;
        return (
          <span className={cn(
            "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
            o === "isp"     && "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300",
            o === "client"  && "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
            o === "unknown" && "bg-muted text-muted-foreground",
          )}>
            {o === "isp" ? "ISP" : o === "client" ? "Klient" : "—"}
          </span>
        );
      },
    },
    {
      accessorKey: "location_name",
      header: "Lokace",
      size: 140,
      cell: ({ getValue }) => {
        const v = getValue() as string | null;
        return v
          ? <span className="text-xs">{v}</span>
          : <span className="text-muted-foreground text-xs">—</span>;
      },
    },
    {
      accessorKey: "device_type",
      header: "Typ",
      size: 100,
      cell: ({ getValue }) => {
        const v = getValue() as string;
        return v && v !== "unknown"
          ? <Badge variant="outline">{v}</Badge>
          : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      accessorKey: "vendor",
      header: "Výrobce",
      size: 120,
      cell: ({ getValue }) => {
        const v = getValue() as string | null;
        return v ? <span className="text-sm">{v}</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      accessorKey: "mac",
      header: "MAC",
      size: 150,
      cell: ({ getValue }) => {
        const v = getValue() as string | null;
        return v
          ? <span className="font-mono text-xs">{v}</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "uptime",
      header: "Uptime",
      size: 85,
      accessorFn: (row) => row.hostInfo?.uptime_pct,
      cell: ({ row }) => <UptimeCell value={row.original.hostInfo?.uptime_pct} />,
      sortingFn: (a, b) => {
        const av = a.original.hostInfo?.uptime_pct ?? -1;
        const bv = b.original.hostInfo?.uptime_pct ?? -1;
        return av - bv;
      },
    },
    {
      id: "rtt",
      header: "RTT",
      size: 80,
      accessorFn: (row) => row.hostInfo?.avg_rtt_ms,
      cell: ({ row }) => {
        const v = row.original.hostInfo?.avg_rtt_ms;
        return v != null
          ? <span className="tabular-nums text-sm">{v.toFixed(1)} ms</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },
    {
      id: "last_scan",
      header: "Poslední scan",
      size: 110,
      accessorFn: (row) => row.hostInfo?.last_check,
      cell: ({ row }) => (
        <span className="text-xs text-muted-foreground">
          {formatDateShort(row.original.hostInfo?.last_check)}
        </span>
      ),
    },
    {
      id: "last_poll",
      header: "Poslední poll",
      accessorFn: (row) => (row as any).last_polled_at,
      cell: ({ row }) => {
        const r = row.original as any;
        if (!r.last_polled_at) return <span className="text-muted-foreground text-xs">—</span>;
        const MC: Record<string,string> = {
          api:  "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
          snmp: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
          ssh:  "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
          http: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
        };
        const d = new Date(r.last_polled_at);
        const fmt = `${d.getDate().toString().padStart(2,"0")}.${(d.getMonth()+1).toString().padStart(2,"0")}. ${d.getHours().toString().padStart(2,"0")}:${d.getMinutes().toString().padStart(2,"0")}`;
        return (
          <div className="flex items-center gap-1.5 flex-wrap">
            {r.last_poll_method && (
              <span className={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${MC[r.last_poll_method] ?? "bg-muted text-muted-foreground"}`}>
                {r.last_poll_method.toUpperCase()}
              </span>
            )}
            <span className="text-xs text-muted-foreground">{fmt}</span>
          </div>
        );
      },
    },
    {
      id: "fw_uptime",
      header: "Uptime zař.",
      // Řadíme podle sekund (přesné), zobrazujeme originální string ze zařízení
      accessorFn: (row) => (row as any).last_uptime_s ?? -1,
      cell: ({ row }) => {
        const r = row.original as any;
        // Preferujeme originální string ze zařízení (přesný, včetně minut)
        if (r.last_uptime_str) {
          return <span className="text-xs font-mono tabular-nums">{r.last_uptime_str}</span>;
        }
        // Fallback: výpočet ze sekund pokud string není k dispozici
        const s = r.last_uptime_s as number | null;
        if (!s) return <span className="text-muted-foreground text-xs">—</span>;
        const w = Math.floor(s / 604800);
        const d = Math.floor((s % 604800) / 86400);
        const h = Math.floor((s % 86400) / 3600);
        const m = Math.floor((s % 3600) / 60);
        const text = w ? `${w}t ${d}d ${h}h` : d ? `${d}d ${h}h` : `${h}h ${m}m`;
        return <span className="text-xs font-mono tabular-nums text-muted-foreground" title="Vypočteno ze sekund">{text}</span>;
      },
    },
    {
      accessorKey: "created_at",
      header: "Vytvořeno",
      size: 100,
      cell: ({ getValue }) => (
        <span className="text-xs text-muted-foreground">
          {formatDateShort(getValue() as string)}
        </span>
      ),
    },
  ];
}
