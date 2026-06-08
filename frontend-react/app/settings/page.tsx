"use client";

import { useEffect, useState } from "react";
import {
  Save, Loader2, Trash2, RefreshCw, Database, HardDrive,
  Table2, AlertTriangle, Radio, Search, Settings2,
  CheckCircle2, XCircle, Clock, Ban, Plus,
} from "lucide-react";
import {
  useConfig, useUpdateConfig, useHealth,
  useScanStatus, useTriggerScan, useDevices,
  useTriggerBackupScan, useUpdateDeviceBackup,
  useScanExclusions, useAddScanExclusion, useRemoveScanExclusion,
  getErrorMessage,
} from "@/hooks/useNetPulse";
import { dataApi } from "@/lib/api";
import { Button, MetricCard, Spinner } from "@/components/ui";
import { cn } from "@/lib/utils";

function NumInput({ label, value, onChange, min, max, hint }: {
  label: string; value: number; onChange: (v: number) => void;
  min?: number; max?: number; hint?: string;
}) {
  return (
    <div className="space-y-1">
      <label className="block text-xs font-medium text-muted-foreground">{label}</label>
      <input type="number" min={min} max={max} value={value}
        onChange={(e) => { const v = parseInt(e.target.value, 10); if (!isNaN(v)) onChange(v); }}
        className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function Toggle({ enabled, onChange, label, description }: {
  enabled: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-border p-3">
      <div>
        <p className="text-sm font-medium">{label}</p>
        {description && <p className="text-xs text-muted-foreground mt-0.5">{description}</p>}
      </div>
      <button onClick={() => onChange(!enabled)}
        className={cn("relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0",
          enabled ? "bg-primary" : "bg-muted")}>
        <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
          enabled ? "translate-x-6" : "translate-x-1")} />
      </button>
    </div>
  );
}

