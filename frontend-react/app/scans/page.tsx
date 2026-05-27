"use client";

import { useState, useMemo, useEffect } from "react";
import {
  Activity, CheckCircle, XCircle, Clock,
  RefreshCw, Wifi, Search, Cpu, ChevronDown, HardDrive, Radio,
} from "lucide-react";
import { useScanJobs, useScanJobsStats, useTriggerScan } from "@/hooks/useNetPulse";
import type { ScanJob, ScanJobStats } from "@/lib/types";
import { MetricCard, Select, Spinner, Button } from "@/components/ui";
import { formatDateTime, cn } from "@/lib/utils";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Cell,
} from "recharts";

// ---------------------------------------------------------------------------
// Typy jobů — metadata
// ---------------------------------------------------------------------------
const JOB_META: Record<string, {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  color: string;
  bg: string;
}> = {
  ping_scan:  {
    label: "Ping scan",
    icon:  Wifi,
    color: "text-blue-600 dark:text-blue-400",
    bg:    "bg-blue-50 dark:bg-blue-950/40",
  },
  discovery:  {
    label: "Discovery",
    icon:  Search,
    color: "text-purple-600 dark:text-purple-400",
    bg:    "bg-purple-50 dark:bg-purple-950/40",
  },
  snmp_poll:  {
    label: "SNMP poll",
    icon:  Cpu,
    color: "text-amber-600 dark:text-amber-400",
    bg:    "bg-amber-50 dark:bg-amber-950/40",
  },
  poll:  {
    label: "Poll scan",
    icon:  Radio,
    color: "text-cyan-600 dark:text-cyan-400",
    bg:    "bg-cyan-50 dark:bg-cyan-950/40",
  },
  backup:  {
    label: "Backup",
    icon:  HardDrive,
    color: "text-green-600 dark:text-green-400",
    bg:    "bg-green-50 dark:bg-green-950/40",
  },
};

const STATUS_META = {
  done:    { label: "Dokončeno",  color: "text-green-600 dark:text-green-400",  icon: CheckCircle },
  error:   { label: "Chyba",      color: "text-red-600 dark:text-red-400",      icon: XCircle },
  running: { label: "Probíhá",    color: "text-blue-600 dark:text-blue-400",    icon: RefreshCw },
};

// ---------------------------------------------------------------------------
// Formátování doby trvání
// ---------------------------------------------------------------------------
function formatDuration(s: number | null): string {
  if (s == null) return "—";
  if (s < 60)   return `${s.toFixed(1)}s`;
  if (s < 3600) return `${(s / 60).toFixed(1)}min`;
  return `${(s / 3600).toFixed(1)}h`;
}

