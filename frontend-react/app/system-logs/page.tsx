"use client";

import { useState } from "react";
import {
  AlertCircle, AlertTriangle, Info, Zap,
  RefreshCw, Trash2, Loader2, Search, Filter,
  Shield, CheckCircle2,
} from "lucide-react";
import {
  useSystemLogs, useSystemLogStats, useCleanupSystemLogs,
} from "@/hooks/useNetPulse";
import { useAuth } from "@/lib/auth";
import type { SystemLog } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button, Spinner } from "@/components/ui";

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("cs-CZ", {
    day: "2-digit", month: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  });
}

// ---------------------------------------------------------------------------
// Level badge
// ---------------------------------------------------------------------------
const LEVEL_CONFIG: Record<string, { icon: React.ElementType; cls: string; bg: string }> = {
  INFO:     { icon: Info,          cls: "text-blue-600 dark:text-blue-400",   bg: "bg-blue-50 dark:bg-blue-950/30" },
  WARNING:  { icon: AlertTriangle, cls: "text-amber-600 dark:text-amber-400", bg: "bg-amber-50 dark:bg-amber-950/30" },
  ERROR:    { icon: AlertCircle,   cls: "text-red-600 dark:text-red-400",     bg: "bg-red-50 dark:bg-red-950/30" },
  CRITICAL: { icon: Zap,           cls: "text-red-700 dark:text-red-300",     bg: "bg-red-100 dark:bg-red-950/50" },
};

function LevelBadge({ level }: { level: string }) {
  const cfg = LEVEL_CONFIG[level] ?? LEVEL_CONFIG.INFO;
  const Icon = cfg.icon;
  return (
    <span className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium", cfg.bg, cfg.cls)}>
      <Icon className="h-3 w-3" />
      {level}
    </span>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color?: string }) {
  return (
    <div className="rounded-lg border border-border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className={cn("text-2xl font-semibold tabular-nums", color)}>{value}</p>
    </div>
  );
}

