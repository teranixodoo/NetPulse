"use client";

import { type ColumnDef } from "@tanstack/react-table";
import type { HostStats, Device } from "@/lib/types";
import { cn, formatDateShort, getDeviceStatus } from "@/lib/utils";
import { StatusDot, Badge } from "@/components/ui";

// ---------------------------------------------------------------------------
// Rozšířený řádek — HostStats + přiřazené zařízení
// ---------------------------------------------------------------------------
export interface HostRow extends HostStats {
  device?: Device;
}

// ---------------------------------------------------------------------------
// Uptime cell s barvou
// ---------------------------------------------------------------------------
function UptimeCell({ value }: { value: number }) {
  const color =
    value >= 99 ? "text-green-700 dark:text-green-400" :
    value >= 90 ? "text-amber-700 dark:text-amber-400" :
                  "text-red-700 dark:text-red-400";
  return (
    <span className={cn("tabular-nums text-sm font-medium", color)}>
      {value.toFixed(1)} %
    </span>
  );
}

// ---------------------------------------------------------------------------
// Packet loss cell
// ---------------------------------------------------------------------------
function LossCell({ value }: { value: number }) {
  const color =
    value === 0 ? "text-muted-foreground" :
    value < 5   ? "text-amber-600 dark:text-amber-400" :
                  "text-red-600 dark:text-red-400";
  return (
    <span className={cn("tabular-nums text-xs", color)}>
      {value.toFixed(1)} %
    </span>
  );
}

// ---------------------------------------------------------------------------
// Definice sloupců
// ---------------------------------------------------------------------------
export function getHostColumns(): ColumnDef<HostRow, unknown>[] {
  return [
    // Stav
    {
      id: "status",
      header: "Stav",
      size: 90,
      accessorFn: (row) => row.currently_alive,
      cell: ({ row }) => {
        const status = getDeviceStatus(row.original.currently_alive);
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
      },
      sortingFn: (a, b) => {
        const av = a.original.currently_alive;
        const bv = b.original.currently_alive;
        if (av === bv) return 0;
        return av ? -1 : 1;
      },
    },

    // IP adresa
    {
      accessorKey: "ip",
      header: "IP adresa",
      size: 140,
      cell: ({ getValue }) => (
        <span className="font-mono text-sm">{getValue() as string}</span>
      ),
    },

    // Zařízení (hostname + alias)
    {
      id: "device",
      header: "Zařízení",
      size: 180,
      accessorFn: (row) => row.device?.hostname ?? "",
      cell: ({ row }) => {
        const d = row.original.device;
        if (!d) return <span className="text-muted-foreground text-xs">—</span>;
        return (
          <div>
            <p className="font-medium text-sm">{d.hostname}</p>
            {d.alias && (
              <p className="text-xs text-muted-foreground">{d.alias}</p>
            )}
          </div>
        );
      },
    },

    // Typ zařízení
    {
      id: "device_type",
      header: "Typ",
      size: 100,
      accessorFn: (row) => row.device?.device_type ?? "",
      cell: ({ row }) => {
        const t = row.original.device?.device_type;
        return t && t !== "unknown"
          ? <Badge variant="outline">{t}</Badge>
          : <span className="text-muted-foreground">—</span>;
      },
    },

    // Výrobce
    {
      id: "vendor",
      header: "Výrobce",
      size: 110,
      accessorFn: (row) => row.device?.vendor ?? "",
      cell: ({ row }) => {
        const v = row.original.device?.vendor;
        return v
          ? <span className="text-sm">{v}</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },

    // Uptime
    {
      accessorKey: "uptime_pct",
      header: "Uptime",
      size: 90,
      cell: ({ getValue }) => <UptimeCell value={getValue() as number} />,
    },

    // Avg RTT
    {
      accessorKey: "avg_rtt_ms",
      header: "Avg RTT",
      size: 85,
      cell: ({ getValue }) => {
        const v = getValue() as number | null;
        return v != null
          ? <span className="tabular-nums text-sm">{v.toFixed(1)} ms</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },

    // Min RTT
    {
      accessorKey: "min_rtt_ms",
      header: "Min RTT",
      size: 80,
      cell: ({ getValue }) => {
        const v = getValue() as number | null;
        return v != null
          ? <span className="tabular-nums text-xs text-muted-foreground">{v.toFixed(1)} ms</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },

    // Max RTT
    {
      accessorKey: "max_rtt_ms",
      header: "Max RTT",
      size: 80,
      cell: ({ getValue }) => {
        const v = getValue() as number | null;
        return v != null
          ? <span className="tabular-nums text-xs text-muted-foreground">{v.toFixed(1)} ms</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },

    // Packet loss
    {
      accessorKey: "avg_loss_pct",
      header: "Packet loss",
      size: 90,
      cell: ({ getValue }) => <LossCell value={getValue() as number} />,
    },

    // Počet měření
    {
      accessorKey: "checks",
      header: "Měření",
      size: 75,
      cell: ({ getValue }) => (
        <span className="tabular-nums text-xs text-muted-foreground">
          {(getValue() as number).toLocaleString()}
        </span>
      ),
    },

    // Poslední scan
    {
      accessorKey: "last_check",
      header: "Poslední scan",
      size: 120,
      cell: ({ getValue }) => (
        <span className="text-xs text-muted-foreground">
          {formatDateShort(getValue() as string | null)}
        </span>
      ),
    },

    // MAC (z přiřazeného zařízení)
    {
      id: "mac",
      header: "MAC",
      size: 140,
      accessorFn: (row) => row.device?.mac ?? "",
      cell: ({ row }) => {
        const m = row.original.device?.mac;
        return m
          ? <span className="font-mono text-xs">{m}</span>
          : <span className="text-muted-foreground">—</span>;
      },
    },
  ];
}
