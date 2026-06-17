"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { Loader2, X } from "lucide-react";
import { useLocationsMap, useConfigList, useLocations } from "@/hooks/useNetPulse";
import { LocationPanel } from "@/components/locations/LocationPanel";
import type { LocationMapPoint, Location } from "@/lib/types";
import { buildingsApi } from "@/lib/api";

const LocationsMapView = dynamic(
  () => import("@/components/locations/LocationsMapView"),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    ),
  }
);

// ---------------------------------------------------------------------------
// Formulář pro uložení nového polygonu budovy
// ---------------------------------------------------------------------------
function BuildingPolygonForm({
  loc, coords, onSave, onCancel, isPending,
}: {
  loc: LocationMapPoint; coords: [number,number][];
  onSave: (data: any) => void; onCancel: () => void; isPending: boolean;
}) {
  const [name,        setName]        = useState(loc.name);
  const [description, setDescription] = useState("");
  const [floorCount,  setFloorCount]  = useState(3);
  const [floorHeight, setFloorHeight] = useState(3.5);
  const [color,       setColor]       = useState("#3b82f6");
  const [fillOpacity, setFillOpacity] = useState(0.3);

  const totalHeight = +(floorCount * floorHeight).toFixed(1);

  return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-black/40">
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
              className="mt-1 h-9 w-full rounded-md border border-border bg-background px-3 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary/50" />
          </div>
          <div>
            <label className="text-xs font-medium text-muted-foreground">Popis</label>
            <textarea value={description} onChange={e => setDescription(e.target.value)} rows={2}
              placeholder="Volitelný popis budovy"
              className="mt-1 w-full rounded-md border border-border bg-background px-3 py-2 text-sm
                         focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Počet pater</label>
              <input type="number" min={1} max={50} value={floorCount}
                onChange={e => setFloorCount(Math.max(1, Number(e.target.value)))}
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
          <button
            disabled={!name.trim() || isPending}
            onClick={() => onSave({
              name,
              description:   description || null,
              location_id:   loc.id,
              coordinates:   coords.map(p => [p[1], p[0]]),  // [lat,lng] → [lng,lat]
              color,
              fill_opacity:  fillOpacity,
              stroke_color:  color,
              stroke_width:  2,
              height_m:      totalHeight,
              base_height_m: 0,
              floor_count:   floorCount,
              imported_from: "manual",
            })}
            className="flex-1 flex items-center justify-center gap-2 h-9 rounded-md
                       bg-primary text-primary-foreground text-sm font-medium disabled:opacity-50">
            {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            Uložit polygon
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
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function LocationsMapPage() {
  const { data: mapPoints    = [], isLoading } = useLocationsMap();
  const { data: locationTypes = [] }           = useConfigList("location_type", false);
  const { data: allLocations  = [] }           = useLocations(false);

  const [selectedMapPoint, setSelectedMapPoint] = useState<LocationMapPoint | null>(null);
  const [pendingPolygon,   setPendingPolygon]    = useState<{
    loc: LocationMapPoint; coords: [number,number][];
  } | null>(null);
  const [saving, setSaving] = useState(false);

  const selectedLocation = useMemo<Location | null>(() => {
    if (!selectedMapPoint) return null;
    return (allLocations.find(l => l.id === selectedMapPoint.id) ?? null) as Location | null;
  }, [selectedMapPoint, allLocations]);

  async function handleSavePolygon(data: any) {
    setSaving(true);
    try {
      await buildingsApi.create(data);
      setPendingPolygon(null);
    } catch (e: any) {
      alert("Chyba při ukládání polygonu: " + (e?.message || e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 relative">
        <LocationsMapView
          locations={mapPoints}
          locationTypes={locationTypes}
          isLoading={isLoading}
          onSelectLocation={loc => setSelectedMapPoint(loc)}
          selectedId={selectedMapPoint?.id ?? null}
          onBuildingPolygonDrawn={(loc, coords) => setPendingPolygon({ loc, coords })}
        />
      </div>

      {selectedLocation && (
        <div className="w-[520px] shrink-0 border-l border-border overflow-hidden flex flex-col">
          <LocationPanel
            location={selectedLocation}
            onClose={() => setSelectedMapPoint(null)}
          />
        </div>
      )}

      {pendingPolygon && (
        <BuildingPolygonForm
          loc={pendingPolygon.loc}
          coords={pendingPolygon.coords}
          onSave={handleSavePolygon}
          onCancel={() => setPendingPolygon(null)}
          isPending={saving}
        />
      )}
    </div>
  );
}