function MetaPanel({ meta }: { meta: Record<string, unknown> | null }) {
  if (!meta || Object.keys(meta).length === 0) return null;
  return (
    <div className="mt-1 rounded bg-muted/30 px-2 py-1 text-[10px] font-mono text-muted-foreground">
      {Object.entries(meta).filter(([, v]) => v != null).map(([k, v]) => (
        <span key={k} className="mr-3">
          <span className="text-foreground/60">{k}=</span>{String(v)}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function SystemLogsPage() {
  const { user } = useAuth();

  if (user && user.role !== "admin") {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3 text-muted-foreground">
        <Shield className="h-10 w-10 opacity-30" />
        <p className="text-sm">Přístup pouze pro administrátory.</p>
      </div>
    );
  }

  const [levelFilter,  setLevelFilter]  = useState("");
  const [moduleFilter, setModuleFilter] = useState("");
  const [eventFilter,  setEventFilter]  = useState("");
  const [search,       setSearch]       = useState("");
  const [hours,        setHours]        = useState(24);
  const [expanded,     setExpanded]     = useState<number | null>(null);

  const params = {
    limit:      500,
    level:      levelFilter  || undefined,
    module:     moduleFilter || undefined,
    event_type: eventFilter  || undefined,
    search:     search       || undefined,
    hours,
  };

  const { data: logs = [], isLoading, refetch, isFetching } = useSystemLogs(params);
  const { data: meta }  = useSystemLogStats();
  const cleanup         = useCleanupSystemLogs();
  const stats           = meta?.stats;

  return (
    <div className="space-y-5">
      {/* Hlavička */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">System Logs</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Strukturované záznamy událostí backendu — pouze administrátoři
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <RefreshCw className={cn("h-4 w-4", isFetching && "animate-spin")} />
            Obnovit
          </button>
          <Button variant="outline" size="sm" onClick={() => cleanup.mutate()} disabled={cleanup.isPending}>
            {cleanup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Cleanup
          </Button>
        </div>
      </div>

      {/* Statistiky */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
          <StatCard label="Celkem" value={stats.total} />
          <StatCard label="Posledních 24h" value={stats.last_24h} color="text-primary" />
          <StatCard label="INFO" value={stats.info_count} color="text-blue-600 dark:text-blue-400" />
          <StatCard label="WARNING" value={stats.warning_count}
            color={stats.warning_count > 0 ? "text-amber-600 dark:text-amber-400" : undefined} />
          <StatCard label="ERROR / CRITICAL" value={stats.error_count}
            color={stats.error_count > 0 ? "text-red-600 dark:text-red-400" : undefined} />
        </div>
      )}

      {/* Filtry */}
      <div className="flex flex-wrap gap-2 items-center">
        <Filter className="h-4 w-4 text-muted-foreground shrink-0" />

        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="text" placeholder="Hledat…" value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 pl-8 pr-3 rounded-md border border-border bg-background text-sm w-48 focus:outline-none focus:ring-1 focus:ring-ring"
          />
        </div>

        <select value={levelFilter} onChange={(e) => setLevelFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none">
          <option value="">Všechny levely</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="ERROR">ERROR</option>
          <option value="CRITICAL">CRITICAL</option>
        </select>

        <select value={moduleFilter} onChange={(e) => setModuleFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none">
          <option value="">Všechny moduly</option>
          {(meta?.modules ?? []).map((m) => (
            <option key={m} value={m}>{m.replace("netpulse.", "")}</option>
          ))}
        </select>

        <select value={eventFilter} onChange={(e) => setEventFilter(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-2 text-sm focus:outline-none">
          <option value="">Všechny události</option>
          {(meta?.event_types ?? []).map((e) => (
            <option key={e} value={e}>{e}</option>
          ))}
        </select>

        {([6, 24, 48, 168] as const).map((h) => (
          <button key={h} onClick={() => setHours(h)}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-medium border transition-colors",
              hours === h
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground"
            )}>
            {h < 24 ? `${h}h` : `${h / 24}d`}
          </button>
        ))}

        <span className="ml-auto text-xs text-muted-foreground">{logs.length} záznamů</span>
      </div>

      {/* Tabulka */}
      {isLoading && (
        <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
          <Spinner className="h-5 w-5" />
          <span className="text-sm">Načítám logy…</span>
        </div>
      )}

      {!isLoading && logs.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <CheckCircle2 className="h-10 w-10 mx-auto text-muted-foreground/20 mb-3" />
          <p className="text-sm text-muted-foreground">Žádné záznamy pro vybrané filtry</p>
        </div>
      )}

      {!isLoading && logs.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-36">Čas</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground w-24">Level</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground w-28">Modul</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground w-32">Událost</th>
                <th className="px-3 py-2.5 text-left text-xs font-medium text-muted-foreground">Zpráva</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-28">Zařízení</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground w-20">Uživatel</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log: SystemLog, idx: number) => {
                const isExpanded = expanded === log.id;
                return (
                  <tr key={log.id}
                    onClick={() => setExpanded(isExpanded ? null : log.id)}
                    className={cn(
                      "border-b border-border last:border-0 cursor-pointer transition-colors",
                      isExpanded ? "bg-muted/30" : idx % 2 === 0 ? "" : "bg-muted/5",
                      "hover:bg-muted/20",
                      log.level === "ERROR" || log.level === "CRITICAL"
                        ? "bg-red-50/30 dark:bg-red-950/10 hover:bg-red-50/50 dark:hover:bg-red-950/20"
                        : log.level === "WARNING"
                        ? "bg-amber-50/20 dark:bg-amber-950/10"
                        : ""
                    )}
                  >
                    <td className="px-4 py-2 text-xs font-mono text-muted-foreground whitespace-nowrap">
                      {formatDate(log.created_at)}
                    </td>
                    <td className="px-3 py-2"><LevelBadge level={log.level} /></td>
                    <td className="px-3 py-2 text-xs text-muted-foreground truncate max-w-[112px]">
                      {log.module.replace("netpulse.", "")}
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-xs font-mono bg-muted/50 rounded px-1.5 py-0.5">{log.event_type}</span>
                    </td>
                    <td className="px-3 py-2">
                      <p className="text-xs truncate max-w-sm">{log.message}</p>
                      {isExpanded && <MetaPanel meta={log.meta} />}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground truncate">
                      {log.alias || log.hostname || (log.device_id ? `#${log.device_id}` : "—")}
                    </td>
                    <td className="px-4 py-2 text-xs text-muted-foreground">
                      {log.user_name ?? <span className="opacity-50">systém</span>}
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
}
