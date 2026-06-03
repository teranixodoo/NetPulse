"use client";

import { useState } from "react";
import { History, RefreshCw } from "lucide-react";
import { useChangeLog } from "@/hooks/useNetPulse";
import { Button, Select, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { ChangeEvent } from "@/lib/types";

const EVENT_LABELS: Record<string, { label: string; color: string }> = {
  online:           { label: "Online",        color: "text-green-600" },
  offline:          { label: "Offline",       color: "text-red-500" },
  ip_changed:       { label: "Změna IP",      color: "text-blue-500" },
  hostname_changed: { label: "Změna hostname",color: "text-amber-500" },
  mac_seen:         { label: "MAC viděn",     color: "text-purple-500" },
  new_ip:           { label: "Nová IP",       color: "text-cyan-500" },
  ip_disappeared:   { label: "IP zmizela",    color: "text-orange-500" },
};

function EventBadge({ type }: { type: string }) {
  const cfg = EVENT_LABELS[type] ?? { label: type, color: "text-muted-foreground" };
  return <span className={cn("text-xs font-medium", cfg.color)}>{cfg.label}</span>;
}

function formatDt(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString("cs-CZ", { day:"2-digit", month:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit" });
}

function MetaCell({ ev }: { ev: ChangeEvent }) {
  if (ev.event_type === "ip_changed" && ev.old_value && ev.new_value) {
    return (
      <span className="font-mono text-xs">
        {(ev.old_value as any).ip} → {(ev.new_value as any).ip}
      </span>
    );
  }
  if (ev.event_type === "hostname_changed" && ev.old_value && ev.new_value) {
    return (
      <span className="text-xs">
        {(ev.old_value as any).hostname} → {(ev.new_value as any).hostname}
      </span>
    );
  }
  if (ev.meta) {
    const m = ev.meta as any;
    if (m.new_ip) return <span className="font-mono text-xs">→ {m.new_ip}</span>;
  }
  if (ev.event_type === "offline" && ev.last_online) {
    const diff = Math.floor((new Date(ev.occurred_at).getTime() - new Date(ev.last_online).getTime()) / 1000);
    if (diff > 0 && diff < 86400) {
      const m = Math.floor(diff / 60);
      const h = Math.floor(diff / 3600);
      const label = h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
      return <span className="text-xs text-muted-foreground">naposledy online před {label}</span>;
    }
  }
  if (ev.event_type === "online" && ev.last_online) {
    return <span className="text-xs text-muted-foreground">{ev.source === "arp" ? "ARP" : ev.source === "dhcp" ? "DHCP" : "ping"}</span>;
  }
  return null;
}

const EVENT_TYPE_OPTIONS = [
  { value: "",                label: "Vše — typ" },
  { value: "online,offline",  label: "Online / Offline" },
  { value: "ip_changed",      label: "Změny IP" },
  { value: "hostname_changed",label: "Změny hostname" },
];

export default function ChangeLogPage() {
  const [hours,      setHours]      = useState(24);
  const [eventFilter,setEventFilter]= useState("");

  const { data: events = [], isLoading, refetch, isFetching } =
    useChangeLog(hours, undefined, eventFilter || undefined);

  const ipEvents     = events.filter(e => e.log_type === "ip");
  const deviceEvents = events.filter(e => e.log_type === "device");

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <History size={20} className="text-primary" /> Log změn
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Přehled změn IP adres a zařízení — online/offline, změny IP, hostname
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => refetch()} disabled={isFetching}>
          <RefreshCw size={14} className={isFetching ? "animate-spin" : ""} />
        </Button>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={hours} onChange={e => setHours(Number(e.target.value))} className="w-36">
          <option value={6}>Posledních 6h</option>
          <option value={24}>Posledních 24h</option>
          <option value={72}>Posledních 3 dny</option>
          <option value={168}>Posledních 7 dní</option>
        </Select>
        <Select value={eventFilter} onChange={e => setEventFilter(e.target.value)} className="w-48">
          {EVENT_TYPE_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </Select>
        <span className="text-xs text-muted-foreground ml-auto">
          {ipEvents.length} IP událostí · {deviceEvents.length} změn zařízení
        </span>
      </div>

      {/* Feed */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner className="h-6 w-6" /></div>
      ) : events.length === 0 ? (
        <div className="rounded-lg border border-border bg-card py-12 text-center text-sm text-muted-foreground">
          Žádné události v daném období
        </div>
      ) : (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
                <th className="text-left px-4 py-2 w-36">Čas</th>
                <th className="text-left px-4 py-2 w-28">Událost</th>
                <th className="text-left px-4 py-2">IP</th>
              <th className="text-left px-4 py-2">Síť</th>
                <th className="text-left px-4 py-2">Zařízení</th>
              <th className="text-left px-4 py-2">MAC</th>
                <th className="text-left px-4 py-2">Detail</th>
                <th className="text-left px-4 py-2">Last online</th>
              <th className="text-left px-4 py-2 w-16">Zdroj</th>
              </tr>
            </thead>
            <tbody>
              {events.map(ev => (
                <tr key={`${ev.log_type}-${ev.id}`}
                  className="border-b border-border hover:bg-muted/20">
                  <td className="px-4 py-2 text-xs text-muted-foreground tabular-nums">
                    {formatDt(ev.occurred_at)}
                  </td>
                  <td className="px-4 py-2">
                    <EventBadge type={ev.event_type} />
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{ev.ip ?? "—"}</td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {ev.site_name ? <span>{ev.site_name}</span> : null}
                    {ev.range_label ? <span className="ml-1 text-muted-foreground/70">{ev.range_label}</span> : "—"}
                  </td>
                  <td className="px-4 py-2 text-muted-foreground text-xs">
                    {ev.alias || ev.hostname || "—"}
                  </td>
                  <td className="px-4 py-2 font-mono text-xs text-muted-foreground">
                    {ev.mac ?? "—"}
                  </td>
                  <td className="px-4 py-2"><MetaCell ev={ev} /></td>
                  <td className="px-4 py-2 text-xs text-muted-foreground tabular-nums">
                    {ev.last_online ? formatDt(ev.last_online) : "—"}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted-foreground">
                    {ev.source ?? "—"}
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
