"use client";

import { useConfigList } from "@/hooks/useNetPulse";
import { useState, useMemo } from "react";
import { Plus, ChevronDown, Loader2 } from "lucide-react";
import { useCreateDevice, useLocations, useCreateLocation, getErrorMessage } from "@/hooks/useNetPulse";
import type { HostStats, Device } from "@/lib/types";
import { Button, FormField, Input , LocationCombobox } from "@/components/ui";
import { cn } from "@/lib/utils";


interface AddDeviceFormProps {
  hosts:   HostStats[];
  devices: Device[];
}

export function AddDeviceForm({ hosts, devices }: AddDeviceFormProps) {
  const [open,        setOpen]        = useState(false);
  const [statusFilter,setStatusFilter]= useState<"all"|"online"|"offline">("all");
  const [ipSearch,    setIpSearch]    = useState("");
  const createDevice = useCreateDevice();

  // Pole formuláře
  const [ip,           setIp]           = useState("");
  const [hostname,     setHostname]     = useState("");
  const [alias,        setAlias]        = useState("");
  const { data: deviceTypes = [] } = useConfigList("device_type");
  const [deviceType,   setDeviceType]   = useState("other");
  const [ownership,    setOwnership]    = useState<"isp"|"client"|"unknown">("isp");
  const [vendor,       setVendor]       = useState("");
  const [mac,          setMac]          = useState("");
  const [serialNumber, setSerialNumber] = useState("");
  const [locationId,   setLocationId]   = useState<number | null>(null);
  const [description,  setDescription]  = useState("");
  const { data: locations = [] }        = useLocations(false);
  const createLocation                  = useCreateLocation();
  const [error,        setError]        = useState<string | null>(null);

  // Přiřazené IP
  const assignedIps = useMemo(
    () => new Set(devices.map((d) => d.ip.split("/")[0])),
    [devices]
  );

  // Volné hosty dle filtru
  const freeHosts = useMemo(() => {
    return hosts
      .filter((h) => {
        const hIp = h.ip.split("/")[0];
        if (assignedIps.has(hIp))                                    return false;
        if (statusFilter === "online"  && !h.currently_alive)        return false;
        if (statusFilter === "offline" &&  h.currently_alive)        return false;
        if (ipSearch && !hIp.includes(ipSearch))                     return false;
        return true;
      })
      .sort((a, b) => {
        const toNum = (s: string) => s.split(".").reduce((n, o) => (n << 8) + +o, 0);
        return toNum(a.ip.split("/")[0]) - toNum(b.ip.split("/")[0]);
      });
  }, [hosts, assignedIps, statusFilter, ipSearch]);

  function reset() {
    setIp(""); setHostname(""); setAlias(""); setDeviceType("other"); setOwnership("isp"); setOwnership("isp");
    setVendor(""); setMac(""); setSerialNumber(""); setLocationId(null); setDescription(""); setError(null);
    setIpSearch(""); setStatusFilter("all");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!ip)       { setError("Vyberte IP adresu");      return; }
    if (!hostname.trim()) { setError("Hostname je povinný"); return; }

    try {
      await createDevice.mutateAsync({
        ip,
        hostname:      hostname.trim(),
        device_type:   deviceType,
        ownership:     ownership,
        alias:         alias.trim()        || undefined,
        vendor:        vendor.trim()       || undefined,
        mac:           mac.trim()          || undefined,
        serial_number: serialNumber.trim() || undefined,
        location_id:   locationId          || undefined,
        description:   description.trim()  || undefined,
      });
      reset();
      setOpen(false);
    } catch (err) {
      setError(getErrorMessage(err));
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card">
      {/* Toggle header */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-4 py-3 text-sm font-medium
                   hover:bg-muted/40 transition-colors rounded-lg"
      >
        <Plus className="h-4 w-4 text-primary" />
        Registrovat nové zařízení
        <div className="flex-1" />
        <ChevronDown className={cn(
          "h-4 w-4 text-muted-foreground transition-transform duration-150",
          open && "rotate-180"
        )} />
      </button>

      {open && (
        <div className="border-t border-border p-4">
          <form onSubmit={handleSubmit} className="space-y-4">

            {/* IP výběr */}
            <div className="space-y-2">
              <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                IP adresa
              </p>
              <div className="flex gap-2 flex-wrap">
                <input
                  value={ipSearch}
                  onChange={(e) => setIpSearch(e.target.value)}
                  placeholder="🔍 Hledat IP…"
                  className="h-8 flex-1 min-w-[120px] rounded-md border border-border
                             bg-background px-3 text-sm
                             focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                <div className="flex rounded-md border border-border overflow-hidden">
                  {(["all","online","offline"] as const).map((f) => (
                    <button
                      key={f}
                      type="button"
                      onClick={() => setStatusFilter(f)}
                      className={cn(
                        "px-3 py-1 text-xs transition-colors",
                        statusFilter === f
                          ? "bg-primary text-primary-foreground"
                          : "bg-background text-muted-foreground hover:bg-muted"
                      )}
                    >
                      {f === "all" ? "Vše" : f === "online" ? "✅ Online" : "❌ Offline"}
                    </button>
                  ))}
                </div>
              </div>

              <select
                value={ip}
                onChange={(e) => setIp(e.target.value)}
                className="h-9 w-full rounded-md border border-border bg-background
                           px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
              >
                <option value="">— Vyberte IP adresu —</option>
                {freeHosts.map((h) => {
                  const hIp  = h.ip.split("/")[0];
                  const icon = h.currently_alive ? "✅" : "❌";
                  const up   = h.uptime_pct?.toFixed(0) ?? "0";
                  const rtt  = h.avg_rtt_ms ? ` · ${h.avg_rtt_ms.toFixed(1)} ms` : "";
                  return (
                    <option key={hIp} value={hIp}>
                      {icon} {hIp} · uptime {up}%{rtt}
                    </option>
                  );
                })}
              </select>
              <p className="text-xs text-muted-foreground">
                {freeHosts.length} volných IP
                {assignedIps.size > 0 && ` · ${assignedIps.size} přiřazených skryto`}
              </p>
            </div>

            {/* Základní údaje */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <FormField label="Hostname *">
                <Input
                  value={hostname}
                  onChange={(e) => setHostname(e.target.value)}
                  placeholder="ap-sklad-01"
                  autoComplete="off"
                />
              </FormField>
              <FormField label="Alias">
                <Input
                  value={alias}
                  onChange={(e) => setAlias(e.target.value)}
                  placeholder="Sklad A"
                />
              </FormField>
              <FormField label="Typ">
                <select
                  value={deviceType}
                  onChange={(e) => setDeviceType(e.target.value)}
                  className="h-9 w-full rounded-md border border-border bg-background
                             px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50"
                >
                  {deviceTypes.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </FormField>
              <FormField label="Uživatel">
                <select value={ownership} onChange={(e) => setOwnership(e.target.value as "isp"|"client"|"unknown")}
                  className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm">
                  <option value="isp">ISP</option>
                  <option value="client">Klientské</option>
                  <option value="unknown">Neznámé</option>
                </select>
              </FormField>
              <FormField label="Výrobce">
                <Input
                  value={vendor}
                  onChange={(e) => setVendor(e.target.value)}
                  placeholder="MikroTik"
                />
              </FormField>
              <FormField label="MAC adresa">
                <Input
                  value={mac}
                  onChange={(e) => setMac(e.target.value)}
                  placeholder="AA:BB:CC:DD:EE:FF"
                />
              </FormField>
              <FormField label="Sériové číslo">
                <Input
                  value={serialNumber}
                  onChange={(e) => setSerialNumber(e.target.value)}
                />
              </FormField>
              <FormField label="Lokace">
                <LocationCombobox
                  locations={locations as import("@/lib/types").Location[]}
                  value={locationId}
                  onChange={setLocationId}
                  onCreateNew={async (name) => {
                    try {
                      const newLoc = await createLocation.mutateAsync({ name, type: "other" });
                      setLocationId(newLoc.id);
                    } catch {}
                  }}
                />
              </FormField>
            </div>
            <FormField label="Poznámka">
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

            {error && (
              <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <div className="flex gap-2">
              <Button
                type="submit"
                variant="primary"
                size="sm"
                disabled={createDevice.isPending}
              >
                {createDevice.isPending
                  ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  : <Plus className="h-3.5 w-3.5" />}
                Uložit zařízení
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                onClick={() => { reset(); setOpen(false); }}
              >
                Zrušit
              </Button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