function SaveRow({ onSave, isPending, saved }: { onSave: () => void; isPending: boolean; saved: boolean }) {
  return (
    <div className="flex items-center gap-3 pt-4 border-t border-border">
      <Button variant="primary" size="sm" onClick={onSave} disabled={isPending}>
        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
        Uložit
      </Button>
      {saved && <p className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Konfigurace scanu
// ---------------------------------------------------------------------------
function ScanTab({ config, onSave, isPending }: { config: any; onSave: (d: any) => void; isPending: boolean }) {
  const [scanInterval, setScanInterval]   = useState(300);
  const [pingCount, setPingCount]         = useState(3);
  const [pingTimeout, setPingTimeout]     = useState(1000);
  const [maxConcurrent, setMaxConcurrent] = useState(128);
  const [alertRtt, setAlertRtt]           = useState(0);
  const [alertEmail, setAlertEmail]       = useState("");
  const [retention, setRetention]         = useState(30);
  const [cleanupEnabled, setCleanupEnabled] = useState(true);
  const [cleanupRetention, setCleanupRetention] = useState(30);
  const [cleanupTime, setCleanupTime]     = useState("02:00");
  const [saved, setSaved]                 = useState(false);
  const triggerScan = useTriggerScan();
  const { data: status } = useScanStatus();

  useEffect(() => {
    if (!config) return;
    setScanInterval(Number(config.scan_interval_s) || 300);
    setPingCount(Number(config.ping_count) || 3);
    setPingTimeout(Number(config.ping_timeout_ms) || 1000);
    setMaxConcurrent(Number(config.max_concurrent) || 128);
    setAlertRtt(Number(config.alert_rtt_ms) || 0);
    setAlertEmail(config.alert_email || "");
    setRetention(Number(config.retention_days) || 30);
    setCleanupEnabled(config.cleanup_enabled ?? true);
    setCleanupRetention(Number(config.cleanup_retention_days) || 30);
    setCleanupTime(config.cleanup_time ?? "02:00");
  }, [config]);

  async function handleSave() {
    await onSave({ scan_interval_s: scanInterval, ping_count: pingCount, ping_timeout_ms: pingTimeout,
      max_concurrent: maxConcurrent, alert_rtt_ms: alertRtt, alert_email: alertEmail, retention_days: retention,
      cleanup_enabled: cleanupEnabled, cleanup_retention_days: cleanupRetention, cleanup_time: cleanupTime });
    setSaved(true); setTimeout(() => setSaved(false), 3000);
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-border p-4 space-y-3">
        <p className="text-sm font-medium">Stav ping scanneru</p>
        <div className="grid grid-cols-3 gap-3">
          <MetricCard label="Stav" value={status?.running ? "Probíhá" : "Čeká"} color={status?.running ? "amber" : "default"} />
          <MetricCard label="Celkem scanů" value={status?.scan_count ?? 0} />
          <MetricCard label="Celkem IP" value={status?.total_ips ?? "—"} />
        </div>
        <Button variant="outline" size="sm" onClick={() => triggerScan.mutate()} disabled={status?.running || triggerScan.isPending}>
          {triggerScan.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
          Spustit scan nyní
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <NumInput label="Interval scanu (s)" value={scanInterval} onChange={setScanInterval} min={10} max={86400} hint="Min 10s, max 86400s" />
        <NumInput label="Počet pingů na IP" value={pingCount} onChange={setPingCount} min={1} max={10} />
        <NumInput label="Timeout pingu (ms)" value={pingTimeout} onChange={setPingTimeout} min={100} max={10000} />
        <NumInput label="Max. souběžných pingů" value={maxConcurrent} onChange={setMaxConcurrent} min={1} max={1000} hint="Vyšší = rychlejší, více RAM" />
        <NumInput label="RTT práh pro alert (ms)" value={alertRtt} onChange={setAlertRtt} min={0} />
        <div className="space-y-1">
          <label className="block text-xs font-medium text-muted-foreground">Email pro alerty</label>
          <input type="email" value={alertEmail} onChange={(e) => setAlertEmail(e.target.value)} placeholder="admin@example.com"
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
        </div>
      </div>
      <NumInput label="Retence dat (dny)" value={retention} onChange={setRetention} min={1} max={365}
        hint={`Ping výsledky starší než ${retention} dní se automaticky mažou.`} />

      <h3 className="text-sm font-semibold mt-4 mb-1 text-foreground">Automatický cleanup</h3>
      <div className="flex items-center justify-between py-2">
        <div>
          <p className="text-sm font-medium">Automatické mazání ping výsledků</p>
          <p className="text-xs text-muted-foreground">Spouští se jednou denně, maže záznamy starší než zadaný počet dní</p>
        </div>
        <input type="checkbox" checked={cleanupEnabled} onChange={(e) => setCleanupEnabled(e.target.checked)}
          className="h-4 w-4 cursor-pointer" />
      </div>
      <NumInput label="Počet dní pro zachování dat" value={cleanupRetention} onChange={setCleanupRetention} min={1} max={365}
        hint="Ping výsledky starší než zadaný počet dní budou smazány (+ VACUUM)" />
      <div className="flex items-center gap-3">
        <label className="text-sm font-medium w-48 shrink-0">Čas spuštění</label>
        <input type="time" value={cleanupTime}
          onChange={(e) => setCleanupTime(e.target.value)}
          className="h-9 rounded-md border border-input bg-background px-3 text-sm
                     focus:outline-none focus:ring-2 focus:ring-primary/50" />
        <span className="text-xs text-muted-foreground">Doporučeno: 02:00 (mimo provoz)</span>
      </div>
      <SaveRow onSave={handleSave} isPending={isPending} saved={saved} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Discovery scheduler
// ---------------------------------------------------------------------------
function DiscoveryTab({ config, onSave, isPending }: { config: any; onSave: (d: any) => void; isPending: boolean }) {
  const [enabled, setEnabled]         = useState(false);
  const [interval, setInterval]       = useState(3600);
  const [onlyOnline, setOnlyOnline]   = useState(true);
  const [skipPolled, setSkipPolled]   = useState(true);
  const [saved, setSaved]             = useState(false);
  const [triggering, setTriggering]   = useState(false);

  useEffect(() => {
    if (!config) return;
    setEnabled(String((config as any).discovery_enabled) === "true");
    setInterval(Number((config as any).discovery_interval_s) || 3600);
    setOnlyOnline(String((config as any).discovery_only_online) !== "false");
    setSkipPolled(String((config as any).discovery_skip_polled) !== "false");
  }, [config]);

  async function handleSave() {
    await onSave({ discovery_enabled: String(enabled), discovery_interval_s: interval,
      discovery_only_online: String(onlyOnline), discovery_skip_polled: String(skipPolled) });
    setSaved(true); setTimeout(() => setSaved(false), 3000);
  }

  async function handleTrigger() {
    setTriggering(true);
    try {
      const token = document.cookie.match(/np_token=([^;]+)/)?.[1] ?? "";
      await fetch("/api/backend/scan/trigger-discovery", { method: "POST", headers: { Authorization: `Bearer ${token}` } });
    } finally { setTriggering(false); }
  }

  return (
    <div className="space-y-4">
      <Toggle enabled={enabled} onChange={setEnabled} label="Automatický discovery scheduler"
        description="Pravidelně testuje registrovaná zařízení (porty, rDNS, identifikace)" />
      {enabled && (
        <div className="space-y-3 pl-1">
          <NumInput label="Interval discovery (s)" value={interval} onChange={setInterval} min={60} max={86400} hint="Min 60s, doporučeno 3600s (1h)" />
          <Toggle enabled={onlyOnline} onChange={setOnlyOnline} label="Pouze online zařízení" description="Offline zařízení přeskočí" />
          <Toggle enabled={skipPolled} onChange={setSkipPolled} label="Přeskočit zařízení s pollem" description="Zařízení s last_polled_at přeskočí" />
        </div>
      )}
      <div className="flex items-center gap-3 pt-2 border-t border-border">
        <Button variant="outline" size="sm" onClick={handleTrigger} disabled={triggering}>
          {triggering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
          Spustit discovery nyní
        </Button>
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={handleSave} disabled={isPending}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Uložit
        </Button>
        {saved && <p className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</p>}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Tab: Poll scheduler
// ---------------------------------------------------------------------------
function PollSchedulerTab({ config, onSave, isPending }: { config: any; onSave: (d: any) => void; isPending: boolean }) {
  const [enabled,  setEnabled]  = useState(false);
  const [interval, setInterval] = useState(300);
  const [saved,    setSaved]    = useState(false);
  const [triggering, setTriggering] = useState(false);

  useEffect(() => {
    if (!config) return;
    setEnabled(String((config as any).poll_scheduler_enabled) === "true");
    setInterval(Number((config as any).poll_scheduler_interval_s) || 300);
  }, [config]);

  async function handleSave() {
    await onSave({
      poll_scheduler_enabled:    String(enabled),
      poll_scheduler_interval_s: interval,
    });
    setSaved(true); setTimeout(() => setSaved(false), 3000);
  }

  async function handleTrigger() {
    setTriggering(true);
    try {
      const token = document.cookie.match(/np_token=([^;]+)/)?.[1] ?? "";
      await fetch("/api/backend/poll/trigger", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
      });
    } finally { setTriggering(false); }
  }

  return (
    <div className="space-y-4">
      <Toggle enabled={enabled} onChange={setEnabled}
        label="Automatický poll scheduler"
        description="Pravidelně sbírá data ze zařízení s povoleným Cron poll (přepínač v záložce Základní údaje)" />
      {enabled && (
        <div className="space-y-3 pl-1">
          <NumInput label="Interval pollu (s)" value={interval} onChange={setInterval}
            min={60} max={86400}
            hint="Min 60s, doporučeno 300s (5 min). Zařízení s cron_poll=true budou pollována tímto intervalem." />
          <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs text-muted-foreground space-y-1">
            <p>💡 <strong>Jak nastavit zařízení pro cron poll:</strong></p>
            <p>Zařízení → záložka Základní údaje → přepínač <em>Cron poll povolen</em></p>
            <p>Poll použije nejlepší dostupný přihlašovací profil dle priority výrobce.</p>
          </div>
        </div>
      )}
      <div className="flex items-center gap-3 pt-2 border-t border-border">
        <Button variant="outline" size="sm" onClick={handleTrigger} disabled={triggering}>
          {triggering ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Radio className="h-3.5 w-3.5" />}
          Spustit poll nyní
        </Button>
        <div className="flex-1" />
        <Button variant="primary" size="sm" onClick={handleSave} disabled={isPending}>
          {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
          Uložit
        </Button>
        {saved && <p className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</p>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Backup scheduler
// ---------------------------------------------------------------------------
function BackupTab({ config, onSave, isPending }: { config: any; onSave: (d: any) => void; isPending: boolean }) {
  const [enabled, setEnabled]               = useState(false);
  const [interval, setIntervalS]            = useState(86400);
  const [onlyOnline, setOnlyOnline]         = useState(true);
  const [onlySuccessful, setOnlySuccessful] = useState(true);
  const [saved, setSaved]                   = useState(false);

  const { data: devices = [] }   = useDevices();
  const triggerBackup            = useTriggerBackupScan();
  const updateDeviceBackup       = useUpdateDeviceBackup();

  useEffect(() => {
    if (!config) return;
    setEnabled(String((config as any).backup_enabled) === "true");
    setIntervalS(Number((config as any).backup_interval_s) || 86400);
    setOnlyOnline(String((config as any).backup_only_online) !== "false");
    setOnlySuccessful(String((config as any).backup_only_successful) !== "false");
  }, [config]);

  async function handleSave() {
    await onSave({ backup_enabled: String(enabled), backup_interval_s: interval,
      backup_only_online: String(onlyOnline), backup_only_successful: String(onlySuccessful) });
    setSaved(true); setTimeout(() => setSaved(false), 3000);
  }

  const backupDevices = (devices as any[]).filter((d: any) =>
    d.credentials?.some((c: any) => c.auth_type === "ssh")
  );

  function intervalLabel(s: number) {
    if (s >= 86400) return `${Math.round(s / 86400)}d`;
    if (s >= 3600)  return `${Math.round(s / 3600)}h`;
    return `${Math.round(s / 60)}m`;
  }

  return (
    <div className="space-y-5">
      {/* Globální nastavení */}
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Globální nastavení</p>
        <Toggle enabled={enabled} onChange={setEnabled} label="Automatický backup scheduler"
          description="Pravidelně zálohuje zařízení jako .rsc export přes SSH" />
        {enabled && (
          <div className="space-y-3 pl-1">
            <NumInput label="Interval zálohy (s)" value={interval} onChange={setIntervalS}
              min={3600} max={604800} hint={`Aktuálně: ${intervalLabel(interval)} — min 1h, doporučeno 24h`} />
            <Toggle enabled={onlyOnline} onChange={setOnlyOnline} label="Pouze online zařízení" description="Offline zařízení přeskočí" />
            <Toggle enabled={onlySuccessful} onChange={setOnlySuccessful} label="Pouze zařízení s úspěšným pollem"
              description="Přeskočí zařízení bez last_polled_at — neznámé credentials" />
          </div>
        )}
      </div>

      {/* Ruční spuštění */}
      <div className="flex items-center gap-3 py-3 border-y border-border">
        <Button variant="outline" size="sm" onClick={() => triggerBackup.mutate()} disabled={triggerBackup.isPending}>
          {triggerBackup.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <HardDrive className="h-3.5 w-3.5" />}
          Spustit backup nyní
        </Button>
        <p className="text-xs text-muted-foreground">Zálohuje všechna způsobilá zařízení</p>
      </div>

      {/* Individuální nastavení */}
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Individuální nastavení — {backupDevices.length} zařízení se SSH profilem
        </p>
        {backupDevices.length === 0 && (
          <p className="text-xs text-muted-foreground">Žádné zařízení nemá SSH přihlašovací profil.</p>
        )}
        <div className="space-y-2">
          {backupDevices.map((d: any) => (
            <div key={d.id} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5">
              <div className="flex gap-1">
                {d.is_alive
                  ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" aria-label="Online" />
                  : <XCircle className="h-3.5 w-3.5 text-muted-foreground" aria-label="Offline" />}
                {d.last_polled_at
                  ? <Clock className="h-3.5 w-3.5 text-blue-500" aria-label="Poll proběhl" />
                  : <Clock className="h-3.5 w-3.5 text-muted-foreground" aria-label="Poll ještě neproběhl" />}
              </div>
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium truncate">{d.alias || d.hostname || d.ip?.split("/")[0]}</p>
                <p className="text-xs text-muted-foreground font-mono">
                  {d.ip?.split("/")[0]}
                  {d.last_polled_at && <span className="ml-2">· poll {new Date(d.last_polled_at).toLocaleDateString("cs-CZ")}</span>}
                </p>
              </div>
              <button
                onClick={() => updateDeviceBackup.mutate({ deviceId: d.id, backup_enabled: !(d.backup_enabled !== false) })}
                disabled={updateDeviceBackup.isPending}
                className={cn("relative inline-flex h-6 w-11 items-center rounded-full transition-colors shrink-0",
                  d.backup_enabled !== false ? "bg-primary" : "bg-muted")}>
                <span className={cn("inline-block h-4 w-4 transform rounded-full bg-white transition-transform",
                  d.backup_enabled !== false ? "translate-x-6" : "translate-x-1")} />
              </button>
            </div>
          ))}
        </div>
      </div>

      <SaveRow onSave={handleSave} isPending={isPending} saved={saved} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Správa dat
// ---------------------------------------------------------------------------
function DataTab() {
  const [cleanupResult, setCleanupResult]   = useState<string | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [dbStats, setDbStats]               = useState<any | null>(null);
  const [dbStatsLoading, setDbStatsLoading] = useState(false);

  async function loadDbStats() {
    setDbStatsLoading(true);
    try {
      const token = document.cookie.match(/np_token=([^;]+)/)?.[1] ?? "";
      const r = await fetch("/api/backend/system/db-stats", { headers: { Authorization: `Bearer ${token}` } });
      setDbStats(await r.json());
    } catch { } finally { setDbStatsLoading(false); }
  }

  async function handleCleanup() {
    setCleanupLoading(true); setCleanupResult(null);
    try {
      const res = await dataApi.deleteOrphanedLogs();
      setCleanupResult(`Smazáno ${res.deleted} orphan záznamů.`);
    } catch (err) { setCleanupResult(`Chyba: ${getErrorMessage(err)}`); }
    finally { setCleanupLoading(false); }
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Čištění dat</p>
        <div className="flex items-center gap-3">
          <Button variant="outline" size="sm" onClick={handleCleanup} disabled={cleanupLoading}>
            {cleanupLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
            Smazat orphan logy
          </Button>
          {cleanupResult && <p className={cn("text-xs", cleanupResult.startsWith("Chyba") ? "text-destructive" : "text-green-600 dark:text-green-400")}>{cleanupResult}</p>}
        </div>
        <p className="text-xs text-muted-foreground">Smaže záznamy pro IP adresy mimo aktivní rozsahy.</p>
      </div>

      <div className="space-y-3">
        <div className="flex items-center gap-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground flex-1">Přehled databáze</p>
          <Button variant="outline" size="sm" onClick={loadDbStats} disabled={dbStatsLoading}>
            {dbStatsLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Database className="h-3.5 w-3.5" />}
            {dbStats ? "Obnovit" : "Načíst statistiky"}
          </Button>
        </div>
        {dbStats && (
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <HardDrive className="h-4 w-4 text-primary" />
              <span className="text-sm font-semibold">Celková velikost DB:</span>
              <span className={cn("text-sm font-bold",
                dbStats.database.total_bytes > 3_000_000_000_000 ? "text-red-600 dark:text-red-400"
                : dbStats.database.total_bytes > 1_000_000_000_000 ? "text-amber-600 dark:text-amber-400"
                : "text-green-600 dark:text-green-400")}>
                {dbStats.database.total_size}
              </span>
              <span className="text-xs text-muted-foreground">({(dbStats.database.total_bytes / 1_048_576).toFixed(1)} MB)</span>
            </div>
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-muted/40 border-b border-border">
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Tabulka</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Záznamy</th>
                    <th className="px-4 py-2.5 text-right text-xs font-medium text-muted-foreground">Celkem</th>
                    <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Využití</th>
                  </tr>
                </thead>
                <tbody>
                  {dbStats.tables.map((t: any, i: number) => {
                    const pct = dbStats.database.total_bytes > 0 ? (t.total_bytes / dbStats.database.total_bytes) * 100 : 0;
                    return (
                      <tr key={t.name} className={cn("border-b border-border last:border-0", i % 2 === 0 ? "" : "bg-muted/20")}>
                        <td className="px-4 py-2.5"><div className="flex items-center gap-2"><Table2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /><span className="font-mono text-xs">{t.name}</span></div></td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-xs">{Number(t.row_count).toLocaleString("cs-CZ")}</td>
                        <td className="px-4 py-2.5 text-right tabular-nums text-xs font-medium">{t.total_size}</td>
                        <td className="px-4 py-2.5">
                          <div className="flex items-center gap-2 min-w-[80px]">
                            <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
                              <div className={cn("h-full rounded-full", pct > 60 ? "bg-red-500" : pct > 30 ? "bg-amber-500" : "bg-primary")} style={{ width: `${Math.min(100, pct)}%` }} />
                            </div>
                            <span className="text-[10px] text-muted-foreground tabular-nums w-8">{pct.toFixed(1)}%</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: O systému
// ---------------------------------------------------------------------------
function SystemTab() {
  const { data: healthy } = useHealth();
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <MetricCard label="Backend" value={healthy ? "Online" : "Offline"} color={healthy ? "green" : "red"} />
      </div>
      <div className="rounded-lg border border-border p-4 space-y-2 text-sm text-muted-foreground">
        {[["Frontend","Next.js 14 / React 18"],["Backend","FastAPI + asyncpg"],["Scanner","icmplib (privileged ICMP)"],["Backup","asyncssh / RouterOS export"],["Databáze","PostgreSQL"]].map(([l, v]) => (
          <div key={l} className="flex justify-between"><span>{l}</span><span className="font-mono text-foreground">{v}</span></div>
        ))}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Tab: Vyloučené IP ze scanování
// ---------------------------------------------------------------------------
function ExclusionsTab() {
  const { data: exclusions = [], isLoading } = useScanExclusions();
  const addExclusion    = useAddScanExclusion();
  const removeExclusion = useRemoveScanExclusion();
  const [newIp,     setNewIp]     = useState("");
  const [newReason, setNewReason] = useState("");
  const [error,     setError]     = useState("");

  async function handleAdd() {
    setError("");
    if (!newIp.trim()) { setError("IP adresa je povinná"); return; }
    try {
      await addExclusion.mutateAsync({ ip: newIp.trim(), reason: newReason.trim() });
      setNewIp(""); setNewReason("");
    } catch (e) { setError(getErrorMessage(e)); }
  }

  return (
    <div className="space-y-5">
      <div className="space-y-1">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Přidat vyloučení
        </p>
        <p className="text-xs text-muted-foreground">
          IP adresy v tomto seznamu jsou přeskočeny při ICMP scanu — i pokud jsou v aktivním rozsahu.
        </p>
      </div>

      {/* Formulář přidání */}
      <div className="flex gap-2 items-start">
        <div className="space-y-1 flex-1">
          <input
            type="text" placeholder="IP adresa (např. 10.30.30.55)"
            value={newIp} onChange={(e) => setNewIp(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 font-mono"
          />
        </div>
        <div className="space-y-1 flex-1">
          <input
            type="text" placeholder="Důvod vyloučení (volitelné)"
            value={newReason} onChange={(e) => setNewReason(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
        </div>
        <Button variant="primary" size="sm" onClick={handleAdd} disabled={addExclusion.isPending}>
          {addExclusion.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
          Přidat
        </Button>
      </div>
      {error && <p className="text-xs text-destructive">{error}</p>}

      {/* Seznam vyloučení */}
      {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Načítám...</div>}

      {!isLoading && exclusions.length === 0 && (
        <div className="rounded-lg border border-dashed border-border py-8 text-center">
          <Ban className="h-8 w-8 mx-auto text-muted-foreground/20 mb-2" />
          <p className="text-sm text-muted-foreground">Žádné vyloučené IP adresy</p>
        </div>
      )}

      {exclusions.length > 0 && (
        <div className="rounded-lg border border-border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/40">
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">IP adresa</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Důvod</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Přidal</th>
                <th className="px-4 py-2.5 text-left text-xs font-medium text-muted-foreground">Datum</th>
                <th className="px-4 py-2.5 w-10" />
              </tr>
            </thead>
            <tbody>
              {exclusions.map((ex: any, i: number) => (
                <tr key={ex.id} className={cn("border-b border-border last:border-0", i % 2 === 0 ? "" : "bg-muted/10")}>
                  <td className="px-4 py-2.5 font-mono text-sm font-medium">{ex.ip}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{ex.reason || "—"}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">{ex.created_by || "—"}</td>
                  <td className="px-4 py-2.5 text-xs text-muted-foreground">
                    {new Date(ex.created_at).toLocaleDateString("cs-CZ")}
                  </td>
                  <td className="px-2 py-2">
                    <Button variant="ghost" size="icon"
                      onClick={() => removeExclusion.mutate(ex.id)}
                      disabled={removeExclusion.isPending}
                      className="h-7 w-7 text-destructive hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
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

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
type TabId = "scan" | "discovery" | "poll_sched" | "backup" | "exclusions" | "data" | "system";
const TABS: { id: TabId; label: string; icon: React.ElementType }[] = [
  { id: "scan",       label: "Konfigurace scanu",   icon: Radio },
  { id: "discovery",  label: "Discovery scheduler", icon: Search },
  { id: "poll_sched", label: "Poll scheduler",      icon: Radio },
  { id: "backup",     label: "Backup scheduler",    icon: HardDrive },
  { id: "exclusions", label: "Vyloučené IP",        icon: Ban },
  { id: "data",       label: "Správa dat",          icon: Database },
  { id: "system",     label: "O systému",           icon: Settings2 },
];

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState<TabId>("scan");
  const { data: config, isLoading } = useConfig();
  const updateConfig = useUpdateConfig();

  async function handleSave(partial: Record<string, any>) {
    await updateConfig.mutateAsync(partial as any);
  }

  if (isLoading) return <div className="flex h-64 items-center justify-center"><Spinner className="h-6 w-6" /></div>;

  return (
    <div className="w-full">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold">Nastavení</h1>
        <p className="text-sm text-muted-foreground mt-1">Konfigurace scanneru, schedulerů a systému</p>
      </div>
      <div className="border-b border-border mb-6">
        <div className="flex gap-0 overflow-x-auto">
          {TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setActiveTab(id)}
              className={cn("flex items-center gap-1.5 px-4 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap",
                activeTab === id ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground hover:border-border")}>
              <Icon className="h-3.5 w-3.5" />{label}
            </button>
          ))}
        </div>
      </div>
      {activeTab === "scan"      && <ScanTab config={config} onSave={handleSave} isPending={updateConfig.isPending} />}
      {activeTab === "discovery" && <DiscoveryTab config={config} onSave={handleSave} isPending={updateConfig.isPending} />}
      {activeTab === "poll_sched" && <PollSchedulerTab config={config} onSave={handleSave} isPending={updateConfig.isPending} />}
      {activeTab === "backup"    && <BackupTab config={config} onSave={handleSave} isPending={updateConfig.isPending} />}
      {activeTab === "exclusions" && <ExclusionsTab />}
      {activeTab === "data"       && <DataTab />}
      {activeTab === "system"     && <SystemTab />}
    </div>
  );
}
