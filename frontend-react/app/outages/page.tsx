"use client";

import { useState } from "react";
import { AlertTriangle, RefreshCw } from "lucide-react";
import { useOutagesNew, useOutageStats } from "@/hooks/useNetPulse";
import { Button, Select, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { Outage } from "@/lib/types";

function formatDuration(s: number | null): string {
  if (!s) return "—";
  if (s < 60)   return `${s}s`;
  if (s < 3600) return `${Math.floor(s/60)}m ${s%60}s`;
  return `${Math.floor(s/3600)}h ${Math.floor((s%3600)/60)}m`;
}

function formatDt(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("cs-CZ", { day:"2-digit", month:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

function ResolutionBadge({ r }: { r: string | null }) {
  if (!r) return <span className="text-xs text-amber-500 font-medium">● Aktivní</span>;
  if (r === "recovered")  return <span className="text-xs text-green-600 font-medium">✓ Obnoveno</span>;
  if (r === "ip_changed") return <span className="text-xs text-blue-500 font-medium">⇄ Změna IP</span>;
  return <span className="text-xs text-muted-foreground">? {r}</span>;
}

export default function OutagesPage() {
  const [hours,      setHours]      = useState(24);
  const [activeOnly, setActiveOnly] = useState(false);
  const [minDuration, setMinDuration] = useState(120); // 2 minuty výchozí

  const { data: outages = [], isLoading, refetch, isFetching } = useOutagesNew(hours, activeOnly, 200, minDuration);
  const { data: stats } = useOutageStats(hours);

  const realOutages   = outages.filter(o => o.resolution !== "ip_changed");
  const ipChanges     = outages.filter(o => o.resolution === "ip_changed");

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <AlertTriangle size={20} className="text-red-500" /> Log výpadků
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Skutečné výpadky zařízení a změny IP adres
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* Statistiky */}
      {stats && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
          {[
            { label: "Aktivní výpadky",  value: stats.active,       color: "text-red-500" },
            { label: "Obnoveno",         value: stats.recovered,    color: "text-green-600" },
            { label: "Změny IP",         value: stats.ip_changes,   color: "text-blue-500" },
            { label: "Průměrná délka",   value: formatDuration(stats.avg_duration_s), color: "" },
            { label: "Nejdelší výpadek", value: formatDuration(stats.max_duration_s), color: "" },
          ].map(s => (
            <div key={s.label} className="rounded-lg border border-border bg-card p-3">
              <p className="text-xs text-muted-foreground">{s.label}</p>
              <p className={cn("text-xl font-bold mt-1", s.color)}>{s.value}</p>
            </div>
          ))}
        </div>
      )}

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={hours} onChange={e => setHours(Number(e.target.value))} className="w-36">
          <option value={6}>Posledních 6h</option>
          <option value={24}>Posledních 24h</option>
          <option value={72}>Posledních 3 dny</option>
          <option value={168}>Posledních 7 dní</option>
          <option value={720}>Posledních 30 dní</option>
        </Select>
        <label className="flex items-center gap-2 text-sm cursor-pointer">
          <input type="checkbox" checked={activeOnly}
            onChange={e => setActiveOnly(e.target.checked)} className="h-4 w-4" />
          Pouze aktivní
        </label>
        <Select value={minDuration} onChange={e => setMinDuration(Number(e.target.value))} className="w-40">
          <option value={0}>Vše — délka</option>
          <option value={60}>Min. 1 minuta</option>
          <option value={120}>Min. 2 minuty</option>
          <option value={300}>Min. 5 minut</option>
          <option value={600}>Min. 10 minut</option>
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">
          {realOutages.length} výpadků · {ipChanges.length} změn IP
        </span>
      </div>

      {/* Tabulka */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner className="h-6 w-6" /></div>
      ) : outages.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          Žádné výpadky v daném období
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th className="text-left px-4 py-2">Stav</th>
                <th className="text-left px-4 py-2">IP</th>
                <th className="text-left px-4 py-2">Zařízení</th>
                <th className="text-left px-4 py-2">Začátek</th>
                <th className="text-left px-4 py-2">Konec</th>
                <th className="text-left px-4 py-2">Last online</th>
              <th className="text-right px-4 py-2">Délka</th>
              </tr>
            </thead>
            <tbody>
              {outages.map(o => (
                <tr key={o.id}
                  className={cn("border-b border-border hover:bg-muted/20",
                    o.is_active && o.resolution !== "ip_changed" && "bg-red-500/5")}>
                  <td className="px-4 py-2"><ResolutionBadge r={o.resolution} /></td>
                  <td className="px-4 py-2 font-mono text-xs">{o.ip}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {o.site_name && <span>{o.site_name} </span>}
                    {o.range_label || "—"}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">
                    {o.alias || o.hostname || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {o.mac ?? "—"}
                  </td>
                  <td className="px-4 py-2 text-xs">{formatDt(o.started_at)}</td>
                  <td className="px-4 py-2 text-xs">{formatDt(o.ended_at)}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {formatDt(o.last_online)}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">
                    {formatDuration(o.duration_s)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
