"use client";

import { useState, useMemo } from "react";
import {
  Wifi, RefreshCw, Plus, Search,
  ChevronUp, ChevronDown, ChevronsUpDown,
  Clock, Loader2, ChevronLeft, ChevronRight,
  ChevronRight as ChevronR,
} from "lucide-react";
import {
  useMacInventory, useMacEvents, useMacStats,
  useSyncMacDevice, useMikrotikProxies, getErrorMessage,
} from "@/hooks/useNetPulse";
import type { MacInventoryItem, MacEvent } from "@/lib/types";
import { Button, Select, MetricCard } from "@/components/ui";
import { cn } from "@/lib/utils";

const PAGE_SIZE = 256;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmtDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("cs-CZ", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function fmtDateShort(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("cs-CZ", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

function stripCidr(s: string | null | undefined): string {
  if (!s) return "—";
  return s.replace(/\/\d+$/, "");
}

function ipToNum(ip: string | null): number {
  if (!ip) return 0;
  return ip.replace(/\/\d+$/, "").split(".")
    .reduce((a, o) => a * 256 + parseInt(o || "0"), 0);
}

function macToNum(mac: string | null): number {
  if (!mac) return 0;
  return parseInt(mac.replace(/:/g, ""), 16);
}

const EVENT_META: Record<string, { icon: string; label: string; color: string; bg: string }> = {
  new:       { icon: "🆕", label: "Nové",     color: "text-amber-600 dark:text-amber-400",  bg: "bg-amber-50 dark:bg-amber-950/30" },
  ip_change: { icon: "🔄", label: "Změna IP", color: "text-blue-600 dark:text-blue-400",    bg: "bg-blue-50 dark:bg-blue-950/30"   },
  online:    { icon: "📶", label: "Online",   color: "text-green-600 dark:text-green-400",  bg: "bg-green-50 dark:bg-green-950/30" },
  offline:   { icon: "📴", label: "Offline",  color: "text-muted-foreground",               bg: "bg-muted/30"                      },
};

// ---------------------------------------------------------------------------
// Sort header
// ---------------------------------------------------------------------------
type SortDir = "asc" | "desc" | null;

function SortTh({ label, col, sortCol, sortDir, onSort }: {
  label: string; col: string;
  sortCol: string | null; sortDir: SortDir;
  onSort: (col: string) => void;
}) {
  const active = sortCol === col;
  return (
    <th className="px-3 py-2 cursor-pointer select-none whitespace-nowrap hover:text-foreground transition-colors"
      onClick={() => onSort(col)}>
      <span className="inline-flex items-center gap-1">
        {label}
        {active && sortDir === "asc"  && <ChevronUp    className="h-3 w-3" />}
        {active && sortDir === "desc" && <ChevronDown   className="h-3 w-3" />}
        {!active && <ChevronsUpDown className="h-3 w-3 opacity-30" />}
      </span>
    </th>
  );
}

// ---------------------------------------------------------------------------
// Pagination
// ---------------------------------------------------------------------------
function Pagination({ page, total, pageSize, onChange }: {
  page: number; total: number; pageSize: number; onChange: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (pages <= 1) return null;
  return (
    <div className="flex items-center gap-2 px-3 py-2 border-t border-border text-xs text-muted-foreground shrink-0">
      <span>{page * pageSize + 1}–{Math.min((page + 1) * pageSize, total)} z {total}</span>
      <div className="flex-1" />
      <button onClick={() => onChange(page - 1)} disabled={page === 0}
        className="p-1 rounded hover:bg-muted disabled:opacity-40">
        <ChevronLeft className="h-4 w-4" />
      </button>
      <span className="font-medium text-foreground">{page + 1} / {pages}</span>
      <button onClick={() => onChange(page + 1)} disabled={page >= pages - 1}
        className="p-1 rounded hover:bg-muted disabled:opacity-40">
        <ChevronRight className="h-4 w-4" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inventory Tab
// ---------------------------------------------------------------------------
function InventoryTab({ proxyId, onlyNew, onlyUnknown, deviceFilter, search }: {
  proxyId: number | null; onlyNew: boolean; onlyUnknown: boolean;
  deviceFilter: "all" | "with" | "without"; search: string;
}) {
  const [sortCol, setSortCol] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<SortDir>(null);
  const [page,    setPage]    = useState(0);

  const { data = [], isLoading } = useMacInventory({
    proxy_device_id: proxyId ?? undefined,
    only_new: onlyNew, only_unknown: onlyUnknown,
    search: search || undefined, limit: 2000,
  });

  const filtered = useMemo(() => {
    let rows = [...data];
    if (deviceFilter === "with")    rows = rows.filter(r => r.device_id !== null);
    if (deviceFilter === "without") rows = rows.filter(r => r.device_id === null);
    if (!sortCol || !sortDir) return rows;
    return rows.sort((a, b) => {
      let va: any, vb: any;
      switch (sortCol) {
        case "mac":    va = macToNum(a.mac);               vb = macToNum(b.mac);    break;
        case "ip":     va = ipToNum(a.ip);                 vb = ipToNum(b.ip);      break;
        case "vendor": va = (a.vendor||"").toLowerCase();  vb = (b.vendor||"").toLowerCase(); break;
        case "device": va = (a.device_hostname||"").toLowerCase(); vb = (b.device_hostname||"").toLowerCase(); break;
        case "proxy":  va = (a.proxy_hostname||"").toLowerCase(); vb = (b.proxy_hostname||"").toLowerCase(); break;
        case "first":  va = a.first_seen||""; vb = b.first_seen||""; break;
        case "last":   va = a.last_seen||"";  vb = b.last_seen||"";  break;
        default: return 0;
      }
      if (va < vb) return sortDir === "asc" ? -1 :  1;
      if (va > vb) return sortDir === "asc" ?  1 : -1;
      return 0;
    });
  }, [data, deviceFilter, sortCol, sortDir]);

  const pageRows = useMemo(() =>
    filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [filtered, page]);

  function handleSort(col: string) {
    if (sortCol !== col) { setSortCol(col); setSortDir("asc"); setPage(0); }
    else if (sortDir === "asc")  { setSortDir("desc"); setPage(0); }
    else { setSortCol(null); setSortDir(null); setPage(0); }
  }

  if (isLoading) return (
    <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
      <Loader2 className="h-5 w-5 animate-spin" /> Načítám inventář…
    </div>
  );
  if (!filtered.length) return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
      <Wifi className="h-10 w-10 opacity-20" /><p>Žádné záznamy</p>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      <div className="flex-1 overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-card shadow-sm">
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 w-4"></th>
              <SortTh label="MAC adresa"    col="mac"    sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortTh label="IP adresa"     col="ip"     sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortTh label="Vendor"        col="vendor" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortTh label="Zařízení"      col="device" sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortTh label="Proxy"         col="proxy"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortTh label="Poprvé viděno" col="first"  sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <SortTh label="Naposledy"     col="last"   sortCol={sortCol} sortDir={sortDir} onSort={handleSort} />
              <th className="px-3 py-2">Akce</th>
            </tr>
          </thead>
          <tbody>
            {pageRows.map(item => (
              <tr key={item.id} className="border-b border-border/50 hover:bg-muted/30 transition-colors">
                <td className="px-3 py-2">
                  <span className={cn("inline-block w-2 h-2 rounded-full",
                    item.is_online ? "bg-green-500" : "bg-muted-foreground/40")} />
                </td>
                <td className="px-3 py-2 font-mono text-xs">
                  <div className="flex items-center gap-1.5">
                    {item.mac}
                    {item.is_new && (
                      <span className="rounded-full bg-amber-100 dark:bg-amber-950/40
                        text-amber-700 dark:text-amber-400 text-[10px] font-medium px-1.5 py-0.5">
                        nové
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted-foreground">{stripCidr(item.ip)}</td>
                <td className="px-3 py-2 text-xs">{item.vendor || <span className="text-muted-foreground">—</span>}</td>
                <td className="px-3 py-2 text-xs">
                  {item.device_hostname ? (
                    <a href={`/devices?q=${item.device_hostname}`} className="text-primary hover:underline">
                      {item.device_alias || item.device_hostname}
                    </a>
                  ) : <span className="text-muted-foreground/60 italic">neevidováno</span>}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">{item.proxy_hostname || "—"}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(item.first_seen)}</td>
                <td className="px-3 py-2 text-xs text-muted-foreground whitespace-nowrap">{fmtDateTime(item.last_seen)}</td>
                <td className="px-3 py-2">
                  {!item.device_id && (
                    <a href={`/devices?new=1&mac=${item.mac}&ip=${stripCidr(item.ip)}&vendor=${item.vendor || ""}`}
                      className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
                      <Plus className="h-3 w-3" />Přidat
                    </a>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination page={page} total={filtered.length} pageSize={PAGE_SIZE} onChange={p => { setPage(p); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Events Tab — seskupeno po MAC
// ---------------------------------------------------------------------------
interface MacGroup {
  mac:          string;
  lastIp:       string;
  lastSeen:     string;
  proxy:        string;
  eventCount:   number;
  hasIpChange:  boolean;
  hasOffline:   boolean;
  events:       MacEvent[];
}

function buildGroups(events: MacEvent[]): MacGroup[] {
  const map = new Map<string, MacGroup>();
  for (const ev of events) {
    const key = ev.mac + "|" + (ev.proxy_device_id ?? "");
    if (!map.has(key)) {
      map.set(key, {
        mac:         ev.mac,
        lastIp:      stripCidr(ev.new_value || ev.old_value),
        lastSeen:    ev.seen_at,
        proxy:       ev.proxy_hostname || "—",
        eventCount:  0,
        hasIpChange: false,
        hasOffline:  false,
        events:      [],
      });
    }
    const g = map.get(key)!;
    g.eventCount++;
    g.events.push(ev);
    if (ev.event_type === "ip_change") g.hasIpChange = true;
    if (ev.event_type === "offline")   g.hasOffline  = true;
    if (ev.seen_at > g.lastSeen)       g.lastSeen    = ev.seen_at;
    if (ev.new_value && ev.event_type !== "offline") g.lastIp = stripCidr(ev.new_value);
  }
  return Array.from(map.values()).sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
}

function GroupBadge({ g }: { g: MacGroup }) {
  if (g.hasIpChange) return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-blue-100 dark:bg-blue-950/40 text-blue-700 dark:text-blue-400">
      🔄 Změna IP
    </span>
  );
  if (g.hasOffline) return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-muted text-muted-foreground">
      📴 Offline
    </span>
  );
  return (
    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950/40 text-amber-700 dark:text-amber-400">
      🆕 Nové
    </span>
  );
}

function EventsTab({ proxyId, hours }: { proxyId: number | null; hours: number }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [page,     setPage]     = useState(0);
  const [typeFilter, setTypeFilter] = useState<string>("all");

  const { data = [], isLoading } = useMacEvents({
    proxy_device_id: proxyId ?? undefined, hours, limit: 5000,
  });

  const filtered = useMemo(() => {
    if (typeFilter === "all") return data;
    return data.filter(e => e.event_type === typeFilter);
  }, [data, typeFilter]);

  const groups = useMemo(() => buildGroups(filtered), [filtered]);
  const pageGroups = useMemo(() =>
    groups.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE), [groups, page]);

  function toggleExpand(key: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  }

  if (isLoading) return (
    <div className="flex items-center justify-center py-16 text-muted-foreground gap-2">
      <Loader2 className="h-5 w-5 animate-spin" /> Načítám události…
    </div>
  );
  if (!groups.length) return (
    <div className="flex flex-col items-center justify-center py-16 text-muted-foreground gap-2">
      <Clock className="h-10 w-10 opacity-20" /><p>Žádné události za dané období</p>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Filtr typů */}
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <span className="text-xs text-muted-foreground">{groups.length} MAC s událostmi</span>
        <div className="flex-1" />
        <Select value={typeFilter} onChange={e => { setTypeFilter(e.target.value); setPage(0); }} className="w-36">
          <option value="all">Všechny typy</option>
          <option value="new">🆕 Nové</option>
          <option value="ip_change">🔄 Změna IP</option>
          <option value="online">📶 Online</option>
          <option value="offline">📴 Offline</option>
        </Select>
      </div>

      {/* Hlavičky sloupců */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border bg-muted/30 shrink-0 text-xs font-medium text-muted-foreground">
        <div className="w-4 shrink-0"></div>
        <div className="w-40 shrink-0">MAC adresa</div>
        <div className="w-32 shrink-0">Poslední IP</div>
        <div className="w-24 shrink-0">Typ aktivity</div>
        <div className="w-20 shrink-0">Událostí</div>
        <div className="flex-1"></div>
        <div className="shrink-0">Proxy · Poslední aktivita</div>
      </div>

      <div className="flex-1 overflow-auto">
        <div className="divide-y divide-border">
          {pageGroups.map(g => {
            const key = g.mac + "|" + g.proxy;
            const isOpen = expanded.has(key);
            return (
              <div key={key}>
                {/* Hlavička skupiny */}
                <button
                  onClick={() => toggleExpand(key)}
                  className="w-full flex items-center gap-3 px-4 py-3 hover:bg-muted/30 transition-colors text-left"
                >
                  <ChevronDown className={cn("h-4 w-4 text-muted-foreground shrink-0 transition-transform",
                    isOpen ? "rotate-0" : "-rotate-90")} />

                  <span className="font-mono text-xs font-medium w-40 shrink-0">{g.mac}</span>

                  <span className="font-mono text-xs text-muted-foreground w-32 shrink-0">
                    {g.lastIp !== "—" ? g.lastIp : ""}
                  </span>

                  <GroupBadge g={g} />

                  <span className="text-xs text-muted-foreground">
                    {g.eventCount} {g.eventCount === 1 ? "událost" : g.eventCount < 5 ? "události" : "událostí"}
                  </span>

                  <span className="text-xs text-muted-foreground ml-auto shrink-0">
                    {g.proxy} · {fmtDateShort(g.lastSeen)}
                  </span>
                </button>

                {/* Detail událostí */}
                {isOpen && (
                  <div className="bg-muted/20 border-t border-border/50">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-muted-foreground border-b border-border/50">
                          <th className="px-8 py-1.5 text-left font-medium w-44">Čas</th>
                          <th className="px-3 py-1.5 text-left font-medium w-28">Typ</th>
                          <th className="px-3 py-1.5 text-left font-medium">Detail</th>
                        </tr>
                      </thead>
                      <tbody>
                        {g.events.map(ev => {
                          const meta = EVENT_META[ev.event_type] ?? { icon: "•", label: ev.event_type, color: "", bg: "" };
                          return (
                            <tr key={ev.id} className="border-b border-border/30 last:border-0">
                              <td className="px-8 py-1.5 text-muted-foreground whitespace-nowrap">
                                {fmtDateShort(ev.seen_at)}
                              </td>
                              <td className="px-3 py-1.5">
                                <span className={cn("font-medium", meta.color)}>
                                  {meta.icon} {meta.label}
                                </span>
                              </td>
                              <td className="px-3 py-1.5 text-muted-foreground">
                                {ev.event_type === "ip_change"
                                  ? <span>{stripCidr(ev.old_value)} → <strong className="text-foreground">{stripCidr(ev.new_value)}</strong></span>
                                  : stripCidr(ev.new_value) || stripCidr(ev.old_value) || "—"}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
      <Pagination page={page} total={groups.length} pageSize={PAGE_SIZE} onChange={p => { setPage(p); }} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export default function NetworkAwarenessPage() {
  const [tab,          setTab]          = useState<"inventory" | "events">("inventory");
  const [proxyId,      setProxyId]      = useState<number | null>(null);
  const [onlyNew,      setOnlyNew]      = useState(false);
  const [onlyUnknown,  setOnlyUnknown]  = useState(false);
  const [deviceFilter, setDeviceFilter] = useState<"all" | "with" | "without">("all");
  const [search,       setSearch]       = useState("");
  const [hours,        setHours]        = useState(24);

  const { data: stats }          = useMacStats();
  const { data: mikrotiks = [] } = useMikrotikProxies();
  const syncMac                  = useSyncMacDevice();

  async function handleSync() {
    if (!proxyId) return;
    try { await syncMac.mutateAsync(proxyId); }
    catch (e) { alert(getErrorMessage(e)); }
  }

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Metric cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 px-6 py-4 border-b border-border shrink-0">
        <MetricCard label="Celkem MAC"   value={stats?.total  ?? "—"} />
        <MetricCard label="Online"       value={stats?.online ?? "—"} color="green" />
        <MetricCard label="Nové (7 dní)" value={stats?.new_7d ?? "—"} color="amber"
          sub={stats?.new_7d ? "Poprvé viděné za posledních 7 dní" : undefined} />
        <MetricCard label="Neevidované"  value={stats?.unknown ?? "—"}
          color={(stats?.unknown ?? 0) > 0 ? "amber" : "default"}
          sub={(stats?.unknown ?? 0) > 0 ? "Bez záznamu v evidenci" : undefined} />
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-2 border-b border-border px-6 py-2 flex-wrap shrink-0">
        <div className="flex rounded-md border border-border overflow-hidden mr-2">
          {(["inventory", "events"] as const).map(t => (
            <button key={t} onClick={() => setTab(t)}
              className={cn("px-3 py-1.5 text-sm font-medium transition-colors",
                tab === t ? "bg-primary text-primary-foreground" : "bg-background text-muted-foreground hover:bg-muted")}>
              {t === "inventory" ? "Inventář" : "Události"}
            </button>
          ))}
        </div>

        <Select value={proxyId ?? ""} onChange={e => setProxyId(e.target.value ? Number(e.target.value) : null)} className="w-52">
          <option value="">Všechny MikroTiky</option>
          {mikrotiks.map(m => <option key={m.id} value={m.id}>{m.hostname} ({m.ip})</option>)}
        </Select>

        {tab === "inventory" && (
          <>
            <div className="relative">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <input type="text" placeholder="MAC, IP, vendor…" value={search}
                onChange={e => setSearch(e.target.value)}
                className="h-9 pl-8 pr-3 w-44 rounded-md border border-border bg-background text-sm
                  placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <Select value={deviceFilter} onChange={e => setDeviceFilter(e.target.value as any)} className="w-40">
              <option value="all">Všechna zařízení</option>
              <option value="with">Se zařízením</option>
              <option value="without">Bez zařízení</option>
            </Select>
            <button onClick={() => setOnlyNew(v => !v)}
              className={cn("inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-medium transition-colors",
                onlyNew ? "border-amber-500 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
                        : "border-border bg-background text-muted-foreground hover:bg-muted")}>
              🆕 Nové MAC
            </button>
            <button onClick={() => setOnlyUnknown(v => !v)}
              className={cn("inline-flex items-center gap-1.5 h-9 px-3 rounded-md border text-sm font-medium transition-colors",
                onlyUnknown ? "border-orange-500 bg-orange-50 text-orange-700 dark:bg-orange-950/30 dark:text-orange-400"
                            : "border-border bg-background text-muted-foreground hover:bg-muted")}>
              ⚠️ Neevidované
            </button>
          </>
        )}

        {tab === "events" && (
          <Select value={hours} onChange={e => setHours(Number(e.target.value))} className="w-36">
            <option value={6}>Posledních 6h</option>
            <option value={24}>Posledních 24h</option>
            <option value={72}>Posledních 72h</option>
            <option value={168}>Posledních 7 dní</option>
          </Select>
        )}

        <div className="flex-1" />
        {proxyId && (
          <Button size="sm" variant="outline" onClick={handleSync} disabled={syncMac.isPending}>
            {syncMac.isPending
              ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Synchronizuji…</>
              : <><RefreshCw className="h-3.5 w-3.5" />Sync MAC</>}
          </Button>
        )}
      </div>

      <div className="flex-1 overflow-hidden flex flex-col">
        {tab === "inventory"
          ? <InventoryTab proxyId={proxyId} onlyNew={onlyNew} onlyUnknown={onlyUnknown}
              deviceFilter={deviceFilter} search={search} />
          : <EventsTab proxyId={proxyId} hours={hours} />}
      </div>
    </div>
  );
}
