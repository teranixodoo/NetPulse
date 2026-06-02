"use client";

import {
  useState, useMemo, useCallback, useEffect, useRef,
} from "react";
import { format, parseISO } from "date-fns";
import { RefreshCw, Search, X, Wifi, WifiOff, Activity } from "lucide-react";
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Brush, Area,
} from "recharts";
import { useHosts, useRttTrend, useIpPresence, useIpAddresses } from "@/hooks/useNetPulse";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { HostStats, RttTrendPoint , PresenceBlock } from "@/lib/types";
import api from "@/lib/api";


// ---------------------------------------------------------------------------
// Live ping intervaly
// ---------------------------------------------------------------------------
const LIVE_INTERVALS = [
  { label: "5s",  ms: 5_000  },
  { label: "10s", ms: 10_000 },
  { label: "30s", ms: 30_000 },
  { label: "60s", ms: 60_000 },
  { label: "2m",  ms: 120_000 },
  { label: "5m",  ms: 300_000 },
];

// ---------------------------------------------------------------------------
// Konstanty
// ---------------------------------------------------------------------------
const TIME_RANGES = [
  { label: "1h",  hours: 1,   limit: 300  },
  { label: "3h",  hours: 3,   limit: 500  },
  { label: "6h",  hours: 6,   limit: 700  },
  { label: "12h", hours: 12,  limit: 700  },
  { label: "24h", hours: 24,  limit: 1000 },
  { label: "2d",  hours: 48,  limit: 1000 },
  { label: "7d",  hours: 168, limit: 1000 },
  { label: "30d", hours: 720, limit: 1000 },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function calcStats(points: RttTrendPoint[]) {
  const alive  = points.filter((p) => p.alive && p.rtt_ms != null);
  const rtts   = alive.map((p) => p.rtt_ms as number);
  const losses = points.map((p) => p.packet_loss ?? 0);
  return {
    last:    rtts.length > 0 ? rtts[rtts.length - 1] : null,
    min:     rtts.length > 0 ? Math.min(...rtts) : null,
    avg:     rtts.length > 0 ? rtts.reduce((a, b) => a + b, 0) / rtts.length : null,
    max:     rtts.length > 0 ? Math.max(...rtts) : null,
    avgLoss: losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / losses.length : 0,
    maxLoss: losses.length > 0 ? Math.max(...losses) : 0,
    uptime:  points.length > 0
      ? (points.filter((p) => p.alive).length / points.length) * 100 : 100,
  };
}

function fmtMs(v: number | null, d = 2): string {
  if (v == null) return "—";
  return v >= 1000 ? `${(v / 1000).toFixed(2)}s` : `${v.toFixed(d)}ms`;
}

function fmtTick(ts: string, hours: number): string {
  try {
    const d = parseISO(ts);
    return hours <= 6   ? format(d, "HH:mm:ss")
         : hours <= 48  ? format(d, "dd.MM HH:mm")
         :                format(d, "dd.MM HH:mm");
  } catch { return ts; }
}

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------
function ChartTooltip({ active, payload }: any) {
  if (!active || !payload?.length) return null;
  const pt   = payload[0]?.payload;
  const rtt  = payload.find((p: any) => p.dataKey === "rtt_ms");
  const loss = payload.find((p: any) => p.dataKey === "packet_loss");
  return (
    <div className="rounded-lg border border-border bg-card shadow-lg px-3 py-2 text-xs min-w-[180px]">
      <p className="font-medium text-muted-foreground mb-1.5">
        {pt?.ts ? (() => { try { return format(parseISO(pt.ts), "dd.MM.yyyy HH:mm:ss"); } catch { return ""; } })() : ""}
      </p>
      <div className="space-y-1">
        {rtt && (
          <div className="flex justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-green-500" />
              <span className="text-muted-foreground">RTT</span>
            </div>
            <span className="font-mono font-medium">
              {rtt.value != null ? fmtMs(rtt.value) : <span className="text-red-500">offline</span>}
            </span>
          </div>
        )}
        {loss && (
          <div className="flex justify-between gap-4">
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-red-500" />
              <span className="text-muted-foreground">Loss</span>
            </div>
            <span className="font-mono font-medium">{(loss.value ?? 0).toFixed(1)} %</span>
          </div>
        )}
        {pt?.alive === false && <p className="mt-1 text-red-500 font-medium">⚠ Offline</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Legenda (Zabbix styl)
// ---------------------------------------------------------------------------
function LegendRow({ color, label, last, min, avg, max }: {
  color: string; label: string; last: string; min: string; avg: string; max: string;
}) {
  return (
    <div className="flex items-center gap-3 text-xs flex-wrap">
      <div className="flex items-center gap-1.5 w-44 shrink-0">
        <span className={cn("h-2.5 w-4 rounded-sm shrink-0", color)} />
        <span className="font-medium truncate">{label}</span>
        <span className="text-muted-foreground">[avg]</span>
      </div>
      <div className="flex gap-5 tabular-nums text-muted-foreground">
        {[["last", last], ["min", min], ["avg", avg], ["max", max]].map(([k, v]) => (
          <span key={k}>{k} <strong className="text-foreground">{v}</strong></span>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// IP search s dropdownem
// ---------------------------------------------------------------------------
function IpSearch({ hosts, value, onChange }: {
  hosts: HostStats[]; value: string; onChange: (ip: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open,  setOpen]  = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const h = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, []);

  const filtered = useMemo(() => {
    const q = query.toLowerCase().trim();
    return [...hosts]
      .filter((h) => {
        const ip = h.ip.split("/")[0];
        return !q || ip.includes(q) || (h as any).hostname?.toLowerCase().includes(q);
      })
      .sort((a, b) => {
        const n = (s: string) => s.split("/")[0].split(".").reduce((acc, o) => (acc << 8) + +o, 0);
        return n(a.ip) - n(b.ip);
      })
      .slice(0, 60);
  }, [hosts, query]);

  const displayIp = value || "";

  return (
    <div ref={ref} className="relative flex-1 min-w-[240px]">
      <label className="block text-xs font-medium text-muted-foreground mb-1.5">
        IP adresa
      </label>
      <div className="relative">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
        <input
          value={open ? query : displayIp}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          placeholder="Hledat IP adresu nebo hostname…"
          autoComplete="off"
          className="h-9 w-full rounded-md border border-border bg-background
                     pl-8 pr-8 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        />
        {value && (
          <button
            onClick={() => { onChange(""); setQuery(""); }}
            className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {open && (
        <div className="absolute z-50 mt-1 w-full max-h-72 overflow-y-auto
                        rounded-md border border-border bg-card shadow-xl">
          {filtered.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Žádné výsledky</p>
          ) : filtered.map((h) => {
            const ip = h.ip.split("/")[0];
            return (
              <button
                key={ip}
                onClick={() => { onChange(ip); setQuery(""); setOpen(false); }}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-2 text-left text-sm",
                  "hover:bg-muted/50 transition-colors",
                  ip === value && "bg-primary/10 font-medium"
                )}
              >
                {h.currently_alive
                  ? <Wifi    className="h-3.5 w-3.5 shrink-0 text-green-500" />
                  : <WifiOff className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                <span className="font-mono flex-1">{ip}</span>
                {h.avg_rtt_ms != null && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {h.avg_rtt_ms.toFixed(1)} ms
                  </span>
                )}
                {h.uptime_pct != null && (
                  <span className={cn("text-xs tabular-nums",
                    h.uptime_pct >= 99 ? "text-green-600 dark:text-green-400"
                    : h.uptime_pct >= 90 ? "text-amber-600" : "text-red-500"
                  )}>
                    {h.uptime_pct.toFixed(1)}%
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Graf s live pingem
// ---------------------------------------------------------------------------
function RttGraph({ ip, hostname, hours, limit, liveEnabled, liveIntervalMs }: {
  ip: string; hostname: string; hours: number; limit: number; liveEnabled: boolean; liveIntervalMs: number;
}) {
  const qc = useQueryClient();
  const { data: trend, isLoading, refetch, isFetching } = useRttTrend(ip, hours, limit);

  const [lastPing,   setLastPing]   = useState<Date | null>(null);
  const [countdown,  setCountdown]  = useState(liveIntervalMs / 1000);
  const [liveResult, setLiveResult] = useState<{
    rtt_ms: number | null; packet_loss: number; is_alive: boolean;
  } | null>(null);

  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const countRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const countValRef  = useRef(liveIntervalMs / 1000);

  const doPing = useCallback(async () => {
    try {
      const r = await api.post<{
        rtt_ms: number | null; packet_loss: number; is_alive: boolean;
      }>(`/hosts/${encodeURIComponent(ip)}/ping`);
      setLiveResult(r.data);
      setLastPing(new Date());
      // Invalidujeme cache a okamžitě refetchneme
      await qc.invalidateQueries({
        queryKey: ["rtt-trend", ip],
        exact: false,
        refetchType: "active",
      });
    } catch {}
    countValRef.current = liveIntervalMs / 1000;
    setCountdown(liveIntervalMs / 1000);
  }, [ip, qc, liveIntervalMs]);

  useEffect(() => {
    if (!liveEnabled) {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countRef.current) clearInterval(countRef.current);
      return;
    }
    doPing();
    timerRef.current = setInterval(doPing, liveIntervalMs);
    countRef.current = setInterval(() => {
      countValRef.current = Math.max(0, countValRef.current - 1);
      setCountdown(countValRef.current);
    }, 1000);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (countRef.current) clearInterval(countRef.current);
    };
  }, [liveEnabled, doPing, liveIntervalMs]);

  const points = useMemo(() => {
    if (!trend?.points) return [];
    return trend.points.map((p) => ({
      ts:          p.ts,
      rtt_ms:      p.alive ? (p.rtt_ms ?? null) : null,
      packet_loss: p.packet_loss ?? 0,
      alive:       p.alive,
    }));
  }, [trend]);

  const stats   = useMemo(() => calcStats(trend?.points ?? []), [trend]);
  const maxRtt  = stats.max ? stats.max * 1.35 : 100;
  const maxLoss = Math.max((stats.maxLoss ?? 0) * 1.5, 5);

  if (isLoading) return (
    <div className="flex h-64 items-center justify-center gap-2 text-muted-foreground">
      <Spinner className="h-5 w-5" />
      <span className="text-sm">Načítám data…</span>
    </div>
  );
  if (points.length === 0) return (
    <div className="flex h-48 items-center justify-center text-muted-foreground text-sm">
      Žádná data pro tuto IP v daném rozsahu
    </div>
  );

  return (
    <div className="space-y-3">
      {/* Hlavička */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h3 className="text-sm font-semibold">{hostname || ip}: ICMP dostupnost</h3>
          <p className="text-xs text-muted-foreground">
            {points.length} měření · uptime {stats.uptime.toFixed(2)} %
          </p>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {/* Live badge */}
          {liveEnabled && (
            <div className="flex items-center gap-2 text-xs">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-green-500" />
              </span>
              <span className="text-green-600 dark:text-green-400 font-medium">LIVE</span>
              <span className="text-muted-foreground">· za {countdown}s</span>
              {lastPing && (
                <span className="text-muted-foreground">
                  · {format(lastPing, "HH:mm:ss")}
                </span>
              )}
            </div>
          )}
          {/* Live výsledek */}
          {liveResult && liveEnabled && (
            <span className={cn(
              "flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
              liveResult.is_alive
                ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                : "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
            )}>
              {liveResult.is_alive
                ? <><Wifi className="h-3 w-3" /> {fmtMs(liveResult.rtt_ms)}</>
                : <><WifiOff className="h-3 w-3" /> offline</>}
            </span>
          )}
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
          </Button>
        </div>
      </div>

      {/* Graf */}
      <div className="rounded-lg border border-border bg-background">
        <ResponsiveContainer width="100%" height={320}>
          <ComposedChart data={points} margin={{ top: 8, right: 56, left: 10, bottom: 0 }}>
            <CartesianGrid strokeDasharray="4 4" stroke="hsl(var(--border))" strokeOpacity={0.5} />
            <XAxis
              dataKey="ts"
              tickFormatter={(ts) => fmtTick(ts, hours)}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              stroke="hsl(var(--border))"
              minTickGap={40}
              interval="preserveStartEnd"
            />
            <YAxis
              yAxisId="rtt"
              orientation="left"
              domain={[0, maxRtt]}
              tickFormatter={(v) => `${v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0)}ms`}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              stroke="hsl(var(--border))"
              width={54}
            />
            <YAxis
              yAxisId="loss"
              orientation="right"
              domain={[0, maxLoss]}
              tickFormatter={(v) => `${v.toFixed(1)}%`}
              tick={{ fontSize: 10, fill: "hsl(var(--muted-foreground))" }}
              stroke="hsl(var(--border))"
              width={48}
            />
            <Tooltip content={<ChartTooltip />} isAnimationActive={false} />
            <Bar
              yAxisId="loss"
              dataKey="packet_loss"
              fill="#ef4444"
              fillOpacity={0.65}
              maxBarSize={5}
              isAnimationActive={false}
            />
            <Line
              yAxisId="rtt"
              type="linear"
              dataKey="rtt_ms"
              stroke="#22c55e"
              strokeWidth={1.5}
              dot={false}
              activeDot={{ r: 3, fill: "#22c55e" }}
              connectNulls={false}
              isAnimationActive={false}
            />
            {stats.avg != null && (
              <ReferenceLine
                yAxisId="rtt"
                y={stats.avg}
                stroke="#22c55e"
                strokeDasharray="5 3"
                strokeOpacity={0.5}
                label={{ value: `avg ${fmtMs(stats.avg)}`, position: "insideTopLeft",
                         fontSize: 9, fill: "#22c55e", fillOpacity: 0.8 }}
              />
            )}
            <Brush
              dataKey="ts"
              height={18}
              stroke="hsl(var(--border))"
              fill="hsl(var(--muted))"
              travellerWidth={5}
              tickFormatter={(ts) => fmtTick(ts, hours)}
            >
              <Area dataKey="rtt_ms" fill="#22c55e" fillOpacity={0.15}
                    stroke="#22c55e" strokeWidth={0.5} />
            </Brush>
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legenda */}
      <div className="rounded-lg border border-border bg-muted/20 px-4 py-3 space-y-2">
        <LegendRow color="bg-green-500" label="ICMP response time"
          last={fmtMs(stats.last)} min={fmtMs(stats.min)}
          avg={fmtMs(stats.avg)} max={fmtMs(stats.max)} />
        <LegendRow color="bg-red-500" label="ICMP loss"
          last={`${(points[points.length - 1]?.packet_loss ?? 0).toFixed(1)} %`}
          min="0.0 %" avg={`${stats.avgLoss.toFixed(2)} %`}
          max={`${stats.maxLoss.toFixed(1)} %`} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// PresenceTimeline — zobrazení přítomnosti z ARP/DHCP
// ---------------------------------------------------------------------------
function PresenceTimeline({ ip, hostname, blocks, hours }: {
  ip:       string;
  hostname: string;
  blocks:   PresenceBlock[];
  hours:    number;
}) {
  if (blocks.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        <p className="text-lg mb-2">📭</p>
        <p>Žádná ARP/DHCP data pro tuto IP adresu</p>
        <p className="text-xs mt-1">Data se sbírají při pollu zařízení</p>
      </div>
    );
  }

  const now   = Date.now();
  const start = now - hours * 3600 * 1000;
  const total = now - start;

  const srcColors: Record<string, string> = {
    arp:  "bg-blue-500 dark:bg-blue-400",
    dhcp: "bg-yellow-500 dark:bg-yellow-400",
    ping: "bg-green-500 dark:bg-green-400",
  };
  const srcLabels: Record<string, string> = {
    arp:  "🔵 ARP",
    dhcp: "🟡 DHCP",
    ping: "🟢 Ping",
  };

  const onlineMs = blocks.reduce((sum, b) => {
    const f = Math.max(new Date(b.from).getTime(), start);
    const t = Math.min(new Date(b.to).getTime(), now);
    return sum + Math.max(0, t - f);
  }, 0);
  const uptimePct = ((onlineMs / total) * 100).toFixed(1);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h3 className="text-sm font-semibold">{hostname || ip}: Timeline přítomnosti</h3>
          <p className="text-xs text-muted-foreground">{blocks.length} bloků · online {uptimePct}% za posledních {hours}h</p>
        </div>
        <div className="flex gap-3 text-xs">
          {Object.entries(srcLabels).map(([src, label]) =>
            blocks.some(b => b.source === src) ? <span key={src}>{label}</span> : null
          )}
        </div>
      </div>

      <div className="relative h-12 rounded-lg overflow-hidden bg-muted/30 border border-border">
        {blocks.map((b, i) => {
          const bStart = new Date(b.from).getTime();
          const bEnd   = new Date(b.to).getTime();
          const left   = Math.max(0, ((bStart - start) / total) * 100);
          const width  = Math.min(100 - left, ((bEnd - bStart) / total) * 100);
          return (
            <div key={i}
              className={`absolute top-0 h-full opacity-80 hover:opacity-100 ${srcColors[b.source] || "bg-gray-500"}`}
              style={{ left: `${left}%`, width: `${Math.max(0.3, width)}%` }}
              title={`${b.source.toUpperCase()}: ${new Date(b.from).toLocaleString("cs-CZ")} → ${new Date(b.to).toLocaleString("cs-CZ")}`}
            />
          );
        })}
        <div className="absolute bottom-0 left-0 right-0 flex justify-between px-2 text-[9px] text-muted-foreground/60 pointer-events-none">
          <span>{new Date(start).toLocaleTimeString("cs-CZ", { hour: "2-digit", minute: "2-digit" })}</span>
          <span>nyní</span>
        </div>
      </div>

      <div className="space-y-1 max-h-64 overflow-y-auto">
        {[...blocks].reverse().map((b, i) => (
          <div key={i} className="flex items-center gap-3 text-xs py-1 border-b border-border/50 last:border-0">
            <span className={`inline-block h-2.5 w-2.5 rounded-full shrink-0 ${srcColors[b.source] || "bg-gray-400"}`} />
            <span className="font-mono text-muted-foreground w-32 shrink-0">
              {new Date(b.from).toLocaleString("cs-CZ", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className="text-muted-foreground">→</span>
            <span className="font-mono text-muted-foreground w-32 shrink-0">
              {new Date(b.to).toLocaleString("cs-CZ", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}
            </span>
            <span className={`font-medium ${b.source === "arp" ? "text-blue-600 dark:text-blue-400" : b.source === "dhcp" ? "text-yellow-600 dark:text-yellow-400" : "text-green-600"}`}>
              {srcLabels[b.source] || b.source}
            </span>
            <span className="text-muted-foreground ml-auto">
              {Math.round((new Date(b.to).getTime() - new Date(b.from).getTime()) / 60000)} min
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function GraphsPage() {
  const { data: hosts = [], isLoading: hostsLoading } = useHosts();
  const { data: ipAddresses = [] }                    = useIpAddresses();
  const ipAliveMap = useMemo(() => {
    const m: Record<string, { is_alive: boolean | null; alive_source: string | null }> = {};
    for (const a of ipAddresses) m[a.ip.split("/")[0]] = { is_alive: a.is_alive, alive_source: (a as any).alive_source };
    return m;
  }, [ipAddresses]);
  const [selectedIp, setSelectedIp] = useState("");
  const [rangeIdx,   setRangeIdx]   = useState(4);
  const [liveActive,    setLiveActive]    = useState(false);
  const [liveIntervalMs, setLiveIntervalMs] = useState(60_000);

  const range    = TIME_RANGES[rangeIdx];
  const selected = hosts.find((h) => h.ip.split("/")[0] === selectedIp);
  const [activeTab, setActiveTab] = useState<"rtt" | "presence">("rtt");
  const { data: presenceBlocks = [] } = useIpPresence(selectedIp || null, range.hours);

  // Zastavíme live při změně IP
  function handleSelectIp(ip: string) {
    setLiveActive(false);
    setSelectedIp(ip);
  }

  // Cleanup při opuštění stránky
  useEffect(() => () => setLiveActive(false), []);

  return (
    <div className="space-y-4">
      {/* Ovládací panel */}
      <div className="rounded-xl border border-border bg-card p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-4">

          {/* Vyhledávání IP */}
          {hostsLoading
            ? <div className="flex-1 min-w-[240px] flex items-end h-[62px]"><Spinner /></div>
            : <IpSearch hosts={hosts} value={selectedIp} onChange={handleSelectIp} />
          }

          {/* Časový rozsah */}
          <div className="flex-1 min-w-[260px]">
            <label className="block text-xs font-medium text-muted-foreground mb-1.5">
              Časový rozsah
            </label>
            <div className="flex rounded-md border border-border overflow-hidden">
              {TIME_RANGES.map((r, i) => (
                <button
                  key={i}
                  onClick={() => setRangeIdx(i)}
                  className={cn(
                    "flex-1 py-1.5 text-xs transition-colors",
                    i === rangeIdx
                      ? "bg-primary text-primary-foreground font-medium"
                      : "bg-background text-muted-foreground hover:bg-muted"
                  )}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {/* Live ping tlačítko + interval */}
          {selectedIp && (
            <div className="flex items-end gap-2">
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Live ping
                </label>
                <Button
                  variant={liveActive ? "primary" : "outline"}
                  size="sm"
                  onClick={() => setLiveActive((v) => !v)}
                  className={cn(liveActive && "ring-2 ring-green-500/30")}
                >
                  <Activity className={cn("h-3.5 w-3.5",
                    liveActive && "animate-pulse text-green-400")} />
                  {liveActive ? "Live ●" : "Spustit live"}
                </Button>
              </div>
              <div>
                <label className="block text-xs font-medium text-muted-foreground mb-1.5">
                  Interval
                </label>
                <div className="flex rounded-md border border-border overflow-hidden">
                  {LIVE_INTERVALS.map((iv) => (
                    <button
                      key={iv.ms}
                      onClick={() => {
                        setLiveIntervalMs(iv.ms);
                        if (liveActive) setLiveActive(false);
                      }}
                      className={cn(
                        "px-2.5 py-1.5 text-xs transition-colors",
                        iv.ms === liveIntervalMs
                          ? "bg-primary text-primary-foreground font-medium"
                          : "bg-background text-muted-foreground hover:bg-muted"
                      )}
                    >
                      {iv.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Info řádek */}
        {selected && (
          <div className="flex items-center gap-5 text-xs text-muted-foreground
                          border-t border-border pt-3 flex-wrap">
            {(() => {
              const cleanIp = selected.ip.split("/")[0];
              const ipInfo  = ipAliveMap[cleanIp];
              const alive   = ipInfo?.is_alive ?? selected.currently_alive;
              const src     = ipInfo?.alive_source;
              return (
                <span className={cn("font-semibold flex items-center gap-1",
                  alive ? "text-green-600 dark:text-green-400"
                        : "text-red-600 dark:text-red-400"
                )}>
                  {alive ? "● Online" : "○ Offline"}
                  {alive && src && src !== "ping" && (
                    <span className={cn("text-[9px] font-medium rounded px-1 py-0.5",
                      src === "arp"  && "bg-blue-100 text-blue-600 dark:bg-blue-950/40 dark:text-blue-400",
                      src === "dhcp" && "bg-yellow-100 text-yellow-600 dark:bg-yellow-950/40 dark:text-yellow-400",
                    )}>{src.toUpperCase()}</span>
                  )}
                </span>
              );
            })()}
            {[
              ["Uptime",  `${selected.uptime_pct?.toFixed(2)} %`],
              ["Avg RTT", `${selected.avg_rtt_ms?.toFixed(2)} ms`],
              ["Min RTT", `${selected.min_rtt_ms?.toFixed(2)} ms`],
              ["Max RTT", `${selected.max_rtt_ms?.toFixed(2)} ms`],
              ["Měření",  selected.checks?.toLocaleString() ?? "—"],
            ].map(([k, v]) => (
              <span key={k}>{k}: <strong>{v}</strong></span>
            ))}
          </div>
        )}
      </div>

      {/* Záložky RTT / Přítomnost */}
      {selectedIp && (
        <div className="flex border-b border-border mb-0 -mt-2">
          {(["rtt", "presence"] as const).map((tab) => (
            <button key={tab}
              onClick={() => setActiveTab(tab)}
              className={cn(
                "px-4 py-2 text-sm transition-colors",
                activeTab === tab
                  ? "border-b-2 border-primary font-medium text-foreground"
                  : "text-muted-foreground hover:text-foreground"
              )}>
              {tab === "rtt" ? "📈 RTT graf" : "📅 Přítomnost"}
            </button>
          ))}
        </div>
      )}

      {/* Graf nebo placeholder */}
      {!selectedIp ? (
        <div className="rounded-xl border border-dashed border-border p-16 text-center">
          <Search className="mx-auto h-8 w-8 text-muted-foreground mb-3" />
          <p className="text-muted-foreground text-sm">
            Vyhledejte IP adresu pro zobrazení grafu
          </p>
          <p className="text-muted-foreground text-xs mt-1">
            Zadejte IP nebo hostname do pole vyhledávání výše
          </p>
        </div>
      ) : activeTab === "rtt" ? (
        <div className="rounded-xl border border-border bg-card p-4">
          <RttGraph
            key={`${selectedIp}-${rangeIdx}`}
            ip={selectedIp}
            hostname={(selected as any)?.hostname ?? selectedIp}
            hours={range.hours}
            limit={range.limit}
            liveEnabled={liveActive}
            liveIntervalMs={liveIntervalMs}
          />
        </div>
      ) : (
        <div className="rounded-xl border border-border bg-card p-4">
          <PresenceTimeline
            ip={selectedIp}
            hostname={(selected as any)?.hostname ?? selectedIp}
            blocks={presenceBlocks}
            hours={range.hours}
          />
        </div>
      )}
    </div>
  );
}
