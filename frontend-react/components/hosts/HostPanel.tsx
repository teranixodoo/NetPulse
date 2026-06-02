"use client";

import type { HostRow } from "./HostColumns";
import type { Device } from "@/lib/types";
import { StatusDot } from "@/components/ui";
import { formatDateTime, getDeviceStatus, cn, uptimeColor } from "@/lib/utils";
import { useRttTrend } from "@/hooks/useNetPulse";
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from "recharts";
import { format, parseISO } from "date-fns";

// ---------------------------------------------------------------------------
// RTT trend mini-graf
// ---------------------------------------------------------------------------
function RttMiniChart({ ip }: { ip: string }) {
  const { data, isLoading } = useRttTrend(ip, 24);

  if (isLoading) return (
    <p className="text-xs text-muted-foreground">Načítám graf…</p>
  );
  if (!data?.points?.length) return (
    <p className="text-xs text-muted-foreground">Žádná data pro graf</p>
  );

  const points = data.points.map((p) => ({
    ts:  p.ts,
    rtt: p.rtt_ms,
    label: (() => {
      try { return format(parseISO(p.ts), "HH:mm"); } catch { return ""; }
    })(),
  }));

  return (
    <ResponsiveContainer width="100%" height={100}>
      <LineChart data={points} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="hsl(var(--border))"
               interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--border))" unit="ms" />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
            fontSize: "11px",
          }}
          formatter={(v) => [v != null ? `${Number(v).toFixed(1)} ms` : "offline", "RTT"]}
        />
        <Line
          type="monotone"
          dataKey="rtt"
          stroke="#3b82f6"
          strokeWidth={1.5}
          dot={false}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Detailní panel hostitele
// ---------------------------------------------------------------------------
export function HostPanel({ host }: { host: HostRow }) {
  const status = getDeviceStatus(host.currently_alive);
  const d      = host.device;

  return (
    <div
      className="border-l-4 border-primary bg-background p-4"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">

        {/* Blok 1 — Ping statistiky */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Ping statistiky
          </p>
          <div className="grid grid-cols-2 gap-2 text-sm">
            {[
              ["Stav",         <div className="flex items-center gap-1.5" key="s"><StatusDot status={status} />{status}</div>],
              ["Uptime",       <span key="u" className={cn("font-medium", uptimeColor(host.uptime_pct))}>{host.uptime_pct.toFixed(2)} %</span>],
              ["Avg RTT",      host.avg_rtt_ms ? `${host.avg_rtt_ms.toFixed(2)} ms` : "—"],
              ["Min RTT",      host.min_rtt_ms ? `${host.min_rtt_ms.toFixed(2)} ms` : "—"],
              ["Max RTT",      host.max_rtt_ms ? `${host.max_rtt_ms.toFixed(2)} ms` : "—"],
              ["Packet loss",  host.avg_loss_pct != null ? `${host.avg_loss_pct.toFixed(2)} %` : "—"],
              ["Měření",       host.checks.toLocaleString()],
              ["Poslední scan",formatDateTime(host.last_check)],
            ].map(([label, val]) => (
              <div key={String(label)}>
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="mt-0.5 font-medium text-sm">{val}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Blok 2 — Přiřazené zařízení */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Přiřazené zařízení
          </p>
          {d ? (
            <div className="space-y-2 text-sm">
              {[
                ["Hostname",     d.hostname],
                ["Alias",        d.alias ?? "—"],
                ["Typ",          d.device_type !== "unknown" ? d.device_type : "—"],
                ["Výrobce",      d.vendor ?? "—"],
                ["MAC",          d.mac ?? "—"],
                ["Sériové číslo",d.serial_number ?? "—"],
                ["Profily",      d.credentials?.length
                  ? d.credentials.map((c) => c.name).join(", ")
                  : "—"],
              ].map(([label, val]) => (
                <div key={String(label)} className="grid grid-cols-2 gap-1">
                  <p className="text-xs text-muted-foreground">{label}</p>
                  <p className="text-xs font-medium break-all">{val}</p>
                </div>
              ))}
              {d.description && (
                <div className="mt-2 rounded-md bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                  {d.description}
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border p-4 text-center">
              <p className="text-xs text-muted-foreground">Žádné zařízení nepřiřazeno</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Přiřaďte v sekci Evidence zařízení
              </p>
            </div>
          )}
        </div>

        {/* Blok 3 — RTT trend */}
        <div className="space-y-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            RTT trend — posledních 24h
          </p>
          <RttMiniChart ip={host.ip.split("/")[0]} />
        </div>

      </div>
    </div>
  );
}
