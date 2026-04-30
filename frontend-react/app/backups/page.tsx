"use client";

import React, { useState } from "react";
import {
  HardDrive, Download, Trash2, Loader2, RefreshCw,
  CheckCircle2, AlertCircle, Clock, Filter,
} from "lucide-react";
import { useAllBackups, useBackupStats, useDeleteBackup, getErrorMessage } from "@/hooks/useNetPulse";
import type { DeviceBackup } from "@/lib/types";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Pomocné funkce
// ---------------------------------------------------------------------------

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString("cs-CZ", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

// ---------------------------------------------------------------------------
// Stat karta
// ---------------------------------------------------------------------------
function StatCard({
  label, value, sub, icon: Icon, color,
}: {
  label: string; value: string | number; sub?: string;
  icon: React.ElementType; color: string;
}) {
  return (
    <div className="rounded-lg border border-border bg-background p-4 flex gap-3 items-start">
      <div className={cn("rounded-md p-2", color)}>
        <Icon className="h-4 w-4" />
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{label}</p>
        <p className="text-xl font-semibold tabular-nums">{value}</p>
        {sub && <p className="text-xs text-muted-foreground mt-0.5">{sub}</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function BackupsPage() {
  const [statusFilter, setStatusFilter] = useState<string | undefined>(undefined);
  const [typeFilter, setTypeFilter]     = useState<string>("all");
  const [search, setSearch]             = useState("");

  const { data: backups = [], isLoading, refetch } = useAllBackups(statusFilter);
  const { data: stats }   = useBackupStats();
  const deleteBackup      = useDeleteBackup();
  const [deleting, setDeleting] = useState<number | null>(null);

  // Filtrování v prohlížeči
  const filtered = backups.filter((b) => {
    if (typeFilter !== "all" && b.backup_type !== typeFilter) return false;
    if (search) {
      const q = search.toLowerCase();
      const name = (b.hostname ?? b.alias ?? b.ip ?? "").toLowerCase();
      if (!name.includes(q) && !b.filename.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  async function handleDelete(b: DeviceBackup) {
    if (!confirm(`Smazat zálohu ${b.filename}?`)) return;
    setDeleting(b.id);
    try {
      await deleteBackup.mutateAsync(b.id);
    } finally {
      setDeleting(null);
    }
  }

  function handleDownload(b: DeviceBackup) {
    window.open(`/api/backend/backups/${b.id}/download`, "_blank");
  }

  const typeBg: Record<string, string> = {
    binary: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    export: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  };

  return (
    <div className="space-y-6">
      {/* Nadpis */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Zálohy zařízení</h1>
          <p className="text-sm text-muted-foreground mt-1">
            Přehled všech záloh — binary (.backup) i export (.rsc)
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isLoading}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          <RefreshCw className={cn("h-4 w-4", isLoading && "animate-spin")} />
          Obnovit
        </button>
      </div>

      {/* Statistiky */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard
            label="Celkem záloh"
            value={stats.total}
            sub={`${stats.device_count} zařízení`}
            icon={HardDrive}
            color="bg-muted text-muted-foreground"
          />
          <StatCard
            label="Úspěšných"
            value={stats.ok_count}
            sub={stats.total_size_human}
            icon={CheckCircle2}
            color="bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400"
          />
          <StatCard
            label="Selhalo"
            value={stats.failed_count}
            icon={AlertCircle}
            color={stats.failed_count > 0
              ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
              : "bg-muted text-muted-foreground"}
          />
          <StatCard
            label="Poslední záloha"
            value={stats.last_backup_at ? formatDate(stats.last_backup_at) : "—"}
            icon={Clock}
            color="bg-muted text-muted-foreground"
          />
        </div>
      )}

      {/* Filtry */}
      <div className="flex flex-wrap gap-2 items-center">
        <Filter className="h-4 w-4 text-muted-foreground" />

        {/* Vyhledávání */}
        <input
          type="text"
          placeholder="Hledat zařízení nebo soubor…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 rounded-md border border-border bg-background px-3 text-sm w-52 focus:outline-none focus:ring-1 focus:ring-ring"
        />

        {/* Typ zálohy */}
        {(["all", "binary", "export"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTypeFilter(t)}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-medium transition-colors border",
              typeFilter === t
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {t === "all" ? "Vše" : t === "binary" ? ".backup" : ".rsc"}
          </button>
        ))}

        {/* Stav */}
        {([undefined, "ok", "failed"] as const).map((s) => (
          <button
            key={String(s)}
            onClick={() => setStatusFilter(s)}
            className={cn(
              "h-8 rounded-md px-3 text-xs font-medium transition-colors border",
              statusFilter === s
                ? "bg-primary text-primary-foreground border-primary"
                : "border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            {s === undefined ? "Všechny stavy" : s === "ok" ? "✓ OK" : "✗ Selhané"}
          </button>
        ))}

        <span className="ml-auto text-xs text-muted-foreground">
          Zobrazeno {filtered.length} z {backups.length}
        </span>
      </div>

      {/* Tabulka záloh */}
      {isLoading && (
        <div className="flex items-center gap-2 py-8 justify-center text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin" />
          <span className="text-sm">Načítám zálohy…</span>
        </div>
      )}

      {!isLoading && filtered.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-12 text-center">
          <HardDrive className="h-10 w-10 mx-auto text-muted-foreground/20 mb-3" />
          <p className="text-sm text-muted-foreground">Žádné zálohy</p>
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="text-left px-4 py-2.5 text-xs font-medium text-muted-foreground">Zařízení</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Typ</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Datum zálohy</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Stav</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Velikost</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Verze ROS</th>
                <th className="text-left px-3 py-2.5 text-xs font-medium text-muted-foreground">Spustil</th>
                <th className="text-right px-4 py-2.5 text-xs font-medium text-muted-foreground">Akce</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((b, idx) => (
                <tr
                  key={b.id}
                  className={cn(
                    "border-b border-border last:border-0 transition-colors hover:bg-muted/20",
                    idx % 2 === 0 ? "" : "bg-muted/5"
                  )}
                >
                  {/* Zařízení */}
                  <td className="px-4 py-2.5">
                    <p className="font-medium truncate max-w-[180px]">
                      {b.alias || b.hostname || b.ip || "—"}
                    </p>
                    {b.alias && b.hostname && (
                      <p className="text-xs text-muted-foreground font-mono truncate">{b.hostname}</p>
                    )}
                    <p className="text-xs text-muted-foreground font-mono">{b.ip}</p>
                  </td>

                  {/* Typ */}
                  <td className="px-3 py-2.5">
                    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", typeBg[b.backup_type])}>
                      {b.backup_type === "binary" ? ".backup" : ".rsc"}
                    </span>
                  </td>

                  {/* Datum */}
                  <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground whitespace-nowrap">
                    {formatDate(b.created_at)}
                  </td>

                  {/* Stav */}
                  <td className="px-3 py-2.5">
                    {b.status === "ok" && (
                      <span className="flex items-center gap-1 text-green-600 dark:text-green-400 text-xs">
                        <CheckCircle2 className="h-3.5 w-3.5" />OK
                      </span>
                    )}
                    {b.status === "failed" && (
                      <span
                        className="flex items-center gap-1 text-red-500 text-xs cursor-help"
                        title={b.error_msg ?? ""}
                      >
                        <AlertCircle className="h-3.5 w-3.5" />Selhalo
                      </span>
                    )}
                    {b.status === "running" && (
                      <span className="flex items-center gap-1 text-muted-foreground text-xs">
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />Probíhá
                      </span>
                    )}
                  </td>

                  {/* Velikost */}
                  <td className="px-3 py-2.5 text-xs tabular-nums text-muted-foreground">
                    {b.status === "ok" ? formatBytes(b.file_size_bytes) : "—"}
                  </td>

                  {/* Verze ROS */}
                  <td className="px-3 py-2.5 text-xs font-mono text-muted-foreground">
                    {b.mikrotik_version ?? "—"}
                  </td>

                  {/* Spustil */}
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">
                    {b.triggered_by}
                  </td>

                  {/* Akce */}
                  <td className="px-4 py-2.5">
                    <div className="flex items-center gap-1 justify-end">
                      {b.status === "ok" && (
                        <button
                          onClick={() => handleDownload(b)}
                          className="p-1.5 rounded hover:bg-muted/60 text-muted-foreground hover:text-foreground transition-colors"
                          title={`Stáhnout ${b.filename}`}
                        >
                          <Download className="h-3.5 w-3.5" />
                        </button>
                      )}
                      <button
                        onClick={() => handleDelete(b)}
                        disabled={deleting === b.id}
                        className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                        title="Smazat zálohu"
                      >
                        {deleting === b.id
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <Trash2 className="h-3.5 w-3.5" />}
                      </button>
                    </div>
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
