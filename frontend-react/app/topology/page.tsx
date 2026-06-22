"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import {
  useCables, useTopologyConnections, useLocationsMap,
  useConnectionTypes, useDeleteCable, useDeleteConnection,
  useCreateCable, useCreateConnection, useDevices,
  getErrorMessage,
} from "@/hooks/useNetPulse";
import { buildingsApi, locationsCreateApi } from "@/lib/api";
import type { Cable, TopologyConnection, ConnectionType, LocationMapPoint } from "@/lib/types";
import type { EditMode } from "@/components/topology/TopologyMapView";
import { Trash2, X, Loader2, Cable as CableIcon, Network, Map, Table2, Building2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

const TopologyMapView = dynamic(
  () => import("@/components/topology/TopologyMapView"),
  { ssr: false, loading: () => (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">Načítám mapu…</div>
  )}
);
const Building3DView = dynamic(
  () => import("@/components/topology/Building3DView"),
  { ssr: false }
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
function CableForm({ route, onSave, onCancel, isPending }: {
  route: [number, number][]; onSave: (d: any) => void;
  onCancel: () => void; isPending: boolean;
}) {
  const { data: locations = [] } = useLocationsMap();
  const [name, setName]       = useState("");
  const [cableType, setT]     = useState("utp");
  const [medium, setM]        = useState("");
  const [fiberCount, setF]    = useState<number>(12);
  const [lengthM, setL]       = useState<number | "">("");
  const [status, setSt]       = useState("active");
  const [locAId, setA]        = useState<number | "">("");
  const [locBId, setB]        = useState<number | "">("");
  const [notes, setN]         = useState("");

  const mediumOpts: Record<string, string[]> = {
    fiber: ["G652D","G657A1","G657A2","OM3","OM4"],
    utp:   ["Cat5e","Cat6","Cat6A","Cat7"],
    coax:  ["RG58","RG6","RG11"],
  };

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-md p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Nový kabel</h2>
          <button onClick={onCancel}><X className="h-5 w-5 text-muted-foreground" /></button>
        </div>
        <div className="text-xs text-muted-foreground mb-4 bg-muted/50 rounded p-2">
          Trasa: {route.length} bodů nakresleno
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Název *</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="K-001"
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Typ</label>
              <select value={cableType} onChange={e => { setT(e.target.value); setM(""); }}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="utp">UTP</option>
                <option value="fiber">Optika</option>
                <option value="coax">Koax</option>
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Medium</label>
              <select value={medium} onChange={e => setM(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">—</option>
                {(mediumOpts[cableType] || []).map(m => <option key={m} value={m}>{m}</option>)}
              </select>
            </div>
          </div>
          {cableType === "fiber" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">Počet vláken</label>
              <select value={fiberCount} onChange={e => setF(Number(e.target.value))}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                {[2,4,6,8,12,24,48,96].map(n => <option key={n} value={n}>{n} vláken</option>)}
              </select>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Délka (m)</label>
              <input type="number" value={lengthM} onChange={e => setL(e.target.value ? Number(e.target.value) : "")}
                placeholder="50"
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Stav</label>
              <select value={status} onChange={e => setSt(e.target.value)}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="active">Aktivní</option>
                <option value="planned">Plánovaný</option>
                <option value="inactive">Neaktivní</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Lokace A</label>
              <select value={locAId} onChange={e => setA(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">—</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Lokace B</label>
              <select value={locBId} onChange={e => setB(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">—</option>
                {locations.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </div>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Poznámka</label>
            <textarea value={notes} onChange={e => setN(e.target.value)} rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button disabled={!name.trim() || isPending}
            onClick={() => onSave({ name, cable_type: cableType, medium: medium||null,
              fiber_count: cableType === "fiber" ? fiberCount : null,
              length_m: lengthM||null, route: route.map(p => [p[1],p[0]]),
              location_a_id: locAId||null, location_b_id: locBId||null,
              status, notes: notes||null })}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Uložit kabel
          </button>
          <button onClick={onCancel} className="h-9 px-4 rounded-md border border-border text-sm hover:bg-muted">Zrušit</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulář nového polygonu budovy
// ---------------------------------------------------------------------------
function BuildingPolygonForm({ loc, coords, onSave, onCancel, isPending }: {
  loc: LocationMapPoint; coords: [number,number][];
  onSave: (d: any) => void; onCancel: () => void; isPending: boolean;
}) {
  const [name,        setName]        = useState(loc.name);
  const [description, setDescription] = useState("");
  const [floorCount,  setFloorCount]  = useState(3);
  const [floorHeight, setFloorHeight] = useState(3.5);
  const [color,       setColor]       = useState("#3b82f6");
  const [fillOpacity, setFillOpacity] = useState(0.3);
  const totalHeight = +(floorCount * floorHeight).toFixed(1);

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">🏢 Polygon budovy</h2>
          <button onClick={onCancel}><X className="h-5 w-5 text-muted-foreground" /></button>
        </div>
        <div className="text-xs text-muted-foreground bg-muted/50 rounded p-2 mb-4">
          Lokace: <strong>{loc.name}</strong> · {coords.length} bodů nakresleno
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Název polygonu</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Popis</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              placeholder="Volitelný popis budovy"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Počet pater</label>
              <input type="number" min={1} max={50} value={floorCount}
                onChange={e => setFloorCount(Math.max(1, Number(e.target.value)))}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Výška/patro (m)</label>
              <input type="number" min={2} max={10} step={0.5} value={floorHeight}
                onChange={e => setFloorHeight(Number(e.target.value))}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>
          <div className="flex items-center justify-between text-xs bg-primary/5 rounded p-2.5">
            <span className="text-muted-foreground">Celková výška budovy:</span>
            <strong className="text-primary text-sm">{totalHeight} m</strong>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Barva výplně</label>
              <div className="mt-1 flex items-center gap-2">
                <input type="color" value={color} onChange={e => setColor(e.target.value)}
                  className="h-9 w-12 rounded border border-border cursor-pointer p-0.5" />
                <span className="text-xs text-muted-foreground font-mono">{color}</span>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Průhlednost ({Math.round(fillOpacity * 100)}%)
              </label>
              <input type="range" min={0.1} max={0.9} step={0.1} value={fillOpacity}
                onChange={e => setFillOpacity(Number(e.target.value))}
                className="mt-2 w-full" />
            </div>
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button disabled={!name.trim() || isPending}
            onClick={() => onSave({
              name, description: description||null, location_id: loc.id,
              coordinates: coords.map(p => [p[1], p[0]]),
              color, fill_opacity: fillOpacity, stroke_color: color, stroke_width: 2,
              height_m: totalHeight, base_height_m: 0, floor_count: floorCount,
              imported_from: "manual",
            })}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Uložit polygon
          </button>
          <button onClick={onCancel} className="h-9 px-4 rounded-md border border-border text-sm hover:bg-muted">Zrušit</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formulář spoje
// ---------------------------------------------------------------------------
function ConnectionForm({ locA, locB, onSave, onCancel, isPending }: {
  locA: LocationMapPoint; locB: LocationMapPoint;
  onSave: (d: any) => void; onCancel: () => void; isPending: boolean;
}) {
  const { data: connTypes = [] } = useConnectionTypes();
  const { data: cables    = [] } = useCables();
  const { data: devices   = [] } = useDevices() as any;
  const [name,   setName]   = useState("");
  const [typeId, setTypeId] = useState<number|"">("");
  const [cableId,setCableId]= useState<number|"">("");
  const [devAId, setDevAId] = useState<number|"">("");
  const [ifaceA, setIfaceA] = useState("");
  const [devBId, setDevBId] = useState<number|"">("");
  const [ifaceB, setIfaceB] = useState("");
  const [status, setStatus] = useState("active");
  const [notes,  setNotes]  = useState("");
  const selectedType = connTypes.find(t => t.id === typeId);
  const isWireless   = selectedType?.category === "wireless";
  const [freqGhz, setFreq] = useState("");
  const [azimA,   setAA]   = useState("");
  const [azimB,   setAB]   = useState("");

  const distM = useMemo(() => {
    if (!locA.lat || !locB.lat) return null;
    const R = 6371000;
    const dLat = (locB.lat - locA.lat) * Math.PI / 180;
    const dLng = ((locB.lng ?? 0) - (locA.lng ?? 0)) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(locA.lat*Math.PI/180)*Math.cos(locB.lat*Math.PI/180)*Math.sin(dLng/2)**2;
    return Math.round(2*6371000*Math.asin(Math.sqrt(a)));
  }, [locA, locB]);

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">Nový spoj</h2>
          <button onClick={onCancel}><X className="h-5 w-5 text-muted-foreground" /></button>
        </div>
        <div className="text-xs bg-muted/50 rounded p-2 mb-4 space-y-0.5">
          <p>🟢 <strong>A:</strong> {locA.name}</p>
          <p>🔴 <strong>B:</strong> {locB.name}</p>
          {distM && <p className="text-muted-foreground">Vzdálenost: ~{distM} m</p>}
        </div>
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium text-muted-foreground">Název</label>
            <input value={name} onChange={e => setName(e.target.value)} placeholder="např. V3-H46 opt.1"
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Typ spoje *</label>
            <select value={typeId} onChange={e => setTypeId(e.target.value ? Number(e.target.value) : "")}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
              <option value="">— vyberte —</option>
              {connTypes.map(t => <option key={t.id} value={t.id}>{t.icon} {t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Kabel</label>
            <select value={cableId} onChange={e => setCableId(e.target.value ? Number(e.target.value) : "")}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
              <option value="">— bez kabelu —</option>
              {cables.map((c: Cable) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Zařízení A</label>
              <select value={devAId} onChange={e => setDevAId(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">—</option>
                {devices.map((d: any) => <option key={d.id} value={d.id}>{d.alias||d.hostname}</option>)}
              </select>
              <input value={ifaceA} onChange={e => setIfaceA(e.target.value)} placeholder="Interface"
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Zařízení B</label>
              <select value={devBId} onChange={e => setDevBId(e.target.value ? Number(e.target.value) : "")}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
                <option value="">—</option>
                {devices.map((d: any) => <option key={d.id} value={d.id}>{d.alias||d.hostname}</option>)}
              </select>
              <input value={ifaceB} onChange={e => setIfaceB(e.target.value)} placeholder="Interface"
                className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>
          {isWireless && (
            <div className="space-y-2 border border-border rounded-md p-3 bg-muted/20">
              <p className="text-xs font-medium text-muted-foreground">📶 Bezdrátové parametry</p>
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="text-[11px] text-muted-foreground">Frekvence (GHz)</label>
                  <input value={freqGhz} onChange={e => setFreq(e.target.value)} type="number" step="0.1" placeholder="5.0"
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Azimut A (°)</label>
                  <input value={azimA} onChange={e => setAA(e.target.value)} type="number" min="0" max="360" placeholder="045"
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
                <div>
                  <label className="text-[11px] text-muted-foreground">Azimut B (°)</label>
                  <input value={azimB} onChange={e => setAB(e.target.value)} type="number" min="0" max="360" placeholder="225"
                    className="mt-1 h-8 w-full rounded-md border border-border bg-background px-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/50" />
                </div>
              </div>
            </div>
          )}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Stav</label>
            <select value={status} onChange={e => setStatus(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm">
              <option value="active">Aktivní</option>
              <option value="planned">Plánovaný</option>
              <option value="inactive">Neaktivní</option>
            </select>
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Poznámka</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>
        </div>
        <div className="flex gap-2 mt-5">
          <button disabled={!typeId || isPending}
            onClick={() => onSave({
              name: name||null, connection_type_id: typeId||null, cable_id: cableId||null,
              device_a_id: devAId||null, interface_a: ifaceA||null, location_a_id: locA.id,
              device_b_id: devBId||null, interface_b: ifaceB||null, location_b_id: locB.id,
              frequency_ghz: freqGhz ? Number(freqGhz) : null,
              azimuth_a: azimA ? Number(azimA) : null, azimuth_b: azimB ? Number(azimB) : null,
              distance_m: distM, status, notes: notes||null,
            })}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Uložit spoj
          </button>
          <button onClick={onCancel} className="h-9 px-4 rounded-md border border-border text-sm hover:bg-muted">Zrušit</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Formulář vlastností polygonu — s vazbou pater na lokace
// ---------------------------------------------------------------------------
function PolygonPropertiesForm({
  polygon, locations, onSave, onCancel,
}: {
  polygon: any;
  locations: LocationMapPoint[];
  onSave: (data: any) => Promise<void>;
  onCancel: () => void;
}) {
  const [name,        setName]        = useState(polygon.name);
  const [description, setDescription] = useState(polygon.description || "");
  const [floorCount,  setFloorCount]  = useState(polygon.floor_count || 1);
  const [floorHeight, setFloorHeight] = useState(
    polygon.floor_count > 0 ? +(polygon.height_m / polygon.floor_count).toFixed(2) : 3.5
  );
  const [color,       setColor]       = useState(polygon.color || "#3b82f6");
  const [fillOpacity, setFillOpacity] = useState(polygon.fill_opacity || 0.3);
  // floor_location_ids: { "0": locId | null, "1": locId | null, ... }
  const [floorLocIds, setFloorLocIds] = useState<Record<string, number | null>>(() => {
    const existing = polygon.floor_location_ids || {};
    const result: Record<string, number | null> = {};
    for (let i = 0; i < (polygon.floor_count || 1); i++) {
      result[String(i)] = existing[String(i)] ?? null;
    }
    return result;
  });
  const [creating,   setCreating]    = useState<number | null>(null);
  const [newLocNames, setNewLocNames] = useState<Record<string, string>>({});
  const [saving,     setSaving]      = useState(false);

  const totalHeight = +(floorCount * floorHeight).toFixed(1);
  const floorHeight_ = floorHeight; // alias pro closure

  // Podřízené lokace buildingu (typ floor) pro výběr
  const buildingLocId = polygon.location_id;
  const floorLocs = useMemo(() =>
    locations.filter(l =>
      l.parent_id === buildingLocId && l.type === "floor"
    ).sort((a, b) => (a.depth ?? 0) - (b.depth ?? 0)),
    [locations, buildingLocId]
  );

  // Synchronizace počtu pater s floorLocIds
  function updateFloorCount(n: number) {
    const count = Math.max(1, n);
    setFloorCount(count);
    setFloorLocIds(prev => {
      const next: Record<string, number | null> = {};
      for (let i = 0; i < count; i++) {
        next[String(i)] = prev[String(i)] ?? null;
      }
      return next;
    });
  }

  async function handleCreateFloorLoc(floorIndex: number) {
    const name = newLocNames[String(floorIndex)]?.trim();
    if (!name) return;
    setCreating(floorIndex);
    try {
      const parentLoc = locations.find(l => l.id === buildingLocId);
      const newLoc = await locationsCreateApi.create({
        name,
        type:        "floor",
        parent_id:   buildingLocId ?? null,
        floor_level: floorIndex,
        lat:         parentLoc?.lat ?? parentLoc?.inherited_lat ?? null,
        lng:         parentLoc?.lng ?? parentLoc?.inherited_lng ?? null,
        description: `Patro ${floorIndex === 0 ? "Přízemí" : `${floorIndex}. NP`}`,
      });
      setFloorLocIds(prev => ({ ...prev, [String(floorIndex)]: newLoc.id }));
      setNewLocNames(prev => ({ ...prev, [String(floorIndex)]: "" }));
    } catch(e: any) {
      alert("Chyba vytvoření lokace: " + (e?.response?.data?.detail || e.message));
    }
    setCreating(null);
  }

  function floorLabel(i: number) {
    if (i === 0) return "Přízemí";
    if (i < 0)  return `Suterén ${Math.abs(i)}`;
    return `${i}. NP`;
  }

  return (
    <div className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/40">
      <div className="bg-background rounded-xl shadow-2xl border border-border w-full max-w-lg p-6
                      max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold">⚙️ Vlastnosti polygonu</h2>
          <button onClick={onCancel}><X className="h-5 w-5 text-muted-foreground" /></button>
        </div>

        <div className="space-y-4">
          {/* Základní info */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Název</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Popis</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>

          {/* Výška */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Počet pater</label>
              <input type="number" min={1} max={50} value={floorCount}
                onChange={e => updateFloorCount(Number(e.target.value))}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm
                           focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Výška/patro (m)</label>
              <input type="number" min={2} max={10} step={0.5} value={floorHeight}
                onChange={e => setFloorHeight(Number(e.target.value))}
                className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm
                           focus:outline-none focus:ring-2 focus:ring-primary/50" />
            </div>
          </div>
          <div className="flex items-center justify-between text-xs bg-primary/5 rounded p-2.5">
            <span className="text-muted-foreground">Celková výška:</span>
            <strong className="text-primary">{totalHeight} m</strong>
          </div>

          {/* Barva */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Barva výplně</label>
              <div className="mt-1 flex items-center gap-2">
                <input type="color" value={color} onChange={e => setColor(e.target.value)}
                  className="h-9 w-12 rounded border border-border cursor-pointer p-0.5" />
                <span className="text-xs font-mono text-muted-foreground">{color}</span>
              </div>
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                Průhlednost ({Math.round(fillOpacity * 100)}%)
              </label>
              <input type="range" min={0.1} max={0.9} step={0.1} value={fillOpacity}
                onChange={e => setFillOpacity(Number(e.target.value))}
                className="mt-2 w-full" />
            </div>
          </div>

          {/* Vazba pater na lokace */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-xs font-semibold text-foreground">Patra — vazba na lokace</label>
              {!buildingLocId && (
                <span className="text-[10px] text-amber-600">
                  ⚠️ Polygon nemá vazbu na budovu
                </span>
              )}
            </div>
            <div className="space-y-2">
              {Array.from({ length: floorCount }, (_, i) => {
                const base = +(i * floorHeight_).toFixed(1);
                const top  = +(base + floorHeight_).toFixed(1);
                const selectedLocId = floorLocIds[String(i)];

                return (
                  <div key={i} className="border border-border rounded-md p-2.5 space-y-2">
                    <div className="flex items-center gap-2">
                      <span className="w-5 h-5 rounded-sm shrink-0 text-[10px] flex items-center
                                      justify-center font-bold text-white"
                        style={{ background: ["#3b82f6","#22c55e","#f59e0b","#ef4444","#8b5cf6","#06b6d4"][i % 6] }}>
                        {i}
                      </span>
                      <span className="text-xs font-medium">{floorLabel(i)}</span>
                      <span className="text-[10px] text-muted-foreground ml-auto">
                        {base}m – {top}m
                      </span>
                    </div>

                    <div className="flex gap-2">
                      <select
                        value={selectedLocId ?? ""}
                        onChange={e => setFloorLocIds(prev => ({
                          ...prev, [String(i)]: e.target.value ? Number(e.target.value) : null
                        }))}
                        className="flex-1 h-8 rounded-md border border-border bg-background px-2 text-xs
                                   focus:outline-none focus:ring-2 focus:ring-primary/50">
                        <option value="">— bez vazby —</option>
                        {floorLocs.map(l => (
                          <option key={l.id} value={l.id}>
                            {l.name}{l.floor_level != null ? ` (úroveň ${l.floor_level})` : ""}
                          </option>
                        ))}
                        {/* Lokace vybraná ale není v listu floor typů */}
                        {selectedLocId && !floorLocs.find(l => l.id === selectedLocId) && (
                          <option value={selectedLocId}>
                            ID {selectedLocId} (jiný typ)
                          </option>
                        )}
                      </select>
                    </div>

                    {buildingLocId && !selectedLocId && (
                      <div className="flex gap-1.5">
                        <input
                          placeholder={`Název patra (např. "${floorLabel(i)}")`}
                          value={newLocNames[String(i)] ?? ""}
                          onChange={e => setNewLocNames(prev => ({
                            ...prev, [String(i)]: e.target.value
                          }))}
                          onKeyDown={e => e.key === "Enter" && handleCreateFloorLoc(i)}
                          className="flex-1 h-7 rounded border border-dashed border-primary/40
                                     bg-primary/5 px-2 text-xs focus:outline-none
                                     focus:ring-1 focus:ring-primary/50 placeholder:text-muted-foreground/60"
                        />
                        <button
                          onClick={() => handleCreateFloorLoc(i)}
                          disabled={creating === i || !newLocNames[String(i)]?.trim()}
                          className="h-7 px-2 rounded bg-primary/10 text-primary text-xs
                                     hover:bg-primary hover:text-primary-foreground transition-colors
                                     disabled:opacity-50 whitespace-nowrap">
                          {creating === i ? <Loader2 className="h-3 w-3 animate-spin inline" /> : "+ Vytvořit"}
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        <div className="flex gap-2 mt-5">
          <button
            disabled={saving || !name.trim()}
            onClick={async () => {
              setSaving(true);
              await onSave({
                ...polygon,
                name, description: description || null,
                floor_count: floorCount,
                height_m:    totalHeight,
                color, fill_opacity: fillOpacity,
                stroke_color: color,
                floor_location_ids: floorLocIds,
              });
              setSaving(false);
            }}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md
                       bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Uložit
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

export default function TopologyPage() {
  const qc = useQueryClient();
  const { data: cables      = [] } = useCables();
  const { data: connections = [] } = useTopologyConnections();
  const { data: locations   = [] } = useLocationsMap();
  const { data: connTypes   = [] } = useConnectionTypes();

  // Building polygons
  const { data: buildingPolygons = [] } = useQuery({
    queryKey: ["buildings"],
    queryFn:  () => buildingsApi.list(),
  });

  const deleteCable  = useDeleteCable();
  const deleteConn   = useDeleteConnection();
  const createCable  = useCreateCable();
  const createConn   = useCreateConnection();

  const deleteBuildingMutation = useMutation({
    mutationFn: (id: number) => buildingsApi.delete(id),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ["buildings"] }),
  });

  const [view,          setView]          = useState<"map"|"table">("map");
  const [tableTab,      setTableTab]      = useState<"cables"|"connections"|"polygons">("cables");
  const [showCables,    setShowCables]    = useState(true);
  const [showConns,     setShowConns]     = useState(true);
  const [showLocations, setShowLocations] = useState(true);
  const [showPolygons,  setShowPolygons]  = useState(true);
  const [selectedTypes, setSelectedTypes] = useState<Set<string>>(new Set());
  const [editMode,      setEditMode]      = useState<EditMode>("none");

  const [pendingRoute,   setPendingRoute]   = useState<[number,number][]|null>(null);
  const [pendingConn,    setPendingConn]    = useState<{a:LocationMapPoint;b:LocationMapPoint}|null>(null);
  const [pendingPolygon, setPendingPolygon] = useState<{loc:LocationMapPoint;coords:[number,number][]}|null>(null);
  const [view3d,         setView3d]         = useState<{id:number;name:string}|null>(null);
  const [editPolygon,    setEditPolygon]     = useState<any|null>(null);
  const [savingPolygon,  setSavingPolygon]  = useState(false);

  function toggleType(cat: string) {
    setSelectedTypes(prev => { const n = new Set(prev); n.has(cat) ? n.delete(cat) : n.add(cat); return n; });
  }

  async function handleCableSave(data: any) {
    try { await createCable.mutateAsync(data); setPendingRoute(null); }
    catch (e) { alert(getErrorMessage(e)); }
  }
  async function handleConnSave(data: any) {
    try { await createConn.mutateAsync(data); setPendingConn(null); }
    catch (e) { alert(getErrorMessage(e)); }
  }
  function handlePolygonAction(action: "view3d" | "properties" | "edit_shape", polygon: any) {
    if (action === "view3d") {
      setView3d({ id: polygon.id, name: polygon.name });
    } else if (action === "properties") {
      setEditPolygon(polygon);
    } else if (action === "edit_shape") {
      alert("Editace tvaru polygonu bude implementována v další verzi.");
    }
  }

  async function handlePolygonSave(data: any) {
    setSavingPolygon(true);
    try {
      await buildingsApi.create(data);
      qc.invalidateQueries({ queryKey: ["buildings"] });
      setPendingPolygon(null);
    } catch (e: any) {
      const detail = e?.response?.data?.detail;
      const msg = typeof detail === "string" ? detail
                : typeof detail === "object" ? JSON.stringify(detail)
                : e?.message || "Neznámá chyba";
      alert("Chyba při ukládání polygonu: " + msg);
    } finally {
      setSavingPolygon(false);
    }
  }

  return (
    <div className="flex h-[calc(100vh-4rem)] overflow-hidden">

      {/* Levý panel */}
      <div className="w-56 shrink-0 border-r border-border bg-card overflow-y-auto flex flex-col">
        <div className="px-3 py-3 border-b border-border">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Topologie sítě</p>
          <div className="flex mt-2 rounded-md border border-border overflow-hidden text-xs">
            {(["map","table"] as const).map(v => (
              <button key={v} onClick={() => setView(v)}
                className={cn("flex-1 flex items-center justify-center gap-1 py-1.5 transition-colors",
                  view===v ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
                {v==="map" ? <><Map className="h-3 w-3"/>Mapa</> : <><Table2 className="h-3 w-3"/>Tabulka</>}
              </button>
            ))}
          </div>
        </div>

        {/* Statistiky */}
        <div className="px-3 py-2 border-b border-border space-y-1">
          {[[CableIcon,"Kabely",cables.length],[Network,"Spoje",connections.length],[Building2,"Polygony",buildingPolygons.length]].map(([Icon,label,count]:any) => (
            <div key={label} className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground flex items-center gap-1"><Icon className="h-3 w-3"/>{label}</span>
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
                ["showPolygons",  showPolygons,  setShowPolygons,  "Polygony budov"],
                ["showCables",    showCables,    setShowCables,    "Kabelové trasy"],
                ["showConns",     showConns,     setShowConns,     "Logické spoje"],
              ] as any[]).map(([key,val,setter,label]) => (
                <button key={key} onClick={() => setter((v:boolean) => !v)}
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
              <button onClick={() => setSelectedTypes(new Set())} className="text-[10px] text-muted-foreground hover:text-foreground mb-1">× Zrušit filtr</button>
            )}
            <div className="space-y-0.5">
              {connTypes.map(t => (
                <button key={t.id} onClick={() => toggleType(t.category)}
                  className={cn("w-full flex items-center gap-2 px-2 py-1 rounded text-xs transition-colors",
                    selectedTypes.size === 0 || selectedTypes.has(t.category) ? "text-foreground hover:bg-muted/30" : "text-muted-foreground/40")}>
                  <span className="w-3 h-3 rounded-sm shrink-0" style={{background: t.color}} />
                  {t.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Hlavní obsah */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {view === "map" ? (
          <TopologyMapView
            cables={cables} connections={connections} locations={locations}
            buildingPolygons={buildingPolygons}
            showCables={showCables} showConnections={showConns}
            showLocations={showLocations} showPolygons={showPolygons}
            selectedTypes={selectedTypes}
            editMode={editMode} onEditModeChange={setEditMode}
            onCableRouteDrawn={route => { setPendingRoute(route); setEditMode("none"); }}
            onConnectionDrawn={(a,b) => { setPendingConn({a,b}); setEditMode("none"); }}
            onBuildingPolygonDrawn={(loc,coords) => { setPendingPolygon({loc,coords}); setEditMode("none"); }}
            onBuildingDelete={id => deleteBuildingMutation.mutate(id)}
            onPolygonAction={handlePolygonAction}
            onLocationMoved={(loc, lat, lng) => {
              // Invaliduj cache lokací po přesunutí
              qc.invalidateQueries({ queryKey: ["locations-map"] });
            }}
          />
        ) : (
          <div className="flex-1 overflow-auto p-4">
            <div className="flex gap-1 mb-4 border-b border-border">
              {(["cables","connections","polygons"] as const).map(tab => (
                <button key={tab} onClick={() => setTableTab(tab)}
                  className={cn("px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors",
                    tableTab===tab ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground")}>
                  {tab==="cables" ? "Kabely" : tab==="connections" ? "Spoje" : "Polygony"}
                  <span className="ml-1.5 text-xs bg-muted px-1.5 py-0.5 rounded-full">
                    {tab==="cables" ? cables.length : tab==="connections" ? connections.length : buildingPolygons.length}
                  </span>
                </button>
              ))}
            </div>

            {/* Kabely */}
            {tableTab === "cables" && (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>{["Název","Typ","Medium","Vlákna","Délka","Od → Do","Stav",""].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                    ))}</tr>
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
                            c.cable_type==="fiber" ? "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-400" :
                            c.cable_type==="utp" ? "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-400" :
                            "bg-gray-100 text-gray-700")}>
                            {c.cable_type.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.medium||"—"}</td>
                        <td className="px-3 py-2 text-xs text-center">{c.cable_type==="fiber" ? (c.fiber_count||"—") : "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.length_m ? `${c.length_m} m` : "—"}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.location_a_name||"—"} → {c.location_b_name||"—"}</td>
                        <td className="px-3 py-2 text-xs"><span className={cn("px-1.5 py-0.5 rounded text-[11px]",STATUS_COLORS[c.status]||"")}>{c.status}</span></td>
                        <td className="px-3 py-2">
                          <button onClick={async () => { if (!confirm(`Smazat "${c.name}"?`)) return; try { await deleteCable.mutateAsync(c.id); } catch(e){alert(getErrorMessage(e));} }}
                            className="text-destructive hover:text-destructive/80 p-1"><Trash2 className="h-3.5 w-3.5"/></button>
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
                    <tr>{["Název","Typ","Bod A","Bod B","Kabel","Stav",""].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {connections.length === 0 ? (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground text-xs">
                        Žádné spoje. Použijte tlačítko "Přidat spoj" na mapě.
                      </td></tr>
                    ) : connections.map(c => (
                      <tr key={c.id} className="border-t border-border/50 hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium text-xs">{c.name||"—"}</td>
                        <td className="px-3 py-2 text-xs">
                          {c.type_name ? <span className="flex items-center gap-1">
                            <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{background:c.color||"#888"}}/>
                            {c.type_name}
                          </span> : "—"}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {c.device_a_alias||c.device_a_name||c.location_a_name||"—"}
                          {c.interface_a && <span className="text-[10px] ml-1 font-mono">[{c.interface_a}]</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">
                          {c.device_b_alias||c.device_b_name||c.location_b_name||"—"}
                          {c.interface_b && <span className="text-[10px] ml-1 font-mono">[{c.interface_b}]</span>}
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{c.cable_name||"—"}</td>
                        <td className="px-3 py-2 text-xs"><span className={cn("px-1.5 py-0.5 rounded text-[11px]",STATUS_COLORS[c.status]||"")}>{c.status}</span></td>
                        <td className="px-3 py-2">
                          <button onClick={async () => { if (!confirm(`Smazat spoj?`)) return; try { await deleteConn.mutateAsync(c.id); } catch(e){alert(getErrorMessage(e));} }}
                            className="text-destructive hover:text-destructive/80 p-1"><Trash2 className="h-3.5 w-3.5"/></button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Polygony budov */}
            {tableTab === "polygons" && (
              <div className="rounded-lg border border-border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50">
                    <tr>{["Název","Lokace","Patra","Výška","Barva","Zdroj",""].map(h => (
                      <th key={h} className="px-3 py-2 text-left text-xs font-medium text-muted-foreground">{h}</th>
                    ))}</tr>
                  </thead>
                  <tbody>
                    {buildingPolygons.length === 0 ? (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-muted-foreground text-xs">
                        Žádné polygony. Použijte tlačítko "Nakreslit polygon budovy" na mapě.
                      </td></tr>
                    ) : buildingPolygons.map((bp: any) => (
                      <tr key={bp.id} className="border-t border-border/50 hover:bg-muted/20">
                        <td className="px-3 py-2 font-medium text-xs">{bp.name}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{bp.location_name||"—"}</td>
                        <td className="px-3 py-2 text-xs text-center">{bp.floor_count}</td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{bp.height_m} m</td>
                        <td className="px-3 py-2 text-xs">
                          <span className="flex items-center gap-1.5">
                            <span className="w-4 h-4 rounded shrink-0 border border-border" style={{background:bp.color}}/>
                            <span className="font-mono text-[10px]">{bp.color}</span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-xs text-muted-foreground">{bp.imported_from||"—"}</td>
                        <td className="px-3 py-2">
                          <button onClick={async () => { if (!confirm(`Smazat polygon "${bp.name}"?`)) return; deleteBuildingMutation.mutate(bp.id); }}
                            className="text-destructive hover:text-destructive/80 p-1"><Trash2 className="h-3.5 w-3.5"/></button>
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

      {/* Formuláře */}
      {pendingRoute && (
        <CableForm route={pendingRoute} onSave={handleCableSave}
          onCancel={() => setPendingRoute(null)} isPending={createCable.isPending} />
      )}
      {pendingConn && (
        <ConnectionForm locA={pendingConn.a} locB={pendingConn.b}
          onSave={handleConnSave} onCancel={() => setPendingConn(null)} isPending={createConn.isPending} />
      )}
      {pendingPolygon && (
        <BuildingPolygonForm loc={pendingPolygon.loc} coords={pendingPolygon.coords}
          onSave={handlePolygonSave} onCancel={() => setPendingPolygon(null)} isPending={savingPolygon} />
      )}

      {/* 3D zobrazení budovy */}
      {view3d && (
        <Building3DView
          polygonId={view3d.id}
          polygonName={view3d.name}
          onClose={() => setView3d(null)}
        />
      )}

      {/* Editace vlastností polygonu */}
      {editPolygon && (
        <PolygonPropertiesForm
          polygon={editPolygon}
          locations={locations}
          onSave={async (updated) => {
            try {
              await buildingsApi.update(editPolygon.id, updated);
              qc.invalidateQueries({ queryKey: ["buildings"] });
              qc.invalidateQueries({ queryKey: ["locations-map"] });
              setEditPolygon(null);
            } catch(e: any) {
              const detail = e?.response?.data?.detail;
              const msg = typeof detail === "string" ? detail
                        : Array.isArray(detail) ? detail.map((d:any) => d.msg || JSON.stringify(d)).join(", ")
                        : typeof detail === "object" && detail ? JSON.stringify(detail)
                        : e?.message || String(e);
              alert("Chyba uložení: " + msg);
            }
          }}
          }}
          onCancel={() => setEditPolygon(null)}
        />
      )}
    </div>
  );
}
