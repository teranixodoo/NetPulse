"use client";

import { useEffect, useState } from "react";
import { Save, Loader2, Trash2, RefreshCw, Database, HardDrive, Table2, AlertTriangle } from "lucide-react";
import {
  useConfig, useUpdateConfig, useHealth,
  useScanStatus, useTriggerScan, getErrorMessage,
} from "@/hooks/useNetPulse";
import { dataApi } from "@/lib/api";
import { Button, MetricCard, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Jednoduchý number input — žádná Zod magie, jen čistý controlled input
// ---------------------------------------------------------------------------
function NumInput({
  label,
  value,
  onChange,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(e) => {
          const v = parseInt(e.target.value, 10);
          if (!isNaN(v)) onChange(v);
        }}
        className="h-9 w-full rounded-md border border-border bg-background
                   px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sekce wrapper
// ---------------------------------------------------------------------------
function Section({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-lg border border-border bg-card p-6 space-y-4">
      <div>
        <h2 className="text-base font-semibold">{title}</h2>
        {description && (
          <p className="mt-0.5 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function SettingsPage() {
  const { data: config, isLoading } = useConfig();
  const updateConfig  = useUpdateConfig();
  const triggerScan   = useTriggerScan();
  const { data: status }  = useScanStatus();
  const { data: healthy } = useHealth();

  const [cleanupResult,  setCleanupResult]  = useState<string | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [dbStats,        setDbStats]        = useState<any | null>(null);
  const [dbStatsLoading, setDbStatsLoading] = useState(false);
  const [saved,          setSaved]          = useState(false);

  // Lokální stav formuláře — čistá čísla
  const [scanInterval,  setScanInterval]  = useState(300);
  const [pingCount,     setPingCount]     = useState(3);
  const [pingTimeout,   setPingTimeout]   = useState(1000);
  const [maxConcurrent, setMaxConcurrent] = useState(128);
  const [alertRtt,      setAlertRtt]      = useState(100);
  const [alertEmail,    setAlertEmail]    = useState("");
  const [retention,     setRetention]     = useState(30);
  // Discovery scheduler
  const [discoveryEnabled,    setDiscoveryEnabled]    = useState(false);
  const [discoveryInterval,   setDiscoveryInterval]   = useState(3600);
  const [discoveryOnlyOnline, setDiscoveryOnlyOnline] = useState(true);

  // Naplníme stavem z API jakmile dorazí
  useEffect(() => {
    if (!config) return;
    setScanInterval(Number(config.scan_interval_s) || 300);
    setPingCount(Number(config.ping_count)          || 3);
    setPingTimeout(Number(config.ping_timeout_ms)   || 1000);
    setMaxConcurrent(Number(config.max_concurrent)  || 128);
    setAlertRtt(Number(config.alert_rtt_ms)         || 0);
    setAlertEmail(config.alert_email                || "");
    setRetention(Number(config.retention_days)      || 30);
    // Discovery
    setDiscoveryEnabled(String((config as any).discovery_enabled) === "true");
    setDiscoveryInterval(Number((config as any).discovery_interval_s) || 3600);
    setDiscoveryOnlyOnline(String((config as any).discovery_only_online) !== "false");
  }, [config]);

  async function handleSave() {
    setSaved(false);
    try {
      await updateConfig.mutateAsync({
        scan_interval_s:      scanInterval,
        ping_count:           pingCount,
        ping_timeout_ms:      pingTimeout,
        max_concurrent:       maxConcurrent,
        alert_rtt_ms:         alertRtt,
        alert_email:          alertEmail,
        retention_days:       retention,
        discovery_enabled:    String(discoveryEnabled),
        discovery_interval_s: discoveryInterval,
        discovery_only_online:String(discoveryOnlyOnline),
      } as any);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      alert(getErrorMessage(err));
    }
  }

  async function loadDbStats() {
    setDbStatsLoading(true);
    try {
      const r = await fetch("/api/backend/system/db-stats", {
        headers: { Authorization: `Bearer ${document.cookie.match(/np_token=([^;]+)/)?.[1] ?? ""}` },
      });
      const data = await r.json();
      setDbStats(data);
    } catch (err) {
      console.error("DB stats error:", err);
    } finally {
      setDbStatsLoading(false);
    }
  }

  async function handleCleanup() {
    setCleanupLoading(true);
    setCleanupResult(null);
    try {
      const res = await dataApi.deleteOrphanedLogs();
      setCleanupResult(`Smazáno ${res.deleted} orphan záznamů.`);
    } catch (err) {
      setCleanupResult(`Chyba: ${getErrorMessage(err)}`);
    } finally {
      setCleanupLoading(false);
    }
  }

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Spinner className="h-6 w-6" />
      </div>
    );
  }

  return (
    <div className="max-w-2xl space-y-6">

      {/* Stav systému */}
      <Section title="Stav systému">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard label="Backend"      value={healthy ? "Online" : "Offline"} color={healthy ? "green" : "red"} />
          <MetricCard label="Scan"         value={status?.running ? "Probíhá" : "Čeká"} color={status?.running ? "amber" : "default"} />
          <MetricCard label="Celkem scanů" value={status?.scan_count ?? 0} />
          <MetricCard label="Celkem IP"    value={status?.total_ips ?? "—"} />
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={() => triggerScan.mutate()}
          disabled={status?.running || triggerScan.isPending}
        >
          {triggerScan.isPending
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <RefreshCw className="h-3.5 w-3.5" />}
          Spustit scan nyní
        </Button>
      </Section>

      {/* Konfigurace scanu */}
      <Section
        title="Konfigurace scanu"
        description="Nastavení intervalu, timeoutů a limitů pro ICMP ping scanner."
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <NumInput
            label="Interval scanu (sekundy)"
            value={scanInterval}
            onChange={setScanInterval}
            min={10} max={86400}
            hint="Min 10s, max 86400s (24h)"
          />
          <NumInput
            label="Počet pingů na IP"
            value={pingCount}
            onChange={setPingCount}
            min={1} max={10}
          />
          <NumInput
            label="Timeout pingu (ms)"
            value={pingTimeout}
            onChange={setPingTimeout}
            min={100} max={10000}
          />
          <NumInput
            label="Max. souběžných pingů"
            value={maxConcurrent}
            onChange={setMaxConcurrent}
            min={1} max={1000}
            hint="Vyšší = rychlejší, více RAM"
          />
        </div>

        {/* Alerty */}
        <div className="border-t border-border pt-4 space-y-3">
          <p className="text-sm font-medium">Alerty</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <NumInput
              label="RTT práh pro alert (ms)"
              value={alertRtt}
              onChange={setAlertRtt}
              min={0}
            />
            <div className="space-y-1">
              <label className="block text-xs font-medium text-muted-foreground">
                Email pro alerty
              </label>
              <input
                type="email"
                value={alertEmail}
                onChange={(e) => setAlertEmail(e.target.value)}
                placeholder="admin@example.com"
                className="h-9 w-full rounded-md border border-border bg-background
                           px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              />
            </div>
          </div>
        </div>

        {/* Uchovávání dat */}
        <div className="border-t border-border pt-4">
          <NumInput
            label="Uchovávání dat (dny)"
            value={retention}
            onChange={setRetention}
            min={1} max={365}
            hint={`Ping výsledky starší než ${retention} dní se automaticky mažou.`}
          />
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button
            variant="primary"
            size="sm"
            onClick={handleSave}
            disabled={updateConfig.isPending}
          >
            {updateConfig.isPending
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Save className="h-3.5 w-3.5" />}
            Uložit konfiguraci
          </Button>
          {saved && (
            <p className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</p>
          )}
        </div>
      </Section>

      {/* Discovery scheduler */}
      <Section
        title="Discovery scheduler"
        description="Automatické spouštění discovery testů na registrovaných zařízeních."
      >
        <div className="space-y-4">
          {/* Zapnout/vypnout */}
          <div className="flex items-center justify-between rounded-lg border border-border p-3">
            <div>
              <p className="text-sm font-medium">Automatický discovery</p>
              <p className="text-xs text-muted-foreground">
                Pravidelně testuje všechna registrovaná zařízení
              </p>
            </div>
            <button
              onClick={() => setDiscoveryEnabled(v => !v)}
              className={cn(
                "relative inline-flex h-6 w-11 items-center rounded-full transition-colors",
                discoveryEnabled ? "bg-primary" : "bg-muted"
              )}
            >
              <span className={cn(
                "inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                discoveryEnabled ? "translate-x-6" : "translate-x-1"
              )} />
            </button>
          </div>

          {discoveryEnabled && (
            <div className="space-y-3 pl-1">
              <NumInput
                label="Interval discovery (sekundy)"
                value={discoveryInterval}
                onChange={setDiscoveryInterval}
                min={60}
                max={86400}
                hint="Min 60s (1 min), doporučeno 3600s (1h)"
              />
              <div className="flex items-center gap-3">
                <input
                  type="checkbox"
                  id="onlyOnline"
                  checked={discoveryOnlyOnline}
                  onChange={(e) => setDiscoveryOnlyOnline(e.target.checked)}
                  className="h-4 w-4 rounded accent-primary"
                />
                <label htmlFor="onlyOnline" className="text-sm">
                  Testovat pouze online zařízení
                  <span className="ml-1 text-xs text-muted-foreground">
                    (doporučeno — offline zařízení přeskočí)
                  </span>
                </label>
              </div>
            </div>
          )}

          {/* Manuální spuštění */}
          <div className="flex items-center gap-3 pt-1">
            <Button
              variant="outline"
              size="sm"
              onClick={async () => {
                try {
                  await fetch("/api/backend/scan/trigger-discovery", {
                    method: "POST",
                    headers: {
                      "Authorization": `Bearer ${document.cookie.match(/np_token=([^;]+)/)?.[1] || ""}`,
                    },
                  });
                  setSaved(true);
                  setTimeout(() => setSaved(false), 3000);
                } catch (err) {
                  alert("Chyba spuštění discovery");
                }
              }}
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Spustit discovery nyní
            </Button>
            <p className="text-xs text-muted-foreground">
              Otestuje všechna{discoveryOnlyOnline ? " online" : ""} registrovaná zařízení
            </p>
          </div>
        </div>
      </Section>

      {/* Správa dat */}
      <Section
        title="Správa dat"
        description="Mazání orphan záznamů pro IP adresy mimo aktivní rozsahy."
      >
        <div className="flex items-center gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={handleCleanup}
            disabled={cleanupLoading}
          >
            {cleanupLoading
              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
              : <Trash2 className="h-3.5 w-3.5" />}
            Smazat orphan logy
          </Button>
          {cleanupResult && (
            <p className={cn(
              "text-xs",
              cleanupResult.startsWith("Chyba")
                ? "text-destructive"
                : "text-green-600 dark:text-green-400"
            )}>
              {cleanupResult}
            </p>
          )}
        </div>
      </Section>

      {/* Databáze */}
      <Section
        title="Přehled databáze"
        description="Velikost tabulek a celková velikost databáze. Sledujte nárůst při skenování velkých rozsahů."
      >
        <div className="space-y-4">
          {/* Načíst tlačítko */}
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              size="sm"
              onClick={loadDbStats}
              disabled={dbStatsLoading}
            >
              {dbStatsLoading
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Database className="h-3.5 w-3.5" />}
              {dbStats ? "Obnovit" : "Načíst statistiky"}
            </Button>
            {dbStats && (
              <div className="flex items-center gap-2">
                <HardDrive className="h-4 w-4 text-primary" />
                <span className="text-sm font-semibold">
                  Celková velikost DB:
                </span>
                <span className={cn(
                  "text-sm font-bold",
                  dbStats.database.total_bytes > 3_000_000_000_000
                    ? "text-red-600 dark:text-red-400"
                    : dbStats.database.total_bytes > 1_000_000_000_000
                    ? "text-amber-600 dark:text-amber-400"
                    : "text-green-600 dark:text-green-400"
                )}>
                  {dbStats.database.total_size}
                </span>
                <span className="text-xs text-muted-foreground">
                  ({(dbStats.database.total_bytes / 1_048_576).toFixed(1)} MB)
                  · Varování: amber &gt;1TB, červené &gt;3TB
                </span>
{dbStats.database.total_bytes > 3_000_000_000_000 && (
                  <AlertTriangle className="h-4 w-4 text-red-500" />
                )}
              </div>
            )}
          </div>

          {/* Tabulka přehledu */}
          {dbStats && (
            <div className="space-y-3">
              {/* Tabulky */}
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-muted/40 border-b border-border">
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        Tabulka
                      </th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                        Záznamy
                      </th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                        Data
                      </th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                        Indexy
                      </th>
                      <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">
                        Celkem
                      </th>
                      <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">
                        Využití
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {dbStats.tables.map((t: any, i: number) => {
                      const pct = dbStats.database.total_bytes > 0
                        ? (t.total_bytes / dbStats.database.total_bytes) * 100
                        : 0;
                      const isLarge = t.total_bytes > 500_000_000_000;
                      return (
                        <tr key={t.name}
                            className={cn(
                              "border-b border-border last:border-0",
                              i % 2 === 0 ? "bg-background" : "bg-muted/20"
                            )}>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2">
                              <Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                              <span className="font-mono text-xs font-medium">{t.name}</span>
                              {isLarge && (
                                <AlertTriangle className="h-3 w-3 text-amber-500" />
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-xs">
                            {Number(t.row_count).toLocaleString("cs-CZ")}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                            {t.data_size}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-xs text-muted-foreground">
                            {t.index_size}
                          </td>
                          <td className="px-4 py-2.5 text-right tabular-nums text-xs font-medium">
                            {t.total_size}
                          </td>
                          <td className="px-4 py-2.5">
                            <div className="flex items-center gap-2 min-w-[80px]">
                              <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                                <div
                                  className={cn(
                                    "h-full rounded-full",
                                    pct > 60 ? "bg-red-500"
                                    : pct > 30 ? "bg-amber-500"
                                    : "bg-primary"
                                  )}
                                  style={{ width: `${Math.min(100, pct)}%` }}
                                />
                              </div>
                              <span className="text-[10px] text-muted-foreground tabular-nums w-8">
                                {pct.toFixed(1)}%
                              </span>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  <tfoot>
                    <tr className="bg-muted/40 border-t border-border font-medium">
                      <td className="px-4 py-2 text-xs">Celkem</td>
                      <td className="px-4 py-2 text-right tabular-nums text-xs">
                        {dbStats.tables
                          .reduce((s: number, t: any) => s + Number(t.row_count), 0)
                          .toLocaleString("cs-CZ")}
                      </td>
                      <td colSpan={2} />
                      <td className="px-4 py-2 text-right tabular-nums text-xs font-bold">
                        {dbStats.database.total_size}
                      </td>
                      <td />
                    </tr>
                  </tfoot>
                </table>
              </div>

              {/* Ping results rozsah */}
              {dbStats.ping_results && (
                <div className="rounded-lg bg-muted/30 border border-border px-4 py-3 text-xs space-y-1">
                  <p className="font-medium text-muted-foreground mb-1">
                    ping_results — datový rozsah
                  </p>
                  <div className="grid grid-cols-3 gap-4 text-muted-foreground">
                    <div>
                      <p>Nejstarší záznam</p>
                      <p className="font-medium text-foreground">
                        {dbStats.ping_results.oldest
                          ? new Date(dbStats.ping_results.oldest).toLocaleString("cs-CZ")
                          : "—"}
                      </p>
                    </div>
                    <div>
                      <p>Nejnovější záznam</p>
                      <p className="font-medium text-foreground">
                        {dbStats.ping_results.newest
                          ? new Date(dbStats.ping_results.newest).toLocaleString("cs-CZ")
                          : "—"}
                      </p>
                    </div>
                    <div>
                      <p>Celkem řádků</p>
                      <p className="font-medium text-foreground">
                        {Number(dbStats.ping_results.total_rows).toLocaleString("cs-CZ")}
                      </p>
                    </div>
                  </div>
                </div>
              )}

              {/* Varování */}
              {dbStats.database.total_bytes > 1_000_000_000_000 && (
                <div className={cn(
                  "flex items-start gap-2 rounded-lg border px-3 py-2.5 text-xs",
                  dbStats.database.total_bytes > 3_000_000_000_000
                    ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                    : "border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300"
                )}>
                  <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                  <div>
                    {dbStats.database.total_bytes > 3_000_000_000_000
                      ? "⚠ Databáze přesahuje 3 TB. Zvažte snížení doby uchování dat nebo ruční cleanup."
                      : "⚠ Databáze přesahuje 1 TB. Sledujte nárůst při skenování velkých rozsahů."}
                    {" "}Aktuální retence: <strong>{retention} dní</strong>.
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Section>

      {/* O systému */}
      <Section title="O systému">
        <div className="space-y-2 text-sm text-muted-foreground">
          <div className="flex justify-between">
            <span>Frontend</span>
            <span className="font-mono">Next.js 14 / React 18</span>
          </div>
          <div className="flex justify-between">
            <span>Backend</span>
            <span className="font-mono">FastAPI + asyncpg</span>
          </div>
          <div className="flex justify-between">
            <span>Scanner</span>
            <span className="font-mono">icmplib (privileged ICMP)</span>
          </div>
        </div>
      </Section>

    </div>
  );
}
