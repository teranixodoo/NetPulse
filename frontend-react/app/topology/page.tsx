"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  useCables, useTopologyConnections, useLocationsMap,
  useConnectionTypes, useDeleteCable, useDeleteConnection,
  useCreateCable, useCreateConnection, useDevices,
  getErrorMessage,
} from "@/hooks/useNetPulse";
import type { Cable, TopologyConnection, ConnectionType, LocationMapPoint } from "@/lib/types";
import type { EditMode } from "@/components/topology/TopologyMapView";
import { Trash2, X, Loader2, Cable as CableIcon, Network, Map, Table2 } from "lucide-react";
import { cn } from "@/lib/utils";

const TopologyMapView = dynamic(
  () => import("@/components/topology/TopologyMapView"),
  { ssr: false, loading: () => (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">
      Načítám mapu…
    </div>
  )}
);

const STATUS_COLORS: Record<string, string> = {
  active:   "bg-green-500/15 text-green-700 dark:text-green-400",
  inactive: "bg-gray-500/15 text-gray-600",
  planned:  "bg-blue-500/15 text-blue-700 dark:text-blue-400",
  damaged:  "bg-red-500/15 text-red-700 dark:text-red-400",
};

// ---------------------------------------------------------------------------
// Formulář nového kabelu
// ---------------------------------------------------------------------------
function CableForm({
  route,
  onSave,
  onCancel,
  isPending,
}: {
  route: [number, number][];
  onSave: (data: any) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const { data: locations = [] } = useLocationsMap();
  const [name,       setName]       = useState("");
  const [cableType,  setCableType]  = useState("utp");
  const [medium,     setMedium]     = useState("");
  const [fiberCount, setFiberCount] = useState<number>(12);
  const [lengthM,    setLengthM]    = useState<number | "">("");
  const [status,     setStatus]     = useState("active");
  const [locAId,     setLocAId]     = useState<number | "">("");
  const [locBId,     setLocBId]     = useState<number | "">("");
  const [notes,      setNotes]      = useState("");

  const mediumOptions: Record<string, string[]> = {
    fiber: ["G652D", "G657A1", "G657A2", "OM3", "OM4"],
    utp:   ["Cat5e", "Cat6", "Cat6A", "Cat7"],
    coax:  ["RG58", "RG6", "RG11"],
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Nový kabel</h2>
          <button onClick={onCancel} className="text-muted-foreground hover:text-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="text-xs text-muted-foreground mb-4 bg-muted/50 rounded p-2">
          Trasa: {route.length} bodů nakresleno na mapě
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Název / ID *</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="K-001 nebo Optika H46-V3"
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Typ kabelu</label>
              <select value={cableType} onChange={e => { setCableType(e.target.value); setMedium(""); }}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="utp">UTP</option>
                <option value="fiber">Optika</option>
                <option value="coax">Koax</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Medium</label>
              <select value={medium} onChange={e => setMedium(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">— vyberte —</option>
                {(mediumOptions[cableType] || []).map(m => (
                  <option key={m} value={m}>{m}</option>
                ))}
              </select>
            </div>
          </div>

          {cableType === "fiber" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Počet vláken</label>
              <select value={fiberCount} onChange={e => setFiberCount(Number(e.target.value))}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                {[2,4,6,8,12,24,48,96].map(n => (
                  <option key={n} value={n}>{n} vláken</option>
                ))}
              </select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Délka (m)</label>
              <input type="number" value={lengthM} onChange={e => setLengthM(e.target.value ? Number(e.target.value) : "")}
                placeholder="50"
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Stav</label>
              <select value={status} onChange={e => setStatus(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="active">Aktivní</option>
                <option value="planned">Plánovaný</option>
                <option value="inactive">Neaktivní</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Lokace A (začátek)</label>
              <select value={locAId} onChange={e => setLocAId(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">— nepovinné —</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Lokace B (konec)</label>
              <select value={locBId} onChange={e => setLocBId(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">— nepovinné —</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Poznámka</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            disabled={!name.trim() || isPending}
            onClick={() => onSave({
              name, cable_type: cableType, medium: medium || null,
              fiber_count: cableType === "fiber" ? fiberCount : null,
              length_m: lengthM || null,
              route: route.map(p => [p[1], p[0]]),  // → [lng,lat]
              location_a_id: locAId || null,
              location_b_id: locBId || null,
              status, notes: notes || null,
            })}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Uložit kabel
          </button>
          <button onClick={onCancel}
            className="h-9 px-4 rounded-md border border-border text-sm hover:bg-muted">
            Zrušit
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulář nového spoje
// ---------------------------------------------------------------------------
function ConnectionForm({
  locA, locB,
  onSave, onCancel, isPending,
}: {
  locA: LocationMapPoint; locB: LocationMapPoint;
  onSave: (data: any) => void; onCancel: () => void; isPending: boolean;
}) {
  const { data: connTypes = [] } = useConnectionTypes();
  const { data: cables    = [] } = useCables();
  const { data: devices   = [] } = useDevices() as any;

  const [name,       setName]       = useState("");
  const [typeId,     setTypeId]     = useState<number | "">("");
  const [cableId,    setCableId]    = useState<number | "">("");
  const [fiberNum,   setFiberNum]   = useState<number | "">("");
  const [devAId,     setDevAId]     = useState<number | "">("");
  const [ifaceA,     setIfaceA]     = useState("");
  const [devBId,     setDevBId]     = useState<number | "">("");
  const [ifaceB,     setIfaceB]     = useState("");
  const [status,     setStatus]     = useState("active");
  const [notes,      setNotes]      = useState("");
  // Wireless
  const selectedType = connTypes.find(t => t.id === typeId);
  const isWireless   = selectedType?.category === "wireless";
  const [freqGhz,  setFreqGhz]  = useState("");
  const [tech,     setTech]     = useState("");
  const [azimA,    setAzimA]    = useState("");
  const [azimB,    setAzimB]    = useState("");

  // Vzdálenost z GPS
  const distM = useMemo(() => {
    if (!locA.lat || !locB.lat) return null;
    const R = 6371000;
    const dLat = (locB.lat - locA.lat) * Math.PI / 180;
    const dLng = (locB.lng! - locA.lng!) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(locA.lat*Math.PI/180) * Math.cos(locB.lat*Math.PI/180) * Math.sin(dLng/2)**2;
    return Math.round(2 * R * Math.asin(Math.sqrt(a)));
  }, [locA, locB]);

  const fiberOptions = useMemo(() => {
    if (!cableId) return [];
    const cab = cables.find(c => c.id === cableId);
    return cab?.fiber_count ? Array.from({length: cab.fiber_count}, (_, i) => i + 1) : [];
  }, [cableId, cables]);

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Nový spoj</h2>
          <button onClick={onCancel}><X className="h-5 w-5 text-muted-foreground" /></button>
        </div>

        <div className="text-xs bg-muted/50 rounded p-2 mb-4 space-y-0.5">
          <p>🟢 <span className="font-medium">A:</span> {locA.name}</p>
          <p>🔴 <span className="font-medium">B:</span> {locB.name}</p>
          {distM && <p className="text-muted-foreground">Vzdálenost (vzdušnou čarou): ~{distM} m</p>}
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Název / popis</label>
            <input value={name} onChange={e => setName(e.target.value)}
              placeholder="např. V3-H46 opt.1"
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Typ spoje *</label>
            <select value={typeId} onChange={e => setTypeId(e.target.value ? Number(e.target.value) : "")}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
              <option value="">— vyberte —</option>
              {connTypes.map(t => (
                <option key={t.id} value={t.id}>{t.icon} {t.name}</option>
              ))}
            </select>
          </div>

          {/* Kabelová vazba (nepovinné) */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Kabel</label>
              <select value={cableId} onChange={e => { setCableId(e.target.value ? Number(e.target.value) : ""); setFiberNum(""); }}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">— bez kabelu —</option>
                {cables.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Vlákno</label>
              <select value={fiberNum} onChange={e => setFiberNum(e.target.value ? Number(e.target.value) : "")}
                disabled={!cableId || fiberOptions.length === 0}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm disabled:opacity-50">
                <option value="">—</option>
                {fiberOptions.map(n => <option key={n} value={n}>{n}</option>)}
              </select>
            </div>
          </div>

          {/* Zařízení */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Zařízení A</label>
              <select value={devAId} onChange={e => setDevAId(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">— bez zařízení —</option>
                {devices.map((d: any) => <option key={d.id} value={d.id}>{d.alias || d.hostname}</option>)}
              </select>
              <input value={ifaceA} onChange={e => setIfaceA(e.target.value)}
                placeholder="Interface (ether1, SFP1...)"
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Zařízení B</label>
              <select value={devBId} onChange={e => setDevBId(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">— bez zařízení —</option>
                {devices.map((d: any) => <option key={d.id} value={d.id}>{d.alias || d.hostname}</option>)}
              </select>
              <input value={ifaceB} onChange={e => setIfaceB(e.target.value)}
                placeholder="Interface (ether1, SFP1...)"
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>

          {/* Bezdrátové parametry */}
          {isWireless && (
            <div className="space-y-2 border border-border rounded-md p-3 bg-muted/20">
              <p className="text-xs font-medium text-muted-foreground">📶 Bezdrátové parametry</p>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="text-[11px] text-muted-foreground">Frekvence (GHz)</label>
                  <input value={freqGhz} onChange={e => setFreqGhz(e.target.value)}
                    placeholder="5.0" type="number" step="0.1"
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Technologie</label>
                  <select value={tech} onChange={e => setTech(e.target.value)}
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs">
                    <option value="">—</option>
                    <option value="wifi">WiFi</option>
                    <option value="ptp">PtP</option>
                    <option value="ptmp">PtMP</option>
                    <option value="lte">LTE</option>
                    <option value="microwave">Mikrovlnný</option>
                  </select>
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Azimut A (°)</label>
                  <input value={azimA} onChange={e => setAzimA(e.target.value)}
                    type="number" min="0" max="360" placeholder="045"
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Azimut B (°)</label>
                  <input value={azimB} onChange={e => setAzimB(e.target.value)}
                    type="number" min="0" max="360" placeholder="225"
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
              </div>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Stav</label>
              <select value={status} onChange={e => setStatus(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="active">Aktivní</option>
                <option value="planned">Plánovaný</option>
                <option value="inactive">Neaktivní</option>
              </select>
            </div>
          </div>

          <div>
            <label className="text-xs font-medium text-muted-foreground">Poznámka</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            disabled={!typeId || isPending}
            onClick={() => onSave({
              name: name || null,
              connection_type_id: typeId || null,
              cable_id:     cableId || null,
              fiber_id:     null,  // bude doplněno přes fiber_number lookup na backendu
              device_a_id:  devAId || null,
              interface_a:  ifaceA || null,
              location_a_id: locA.id,
              device_b_id:  devBId || null,
              interface_b:  ifaceB || null,
              location_b_id: locB.id,
              frequency_ghz: freqGhz ? Number(freqGhz) : null,
              technology:   tech || null,
              azimuth_a:    azimA ? Number(azimA) : null,
              azimuth_b:    azimB ? Number(azimB) : null,
              distance_m:   distM,
              status, notes: notes || null,
            })}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Uložit spoj
          </button>
          <button onClick={onCancel} className="h-9 px-4 rounded-md border border-border text-sm hover:bg-muted">
            Zrušit
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function TopologyPage() {
  const { data: cables      = [] } = useCables();
  const { data: connections = [] } = useTopologyConnections();
  const { data: locations   = [] } = useLocationsMap();
  const { data: connTypes   = [] } = useConnectionTypes();

  const deleteCable  = useDeleteCable();
  const deleteConn   = useDeleteConnection();
  const createCable  = useCreateCable();
  const createConn   = useCreateConnection();

  const [view,          setView]          = useState<"map" | "table">("map");
  const [tableTab,      setTableTab]      = useState<"cables" | "connections">("cables");
  const [showCables,    setShowCables]    = useState(true);
  const [showConns,     setShowConns]     = useState(true);
  const [showLocations, setShowLocations] = useState(true);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [editMode,      setEditMode]      = useState<EditMode>("none");

  // Stav formulářů
  const [pendingRoute,  setPendingRoute]  = useState<[number, number][] | null>(null);
  const [pendingConn,   setPendingConn]   = useState<{a: LocationMapPoint, b: LocationMapPoint} | null>(null);

  function toggleType(cat: string) {
    setSelectedTypes(prev => {
      const next = new Set(prev);
      next.has(cat) ? next.delete(cat) : next.add(cat);
      return next;
    });
  }

  async function handleCableSave(data: any) {
    try {
      await createCable.mutateAsync(data);
      setPendingRoute(null);
    } catch (e) { alert(getErrorMessage(e)); }
  }

  async function handleConnSave(data: any) {
    try {
      await createConn.mutateAsync(data);
      setPendingConn(null);
    } catch (e) { alert(getErrorMessage(e)); }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">

      {/* ── Levý panel ── */}
      <div className="w-56 shrink-0 border-r border-border bg-card overflow-y-auto flex flex-col">
        <div className="px-3 py-3 border-b border-border">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Topologie sítě
          </p>
          <div className="flex mt-2 rounded-md border border-border overflow-hidden text-xs">
            {(["map","table"] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={cn("flex-1 flex items-center justify-center gap-1 py-1.5 transition-colors",
                  view === v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
                {v === "map" ? <><Map className="h-3 w-3" />Mapa</> : <><Table2 className="h-3 w-3" />Tabulka</>}
              </button>
            ))}
          </div>
        </div>

        {/* Statistiky */}
        <div className="px-3 py-2 border-b border-border space-y-1">
          {[
            [CableIcon, "Kabely",   cables.length],
            [Network,   "Spoje",    connections.length],
          ].map(([Icon, label, count]: any) => (
            <div key={label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1">
                <Icon className="h-3 w-3" /> {label}
              </span>
              <span className="font-medium">{count}</span>
            </div>
          ))}
        </div>

        {/* Vrstvy */}
        {view === "map" && (
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Vrstvy</p>
            <div className="space-y-1">
              {([
                ["showLocations", showLocations, setShowLocations, "Lokace"],
                ["showCables",    showCables,    setShowCables,    "Kabelové trasy"],
                ["showConns",     showConns,     setShowConns,     "Logické spoje"],
              ] as any[]).map(([key, val, setter, label]) => (
                <button key={key} onClick={() => setter((v: boolean) => !v)}
                  className={cn("w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors",
                    val ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted/50")}>
                  <span className={cn("w-4 h-4 rounded border text-[10px] flex items-center justify-center shrink-0",
                    val ? "bg-primary border-primary text-primary-foreground" : "border-muted-foreground")}>
                    {val ? "✓" : ""}
                  </span>
                  {label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Typy spojů */}
        {view === "map" && (
          <div className="px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Typy spojů</p>
            {selectedTypes.size > 0 && (
              <button onClick={() => setSelectedTypes(new Set())}
                className="text-[10px] text-muted-foreground hover:text-foreground mb-1">
                × Zrušit filtr
              </button>
            )}
            <div className="space-y-0.5">
              {connTypes.map(t => (
                <button key={t.id} onClick={() => toggleType(t.category)}
                  className={cn("w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors",
                    selectedTypes.size === 0 || selectedTypes.has(t.category)
                      ? "text-foreground hover:bg-muted/30" : "text-muted-foreground/40")}>
                  <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: t.color }} />
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Hlavní obsah ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {view === "map" ? (
          <TopologyMapView
            cables={cables} connections={connections} locations={locations}
            showCables={showCables} showConnections={showConns} showLocations={showLocations}
            selectedTypes={selectedTypes}
            editMode={editMode}
            onEditModeChange={setEditMode}
            onCableRouteDrawn={route => { setPendingRoute(route); setEditMode("none"); }}
            onConnectionDrawn={(a, b) => { setPendingConn({ a, b }); setEditMode("none"); }}
          />
        ) : (
          <div className="flex-1 overflow-auto p-4">
            <div className="flex gap-1 mb-4 border-b border-border">
              {(["cables","connections"] as const).map(tab => (
                <button key={tab} onClick={() => setTableTab(tab)}
                  className={cn("px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                    tableTab === tab ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
                  {tab === "cables" ? "Kabely" : "Spoje"}
                  <span className="ml-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                    {tab === "cables" ? cables.length : connections.length}
                  </span>
                </button>
              ))}
            </div>

            {/* Kabely */}
            {tableTab === "cables" && (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      {["Název","Typ","Medium","Vlákna","Délka","Od → Do","Stav",""].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {cables.length === 0 ? (
                      <tr><td colSpan={8} className="px-3 py-8 text-center text-muted-foreground text-xs">
                        Žádné kabely. Použijte tlačítko "Kreslit trasu kabelu" na mapě.
                      </td></tr>
                    ) : cables.map(c => (
                      <tr key={c.id} className="border-t border-border/50 hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium text-xs">{c.name}</td>
                        <td className="px-3 py-2 text-xs">
                          <span className={cn("px-1.5 py-0.5 rounded text-[11px] font-medium",
                            c.cable_type === "fiber" ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" :
                            c.cable_type === "utp" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" :
                            "bg-gray-100 text-gray-700")}>
                            {c.cable_type.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.medium || "—"}</td>
                        <td className="px-3 py-2 text-xs text-center">{c.cable_type === "fiber" ? (c.fiber_count || "—") : "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.length_m ? `${c.length_m} m` : "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.location_a_name || "—"} → {c.location_b_name || "—"}</td>
                        <td className="px-3 py-2 text-xs">
                          <span className={cn("px-1.5 py-0.5 rounded text-[11px]", STATUS_COLORS[c.status] || "")}>{c.status}</span>
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={async () => {
                            if (!confirm(`Smazat kabel "${c.name}"?`)) return;
                            try { await deleteCable.mutateAsync(c.id); }
                            catch (e) { alert(getErrorMessage(e)); }
                          }} className="text-destructive hover:text-destructive/80 p-1">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Spoje */}
            {tableTab === "connections" && (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>
                      {["Název","Typ","Bod A","Bod B","Kabel/Vlákno","Stav",""].map(h => (
                        <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {connections.length === 0 ? (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground text-xs">
                        Žádné spoje. Použijte tlačítko "Přidat spoj" na mapě.
                      </td></tr>
                    ) : connections.map(c => (
                      <tr key={c.id} className="border-t border-border/50 hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium text-xs">{c.name || "—"}</td>
                        <td className="px-3 py-2 text-xs">
                          {c.type_name ? <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: c.color || "#888" }} />
                            {c.type_name}
                          </span> : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {c.device_a_alias || c.device_a_name || c.location_a_name || "—"}
                          {c.interface_a && <span className="text-[10px] ml-1 font-mono">[{c.interface_a}]</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {c.device_b_alias || c.device_b_name || c.location_b_name || "—"}
                          {c.interface_b && <span className="text-[10px] ml-1 font-mono">[{c.interface_b}]</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {c.cable_name || "—"}{c.fiber_number != null ? ` / vl.${c.fiber_number}` : ""}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span className={cn("px-1.5 py-0.5 rounded text-[11px]", STATUS_COLORS[c.status] || "")}>{c.status}</span>
                        </td>
                        <td className="px-3 py-2">
                          <button onClick={async () => {
                            if (!confirm(`Smazat spoj "${c.name || c.id}"?`)) return;
                            try { await deleteConn.mutateAsync(c.id); }
                            catch (e) { alert(getErrorMessage(e)); }
                          }} className="text-destructive hover:text-destructive/80 p-1">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Formuláře ── */}
      {pendingRoute && (
        <CableForm
          route={pendingRoute}
          onSave={handleCableSave}
          onCancel={() => setPendingRoute(null)}
          isPending={createCable.isPending}
        />
      )}
      {pendingConn && (
        <ConnectionForm
          locA={pendingConn.a} locB={pendingConn.b}
          onSave={handleConnSave}
          onCancel={() => setPendingConn(null)}
          isPending={createConn.isPending}
        />
      )}
    </div>
  );
}
