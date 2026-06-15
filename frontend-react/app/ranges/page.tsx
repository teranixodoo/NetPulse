"use client";

import { useState, useMemo } from "react";
import {
  Plus, Pencil, Trash2, Save, X,
  ChevronDown, Loader2, Network, AlertTriangle, Info, Router,
} from "lucide-react";
import {
  useRanges, useHosts, useIpAddresses, useCreateRange, useSites,
  useUpdateRange, useDeleteRange, useRangeImpact, getErrorMessage,
  useMikrotikProxies, useSetRangeProxy,
} from "@/hooks/useNetPulse";
import type { IpRange, HostStats, Site, MikrotikProxy } from "@/lib/types";
import { Button, MetricCard, FormField, Input, EmptyState, Spinner, Select } from "@/components/ui";
import { cn, normalizeNetwork, compareInet } from "@/lib/utils";

// ---------------------------------------------------------------------------
// IP mapa rozsahu
// ---------------------------------------------------------------------------
function ipToNum(ip: string): number {
  return ip.split(".").reduce((n, o) => (n << 8) + +o, 0) >>> 0;
}

function ipInNetwork(ip: string, netAddr: string, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (ipToNum(ip) & mask) === (ipToNum(netAddr) & mask);
}

function IpMap({ hosts, ipAddrMap = {} }: { hosts: HostStats[]; ipAddrMap?: Record<string, boolean> }) {
  const sorted = [...hosts].sort((a, b) =>
    ipToNum(a.ip.split("/")[0]) - ipToNum(b.ip.split("/")[0])
  );
  if (sorted.length === 0)
    return <p className="text-sm text-muted-foreground">Žádná data ze skenování.</p>;

  return (
    <div>
      <div className="flex flex-wrap gap-1">
        {sorted.map((h) => {
          const ip      = h.ip.split("/")[0];
          const lastOct = ip.split(".").pop() ?? ip;
          const rtt     = h.avg_rtt_ms;
          const cleanIp2 = h.ip.split("/")[0];
          const isAlive = cleanIp2 in ipAddrMap ? ipAddrMap[cleanIp2] : (h.currently_alive ?? false);
          const bg = !isAlive
            ? "bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200"
            : rtt && rtt > 50
            ? "bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"
            : "bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-200";
          return (
            <div
              key={ip}
              title={`${ip}\nRTT: ${rtt ? rtt.toFixed(1) + " ms" : "—"}\nUptime: ${h.uptime_pct.toFixed(1)}%`}
              className={cn(
                "flex h-9 w-9 items-center justify-center rounded text-[11px]",
                "font-mono font-semibold cursor-default select-none",
                "transition-opacity hover:opacity-75",
                bg
              )}
            >
              {lastOct}
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-xs text-muted-foreground">
        🟢 online &nbsp; 🟡 RTT &gt;50ms &nbsp; 🔴 offline
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// CIDR kalkulačka — čistá JS funkce, žádný backend
// ---------------------------------------------------------------------------
function calcCidr(network: string): {
  prefix: number; size: number; hosts: number;
  mask: string; netAddr: string; broadcast: string;
  minHost: string; maxHost: string;
  hex: string; binary: string;
} | null {
  try {
    const [ip, prefixStr] = network.split("/");
    const prefix = parseInt(prefixStr ?? "32", 10);
    if (isNaN(prefix) || prefix < 0 || prefix > 32) return null;

    const ipParts = ip.split(".").map(Number);
    if (ipParts.length !== 4 || ipParts.some((p) => isNaN(p) || p < 0 || p > 255)) return null;

    const ipInt = (ipParts[0] << 24) | (ipParts[1] << 16) | (ipParts[2] << 8) | ipParts[3];
    const maskInt = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
    const netInt  = (ipInt & maskInt) >>> 0;
    const bcastInt = (netInt | (~maskInt >>> 0)) >>> 0;

    const toIp = (n: number) => [
      (n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff,
    ].join(".");

    const toHex = (n: number) => n.toString(16).padStart(8, "0").toUpperCase();
    const toBin = (n: number) => n.toString(2).padStart(32, "0");

    const size  = prefix === 32 ? 1 : 2 ** (32 - prefix);
    const hosts = prefix >= 31 ? size : Math.max(0, size - 2);

    return {
      prefix, size, hosts,
      mask:      toIp(maskInt),
      netAddr:   toIp(netInt),
      broadcast: toIp(bcastInt),
      minHost:   prefix >= 31 ? toIp(netInt)      : toIp(netInt + 1),
      maxHost:   prefix >= 31 ? toIp(bcastInt)    : toIp(bcastInt - 1),
      hex:       toHex(netInt),
      binary:    toBin(netInt),
    };
  } catch { return null; }
}

// Formulář přidání / editace rozsahu
// ---------------------------------------------------------------------------
interface FormData {
  label:        string;
  network:      string;
  active:       boolean;
  scan_enabled: boolean;
  description:  string;
  site_id:      number | null;
}

function RangeForm({
  defaultValues,
  onSubmit,
  onCancel,
  isPending,
  sites = [],
}: {
  defaultValues?: Partial<FormData>;
  onSubmit: (data: FormData) => Promise<void>;
  onCancel: () => void;
  isPending: boolean;
  sites?: import("@/lib/types").Site[];
}) {
  const [label,       setLabel]       = useState(defaultValues?.label       ?? "");
  const [network,     setNetwork]     = useState(defaultValues?.network     ?? "");
  const [active,       setActive]       = useState(defaultValues?.active       ?? true);
  const [scanEnabled,  setScanEnabled]  = useState(defaultValues?.scan_enabled ?? true);
  const [siteId,       setSiteId]       = useState<number | null>(defaultValues?.site_id ?? null);
  const [description,  setDescription]  = useState(defaultValues?.description  ?? "");
  const [error,       setError]       = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim())   { setError("Název rozsahu je povinný"); return; }
    if (!network.trim()) { setError("Síť (CIDR) je povinná"); return; }
    await onSubmit({ label: label.trim(), network: network.trim(), active, scan_enabled: scanEnabled, description: description.trim(), site_id: siteId });
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <FormField label="Název rozsahu">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="LAN Sklad"
          />
        </FormField>
        <FormField label="Síť (CIDR)">
          <Input
            value={network}
            onChange={(e) => setNetwork(e.target.value)}
            placeholder="10.30.30.0/24"
          />
        </FormField>
        <FormField label="Popis (volitelný)">
          <Input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="Popis rozsahu..."
          />
        </FormField>
        <FormField label="Síť">
          <select
            value={siteId ?? ""}
            onChange={(e) => setSiteId(e.target.value ? Number(e.target.value) : null)}
            className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
          >
            <option value="">— bez sítě (Default) —</option>
            {sites.map((s: import("@/lib/types").Site) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Stav">
          <div className="flex h-9 items-center gap-2">
            <input
              type="checkbox"
              id="active"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
              className="h-4 w-4 rounded accent-primary"
            />
            <label htmlFor="active" className="text-sm">Aktivní</label>
          </div>
        </FormField>
        <FormField label="Skenovat">
          <div className="flex h-9 items-center gap-2">
            <input
              type="checkbox"
              id="scan_enabled"
              checked={scanEnabled}
              onChange={(e) => setScanEnabled(e.target.checked)}
              className="h-4 w-4 rounded accent-primary"
            />
            <label htmlFor="scan_enabled" className="text-sm">Zahrnout do ICMP scanu</label>
          </div>
        </FormField>
      </div>
      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}
      <p className="text-xs text-muted-foreground">
        Tip: Jednotlivou IP zadejte bez masky — automaticky se doplní /32.
      </p>
      <div className="flex gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={isPending}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Uložit
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
          <X className="h-3.5 w-3.5" /> Zrušit
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Řádek rozsahu (expander)
// ---------------------------------------------------------------------------
function RangeRow({
  range,
  hosts,
  ipAddresses = [],
  sites = [],
}: {
  range: IpRange;
  hosts: HostStats[];
  ipAddresses?: import("@/lib/types").IpAddress[];
  sites?: import("@/lib/types").Site[];
}) {
  const [expanded,    setExpanded]    = useState(false);
  const [editing,     setEditing]     = useState(false);
  const [confirming,  setConfirming]  = useState(false);
  const [deleteData,  setDeleteData]  = useState(false);
  const [networkChanged, setNetworkChanged] = useState(false);
  const updateRange = useUpdateRange();
  const deleteRange = useDeleteRange();
  // Načteme impact data pouze když je otevřen dialog smazání
  const { data: impact, isLoading: impactLoading } = useRangeImpact(
    confirming ? range.id : null
  );

  const hostsInRange = useMemo(() => {
    try {
      const [netAddr, prefix] = range.network.split("/");
      return hosts.filter((h) =>
        ipInNetwork(h.ip.split("/")[0], netAddr, parseInt(prefix ?? "32"))
      );
    } catch { return []; }
  }, [hosts, range.network]);

  // Mapa IP → is_alive z ip_addresses (zahrnuje ARP/DHCP)
  const ipAddrMap = useMemo(() => {
    const m: Record<string, boolean> = {};
    // Klíčujeme bez /prefix aby match fungoval s cleanIp
    for (const a of ipAddresses) m[a.ip.split("/")[0]] = a.is_alive ?? false;
    return m;
  }, [ipAddresses]);

  const aliveN = hostsInRange.filter((h) => {
    const cleanIp = h.ip.split("/")[0];
    // Pokud IP je v ip_addresses, použij její stav
    // Pokud není (nový IP bez záznamu), fallback na ping
    if (cleanIp in ipAddrMap) return ipAddrMap[cleanIp];
    return h.currently_alive ?? false;
  }).length;
  const deadN  = hostsInRange.length - aliveN;
  const rtts   = hostsInRange.filter((h) => h.avg_rtt_ms != null).map((h) => h.avg_rtt_ms!);
  const avgRtt = rtts.length ? (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(1) : null;

  const icon = hostsInRange.length === 0 ? "⚫"
    : deadN  === 0 ? "🟢"
    : aliveN === 0 ? "🔴" : "🟡";

  async function handleUpdate(data: FormData, force = false) {
    const newNetwork = normalizeNetwork(data.network);
    const networkChanged = newNetwork !== range.network;
    try {
      await updateRange.mutateAsync({
        id:              range.id!,
        force,
        label:           data.label,
        network:         newNetwork,
        active:          data.active,
        scan_enabled:    data.scan_enabled,
        description:     data.description || null,
        site_id:         data.site_id ?? null,
        site_name:       null,
        site_color:      null,
        ownership:       (range as any).ownership ?? "isp",
        proxy_device_id: (range as any).proxy_device_id ?? null,
        proxy_mode:      (range as any).proxy_mode ?? "auto",
        proxy_hostname:  null,
        proxy_ip:        null,
      } as any);
      setEditing(false);
      if (networkChanged) {
        setNetworkChanged(true);
        setExpanded(true);
        setTimeout(() => setNetworkChanged(false), 8000);
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.errors?.length) {
        alert("❌ " + detail.errors.join("\n"));
      } else if (detail?.warnings?.length) {
        const msg = detail.warnings.join("\n");
        if (confirm(`⚠️ Upozornění:\n\n${msg}\n\nChcete rozsah přesto uložit?`)) {
          await handleUpdate(data, true);
        }
      } else {
        alert("Chyba při ukládání: " + getErrorMessage(err));
      }
    }
  }

  async function handleDelete() {
    try {
      await deleteRange.mutateAsync({ id: range.id!, deleteData });
    } catch (err) { alert(getErrorMessage(err)); }
  }

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded((v) => !v)}
      >
        <span className="text-base">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium">{range.label}</p>
            {(range as any).site_name && (range as any).site_name !== "Default" && (
              <span
                className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium text-white"
                style={{ backgroundColor: (range as any).site_color ?? "#6366f1" }}
              >
                {(range as any).site_name}
              </span>
            )}
            {!range.active && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                neaktivní
              </span>
            )}
          </div>
          <p className="font-mono text-xs text-muted-foreground">{range.network}</p>
          {!range.scan_enabled && (
            <span className="inline-flex items-center gap-1 rounded bg-amber-100 dark:bg-amber-950/40 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-400">
              ⏸ Sken zakázán
            </span>
          )}
          {/* Proxy indikátor */}
          {(range as any).proxy_mode === "direct" ? (
            <span className="inline-flex items-center gap-1 rounded bg-blue-100 dark:bg-blue-950/40 px-1.5 py-0.5 text-[10px] font-medium text-blue-700 dark:text-blue-400">
              📡 Přímý ICMP
            </span>
          ) : (range as any).proxy_hostname ? (
            <span className="inline-flex items-center gap-1 rounded bg-green-100 dark:bg-green-950/40 px-1.5 py-0.5 text-[10px] font-medium text-green-700 dark:text-green-400"
              title={`Ping proxy: ${(range as any).proxy_hostname} (${(range as any).proxy_ip})`}>
              🔀 Proxy: {(range as any).proxy_hostname}
            </span>
          ) : (range as any).proxy_mode === "auto" ? (
            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              🔀 Auto proxy
            </span>
          ) : null}
          {range.description && (
            <p className="text-xs text-muted-foreground/70 truncate max-w-sm">{range.description}</p>
          )}
        </div>
        <div className="flex items-center gap-6 text-right text-xs shrink-0">
          <div className="hidden sm:block">
            <p className="text-muted-foreground">Online / Offline</p>
            <p>
              <span className="font-semibold text-green-600 dark:text-green-400">{aliveN}</span>
              {" / "}
              <span className="font-semibold text-red-600 dark:text-red-400">{deadN}</span>
            </p>
          </div>
          {avgRtt && (
            <div className="hidden sm:block">
              <p className="text-muted-foreground">Avg RTT</p>
              <p className="font-semibold">{avgRtt} ms</p>
            </div>
          )}
          <div className="flex items-center gap-1">
            <Button
              size="icon"
              variant="ghost"
              onClick={(e) => { e?.stopPropagation(); setEditing((v) => !v); setExpanded(true); }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={(e) => { e?.stopPropagation(); setConfirming(true); setExpanded(true); }}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
            <ChevronDown className={cn(
              "h-4 w-4 text-muted-foreground transition-transform duration-150 ml-1",
              expanded && "rotate-180"
            )} />
          </div>
        </div>
      </div>

      {/* Expanded obsah */}
      {expanded && (
        <div className="border-t border-border p-4 space-y-4">
          {/* Statistiky */}
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
            <MetricCard label="Online"    value={aliveN} color="green" />
            <MetricCard label="Offline"   value={deadN}  color={deadN > 0 ? "red" : "default"} />
            <MetricCard label="Celkem"    value={hostsInRange.length} />
            <MetricCard label="Avg RTT"   value={avgRtt ? `${avgRtt} ms` : "—"} />
            <MetricCard label="Síť"       value={range.network} />
          </div>

          {/* CIDR kalkulačka */}
          {(() => {
            const c = calcCidr(range.network);
            if (!c) return null;
            return (
              <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-3">
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Informace o rozsahu</p>
                {/* Řádek 1 — základní čísla */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ["Prefix",          `/${c.prefix}`],
                    ["Velikost rozsahu", c.size.toLocaleString("cs-CZ") + " IP"],
                    ["Použitelné hosty", c.hosts.toLocaleString("cs-CZ")],
                    ["Maska podsítě",    c.mask],
                  ].map(([label, value]) => (
                    <div key={label} className="space-y-0.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                      <p className="text-sm font-mono font-medium">{value}</p>
                    </div>
                  ))}
                </div>
                {/* Řádek 2 — adresy */}
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ["Síťová adresa",   c.netAddr],
                    ["Broadcast",        c.broadcast],
                    ["První host",       c.minHost],
                    ["Poslední host",    c.maxHost],
                  ].map(([label, value]) => (
                    <div key={label} className="space-y-0.5">
                      <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</p>
                      <p className="text-sm font-mono font-medium">{value}</p>
                    </div>
                  ))}
                </div>
                {/* Hex + Binary */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1 border-t border-border">
                  <div className="space-y-0.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Hex</p>
                    <p className="text-xs font-mono text-muted-foreground">{c.hex}</p>
                  </div>
                  <div className="space-y-0.5">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground">Binárně (síťová adresa)</p>
                    <p className="text-xs font-mono text-muted-foreground break-all">
                      <span className="text-primary">{c.binary.slice(0, c.prefix)}</span>
                      <span className="opacity-40">{c.binary.slice(c.prefix)}</span>
                    </p>
                  </div>
                </div>
                {/* Popis rozsahu */}
                {range.description && (
                  <div className="pt-1 border-t border-border">
                    <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">Popis</p>
                    <p className="text-sm text-foreground/80">{range.description}</p>
                  </div>
                )}
              </div>
            );
          })()}

          {/* Editační formulář */}
          {editing && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-4 space-y-4">
              <p className="text-sm font-medium">Upravit rozsah</p>
              <RangeForm
                defaultValues={{ label: range.label, network: range.network, active: range.active, scan_enabled: range.scan_enabled ?? true, description: range.description ?? "", site_id: (range as any).site_id ?? null }}
              sites={sites}
                onSubmit={handleUpdate}
                onCancel={() => setEditing(false)}
                isPending={updateRange.isPending}
              />
              {/* Proxy nastavení */}
              {range.id && (
                <ProxyPanel rangeId={range.id} range={range as IpRange} />
              )}
            </div>
          )}

          {/* Upozornění na změnu sítě */}
          {networkChanged && (
            <div className="flex items-center gap-2 rounded-md border border-amber-300 bg-amber-50 dark:border-amber-700 dark:bg-amber-950/30 px-4 py-3 mt-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400 shrink-0" />
              <p className="text-sm text-amber-800 dark:text-amber-300">
                <strong>Síť změněna.</strong> Historická data pro IP mimo nový rozsah zůstávají v DB.
                Smažte je přes <em>Nastavení → Správa dat → Smazat orphan logy</em>.
              </p>
            </div>
          )}

          {/* Potvrzení smazání s impact analýzou */}
          {confirming && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 space-y-3 mt-2">
              <div className="flex items-start gap-2">
                <AlertTriangle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
                <p className="text-sm font-medium text-destructive">
                  Smazat rozsah <strong>{range.label}</strong> ({range.network})? Tato akce je nevratná.
                </p>
              </div>

              {/* Impact analýza */}
              {impactLoading && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzuji dopad...
                </div>
              )}

              {impact && !impactLoading && (
                <div className="space-y-2 text-xs">
                  {impact.device_count > 0 && (
                    <div className="rounded bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-800 px-3 py-2">
                      <p className="font-medium text-amber-800 dark:text-amber-300">
                        ⚠️ {impact.device_count} {impact.device_count === 1 ? "zařízení" : "zařízení"} v tomto rozsahu:
                      </p>
                      <p className="text-amber-700 dark:text-amber-400 mt-0.5">
                        {impact.devices.map((d: any) => d.alias || d.hostname || d.ip).join(", ")}
                        {impact.device_count > 10 && " ..."}
                      </p>
                      <p className="text-amber-600 dark:text-amber-500 mt-1">
                        Zařízení nebudou smazána, ale přestanou být skenována.
                      </p>
                    </div>
                  )}
                  {impact.ip_count > 0 && (
                    <div className="flex items-start gap-1.5 text-muted-foreground">
                      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>
                        Rozsah obsahuje <strong className="text-foreground">{impact.ip_count}</strong> evidovaných IP adres.
                        Historická ping data zůstanou zachována.
                      </span>
                    </div>
                  )}
                  {impact.device_count === 0 && impact.ip_count === 0 && (
                    <div className="flex items-start gap-1.5 text-muted-foreground">
                      <Info className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                      <span>Rozsah neobsahuje žádná zařízení ani IP adresy.</span>
                    </div>
                  )}
                </div>
              )}

              <div className="flex gap-2 pt-1">
                <Button size="sm" variant="destructive" onClick={handleDelete}
                        disabled={deleteRange.isPending || impactLoading}>
                  {deleteRange.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  Smazat rozsah
                </Button>
                <Button size="sm" variant="ghost"
                        onClick={() => { setConfirming(false); setDeleteData(false); }}>
                  Zrušit
                </Button>
              </div>
            </div>
          )}

          {/* IP Mapa */}
          <IpMap hosts={hostsInRange} ipAddrMap={ipAddrMap} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ProxyPanel — nastavení ping proxy pro IP range
// ---------------------------------------------------------------------------
function ProxyPanel({ rangeId, range }: { rangeId: number; range: IpRange }) {
  const { data: mikrotiks = [], isLoading } = useMikrotikProxies();
  const setProxy  = useSetRangeProxy();

  const currentMode     = (range as any).proxy_mode     ?? "auto";
  const currentDeviceId = (range as any).proxy_device_id ?? null;

  const [mode,     setMode]     = useState<string>(currentMode);
  const [deviceId, setDeviceId] = useState<number | null>(currentDeviceId);
  const [saved,    setSaved]    = useState(false);
  const [error,    setError]    = useState<string | null>(null);

  async function handleSave() {
    setError(null);
    try {
      await setProxy.mutateAsync({ rangeId, proxyMode: mode, proxyDeviceId: deviceId });
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "Chyba při ukládání");
    }
  }

  return (
    <div className="border-t border-border pt-4 space-y-3">
      <div className="flex items-center gap-2">
        <Router className="h-4 w-4 text-primary" />
        <p className="text-sm font-medium">Ping proxy</p>
        <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
          MikroTik API
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {/* Režim */}
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Režim</label>
          <Select value={mode} onChange={e => setMode(e.target.value)} className="w-full">
            <option value="auto">🔀 Auto (MikroTik ze site)</option>
            <option value="manual">🎯 Manuální výběr</option>
            <option value="direct">📡 Přímý ICMP</option>
          </Select>
        </div>

        {/* Výběr zařízení — jen při manual */}
        {mode === "manual" && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Proxy zařízení</label>
            {isLoading ? (
              <div className="flex items-center gap-2 h-9 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Načítám…
              </div>
            ) : (
              <Select
                value={deviceId ?? ""}
                onChange={e => setDeviceId(e.target.value ? Number(e.target.value) : null)}
                className="w-full"
              >
                <option value="">— vyberte zařízení —</option>
                {mikrotiks.map((m: MikrotikProxy) => (
                  <option key={m.id} value={m.id}>
                    {m.hostname} ({m.ip}){m.site_name ? ` · ${m.site_name}` : ""}
                  </option>
                ))}
              </Select>
            )}
          </div>
        )}

        {/* Info pro auto mode */}
        {mode === "auto" && (
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Nalezený proxy</label>
            <div className="h-9 flex items-center text-xs text-muted-foreground px-2 rounded-md border border-border bg-muted/30">
              {(range as any).proxy_hostname
                ? `🔀 ${(range as any).proxy_hostname} (${(range as any).proxy_ip})`
                : "— žádný MikroTik v site —"}
            </div>
          </div>
        )}
      </div>

      {/* Popis režimu */}
      <p className="text-[11px] text-muted-foreground">
        {mode === "auto"   && "NetPulse automaticky vybere MikroTik router ze stejného site. Musí mít credential typu API."}
        {mode === "manual" && "Ping bude probíhat přes vybraný MikroTik router. Credential typu API musí být nastaven."}
        {mode === "direct" && "Ping probíhá přímo z NetPulse serveru přes ICMP. Funguje pouze pro L2 dostupné adresy."}
      </p>

      {error && <p className="text-xs text-destructive">{error}</p>}

      <div className="flex items-center gap-2">
        <Button size="sm" variant="primary" onClick={handleSave} disabled={setProxy.isPending}>
          {setProxy.isPending
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Ukládám…</>
            : "Uložit proxy"}
        </Button>
        {saved && <span className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</span>}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function RangesPage() {
  const { data: ranges = [], isLoading } = useRanges();
  const { data: hosts  = [] }            = useHosts();
  const { data: sites  = [] }            = useSites();
  const { data: ipAddresses = [] }       = useIpAddresses();
  const createRange = useCreateRange();
  const [showAdd,     setShowAdd]     = useState(false);
  const [siteFilter,  setSiteFilter]  = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  async function handleCreate(data: FormData, force = false) {
    try {
      await createRange.mutateAsync({ data: {
        id:              null,
        label:           data.label,
        network:         normalizeNetwork(data.network),
        active:          data.active,
        scan_enabled:    data.scan_enabled,
        description:     data.description || null,
        site_id:         data.site_id ?? null,
        site_name:       null,
        site_color:      null,
        ownership:       "isp",
        proxy_device_id: null,
        proxy_mode:      "auto",
        proxy_hostname:  null,
        proxy_ip:        null,
      } as any, force });
      setShowAdd(false);
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      if (detail?.errors?.length) {
        // Blokující chyba
        alert("❌ " + detail.errors.join("\n"));
      } else if (detail?.warnings?.length) {
        // Varování — zeptej se
        const msg = detail.warnings.join("\n");
        if (confirm(`⚠️ Upozornění:\n\n${msg}\n\nChcete rozsah přesto uložit?`)) {
          await handleCreate(data, true);
        }
      } else {
        alert(getErrorMessage(err));
      }
    }
  }

  const filteredRanges = useMemo(() => {
    return (ranges as any[]).filter((r: any) => {
      if (siteFilter && r.site_id !== siteFilter) return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        if (!r.label.toLowerCase().includes(q) && !r.network.toLowerCase().includes(q)) return false;
      }
      return true;
    }).sort((a: any, b: any) => compareInet(a.network, b.network));
  }, [ranges, siteFilter, searchQuery]);
  const activeRanges   = filteredRanges.filter((r: any) => r.active);
  const inactiveRanges = filteredRanges.filter((r: any) => !r.active);

  return (
    <div className="space-y-4">
      {/* Toolbar — filtr + vyhledávání */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          placeholder="Hledat rozsah nebo síť…"
          className="h-9 w-64 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
        <Select
          value={siteFilter ?? ""}
          onChange={(e) => setSiteFilter(e.target.value ? Number(e.target.value) : null)}
          className="w-44"
        >
          <option value="">Vše — síť</option>
          {(sites as Site[]).map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </Select>
        {(siteFilter || searchQuery) && (
          <button
            onClick={() => { setSiteFilter(null); setSearchQuery(""); }}
            className="text-xs text-muted-foreground hover:text-foreground"
          >
            ✕ Zrušit filtr
          </button>
        )}
        <div className="flex-1" />
        <span className="text-xs text-muted-foreground">
          {activeRanges.length} aktivních
          {siteFilter || searchQuery ? ` (filtrováno z ${ranges.length})` : ""}
        </span>
      </div>

      {/* Přidat rozsah */}
      <div className="rounded-lg border border-border bg-card">
        <button
          onClick={() => setShowAdd((v) => !v)}
          className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium
                     hover:bg-muted/40 transition-colors rounded-lg"
        >
          <Plus className="h-4 w-4 text-primary" />
          Přidat IP rozsah
          <div className="flex-1" />
          <ChevronDown className={cn(
            "h-4 w-4 text-muted-foreground transition-transform duration-150",
            showAdd && "rotate-180"
          )} />
        </button>
        {showAdd && (
          <div className="border-t border-border p-4">
            <RangeForm
              onSubmit={handleCreate}
              onCancel={() => setShowAdd(false)}
              isPending={createRange.isPending}
              sites={sites}
            />
          </div>
        )}
      </div>

      {/* Seznam rozsahů */}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : ranges.length === 0 ? (
        <EmptyState
          icon={Network}
          title="Žádné IP rozsahy"
          description="Přidejte první IP rozsah nebo jednotlivou IP adresu."
        />
      ) : (
        <>
          {activeRanges.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Aktivní rozsahy ({activeRanges.length})
              </p>
              {activeRanges.map((r) => (
                <RangeRow key={r.id} range={r} hosts={hosts} ipAddresses={ipAddresses} sites={sites} />
              ))}
            </div>
          )}
          {inactiveRanges.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Neaktivní ({inactiveRanges.length})
              </p>
              {inactiveRanges.map((r) => (
                <RangeRow key={r.id} range={r} hosts={hosts} ipAddresses={ipAddresses} sites={sites} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
