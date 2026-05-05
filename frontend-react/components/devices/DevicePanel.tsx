"use client";

import React, { useState } from "react";
import {
  Loader2, Save, Trash2, Search, RefreshCw,
  Link, Unlink, ChevronDown, Download, HardDrive, AlertCircle, CheckCircle2,
} from "lucide-react";
import {
  useUpdateDevice, useDeleteDevice,
  useLinkCredential, useUnlinkCredential,
  useRunDiscovery, useDiscoveryLogs,
  useCredentials, useDeviceBackups, useRunBackup, useDeleteBackup, getErrorMessage,
} from "@/hooks/useNetPulse";
import type { Device, HostStats, DiscoveryLayer, DeviceBackup } from "@/lib/types";
import { Button, FormField, Input, Spinner } from "@/components/ui";
import { formatDateTime, cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Schéma formuláře
// ---------------------------------------------------------------------------

const DEVICE_TYPES = ["Router","Switch","AP","Server","IP Kamera","Počítač","Jiné"];

// ---------------------------------------------------------------------------
// Tab navigace
// ---------------------------------------------------------------------------
type TabId = "info" | "ip" | "credentials" | "discovery" | "poll" | "backup";

function TabBar({ active, onChange }: { active: TabId; onChange: (t: TabId) => void }) {
  const tabs: { id: TabId; label: string }[] = [
    { id: "info",        label: "📝 Základní údaje" },
    { id: "ip",          label: "🌐 IP adresa" },
    { id: "credentials", label: "🔐 Profily" },
    { id: "discovery",   label: "🔍 Discovery" },
    { id: "poll",        label: "📡 Sběr dat" },
    { id: "backup",      label: "💾 Zálohy" },
  ];
  return (
    <div className="flex border-b border-border bg-background">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={(e) => { e.stopPropagation(); onChange(t.id); }}
          className={cn(
            "px-4 py-2.5 text-sm transition-colors whitespace-nowrap",
            active === t.id
              ? "border-b-2 border-primary font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Základní údaje
// ---------------------------------------------------------------------------
function BasicInfoTab({
  device,
  hostInfo,
  onClose,
}: {
  device: Device;
  hostInfo?: HostStats;
  onClose: () => void;
}) {
  const updateDevice = useUpdateDevice();
  const deleteDevice = useDeleteDevice();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const [hostname,     setHostname]     = useState(device.hostname);
  const [alias,        setAlias]        = useState(device.alias ?? "");
  const [deviceType,   setDeviceType]   = useState(device.device_type);
  const [vendor,       setVendor]       = useState(device.vendor ?? "");
  const [serialNumber, setSerialNumber] = useState(device.serial_number ?? "");
  const [mac,          setMac]          = useState(device.mac ?? "");
  const [description,  setDescription]  = useState(device.description ?? "");
  const [formError,    setFormError]    = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    if (!hostname.trim()) { setFormError("Hostname je povinný"); return; }
    try {
      await updateDevice.mutateAsync({
        id: device.id,
        ip: device.ip,
        hostname:      hostname.trim(),
        alias:         alias.trim()        || undefined,
        device_type:   deviceType,
        vendor:        vendor.trim()       || undefined,
        serial_number: serialNumber.trim() || undefined,
        mac:           mac.trim()          || undefined,
        description:   description.trim()  || undefined,
      });
    } catch (err) {
      alert(getErrorMessage(err));
    }
  }

  async function handleDelete() {
    try {
      await deleteDevice.mutateAsync(device.id);
      onClose();
    } catch (err) {
      alert(getErrorMessage(err));
    }
  }

  return (
    <form onSubmit={onSubmit} onClick={(e) => e.stopPropagation()} className="space-y-4 p-4">
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <FormField label="Hostname">
          <Input value={hostname} onChange={(e) => setHostname(e.target.value)} />
        </FormField>
        <FormField label="Alias">
          <Input value={alias} onChange={(e) => setAlias(e.target.value)} placeholder="Hlavní switch" />
        </FormField>
        <FormField label="Typ zařízení">
          <select
            value={deviceType}
            onChange={(e) => setDeviceType(e.target.value)}
            className="h-9 w-full rounded-md border border-border bg-background
                       px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
          >
            {DEVICE_TYPES.map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Výrobce / platforma">
          <Input value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="MikroTik" />
        </FormField>
        <FormField label="Sériové číslo">
          <Input value={serialNumber} onChange={(e) => setSerialNumber(e.target.value)} placeholder="ABC123" />
        </FormField>
        <FormField label="MAC adresa">
          <Input value={mac} onChange={(e) => setMac(e.target.value)} placeholder="AA:BB:CC:DD:EE:FF" />
        </FormField>
        <FormField label="Poznámka" className="col-span-2 sm:col-span-3">
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={2}
            className="w-full rounded-md border border-border bg-background px-3 py-2
                       text-sm placeholder:text-muted-foreground
                       focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
            placeholder="Volitelná poznámka…"
          />
        </FormField>
      </div>

      {/* Readonly info */}
      <div className="grid grid-cols-3 gap-3 rounded-md bg-muted/30 p-3 text-xs">
        <div>
          <span className="text-muted-foreground">IP adresa</span>
          <p className="mt-0.5 font-mono font-medium">{device.ip}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Vytvořeno</span>
          <p className="mt-0.5">{formatDateTime(device.created_at)}</p>
        </div>
        <div>
          <span className="text-muted-foreground">Poslední scan</span>
          <p className="mt-0.5">{formatDateTime(hostInfo?.last_check)}</p>
        </div>
      </div>

      {/* Poll data — zobrazíme pokud existují */}
      {(device.firmware || device.model || device.last_uptime_s || device.last_polled_at) && (
        <div className="rounded-md border border-border bg-muted/10 p-3">
          <p className="text-xs font-medium text-muted-foreground mb-2 uppercase tracking-wide">
            Data ze sběru
            {device.last_poll_method && (
              <span className={cn(
                "ml-2 rounded-full px-2 py-0.5 font-medium text-[10px]",
                {
                  api:  "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
                  snmp: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
                  ssh:  "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
                  http: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
                }[device.last_poll_method] ?? "bg-muted text-muted-foreground"
              )}>
                {device.last_poll_method.toUpperCase()}
              </span>
            )}
          </p>
          <div className="grid grid-cols-3 gap-2 text-xs">
            {[
              ["Firmware",       device.firmware],
              ["Model",          device.model],
              ["Uptime",         device.last_uptime_s ? (() => {
                const s = device.last_uptime_s!;
                const w = Math.floor(s/604800), d = Math.floor((s%604800)/86400);
                const h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
                return w ? `${w}t ${d}d ${h}h` : d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
              })() : null],
              ["Poslední poll",  device.last_polled_at ? formatDateTime(device.last_polled_at) : null],
            ].filter(([,v]) => v).map(([k, v]) => (
              <div key={String(k)}>
                <span className="text-muted-foreground">{k}</span>
                <p className="mt-0.5 font-medium">{v}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Akce */}
      <div className="flex items-center gap-2">
        {confirmDelete ? (
          <>
            <p className="flex-1 text-sm text-destructive">
              Opravdu smazat <strong>{device.hostname}</strong>?
            </p>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleDelete}
              disabled={deleteDevice.isPending}
            >
              {deleteDevice.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
              Smazat
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(false)}>
              Zrušit
            </Button>
          </>
        ) : (
          <>
            <Button
              type="submit"
              variant="primary"
              size="sm"
              disabled={updateDevice.isPending}
            >
              {updateDevice.isPending
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Save className="h-3.5 w-3.5" />}
              Uložit změny
            </Button>
            <div className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirmDelete(true)}
              className="text-destructive hover:text-destructive hover:bg-destructive/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              Smazat
            </Button>
          </>
        )}
      </div>

      {updateDevice.isSuccess && (
        <p className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</p>
      )}
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tab: IP adresa
// ---------------------------------------------------------------------------
function IpTab({
  device,
  hosts,
}: {
  device: Device;
  hosts: HostStats[];
}) {
  const updateDevice = useUpdateDevice();
  const currentIp = device.ip.split("/")[0];

  // Přiřazené IP ostatních zařízení (ne tohoto)
  const [selectedIp, setSelectedIp] = useState(currentIp);
  const [error, setError] = useState<string | null>(null);

  // Seřadíme hosts dle IP
  const sortedHosts = [...hosts].sort((a, b) => {
    const toNum = (s: string) => s.split(".").reduce((n, o) => (n << 8) + +o, 0);
    return toNum(a.ip.split("/")[0]) - toNum(b.ip.split("/")[0]);
  });

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!selectedIp) { setError("Vyberte IP adresu"); return; }
    try {
      await updateDevice.mutateAsync({
        id:            device.id,
        ip:            selectedIp,
        hostname:      device.hostname,
        device_type:   device.device_type,
        alias:         device.alias         || undefined,
        vendor:        device.vendor        || undefined,
        serial_number: device.serial_number || undefined,
        mac:           device.mac           || undefined,
        description:   device.description   || undefined,
      });
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <form onSubmit={handleSave} onClick={(e) => e.stopPropagation()} className="space-y-4 p-4">
      <p className="text-xs text-muted-foreground">
        Aktuální IP: <span className="font-mono font-medium">{currentIp}</span>
      </p>

      <FormField label="Nová IP adresa">
        <select
          value={selectedIp}
          onChange={(e) => setSelectedIp(e.target.value)}
          className="h-9 w-full rounded-md border border-border bg-background
                     px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
        >
          {sortedHosts.map((h) => {
            const hIp   = h.ip.split("/")[0];
            const icon  = h.currently_alive ? "✅" : "❌";
            const up    = h.uptime_pct?.toFixed(0) ?? "0";
            const rtt   = h.avg_rtt_ms ? ` · ${h.avg_rtt_ms.toFixed(1)} ms` : "";
            const cur   = hIp === currentIp ? "  ← aktuální" : "";
            return (
              <option key={hIp} value={hIp}>
                {icon} {hIp} · uptime {up}%{rtt}{cur}
              </option>
            );
          })}
        </select>
      </FormField>

      {error && (
        <p className="text-xs text-destructive">{error}</p>
      )}

      <div className="flex items-center gap-2">
        <Button type="submit" variant="primary" size="sm" disabled={updateDevice.isPending}>
          {updateDevice.isPending
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Save className="h-3.5 w-3.5" />}
          Uložit IP
        </Button>
        {updateDevice.isSuccess && (
          <span className="text-xs text-green-600 dark:text-green-400">✓ Uloženo</span>
        )}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Tab: Credentials
// ---------------------------------------------------------------------------
function CredentialsTab({ device }: { device: Device }) {
  const { data: allCredentials = [] } = useCredentials();
  const link   = useLinkCredential();
  const unlink = useUnlinkCredential();

  const assignedIds = new Set(device.credentials.map((c) => c.id));

  return (
    <div className="p-4 space-y-3">
      <p className="text-xs text-muted-foreground">
        Přiřazené přihlašovací profily — jedno zařízení může mít více profilů.
      </p>

      {allCredentials.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Žádné profily — přidejte je v sekci Přihl. profily.
        </p>
      ) : (
        <div className="space-y-1">
          {allCredentials.map((cred) => {
            const isAssigned = assignedIds.has(cred.id);
            const isPending =
              (link.isPending && link.variables?.credentialId === cred.id) ||
              (unlink.isPending && unlink.variables?.credentialId === cred.id);
            return (
              <div
                key={cred.id}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
                  isAssigned
                    ? "border-primary/30 bg-primary/5"
                    : "border-border bg-background"
                )}
              >
                <div className="flex-1 min-w-0">
                  <span className="font-medium">{cred.name}</span>
                  <span className="ml-2 text-xs text-muted-foreground">
                    {cred.auth_type}
                    {cred.username && ` · ${cred.username}`}
                    {cred.port && ` · port ${cred.port}`}
                  </span>
                </div>
                <Button
                  size="sm"
                  variant={isAssigned ? "ghost" : "outline"}
                  disabled={isPending}
                  onClick={() =>
                    isAssigned
                      ? unlink.mutate({ deviceId: device.id, credentialId: cred.id })
                      : link.mutate({ deviceId: device.id, credentialId: cred.id })
                  }
                  className={cn(isAssigned && "text-destructive hover:text-destructive")}
                >
                  {isPending ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : isAssigned ? (
                    <><Unlink className="h-3.5 w-3.5" /> Odebrat</>
                  ) : (
                    <><Link className="h-3.5 w-3.5" /> Přiřadit</>
                  )}
                </Button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Discovery
// ---------------------------------------------------------------------------
function DiscoveryLayerRow({ layer, prevLayer }: {
  layer: DiscoveryLayer;
  prevLayer?: DiscoveryLayer;
}) {
  const changed = prevLayer && prevLayer.result !== layer.result && layer.ok;
  return (
    <tr className={cn(
      "border-b border-border last:border-0 transition-colors",
      changed && "bg-amber-50 dark:bg-amber-950/20"
    )}>
      <td className="px-3 py-2 w-24">
        <span className={cn(
          "inline-flex items-center gap-1.5 text-xs font-medium",
          layer.ok ? "text-foreground" : "text-muted-foreground"
        )}>
          {layer.ok
            ? <span className="h-1.5 w-1.5 rounded-full bg-green-500 shrink-0" />
            : <span className="h-1.5 w-1.5 rounded-full bg-muted-foreground/40 shrink-0" />}
          {layer.layer}
        </span>
      </td>
      <td className="px-3 py-2 text-center w-8">
        {layer.ok ? "✅" : <span className="text-muted-foreground text-xs">—</span>}
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {layer.result
          ? <span className={cn(changed && "text-amber-700 dark:text-amber-400 font-medium")}>
              {layer.result}
            </span>
          : <span className="text-muted-foreground">—</span>}
        {changed && prevLayer?.result && (
          <span className="ml-2 text-muted-foreground line-through text-[10px]">
            {prevLayer.result}
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground max-w-[200px] truncate">
        {layer.note || "—"}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Vizuální score discovery (kolik vrstev úspěšných)
// ---------------------------------------------------------------------------
function DiscoveryScore({ layers }: { layers: DiscoveryLayer[] }) {
  const ok    = layers.filter((l) => l.ok).length;
  const total = layers.length;
  const pct   = total > 0 ? Math.round((ok / total) * 100) : 0;
  const color = pct >= 80 ? "bg-green-500" : pct >= 50 ? "bg-amber-500" : "bg-red-500";

  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={cn("h-full rounded-full transition-all", color)}
             style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs font-medium tabular-nums text-muted-foreground w-12 text-right">
        {ok}/{total} OK
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Porovnání dvou logů — co se změnilo
// ---------------------------------------------------------------------------
function DiffBadges({ current, previous }: {
  current:  import("@/lib/types").DiscoveryLog;
  previous: import("@/lib/types").DiscoveryLog;
}) {
  const changes: string[] = [];
  const curLayers  = current.layers  || [];
  const prevLayers = previous.layers || [];

  curLayers.forEach((cl, i) => {
    const pl = prevLayers[i];
    if (pl && cl.ok && cl.result && cl.result !== pl.result) {
      changes.push(`${cl.layer}: ${cl.result}`);
    } else if (!pl?.ok && cl.ok && cl.result) {
      changes.push(`+${cl.layer}`);
    }
  });

  // Nové porty
  const newPorts = (current.open_ports || []).filter(
    (p) => !(previous.open_ports || []).includes(p)
  );
  const closedPorts = (previous.open_ports || []).filter(
    (p) => !(current.open_ports || []).includes(p)
  );
  if (newPorts.length)    changes.push(`+port ${newPorts.join(",")}`);
  if (closedPorts.length) changes.push(`-port ${closedPorts.join(",")}`);

  if (changes.length === 0) return null;
  return (
    <span className="ml-2 inline-flex items-center gap-1 text-amber-600 dark:text-amber-400 text-[10px]">
      ↕ {changes.slice(0, 3).join(" · ")}
      {changes.length > 3 && ` +${changes.length - 3}`}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Jeden záznam v historii
// ---------------------------------------------------------------------------
function DiscoveryLogEntry({
  log,
  prevLog,
  isOpen,
  onToggle,
  isLatest,
}: {
  log:      import("@/lib/types").DiscoveryLog;
  prevLog?: import("@/lib/types").DiscoveryLog;
  isOpen:   boolean;
  onToggle: () => void;
  isLatest: boolean;
}) {
  const patch   = Object.entries(log.patch_applied ?? {});
  const layers  = log.layers || [];
  const okCount = layers.filter((l) => l.ok).length;

  return (
    <div className={cn(
      "rounded-lg border overflow-hidden transition-colors",
      isLatest ? "border-primary/40" : "border-border"
    )}>
      {/* Header řádku */}
      <button
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2.5 text-left transition-colors",
          "hover:bg-muted/40",
          isLatest && "bg-primary/5"
        )}
        onClick={onToggle}
      >
        <ChevronDown className={cn(
          "h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform",
          isOpen && "rotate-180"
        )} />

        {/* Datum + latest badge */}
        <span className="font-mono text-xs text-muted-foreground shrink-0">
          {formatDateTime(log.tested_at)}
        </span>
        {isLatest && (
          <span className="text-[10px] rounded-full bg-primary/10 text-primary px-1.5 py-0.5 font-medium shrink-0">
            nejnovější
          </span>
        )}

        {/* Score minibar */}
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex gap-0.5">
            {layers.map((l, i) => (
              <div key={i} className={cn(
                "h-2.5 w-1.5 rounded-sm",
                l.ok ? "bg-green-500" : "bg-muted"
              )} />
            ))}
          </div>
          <span className="text-[10px] text-muted-foreground">{okCount}/{layers.length}</span>
        </div>

        {/* Změny oproti předchozímu */}
        {prevLog && <DiffBadges current={log} previous={prevLog} />}

        <div className="flex-1" />

        {/* Patch badges */}
        {patch.length > 0 ? (
          <div className="flex gap-1 flex-wrap justify-end">
            {patch.slice(0, 3).map(([k, v]) => (
              <span key={k} className="text-[10px] rounded-full bg-green-100 dark:bg-green-950
                                       text-green-700 dark:text-green-300 px-2 py-0.5">
                {k}={String(v).slice(0, 15)}
              </span>
            ))}
            {patch.length > 3 && (
              <span className="text-[10px] text-muted-foreground">+{patch.length - 3}</span>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-muted-foreground">žádné změny</span>
        )}
      </button>

      {/* Rozbalená část */}
      {isOpen && (
        <div className="border-t border-border">
          {/* Score bar */}
          <div className="px-3 pt-3 pb-2">
            <DiscoveryScore layers={layers} />
          </div>

          {/* Tabulka vrstev */}
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/30 border-b border-border">
                <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground w-24">Vrstva</th>
                <th className="px-3 py-1.5 text-center text-xs font-medium text-muted-foreground w-8">OK</th>
                <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">Výsledek</th>
                <th className="px-3 py-1.5 text-left text-xs font-medium text-muted-foreground">Poznámka</th>
              </tr>
            </thead>
            <tbody>
              {layers.map((layer, i) => (
                <DiscoveryLayerRow
                  key={i}
                  layer={layer}
                  prevLayer={prevLog?.layers?.[i]}
                />
              ))}
            </tbody>
          </table>

          {/* Porty + služby */}
          {(log.open_ports?.length > 0 || Object.keys(log.services || {}).length > 0) && (
            <div className="border-t border-border px-3 py-2 space-y-1">
              {log.open_ports?.length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">Porty:</span>
                  {log.open_ports.map((p) => {
                    const prevPorts = prevLog?.open_ports || [];
                    const isNew     = prevLog && !prevPorts.includes(p);
                    const isClosed  = prevPorts.includes(p);
                    return (
                      <span key={p} className={cn(
                        "font-mono text-xs rounded px-1.5 py-0.5",
                        isNew
                          ? "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300"
                          : "bg-muted text-muted-foreground"
                      )}>
                        {p}
                        {isNew && <span className="ml-0.5 text-[9px]">NEW</span>}
                      </span>
                    );
                  })}
                  {/* Uzavřené porty */}
                  {prevLog && (prevLog.open_ports || []).filter(
                    (p) => !(log.open_ports || []).includes(p)
                  ).map((p) => (
                    <span key={`closed-${p}`} className="font-mono text-xs rounded px-1.5 py-0.5
                                                          bg-red-100 text-red-600 dark:bg-red-950 dark:text-red-400 line-through">
                      {p}
                    </span>
                  ))}
                </div>
              )}
              {Object.keys(log.services || {}).length > 0 && (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-muted-foreground">Bannery:</span>
                  {Object.entries(log.services).map(([port, banner]) => (
                    <span key={port} className="font-mono text-xs text-muted-foreground">
                      :{port} {String(banner).slice(0, 40)}
                    </span>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tab: Discovery
// ---------------------------------------------------------------------------
function DiscoveryTab({
  device,
  hostInfo,
  logs,
  isLoadingLogs,
}: {
  device: Device;
  hostInfo?: HostStats;
  logs: import("@/lib/types").DiscoveryLog[];
  isLoadingLogs: boolean;
}) {
  const runDiscovery  = useRunDiscovery();
  const [openLogId, setOpenLogId] = useState<number | null>(
    logs.length > 0 ? logs[0].id : null
  );

  // Po úspěšném discovery otevřít první (nejnovější) log
  const prevSuccess = React.useRef(false);
  React.useEffect(() => {
    if (runDiscovery.isSuccess && !prevSuccess.current) {
      prevSuccess.current = true;
    }
    if (!runDiscovery.isSuccess) prevSuccess.current = false;
  }, [runDiscovery.isSuccess]);

  // Otevřeme nejnovější log když přijdou data
  React.useEffect(() => {
    if (logs.length > 0 && openLogId === null) {
      setOpenLogId(logs[0].id);
    }
  }, [logs]);

  const isOnline = hostInfo?.currently_alive === true;

  return (
    <div className="p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
      {/* Toolbar */}
      <div className="flex items-center gap-3 flex-wrap">
        <Button
          variant="primary"
          size="sm"
          disabled={!isOnline || runDiscovery.isPending}
          onClick={() => runDiscovery.mutate(device.id)}
        >
          {runDiscovery.isPending
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Search className="h-3.5 w-3.5" />}
          {runDiscovery.isPending ? "Probíhá…" : "Spustit TEST"}
        </Button>
        {!isOnline && (
          <span className="text-xs text-muted-foreground">🔴 Zařízení offline</span>
        )}
        {runDiscovery.isSuccess && (
          <span className="text-xs text-green-600 dark:text-green-400">
            ✓ Discovery dokončen
          </span>
        )}
        {runDiscovery.isError && (
          <span className="text-xs text-destructive">
            ✗ Chyba discovery
          </span>
        )}
        <div className="flex-1" />
        {logs.length > 0 && (
          <span className="text-xs text-muted-foreground">
            {logs.length} {logs.length === 1 ? "test" : logs.length < 5 ? "testy" : "testů"}
          </span>
        )}
      </div>

      {/* Výsledek aktuálně běžícího discovery */}
      {runDiscovery.isPending && (
        <div className="rounded-lg border border-border bg-muted/20 p-4">
          <div className="flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-primary" />
            <div>
              <p className="text-sm font-medium">Discovery probíhá…</p>
              <p className="text-xs text-muted-foreground">
                Testování 10 vrstev: rDNS, ARP, OUI, port scan, banner, HTTP, TLS, SNMP, NetBIOS, mDNS
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Historie */}
      {isLoadingLogs ? (
        <div className="flex items-center gap-2 py-4">
          <Spinner />
          <span className="text-sm text-muted-foreground">Načítání…</span>
        </div>
      ) : logs.length === 0 ? (
        <div className="rounded-lg border border-dashed border-border p-6 text-center">
          <p className="text-sm font-medium text-muted-foreground">Zatím žádné testy</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Klikni na Spustit TEST pro první discovery
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Historie testů
          </p>
          {logs.map((log, idx) => (
            <DiscoveryLogEntry
              key={log.id}
              log={log}
              prevLog={logs[idx + 1]}
              isOpen={openLogId === log.id}
              onToggle={() => setOpenLogId(openLogId === log.id ? null : log.id)}
              isLatest={idx === 0}
            />
          ))}
        </div>
      )}
    </div>
  );
}


// ---------------------------------------------------------------------------
// Tab: Sběr dat (polling)
// ---------------------------------------------------------------------------
function PollTab({ device }: { device: Device }) {
  const [states, setStates] = React.useState<Record<number, {
    running: boolean; result: any | null; error: string | null;
  }>>({});
  const [history,     setHistory]     = React.useState<any[]>([]);
  const [loadingHist, setLoadingHist] = React.useState(false);
  const [expandedId,  setExpandedId]  = React.useState<number | null>(null);

  const hasCreds = device.credentials.length > 0;

  function getState(id: number) {
    return states[id] ?? { running: false, result: null, error: null };
  }
  function patchState(id: number, patch: Partial<{ running: boolean; result: any; error: string | null }>) {
    setStates(prev => ({ ...prev, [id]: { ...getState(id), ...patch } }));
  }

  async function runPoll(credId: number) {
    patchState(credId, { running: true, result: null, error: null });
    try {
      const token = document.cookie.match(/np_token=([^;]+)/)?.[1] ?? "";
      const r = await fetch(`/api/backend/devices/${device.id}/poll?credential_id=${credId}`,
        { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Chyba pollingu");
      patchState(credId, { result: data, running: false });
      loadHistory();
    } catch (err: any) {
      patchState(credId, { error: err.message ?? "Neznámá chyba", running: false });
    }
  }

  async function loadHistory() {
    setLoadingHist(true);
    try {
      const token = document.cookie.match(/np_token=([^;]+)/)?.[1] ?? "";
      const r = await fetch(`/api/backend/devices/${device.id}/poll-results?limit=15`,
        { headers: { Authorization: `Bearer ${token}` } });
      const data = await r.json();
      setHistory(Array.isArray(data) ? data : []);
      if (Array.isArray(data) && data.length > 0 && expandedId === null)
        setExpandedId(data[0].id);
    } catch {} finally { setLoadingHist(false); }
  }

  React.useEffect(() => { loadHistory(); }, [device.id]);

  function fmtUptime(s: number | null): string {
    if (!s) return "—";
    const w = Math.floor(s/604800), d = Math.floor((s%604800)/86400);
    const h = Math.floor((s%86400)/3600), m = Math.floor((s%3600)/60);
    return w ? `${w}t ${d}d ${h}h` : d ? `${d}d ${h}h ${m}m` : `${h}h ${m}m`;
  }

  const MC: Record<string, string> = {
    api:    "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    snmp:   "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    ssh:    "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    http:   "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
    failed: "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300",
  };
  const AC: Record<string, string> = {
    api:  "bg-green-100 text-green-700 dark:bg-green-950 dark:text-green-300",
    snmp: "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300",
    ssh:  "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300",
    http: "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300",
  };

  function ResultCard({ result, error }: { result: any | null; error: string | null }) {
    if (error) return (
      <div className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">✗ {error}</div>
    );
    if (!result) return null;
    return (
      <div className={cn("mt-2 rounded-lg border p-3 space-y-2 text-xs",
        result.success
          ? "border-green-200 bg-green-50/50 dark:border-green-900 dark:bg-green-950/20"
          : "border-red-200 bg-red-50/50 dark:border-red-900 dark:bg-red-950/20")}>
        <div className="flex items-center gap-2">
          <span className="font-semibold">{result.success ? "✅ Úspěch" : "❌ Selhalo"}</span>
          <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium", MC[result.method] ?? "bg-muted")}>
            {result.method?.toUpperCase()}
          </span>
        </div>
        {result.success && (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
            {([
              ["Hostname",      result.hostname],
              ["Model",         result.model],
              ["Výrobce",       result.vendor],
              ["Firmware",      result.firmware],
              ["Sériové číslo", result.serial],
              ["Software ID",   result.software_id],
              ["Typ zařízení",  result.device_type_detected],
              ["Uptime",        fmtUptime(result.uptime_s)],
              ["Rozhraní",      result.interfaces?.length ? `${result.interfaces.length}` : null],
            ] as [string,any][]).filter(([,v]) => v).map(([k, v]) => (
              <div key={k}><p className="text-muted-foreground text-[10px]">{k}</p><p className="font-medium">{v}</p></div>
            ))}
          </div>
        )}
        {result.system_info && Object.keys(result.system_info).length > 0 && (
          <div className="rounded-md bg-muted/40 px-3 py-2 space-y-0.5">
            {Object.entries(result.system_info)
              .filter(([k]) => !["software-id","detected-type"].includes(k))
              .slice(0, 8).map(([k, v]) => (
                <div key={k} className="flex gap-2">
                  <span className="text-muted-foreground w-28 shrink-0">{k}:</span>
                  <span className="font-mono truncate">{String(v).slice(0, 80)}</span>
                </div>
              ))}
          </div>
        )}
        {result.error && <p className="text-destructive">{result.error}</p>}
        {/* Portová výbava */}
        {result.ports?.length > 0 && (
          <div className="space-y-1">
            <p className="text-[10px] font-medium uppercase text-muted-foreground">Porty ({result.ports.length})</p>
            <div className="rounded-lg border border-border overflow-hidden">
              <table className="w-full text-xs">
                <thead><tr className="bg-muted/40 border-b border-border">
                  {["Port","Rychlost","Typ","Stav","MAC"].map(h => (
                    <th key={h} className="px-2 py-1 text-left font-medium text-muted-foreground">{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {result.ports.map((p: any, i: number) => (
                    <tr key={p.name} className={cn("border-b border-border last:border-0", i%2===0?"bg-background":"bg-muted/10", p.disabled&&"opacity-40")}>
                      <td className="px-2 py-1 font-mono font-medium">{p.name}</td>
                      <td className="px-2 py-1">
                        <span className={cn("rounded px-1.5 py-0.5 text-[10px] font-medium",
                          ["10G","25G","40G","100G"].includes(p.speed) ? "bg-purple-100 text-purple-700 dark:bg-purple-950 dark:text-purple-300"
                          : p.speed==="1G" ? "bg-blue-100 text-blue-700 dark:bg-blue-950 dark:text-blue-300"
                          : "bg-muted text-muted-foreground")}>
                          {p.speed||"—"}
                        </span>
                      </td>
                      <td className="px-2 py-1 text-muted-foreground">{p.sfp ? <span className="text-amber-600 dark:text-amber-400">SFP</span> : "ETH"}</td>
                      <td className="px-2 py-1">{p.disabled ? <span className="text-muted-foreground">dis</span> : p.link ? <span className="text-green-600 dark:text-green-400">▲</span> : <span className="text-red-500">▼</span>}</td>
                      <td className="px-2 py-1 font-mono text-[10px] text-muted-foreground">{p.mac||"—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="p-4 space-y-4" onClick={(e) => e.stopPropagation()}>
      {!device.vendor && (
        <div className="flex items-center gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
          ⚠ Nastavte <strong className="mx-1">Výrobce</strong> v záložce Základní údaje
        </div>
      )}
      {!hasCreds && (
        <p className="text-xs text-muted-foreground">⚠ Přiřaďte přihlašovací profil v záložce Profily</p>
      )}

      {hasCreds && (
        <div className="space-y-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Přihlašovací profily ({device.credentials.length})
          </p>
          {device.credentials.map((cred) => {
            const st = getState(cred.id);
            return (
              <div key={cred.id} className="rounded-lg border border-border bg-card overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-2.5">
                  <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium shrink-0",
                    AC[cred.auth_type] ?? "bg-muted text-muted-foreground")}>
                    {cred.auth_type.toUpperCase()}
                  </span>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium">{cred.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {cred.username && `👤 ${cred.username}`}{cred.port ? ` · :${cred.port}` : ""}
                    </p>
                  </div>
                  <Button variant={st.result?.success ? "primary" : "outline"} size="sm"
                    disabled={st.running || !device.vendor} onClick={() => runPoll(cred.id)}>
                    {st.running ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Search className="h-3.5 w-3.5" />}
                    {st.running ? "Probíhá…" : "Spustit"}
                  </Button>
                </div>
                {st.running && (
                  <div className="border-t border-border px-4 py-2">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Loader2 className="h-4 w-4 animate-spin" />Čekám na odpověď…
                    </div>
                  </div>
                )}
                {(st.result || st.error) && (
                  <div className="border-t border-border px-4 pb-3">
                    <ResultCard result={st.result} error={st.error} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Historie */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Historie ({history.length})
          </p>
          <Button size="sm" variant="ghost" onClick={loadHistory} disabled={loadingHist}>
            <RefreshCw className={cn("h-3 w-3", loadingHist && "animate-spin")} />
          </Button>
        </div>
        {loadingHist && history.length === 0 && (
          <div className="flex items-center gap-2 py-2"><Spinner /><span className="text-xs text-muted-foreground">Načítám…</span></div>
        )}
        {!loadingHist && history.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-4 text-center">
            <p className="text-xs text-muted-foreground">Zatím žádný sběr dat</p>
          </div>
        )}
        {history.map((h, idx) => (
          <div key={h.id} className="rounded-lg border border-border overflow-hidden">
            <button className={cn("flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-muted/30 transition-colors", idx===0&&"bg-primary/5")}
              onClick={() => setExpandedId(expandedId===h.id ? null : h.id)}>
              <ChevronDown className={cn("h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform", expandedId===h.id&&"rotate-180")} />
              <span className="text-xs text-muted-foreground font-mono shrink-0">{formatDateTime(h.polled_at)}</span>
              {idx===0 && <span className="text-[10px] rounded-full bg-primary/10 text-primary px-1.5 py-0.5">nejnovější</span>}
              <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0", MC[h.method]??"bg-muted")}>
                {h.method?.toUpperCase()}
              </span>
              {h.success ? <span className="text-[10px] text-green-600 dark:text-green-400">✓ OK</span>
                         : <span className="text-[10px] text-red-500">✗ selhalo</span>}
              <div className="flex-1" />
              {h.hostname && <span className="text-xs text-muted-foreground">{h.hostname}</span>}
              {h.firmware && <span className="text-xs text-muted-foreground">{h.firmware}</span>}
            </button>
            {expandedId===h.id && (
              <div className="border-t border-border p-3 space-y-2 text-xs">
                <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3">
                  {([
                    ["Hostname", h.hostname], ["Model", h.model], ["Výrobce", h.vendor],
                    ["Firmware", h.firmware], ["Sériové číslo", h.system_info?.["serial-number"]],
                    ["Software ID", h.system_info?.["software-id"]],
                    ["Typ", h.system_info?.["detected-type"]], ["Uptime", fmtUptime(h.uptime_s)],
                    ["Rozhraní", h.interfaces?.length ? `${h.interfaces.length}` : null],
                  ] as [string,any][]).filter(([,v]) => v).map(([k,v]) => (
                    <div key={k}><p className="text-muted-foreground text-[10px]">{k}</p><p className="font-medium">{v||"—"}</p></div>
                  ))}
                </div>
                {h.system_info && Object.keys(h.system_info).length > 0 && (
                  <div className="rounded-md bg-muted/40 px-3 py-2 space-y-0.5">
                    {Object.entries(h.system_info)
                      .filter(([k]) => !["software-id","detected-type"].includes(k))
                      .slice(0, 6).map(([k, v]) => (
                        <div key={k} className="flex gap-2">
                          <span className="text-muted-foreground w-28 shrink-0">{k}:</span>
                          <span className="font-mono truncate">{String(v).slice(0, 60)}</span>
                        </div>
                      ))}
                  </div>
                )}
                {h.error && <p className="text-destructive">{h.error}</p>}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Tab: Zálohy
// ---------------------------------------------------------------------------
function BackupTab({ device }: { device: Device }) {
  const canBackup =
    !!device.last_polled_at &&
    device.credentials.some((c) => c.auth_type === "api" || c.auth_type === "ssh");

  const { data: backups = [], isLoading, refetch } = useDeviceBackups(device.id);
  const runBackup   = useRunBackup();
  const deleteBackup = useDeleteBackup();

  const [runResult, setRunResult] = React.useState<null | {
    success: boolean; filename: string; file_size_human: string; error: string | null;
  }>(null);
  const [deleting, setDeleting] = React.useState<number | null>(null);

  async function handleRunBackup() {
    setRunResult(null);
    try {
      const r = await runBackup.mutateAsync(device.id);
      setRunResult({ success: r.success, filename: r.filename, file_size_human: r.file_size_human, error: r.error });
      refetch();
    } catch (e: unknown) {
      // chyba se zobrazí přes runBackup.error
    }
  }

  async function handleDelete(backupId: number) {
    if (!confirm("Opravdu smazat tuto zálohu?")) return;
    setDeleting(backupId);
    try {
      await deleteBackup.mutateAsync(backupId);
      refetch();
    } finally {
      setDeleting(null);
    }
  }

  async function handleDownload(backupId: number, filename: string) {
    // Stažení přes fetch s JWT tokenem — window.open nezašle Authorization header
    try {
      const token = document.cookie.match(/np_token=([^;]+)/)?.[1] ?? "";
      const res   = await fetch(`/api/backend/backups/${backupId}/download`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Chyba stahování: ${err.detail ?? res.statusText}`);
        return;
      }
      const blob = await res.blob();
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement("a");
      a.href     = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Chyba stahování: ${e}`);
    }
  }

  const typeLabel: Record<string, string> = { binary: ".backup", export: ".rsc" };
  const typeBg:    Record<string, string> = {
    binary: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    export: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  };
  const statusBg: Record<string, string> = {
    ok:      "text-green-600 dark:text-green-400",
    failed:  "text-red-500",
    running: "text-muted-foreground animate-pulse",
  };

  return (
    <div className="p-4 space-y-4">

      {/* Spustit zálohu */}
      <div className="rounded-lg border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm font-medium">Záloha MikroTik</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              Vždy oba typy: binary (.backup) + export (.rsc)
            </p>
          </div>
          <Button
            size="sm"
            onClick={handleRunBackup}
            disabled={!canBackup || runBackup.isPending}
          >
            {runBackup.isPending ? (
              <><Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />Zálohuji…</>
            ) : (
              <><HardDrive className="h-3.5 w-3.5 mr-1.5" />Zálohovat nyní</>
            )}
          </Button>
        </div>

        {/* Podmínky dostupnosti */}
        {!device.last_polled_at && (
          <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-md px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Záloha vyžaduje alespoň jeden úspěšný poll
          </div>
        )}
        {device.last_polled_at && !canBackup && (
          <div className="flex items-center gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-50 dark:bg-amber-950/20 rounded-md px-3 py-2">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            Záloha vyžaduje API nebo SSH přihlašovací profil
          </div>
        )}

        {/* Výsledek posledního spuštění */}
        {runResult && (
          <div className={cn(
            "flex items-center gap-2 text-xs rounded-md px-3 py-2 mt-1",
            runResult.success
              ? "bg-green-50 dark:bg-green-950/20"
              : "bg-red-50 dark:bg-red-950/20"
          )}>
            {runResult.success
              ? <CheckCircle2 className="h-3.5 w-3.5 text-green-600 dark:text-green-400 shrink-0" />
              : <AlertCircle className="h-3.5 w-3.5 text-red-500 shrink-0" />}
            <span className="font-medium">.rsc</span>
            {runResult.success
              ? <><span className="text-muted-foreground truncate">{runResult.filename}</span><span className="ml-auto">{runResult.file_size_human}</span></>
              : <span className="text-red-600 dark:text-red-400 truncate">{runResult.error}</span>}
          </div>
        )}

        {runBackup.isError && (
          <p className="text-xs text-destructive">{getErrorMessage(runBackup.error)}</p>
        )}
      </div>

      {/* Historie záloh */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Historie záloh ({backups.length})
          </p>
          <Button size="sm" variant="ghost" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={cn("h-3 w-3", isLoading && "animate-spin")} />
          </Button>
        </div>

        {isLoading && (
          <div className="flex items-center gap-2 py-2">
            <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />
            <span className="text-xs text-muted-foreground">Načítám…</span>
          </div>
        )}
        {!isLoading && backups.length === 0 && (
          <div className="rounded-lg border border-dashed border-border p-6 text-center">
            <HardDrive className="h-8 w-8 mx-auto text-muted-foreground/30 mb-2" />
            <p className="text-xs text-muted-foreground">Zatím žádné zálohy</p>
          </div>
        )}

        {backups.map((b: DeviceBackup) => (
          <div key={b.id} className="rounded-lg border border-border flex items-center gap-2 px-3 py-2.5 text-xs">
            {/* Typ zálohy */}
            <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-medium shrink-0", typeBg[b.backup_type])}>
              {typeLabel[b.backup_type] ?? b.backup_type}
            </span>

            {/* Datum */}
            <span className="text-muted-foreground font-mono shrink-0">
              {new Date(b.created_at).toLocaleString("cs-CZ", {
                day: "2-digit", month: "2-digit", year: "numeric",
                hour: "2-digit", minute: "2-digit",
              })}
            </span>

            {/* Stav */}
            <span className={cn("shrink-0", statusBg[b.status])}>
              {b.status === "ok" ? "✓ OK" : b.status === "running" ? "…" : "✗ selhalo"}
            </span>

            {/* Velikost */}
            {b.file_size_human && b.status === "ok" && (
              <span className="text-muted-foreground shrink-0">{b.file_size_human}</span>
            )}

            {/* Verze ROS */}
            {b.mikrotik_version && (
              <span className="text-muted-foreground font-mono text-[10px] shrink-0">
                ROS {b.mikrotik_version}
              </span>
            )}

            {/* Chyba */}
            {b.status === "failed" && b.error_msg && (
              <span className="text-red-500 truncate flex-1" title={b.error_msg}>
                {b.error_msg.slice(0, 60)}
              </span>
            )}

            <div className="flex-1" />

            {/* Akce */}
            {b.status === "ok" && (
              <button
                onClick={() => handleDownload(b.id, b.filename)}
                className="p-1 rounded hover:bg-muted/50 text-muted-foreground hover:text-foreground transition-colors"
                title="Stáhnout zálohu"
              >
                <Download className="h-3.5 w-3.5" />
              </button>
            )}
            <button
              onClick={() => handleDelete(b.id)}
              disabled={deleting === b.id}
              className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
              title="Smazat zálohu"
            >
              {deleting === b.id
                ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                : <Trash2 className="h-3.5 w-3.5" />}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}


export function DevicePanel({
  device,
  hostInfo,
  hosts,
  onClose,
  defaultTab = "info",
  onTabChange,
}: {
  device:       Device;
  hostInfo?:    HostStats;
  hosts?:       HostStats[];
  onClose:      () => void;
  defaultTab?:  TabId;
  onTabChange?: (tab: string) => void;
}) {
  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);

  function handleTabChange(tab: TabId) {
    setActiveTab(tab);
    onTabChange?.(tab);
  }
  // Načítáme discovery logy vždy — ne jen když je tab aktivní
  const { data: discoveryLogs = [], isLoading: logsLoading } = useDiscoveryLogs(device.id);

  return (
    <div className="border-l-4 border-primary bg-background" onClick={(e) => e.stopPropagation()}>
      <TabBar active={activeTab} onChange={handleTabChange} />
      {activeTab === "info" && (
        <BasicInfoTab device={device} hostInfo={hostInfo} onClose={onClose} />
      )}
      {activeTab === "ip" && (
        <IpTab device={device as Device} hosts={hosts ?? []} />
      )}
      {activeTab === "credentials" && (
        <CredentialsTab device={device} />
      )}
      {activeTab === "poll" && (
        <PollTab device={device} />
      )}
      {activeTab === "discovery" && (
        <DiscoveryTab device={device} hostInfo={hostInfo} logs={discoveryLogs} isLoadingLogs={logsLoading} />
      )}
      {activeTab === "backup" && (
        <BackupTab device={device} />
      )}
    </div>
  );
}
