"use client";

import { useMemo, useState } from "react";
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Cell,
} from "recharts";
import {
  Wifi, WifiOff, Activity, Clock,
  AlertTriangle, TrendingUp, TrendingDown, Minus,
} from "lucide-react";
import {
  useHosts, useOutages, useDevices, useScanStatus,
} from "@/hooks/useNetPulse";
import { Spinner } from "@/components/ui";
import { formatDateShort, formatDateTime, cn, uptimeColor } from "@/lib/utils";
import type { HostStats, OutageEvent } from "@/lib/types";

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------
function formatDuration(s: number | null): string {
  if (s == null) return "probíhá";
  if (s < 60) return `${Math.round(s)}s`;
  if (s < 3600) return `${Math.round(s / 60)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Velká metrika nahoře
// ---------------------------------------------------------------------------
function StatCard({
  label, value, sub, icon: Icon, color, trend,
}: {
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ComponentType<{ className?: string }>;
  color?: "green" | "red" | "amber" | "default";
  trend?: "up" | "down" | "flat";
}) {
  const iconColor = {
    green:   "text-green-500",
    red:     "text-red-500",
    amber:   "text-amber-500",
    default: "text-muted-foreground",
  }[color ?? "default"];

  const valueColor = {
    green:   "text-green-600 dark:text-green-400",
    red:     "text-red-600 dark:text-red-400",
    amber:   "text-amber-600 dark:text-amber-400",
    default: "text-foreground",
  }[color ?? "default"];

  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start justify-between">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <div className={cn("rounded-lg bg-muted/60 p-2", iconColor)}>
          <Icon className="h-4 w-4" />
        </div>
      </div>
      <p className={cn("mt-3 text-3xl font-bold tabular-nums", valueColor)}>
        {value}
      </p>
      <div className="mt-1 flex items-center gap-1">
        {trend === "up"   && <TrendingUp   className="h-3.5 w-3.5 text-green-500" />}
        {trend === "down" && <TrendingDown className="h-3.5 w-3.5 text-red-500" />}
        {trend === "flat" && <Minus        className="h-3.5 w-3.5 text-muted-foreground" />}
        {sub && <p className="text-xs text-muted-foreground">{sub}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graf dostupnosti v čase (posledních N hodin — buckety)
// ---------------------------------------------------------------------------
function AvailabilityChart({ hosts }: { hosts: HostStats[] }) {
  // Simulujeme trend z uptime hodnot — rozdělíme do kvintilek
  const data = useMemo(() => {
    if (!hosts.length) return [];
    const buckets = 12; // 12 datových bodů
    const sorted = [...hosts].sort((a, b) =>
      (a.uptime_pct ?? 0) - (b.uptime_pct ?? 0)
    );
    return Array.from({ length: buckets }, (_, i) => {
      const slice = sorted.slice(
        Math.floor((i / buckets) * sorted.length),
        Math.floor(((i + 1) / buckets) * sorted.length)
      );
      const avg = slice.length
        ? slice.reduce((s, h) => s + (h.uptime_pct ?? 0), 0) / slice.length
        : 0;
      const online = slice.filter((h) => h.currently_alive).length;
      return {
        name:   `${i + 1}`,
        uptime: parseFloat(avg.toFixed(1)),
        online,
      };
    });
  }, [hosts]);

  if (!data.length) return (
    <p className="flex h-40 items-center justify-center text-sm text-muted-foreground">
      Žádná data
    </p>
  );

  return (
    <ResponsiveContainer width="100%" height={180}>
      <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <defs>
          <linearGradient id="uptimeGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%"  stopColor="#22c55e" stopOpacity={0.3} />
            <stop offset="95%" stopColor="#22c55e" stopOpacity={0}   />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="name" tick={{ fontSize: 10 }} stroke="hsl(var(--border))" />
        <YAxis domain={[0, 100]} tick={{ fontSize: 10 }} stroke="hsl(var(--border))" unit="%" />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          formatter={(v: number) => [`${v}%`, "Uptime"]}
        />
        <Area
          type="monotone"
          dataKey="uptime"
          stroke="#22c55e"
          strokeWidth={2}
          fill="url(#uptimeGrad)"
        />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Graf RTT distribuce
// ---------------------------------------------------------------------------
function RttDistributionChart({ hosts }: { hosts: HostStats[] }) {
  const data = useMemo(() => {
    const buckets = [
      { label: "<10ms",    min: 0,   max: 10  },
      { label: "10-25ms",  min: 10,  max: 25  },
      { label: "25-50ms",  min: 25,  max: 50  },
      { label: "50-100ms", min: 50,  max: 100 },
      { label: ">100ms",   min: 100, max: Infinity },
    ];
    return buckets.map((b) => ({
      label: b.label,
      count: hosts.filter((h) => {
        const rtt = h.avg_rtt_ms;
        return rtt != null && rtt >= b.min && rtt < b.max;
      }).length,
    }));
  }, [hosts]);

  const colors = ["#22c55e", "#84cc16", "#eab308", "#f97316", "#ef4444"];

  return (
    <ResponsiveContainer width="100%" height={180}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={{ fontSize: 10 }} stroke="hsl(var(--border))" />
        <YAxis tick={{ fontSize: 10 }} stroke="hsl(var(--border))" />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "8px",
            fontSize: "12px",
          }}
          formatter={(v: number) => [v, "IP adres"]}
        />
        <Bar dataKey="count" radius={[4, 4, 0, 0]}>
          {data.map((_, i) => (
            <Cell key={i} fill={colors[i]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Uptime distribuce (kolik hostů je v jaké kategorii)
// ---------------------------------------------------------------------------
function UptimeDistributionChart({ hosts }: { hosts: HostStats[] }) {
  const data = useMemo(() => {
    const cats = [
      { label: "100%",     min: 100, max: 101, color: "#22c55e" },
      { label: "99-100%",  min: 99,  max: 100, color: "#84cc16" },
      { label: "95-99%",   min: 95,  max: 99,  color: "#eab308" },
      { label: "90-95%",   min: 90,  max: 95,  color: "#f97316" },
      { label: "<90%",     min: 0,   max: 90,  color: "#ef4444" },
    ];
    return cats.map((c) => ({
      label: c.label,
      color: c.color,
      count: hosts.filter((h) =>
        h.uptime_pct != null && h.uptime_pct >= c.min && h.uptime_pct < c.max
      ).length,
    }));
  }, [hosts]);

  const total = hosts.length;

  return (
    <div className="space-y-2">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-3">
          <span className="w-16 shrink-0 text-right text-xs font-mono text-muted-foreground">
            {d.label}
          </span>
          <div className="flex-1 h-5 rounded-full bg-muted overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500"
              style={{
                width:      `${total ? (d.count / total) * 100 : 0}%`,
                background: d.color,
              }}
            />
          </div>
          <span className="w-8 shrink-0 text-xs font-medium tabular-nums">
            {d.count}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Nejhorší hostitele (nejnižší uptime)
// ---------------------------------------------------------------------------
function WorstHostsTable({ hosts }: { hosts: HostStats[] }) {
  const worst = useMemo(
    () => [...hosts]
      .filter((h) => h.checks > 0)
      .sort((a, b) => (a.uptime_pct ?? 0) - (b.uptime_pct ?? 0))
      .slice(0, 10),
    [hosts]
  );

  if (!worst.length) return (
    <p className="py-4 text-center text-sm text-muted-foreground">Žádná data</p>
  );

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border">
          <th className="pb-2 text-left text-xs font-medium text-muted-foreground">IP</th>
          <th className="pb-2 text-right text-xs font-medium text-muted-foreground">Uptime</th>
          <th className="pb-2 text-right text-xs font-medium text-muted-foreground">RTT</th>
          <th className="pb-2 text-right text-xs font-medium text-muted-foreground">Poslední scan</th>
        </tr>
      </thead>
      <tbody>
        {worst.map((h) => (
          <tr key={h.ip} className="border-b border-border/50 last:border-0">
            <td className="py-2 font-mono text-xs">{h.ip}</td>
            <td className={cn("py-2 text-right text-xs font-medium tabular-nums",
              uptimeColor(h.uptime_pct ?? 0))}>
              {h.uptime_pct?.toFixed(1)}%
            </td>
            <td className="py-2 text-right text-xs text-muted-foreground tabular-nums">
              {h.avg_rtt_ms ? `${h.avg_rtt_ms.toFixed(1)} ms` : "—"}
            </td>
            <td className="py-2 text-right text-xs text-muted-foreground">
              {formatDateShort(h.last_check)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// ---------------------------------------------------------------------------
// Alerty — aktivní výpadky + posledních 24h
// ---------------------------------------------------------------------------
function AlertsPanel({ outages }: { outages: OutageEvent[] }) {
  const ongoing  = outages.filter((o) => !o.ended_at);
  const resolved = outages.filter((o) => o.ended_at).slice(0, 10);

  return (
    <div className="space-y-3">
      {ongoing.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40">
          <div className="flex items-center gap-2 border-b border-red-200 dark:border-red-900 px-4 py-2.5">
            <AlertTriangle className="h-4 w-4 text-red-500" />
            <p className="text-sm font-medium text-red-700 dark:text-red-300">
              Aktivní výpadky ({ongoing.length})
            </p>
          </div>
          <div className="divide-y divide-red-100 dark:divide-red-900/50">
            {ongoing.map((o, i) => (
              <div key={i} className="flex items-center gap-3 px-4 py-2.5">
                <span className="relative flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-red-400 opacity-75" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-red-500" />
                </span>
                <span className="flex-1 font-mono text-xs text-red-800 dark:text-red-200">{o.ip}</span>
                <span className="text-xs text-red-600 dark:text-red-400">
                  od {formatDateShort(o.started_at)}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {resolved.length > 0 && (
        <div className="rounded-lg border border-border bg-card overflow-hidden">
          <div className="border-b border-border px-4 py-2.5">
            <p className="text-sm font-medium text-muted-foreground">
              Vyřešené výpadky — posledních 24h
            </p>
          </div>
          <table className="w-full">
            <tbody>
              {resolved.map((o, i) => (
                <tr key={i} className="border-b border-border/50 last:border-0 hover:bg-muted/30">
                  <td className="px-4 py-2 font-mono text-xs">{o.ip}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {formatDateTime(o.started_at)}
                  </td>
                  <td className="px-4 py-2 text-right text-xs font-medium">
                    {formatDuration(o.duration_s)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {!ongoing.length && !resolved.length && (
        <div className="flex items-center gap-2 rounded-lg border border-green-200 bg-green-50
                        dark:border-green-900 dark:bg-green-950/40 px-4 py-3">
          <Wifi className="h-4 w-4 text-green-500" />
          <p className="text-sm text-green-700 dark:text-green-300">
            Žádné výpadky za posledních 24 hodin
          </p>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function DashboardPage() {
  const { data: hosts   = [], isLoading: hostsLoading   } = useHosts();
  const { data: outages = [], isLoading: outagesLoading } = useOutages(200, 24);
  const { data: devices = [] }                            = useDevices();
  const { data: status  }                                 = useScanStatus();

  const stats = useMemo(() => {
    const alive   = hosts.filter((h) => h.currently_alive);
    const dead    = hosts.filter((h) => !h.currently_alive);
    const rtts    = hosts.filter((h) => h.avg_rtt_ms != null).map((h) => h.avg_rtt_ms!);
    const ups     = hosts.filter((h) => h.uptime_pct != null).map((h) => h.uptime_pct!);
    const avgRtt  = rtts.length ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null;
    const avgUp   = ups.length  ? ups.reduce((a, b) => a + b, 0)  / ups.length  : null;
    const highRtt = hosts.filter((h) => h.avg_rtt_ms != null && h.avg_rtt_ms > 50).length;

    return { online: alive.length, offline: dead.length, total: hosts.length, avgRtt, avgUp, highRtt };
  }, [hosts]);

  const activeOutages = outages.filter((o) => !o.ended_at).length;

  if (hostsLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="space-y-6">

      {/* ── Řádek 1: Klíčové metriky ── */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          label="Online"
          value={stats.online}
          sub={`z ${stats.total} celkem`}
          icon={Wifi}
          color="green"
        />
        <StatCard
          label="Offline"
          value={stats.offline}
          sub={stats.offline > 0 ? "⚠ pozor" : "vše OK"}
          icon={WifiOff}
          color={stats.offline > 0 ? "red" : "default"}
        />
        <StatCard
          label="Avg RTT"
          value={stats.avgRtt != null ? `${stats.avgRtt.toFixed(1)} ms` : "—"}
          sub={`${stats.highRtt} nad 50ms`}
          icon={Activity}
          color={stats.avgRtt && stats.avgRtt > 50 ? "amber" : "green"}
        />
        <StatCard
          label="Avg uptime"
          value={stats.avgUp != null ? `${stats.avgUp.toFixed(1)}%` : "—"}
          icon={TrendingUp}
          color={!stats.avgUp ? "default" : stats.avgUp >= 99 ? "green" : stats.avgUp >= 90 ? "amber" : "red"}
        />
        <StatCard
          label="Výpadky 24h"
          value={activeOutages > 0 ? `${activeOutages} aktivní` : outages.length}
          sub={activeOutages > 0 ? "právě teď" : "celkem dnes"}
          icon={AlertTriangle}
          color={activeOutages > 0 ? "red" : outages.length > 5 ? "amber" : "default"}
        />
        <StatCard
          label="Zařízení"
          value={devices.length}
          sub={`${status?.scan_count ?? 0} scanů`}
          icon={Clock}
        />
      </div>

      {/* ── Řádek 2: Grafy ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Uptime trend */}
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-semibold">
            Uptime distribuce hostů
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              průměrný uptime dle skupin
            </span>
          </p>
          <AvailabilityChart hosts={hosts} />
        </div>

        {/* RTT distribuce */}
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-semibold">
            Distribuce RTT
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              počet IP adres dle latence
            </span>
          </p>
          <RttDistributionChart hosts={hosts} />
        </div>
      </div>

      {/* ── Řádek 3: Uptime kategorie + Alerty ── */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        {/* Uptime kategorie — horizontální pruhy */}
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-semibold">
            Kategorie dostupnosti
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {hosts.length} IP adres
            </span>
          </p>
          <UptimeDistributionChart hosts={hosts} />
        </div>

        {/* Alerty */}
        <div className="rounded-xl border border-border bg-card p-5">
          <p className="mb-4 text-sm font-semibold">
            Alerty
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              aktivní výpadky a posledních 24h
            </span>
          </p>
          <AlertsPanel outages={outages} />
        </div>
      </div>

      {/* ── Řádek 4: Nejhorší hostitele ── */}
      <div className="rounded-xl border border-border bg-card p-5">
        <p className="mb-4 text-sm font-semibold">
          Nejproblematičtější hostitele
          <span className="ml-2 text-xs font-normal text-muted-foreground">
            seřazeno podle uptime (nejnižší první)
          </span>
        </p>
        <WorstHostsTable hosts={hosts} />
      </div>

    </div>
  );
}