// ---------------------------------------------------------------------------
// Statistikové karty
// ---------------------------------------------------------------------------
function StatsRow({ stats }: { stats: ScanJobStats }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-7">
      <MetricCard label="Celkem jobů"    value={stats.total} />
      <MetricCard label="Dokončeno"      value={stats.done}
        color="green" sub={`${stats.errors} chyb`} />
      <MetricCard label="Ping scanů"     value={stats.ping_scans} />
      <MetricCard label="Discovery"      value={stats.discoveries} />
      <MetricCard label="Zálohy"         value={stats.backups ?? 0}
        color="green" />
      <MetricCard label="Průměrná doba"
        value={formatDuration(stats.avg_duration_s)}
        sub={`min ${formatDuration(stats.min_duration_s)}`} />
      <MetricCard label="Nejdelší"
        value={formatDuration(stats.max_duration_s)} />
      <MetricCard label="Právě běží"     value={stats.running}
        color={stats.running > 0 ? "amber" : "default"} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Miniaturní bar chart — počet jobů per hodina
// ---------------------------------------------------------------------------
function ActivityChart({ jobs }: { jobs: ScanJob[] }) {
  const data = useMemo(() => {
    // Poslední 24 hodin po hodinách
    const now    = Date.now();
    const hours  = Array.from({ length: 24 }, (_, i) => {
      const h = new Date(now - (23 - i) * 3600_000);
      return {
        label:     `${h.getHours()}:00`,
        ping:      0,
        discovery: 0,
        backup:    0,
        error:     0,
      };
    });
    jobs.forEach((job) => {
      const t   = new Date(job.started_at).getTime();
      const idx = Math.floor((now - t) / 3600_000);
      if (idx < 0 || idx >= 24) return;
      const bucket = hours[23 - idx];
      if (!bucket) return;
      if (job.status === "error") {
        bucket.error++;
      } else if (job.job_type === "discovery") {
        bucket.discovery++;
      } else if (job.job_type === "backup") {
        bucket.backup++;
      } else {
        bucket.ping++;
      }
    });
    return hours;
  }, [jobs]);

  return (
    <ResponsiveContainer width="100%" height={120}>
      <BarChart data={data} margin={{ top: 4, right: 4, left: -28, bottom: 0 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
        <XAxis dataKey="label" tick={{ fontSize: 9 }} stroke="hsl(var(--border))"
               interval={3} />
        <YAxis tick={{ fontSize: 9 }} stroke="hsl(var(--border))" />
        <Tooltip
          contentStyle={{
            background: "hsl(var(--card))",
            border: "1px solid hsl(var(--border))",
            borderRadius: "6px",
            fontSize: "11px",
          }}
        />
        <Bar dataKey="ping"      name="Ping scan"  stackId="a" fill="#3b82f6" radius={[0,0,0,0]} />
        <Bar dataKey="discovery" name="Discovery"  stackId="a" fill="#a855f7" radius={[0,0,0,0]} />
        <Bar dataKey="backup"    name="Backup"     stackId="a" fill="#22c55e" radius={[0,0,0,0]} />
        <Bar dataKey="poll"      name="Poll scan"  stackId="a" fill="#06b6d4" radius={[0,0,0,0]} />
        <Bar dataKey="error"     name="Chyba"      stackId="a" fill="#ef4444" radius={[4,4,0,0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Řádek jobu
// ---------------------------------------------------------------------------
function JobRow({ job }: { job: ScanJob }) {
  const [open, setOpen] = useState(false);
  const meta   = JOB_META[job.job_type]   ?? JOB_META.ping_scan;
  const status = STATUS_META[job.status]  ?? STATUS_META.done;
  const Icon   = meta.icon;
  const SIcon  = status.icon;

  const successRate = job.total_targets > 0
    ? ((job.ok_count / job.total_targets) * 100).toFixed(0)
    : null;

  return (
    <div className="rounded-lg border border-border bg-card overflow-hidden">
      {/* Hlavní řádek */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-muted/30 transition-colors"
        onClick={() => setOpen((v) => !v)}
      >
        {/* Ikona typu */}
        <div className={cn("flex h-8 w-8 shrink-0 items-center justify-center rounded-lg", meta.bg)}>
          <Icon className={cn("h-4 w-4", meta.color)} />
        </div>

        {/* Typ a trigger */}
        <div className="min-w-0 w-36 shrink-0">
          <p className="text-sm font-medium">{meta.label}</p>
          <p className="text-xs text-muted-foreground">
            {job.trigger_type === "manual" ? "⚡ manuálně" : "⏰ cron"}
            {job.triggered_by && ` · ${job.triggered_by}`}
          </p>
        </div>

        {/* Status */}
        <div className={cn("flex items-center gap-1.5 w-28 shrink-0", status.color)}>
          <SIcon className={cn(
            "h-3.5 w-3.5 shrink-0",
            job.status === "running" && "animate-spin"
          )} />
          <span className="text-xs font-medium">{status.label}</span>
        </div>

        {/* Čas */}
        <div className="hidden sm:block min-w-0 w-36 shrink-0">
          <p className="text-xs text-muted-foreground">{formatDateTime(job.started_at)}</p>
          {job.finished_at && (
            <p className="text-xs text-muted-foreground">
              → {formatDateTime(job.finished_at)}
            </p>
          )}
        </div>

        {/* Trvání */}
        <div className="w-16 shrink-0 text-right">
          <span className="text-sm font-mono font-medium tabular-nums">
            {formatDuration(job.duration_s)}
          </span>
        </div>

        {/* Výsledky */}
        <div className="flex-1 hidden md:flex items-center gap-3 text-xs">
          <span className="text-muted-foreground">{job.total_targets} cílů</span>
          {job.ok_count > 0 && (
            <span className="text-green-600 dark:text-green-400">
              ✓ {job.ok_count}
            </span>
          )}
          {job.fail_count > 0 && (
            <span className="text-red-600 dark:text-red-400">
              ✗ {job.fail_count}
            </span>
          )}
          {job.changed_count > 0 && (
            <span className="text-amber-600 dark:text-amber-400">
              ↕ {job.changed_count} změn
            </span>
          )}
          {/* Progress bar úspěšnosti */}
          {successRate && job.status === "done" && (
            <div className="flex items-center gap-1.5 ml-auto">
              <div className="w-20 h-1.5 rounded-full bg-muted overflow-hidden">
                <div
                  className={cn(
                    "h-full rounded-full",
                    Number(successRate) >= 90 ? "bg-green-500" :
                    Number(successRate) >= 50 ? "bg-amber-500" : "bg-red-500"
                  )}
                  style={{ width: `${successRate}%` }}
                />
              </div>
              <span className="text-muted-foreground tabular-nums">{successRate}%</span>
            </div>
          )}
        </div>

        <ChevronDown className={cn(
          "h-4 w-4 text-muted-foreground transition-transform duration-150 shrink-0",
          open && "rotate-180"
        )} />
      </div>

      {/* Detail */}
      {open && (
        <div className="border-t border-border px-4 py-3 space-y-3 bg-muted/10">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 text-xs">
            <div>
              <p className="text-muted-foreground">Job ID</p>
              <p className="font-mono font-medium">#{job.id}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Zahájení</p>
              <p className="font-medium">{formatDateTime(job.started_at)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Ukončení</p>
              <p className="font-medium">{formatDateTime(job.finished_at)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Doba trvání</p>
              <p className="font-medium font-mono">{formatDuration(job.duration_s)}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Celkem cílů</p>
              <p className="font-medium">{job.total_targets}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Úspěšných</p>
              <p className="font-medium text-green-600 dark:text-green-400">{job.ok_count}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Selhalo</p>
              <p className="font-medium text-red-600 dark:text-red-400">{job.fail_count}</p>
            </div>
            <div>
              <p className="text-muted-foreground">Změny</p>
              <p className="font-medium text-amber-600 dark:text-amber-400">{job.changed_count}</p>
            </div>
          </div>

          {/* Meta data */}
          {Object.keys(job.meta || {}).length > 0 && (
            <div className="rounded-md bg-muted/40 px-3 py-2 text-xs space-y-1">
              {Object.entries(job.meta).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-muted-foreground w-24 shrink-0">{k}:</span>
                  <span className="font-mono break-all">
                    {Array.isArray(v) ? v.join(", ") : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* Chybová zpráva */}
          {job.error_msg && (
            <div className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
              <p className="font-medium mb-1">Chyba:</p>
              <p className="font-mono">{job.error_msg}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Stránkování
// ---------------------------------------------------------------------------
function usePaged<T>(items: T[], pageSize = 100) {
  const [page, setPage] = useState(1);
  useEffect(() => setPage(1), [items.length]);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const paged = items.slice((page - 1) * pageSize, page * pageSize);
  return { page, setPage, totalPages, paged, total: items.length, pageSize };
}

function PagerUI({ page, totalPages, total, pageSize, setPage }: {
  page: number; totalPages: number; total: number;
  pageSize: number; setPage: (p: number) => void;
}) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to   = Math.min(page * pageSize, total);
  const pages = totalPages <= 7
    ? Array.from({ length: totalPages }, (_, i) => i + 1)
    : page < 5 ? [1,2,3,4,5,0,totalPages]
    : page > totalPages-4 ? [1,0,totalPages-4,totalPages-3,totalPages-2,totalPages-1,totalPages]
    : [1,0,page-1,page,page+1,0,totalPages];
  return (
    <div className="flex items-center justify-between border-t border-border px-4 py-2 text-xs text-muted-foreground">
      <span>{from}–{to} z {total.toLocaleString("cs-CZ")}</span>
      <div className="flex items-center gap-1">
        <button onClick={() => setPage(page-1)} disabled={page===1}
          className="flex h-6 w-6 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40">
          ‹
        </button>
        {pages.map((p, i) => p === 0
          ? <span key={`e${i}`}>…</span>
          : <button key={p} onClick={() => setPage(p)}
              className={`h-6 min-w-[24px] rounded border px-1 ${p===page ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"}`}>
              {p}
            </button>
        )}
        <button onClick={() => setPage(page+1)} disabled={page===totalPages}
          className="flex h-6 w-6 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40">
          ›
        </button>
      </div>
    </div>
  );
}

export default function ScansPage() {
  const [typeFilter,   setTypeFilter]   = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const triggerScan = useTriggerScan();

  const { data: jobs  = [], isLoading }  = useScanJobs(typeFilter || undefined, 200);
  const { paged: pagedJobs, page, setPage, totalPages, total, pageSize } = usePaged(jobs);
  const { data: stats }                  = useScanJobsStats();

  // Lokální filtr statusu
  const filteredJobs = useMemo(() => {
    if (!statusFilter) return jobs;
    return jobs.filter((j) => j.status === statusFilter);
  }, [jobs, statusFilter]);

  return (
    <div className="space-y-5">

      {/* Statistiky */}
      {stats && <StatsRow stats={stats} />}

      {/* Graf aktivity */}
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <p className="text-sm font-semibold">
            Aktivita scanování
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              posledních 24 hodin
            </span>
          </p>
        </div>
        <ActivityChart jobs={jobs} />
        <div className="mt-2 flex items-center gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-blue-500" /> Ping scan
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-purple-500" /> Discovery
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-green-500" /> Backup
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm bg-red-500" /> Chyba
          </span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2">
        <Select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="w-40">
          <option value="">Vše — typ</option>
          <option value="ping_scan">Ping scan</option>
          <option value="discovery">Discovery</option>
          <option value="snmp_poll">SNMP poll</option>
          <option value="poll">Poll scan</option>
          <option value="backup">Backup</option>
        </Select>
        <Select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} className="w-40">
          <option value="">Vše — stav</option>
          <option value="done">Dokončeno</option>
          <option value="error">Chyba</option>
          <option value="running">Probíhá</option>
        </Select>
        <span className="text-xs text-muted-foreground">
          {filteredJobs.length} jobů
        </span>
        <div className="flex-1" />
        <Button
          variant="primary"
          size="sm"
          onClick={() => triggerScan.mutate()}
          disabled={triggerScan.isPending}
        >
          <RefreshCw className={cn("h-3.5 w-3.5", triggerScan.isPending && "animate-spin")} />
          Spustit scan
        </Button>
      </div>

      {/* Seznam jobů */}
      {isLoading ? (
        <div className="flex h-32 items-center justify-center">
          <Spinner className="h-6 w-6" />
        </div>
      ) : filteredJobs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-8 text-center">
          <Activity className="mx-auto h-8 w-8 text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            Žádné záznamy — spusťte první scan tlačítkem výše
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {filteredJobs.map((job) => (
            <JobRow key={job.id} job={job} />
          ))}
        </div>
      )}
          <PagerUI page={page} totalPages={totalPages} total={total} pageSize={pageSize} setPage={setPage} />
    </div>
  );
}
