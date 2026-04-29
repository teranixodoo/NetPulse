"use client";

import { useState, useMemo } from "react";
import {
  Plus, Pencil, Trash2, Save, X,
  ChevronDown, Loader2, Network,
} from "lucide-react";
import {
  useRanges, useHosts, useCreateRange,
  useUpdateRange, useDeleteRange, getErrorMessage,
} from "@/hooks/useNetPulse";
import type { IpRange, HostStats } from "@/lib/types";
import { Button, MetricCard, FormField, Input, EmptyState, Spinner } from "@/components/ui";
import { cn, normalizeNetwork } from "@/lib/utils";

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

function IpMap({ hosts }: { hosts: HostStats[] }) {
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
          const bg = !h.currently_alive
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
// Formulář přidání / editace rozsahu
// ---------------------------------------------------------------------------
interface FormData {
  label:   string;
  network: string;
  active:  boolean;
}

function RangeForm({
  defaultValues,
  onSubmit,
  onCancel,
  isPending,
}: {
  defaultValues?: Partial<FormData>;
  onSubmit: (data: FormData) => Promise<void>;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [label,   setLabel]   = useState(defaultValues?.label   ?? "");
  const [network, setNetwork] = useState(defaultValues?.network ?? "");
  const [active,  setActive]  = useState(defaultValues?.active  ?? true);
  const [error,   setError]   = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!label.trim())   { setError("Název rozsahu je povinný"); return; }
    if (!network.trim()) { setError("Síť (CIDR) je povinná"); return; }
    await onSubmit({ label: label.trim(), network: network.trim(), active });
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
}: {
  range: IpRange;
  hosts: HostStats[];
}) {
  const [expanded,    setExpanded]    = useState(false);
  const [editing,     setEditing]     = useState(false);
  const [confirming,  setConfirming]  = useState(false);
  const updateRange = useUpdateRange();
  const deleteRange = useDeleteRange();

  const hostsInRange = useMemo(() => {
    try {
      const [netAddr, prefix] = range.network.split("/");
      return hosts.filter((h) =>
        ipInNetwork(h.ip.split("/")[0], netAddr, parseInt(prefix ?? "32"))
      );
    } catch { return []; }
  }, [hosts, range.network]);

  const aliveN = hostsInRange.filter((h) => h.currently_alive).length;
  const deadN  = hostsInRange.length - aliveN;
  const rtts   = hostsInRange.filter((h) => h.avg_rtt_ms != null).map((h) => h.avg_rtt_ms!);
  const avgRtt = rtts.length ? (rtts.reduce((a, b) => a + b, 0) / rtts.length).toFixed(1) : null;

  const icon = hostsInRange.length === 0 ? "⚫"
    : deadN  === 0 ? "🟢"
    : aliveN === 0 ? "🔴" : "🟡";

  async function handleUpdate(data: FormData) {
    try {
      await updateRange.mutateAsync({
        id: range.id!,
        label:   data.label,
        network: normalizeNetwork(data.network),
        active:  data.active,
      });
      setEditing(false);
    } catch (err) { alert(getErrorMessage(err)); }
  }

  async function handleDelete() {
    try {
      await deleteRange.mutateAsync(range.id!);
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
          <div className="flex items-center gap-2">
            <p className="font-medium">{range.label}</p>
            {!range.active && (
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                neaktivní
              </span>
            )}
          </div>
          <p className="font-mono text-xs text-muted-foreground">{range.network}</p>
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
              onClick={() => { setEditing((v) => !v); setExpanded(true); }}
            >
              <Pencil className="h-3.5 w-3.5" />
            </Button>
            <Button
              size="icon"
              variant="ghost"
              onClick={() => { setConfirming(true); setExpanded(true); }}
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

          {/* Editační formulář */}
          {editing && (
            <div className="rounded-md border border-primary/30 bg-primary/5 p-4">
              <p className="mb-3 text-sm font-medium">Upravit rozsah</p>
              <RangeForm
                defaultValues={{ label: range.label, network: range.network, active: range.active }}
                onSubmit={handleUpdate}
                onCancel={() => setEditing(false)}
                isPending={updateRange.isPending}
              />
            </div>
          )}

          {/* Potvrzení smazání */}
          {confirming && (
            <div className="flex items-center gap-3 rounded-md border border-destructive/30
                            bg-destructive/5 px-4 py-3">
              <p className="flex-1 text-sm text-destructive">
                Smazat rozsah <strong>{range.label}</strong>? Tato akce je nevratná.
              </p>
              <Button size="sm" variant="destructive" onClick={handleDelete}
                      disabled={deleteRange.isPending}>
                {deleteRange.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Trash2 className="h-3.5 w-3.5" />}
                Smazat
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Zrušit</Button>
            </div>
          )}

          {/* IP Mapa */}
          <IpMap hosts={hostsInRange} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function RangesPage() {
  const { data: ranges = [], isLoading } = useRanges();
  const { data: hosts  = [] }            = useHosts();
  const createRange = useCreateRange();
  const [showAdd, setShowAdd] = useState(false);

  async function handleCreate(data: FormData) {
    try {
      await createRange.mutateAsync({
        label:   data.label,
        network: normalizeNetwork(data.network),
        active:  data.active,
      });
      setShowAdd(false);
    } catch (err) { alert(getErrorMessage(err)); }
  }

  const activeRanges   = ranges.filter((r) => r.active);
  const inactiveRanges = ranges.filter((r) => !r.active);

  return (
    <div className="space-y-4">
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
                <RangeRow key={r.id} range={r} hosts={hosts} />
              ))}
            </div>
          )}
          {inactiveRanges.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Neaktivní ({inactiveRanges.length})
              </p>
              {inactiveRanges.map((r) => (
                <RangeRow key={r.id} range={r} hosts={hosts} />
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
