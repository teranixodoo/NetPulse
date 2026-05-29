"use client";

import { useState } from "react";
import { AlertTriangle, ChevronRight, ChevronDown, Plus, RefreshCw, Network } from "lucide-react";
import { useUnknownNetworks, useUnknownNetworkIps } from "@/hooks/useNetPulse";
import { Button, Spinner } from "@/components/ui";
import type { UnknownNetwork, UnknownNetworkIp } from "@/lib/types";

function srcBadge(src: string) {
  const color = src === "arp"
    ? "bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300"
    : "bg-yellow-100 text-yellow-700 dark:bg-yellow-950/40 dark:text-yellow-300";
  return (
    <span key={src} className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ${color}`}>
      {src === "arp" ? "🔵" : "🟡"} {src.toUpperCase()}
    </span>
  );
}

function NetworkRow({ net, onAddRange }: {
  net:        UnknownNetwork;
  onAddRange: (subnet: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const { data: ips = [], isLoading } = useUnknownNetworkIps(open ? net.subnet : null) as {
    data: UnknownNetworkIp[];
    isLoading: boolean;
  };

  return (
    <div className="border border-border rounded-lg overflow-hidden mb-2">
      <div
        className="flex items-center gap-3 px-4 py-3 bg-card hover:bg-muted/30 cursor-pointer transition-colors"
        onClick={() => setOpen(!open)}
      >
        <button className="text-muted-foreground shrink-0">
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <span className="font-mono text-sm font-medium w-36 shrink-0">{net.subnet}</span>
        <span className="text-sm text-muted-foreground w-28 shrink-0">
          {net.ip_count} {net.ip_count === 1 ? "adresa" : net.ip_count < 5 ? "adresy" : "adres"}
        </span>
        <div className="flex gap-1 shrink-0">
          {(net.sources as string[]).map(srcBadge)}
        </div>
        <span className="text-xs text-muted-foreground ml-auto shrink-0">
          {net.last_seen
            ? new Date(net.last_seen).toLocaleString("cs-CZ", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
            : "—"}
        </span>
        <Button
          size="sm"
          variant="outline"
          className="shrink-0 ml-2 gap-1 text-xs"
          onClick={(e) => { e?.stopPropagation(); onAddRange(net.subnet); }}
        >
          <Plus size={12} /> Přidat rozsah
        </Button>
      </div>

      {open && (
        <div className="border-t border-border bg-muted/10">
          {isLoading ? (
            <div className="flex items-center gap-2 px-6 py-3 text-sm text-muted-foreground">
              <Spinner className="h-4 w-4" /> Načítám...
            </div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/50 text-muted-foreground">
                  <th className="text-left px-6 py-2 font-medium">IP adresa</th>
                  <th className="text-left px-3 py-2 font-medium">MAC adresa</th>
                  <th className="text-left px-3 py-2 font-medium">Zdroj</th>
                  <th className="text-left px-3 py-2 font-medium">Naposledy viděno</th>
                </tr>
              </thead>
              <tbody>
                {ips.map((ip: UnknownNetworkIp) => (
                  <tr key={ip.ip} className="border-b border-border/30 last:border-0 hover:bg-muted/20">
                    <td className="px-6 py-1.5 font-mono">{ip.ip.replace("/32", "")}</td>
                    <td className="px-3 py-1.5 font-mono text-muted-foreground">{ip.mac || "—"}</td>
                    <td className="px-3 py-1.5">
                      <div className="flex gap-1">{(ip.sources as string[]).map(srcBadge)}</div>
                    </td>
                    <td className="px-3 py-1.5 text-muted-foreground">
                      {ip.last_seen
                        ? new Date(ip.last_seen).toLocaleString("cs-CZ", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
                        : "—"}
                    </td>
                  </tr>
                ))}
                {ips.length === 0 && (
                  <tr><td colSpan={4} className="px-6 py-3 text-muted-foreground">Žádná data</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}

export default function UnknownNetworksPage() {
  const { data: networks = [], isLoading, refetch } = useUnknownNetworks() as {
    data: UnknownNetwork[];
    isLoading: boolean;
    refetch: () => void;
  };

  const totalIps = networks.reduce((s: number, n: UnknownNetwork) => s + n.ip_count, 0);

  function handleAddRange(subnet: string) {
    window.location.href = `/ranges?add=${encodeURIComponent(subnet)}`;
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <AlertTriangle size={20} className="text-amber-500" />
            Neznámé sítě
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Privátní IP viditelné v ARP/DHCP tabulkách routerů, ale mimo evidované rozsahy
          </p>
        </div>
        <Button variant="outline" size="sm" className="gap-2" onClick={() => refetch()}>
          <RefreshCw size={14} /> Obnovit
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Neznámé sítě</p>
          <p className="text-2xl font-bold mt-1 text-amber-500">{networks.length}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Celkem IP</p>
          <p className="text-2xl font-bold mt-1">{totalIps}</p>
        </div>
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-xs text-muted-foreground">Největší síť</p>
          <p className="text-lg font-bold mt-1 font-mono">{networks[0]?.subnet ?? "—"}</p>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Spinner className="h-8 w-8" />
        </div>
      ) : networks.length === 0 ? (
        <div className="rounded-xl border border-border bg-card p-12 text-center">
          <Network size={32} className="mx-auto mb-3 text-muted-foreground/40" />
          <p className="text-sm text-muted-foreground">Žádné neznámé sítě</p>
        </div>
      ) : (
        <div>
          {networks.map((net: UnknownNetwork) => (
            <NetworkRow key={net.subnet} net={net} onAddRange={handleAddRange} />
          ))}
        </div>
      )}
    </div>
  );
}
