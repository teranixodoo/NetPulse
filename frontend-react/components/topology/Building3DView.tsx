"use client";

import { useEffect, useRef, useState } from "react";
import { buildingsApi } from "@/lib/api";
import { ArrowLeft, Loader2, Building2, Monitor } from "lucide-react";
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Barvy pater — každé patro má jinou barvu
// ---------------------------------------------------------------------------
const FLOOR_COLORS = [
  "#3b82f6", // přízemí — modrá
  "#22c55e", // 1. NP — zelená
  "#f59e0b", // 2. NP — žlutá
  "#ef4444", // 3. NP — červená
  "#8b5cf6", // 4. NP — fialová
  "#06b6d4", // 5. NP — cyan
  "#f97316", // 6. NP — oranžová
  "#ec4899", // 7. NP — růžová
];

function floorColor(floorIndex: number): string {
  return FLOOR_COLORS[floorIndex % FLOOR_COLORS.length];
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
interface Props {
  polygonId: number;
  polygonName: string;
  onClose: () => void;
}

interface Floor {
  id: number;
  name: string;
  type: string;
  floor_level: number | null;
  height_m: number | null;
  depth: number;
  total_devices: number;
  online_count: number;
}

interface Device {
  id: number;
  hostname: string;
  alias: string | null;
  device_type: string;
  location_name: string;
  floor_level: number | null;
}

interface Building3DData {
  polygon: {
    id: number;
    name: string;
    description: string | null;
    height_m: number;
    floor_count: number;
    color: string;
    coordinates: [number, number][];
    location_name: string | null;
  };
  floors: Floor[];
  devices: Device[];
}

// ---------------------------------------------------------------------------
// Komponenta
// ---------------------------------------------------------------------------
export default function Building3DView({ polygonId, polygonName, onClose }: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef    = useRef<any>(null);
  const [data,    setData]    = useState<Building3DData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error,   setError]   = useState<string | null>(null);
  const [activeFloor, setActiveFloor] = useState<number | null>(null);

  // Načti data pro 3D
  useEffect(() => {
    buildingsApi.get3d(polygonId)
      .then(setData)
      .catch(e => setError(e?.message || "Chyba načítání"))
      .finally(() => setLoading(false));
  }, [polygonId]);

  // Inicializuj MapLibre GL po načtení dat
  useEffect(() => {
    if (!data || !mapDivRef.current || mapRef.current) return;

    let map: any;

    import("maplibre-gl").then(({ default: maplibregl }) => {
      // Střed budovy z polygonu
      const coords = data.polygon.coordinates;
      const centerLng = coords.reduce((s, c) => s + c[0], 0) / coords.length;
      const centerLat = coords.reduce((s, c) => s + c[1], 0) / coords.length;

      map = new maplibregl.Map({
        container: mapDivRef.current!,
        style: {
          version: 8,
          sources: {
            osm: {
              type: "raster",
              tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
              tileSize: 256,
              attribution: "© OpenStreetMap contributors",
            },
          },
          layers: [{ id: "osm", type: "raster", source: "osm" }],
        },
        center:  [centerLng, centerLat],
        zoom:    18,
        pitch:   55,
        bearing: -20,
        maxZoom: 24,
        antialias: true,
      });

      mapRef.current = map;

      map.on("load", () => {
        const floorHeight = data.polygon.height_m / data.polygon.floor_count;

        // Polygon souřadnice jako GeoJSON (uzavřený ring)
        const ring = [...coords.map(c => [c[0], c[1]]), coords[0]];

        // Přidej vrstvu pro každé patro
        for (let i = 0; i < data.polygon.floor_count; i++) {
          const base = i * floorHeight;
          const top  = base + floorHeight;
          const color = floorColor(i);
          const sourceId = `floor-${i}`;
          const layerId  = `floor-extrusion-${i}`;

          map.addSource(sourceId, {
            type: "geojson",
            data: {
              type: "Feature",
              geometry: { type: "Polygon", coordinates: [ring] },
              properties: {
                height:      top,
                base_height: base,
                color,
                floor:       i,
              },
            },
          });

          map.addLayer({
            id:     layerId,
            type:   "fill-extrusion",
            source: sourceId,
            paint: {
              "fill-extrusion-height":  top,
              "fill-extrusion-base":    base,
              "fill-extrusion-color":   color,
              "fill-extrusion-opacity": activeFloor === null || activeFloor === i ? 0.85 : 0.25,
            },
          });
        }

        // Markery zařízení
        if (maplibregl) {
          data.devices.forEach(dev => {
            const floorIdx = dev.floor_level ?? 0;
            const heightM  = (floorIdx + 0.5) * floorHeight; // střed patra
            // MapLibre neumí 3D markery přímo — zobrazíme je jako HTML markery
            const el = document.createElement("div");
            el.innerHTML = `
              <div style="
                background:${floorColor(floorIdx)};color:white;
                border:2px solid white;border-radius:50%;
                width:22px;height:22px;
                display:flex;align-items:center;justify-content:center;
                font-size:11px;cursor:pointer;
                box-shadow:0 2px 4px rgba(0,0,0,0.4);
                title='${dev.alias || dev.hostname}';
              ">💻</div>
            `;
            el.title = dev.alias || dev.hostname;
            // Pozice zařízení — střed budovy s malým offsetem
            const offsetLng = centerLng + (Math.random() - 0.5) * 0.0001;
            const offsetLat = centerLat + (Math.random() - 0.5) * 0.0001;
            new maplibregl.Marker({ element: el })
              .setLngLat([offsetLng, offsetLat])
              .setPopup(new maplibregl.Popup({ offset: 12 }).setHTML(
                `<div style="font-size:12px;">
                  <b>${dev.alias || dev.hostname}</b><br>
                  ${dev.device_type || ""}<br>
                  <span style="color:#64748b">${dev.location_name}</span>
                </div>`
              ))
              .addTo(map);
          });
        }
      });
    });

    return () => {
      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [data]);

  // Zvýraznění patra po kliknutí
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    const floorHeight = data.polygon.height_m / data.polygon.floor_count;
    for (let i = 0; i < data.polygon.floor_count; i++) {
      const layerId = `floor-extrusion-${i}`;
      if (map.getLayer(layerId)) {
        map.setPaintProperty(layerId, "fill-extrusion-opacity",
          activeFloor === null || activeFloor === i ? 0.85 : 0.25
        );
      }
    }
  }, [activeFloor, data]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-background/80">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Načítám 3D data budovy…</p>
      </div>
    </div>
  );

  if (error) return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-background/80">
      <div className="bg-background border border-border rounded-lg p-6 text-center max-w-sm">
        <p className="text-destructive font-medium mb-2">Chyba načítání</p>
        <p className="text-sm text-muted-foreground mb-4">{error}</p>
        <button onClick={onClose} className="px-4 py-2 rounded-md bg-primary text-primary-foreground text-sm">Zavřít</button>
      </div>
    </div>
  );

  const floorCount  = data?.polygon.floor_count ?? 0;
  const floorHeight = (data?.polygon.height_m ?? 0) / Math.max(floorCount, 1);

  return (
    <div className="fixed inset-0 z-[3000] flex flex-col bg-background">

      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border bg-card shrink-0">
        <button onClick={onClose}
          className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Zpět na 2D
        </button>
        <div className="w-px h-5 bg-border" />
        <Building2 className="h-4 w-4 text-primary" />
        <span className="font-semibold text-sm">{data?.polygon.name}</span>
        {data?.polygon.description && (
          <span className="text-xs text-muted-foreground">{data.polygon.description}</span>
        )}
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>{floorCount} pater · {data?.polygon.height_m} m</span>
          <span>{data?.devices.length} zařízení</span>
        </div>
      </div>

      <div className="flex flex-1 overflow-hidden">

        {/* 3D Mapa */}
        <div ref={mapDivRef} className="flex-1" />

        {/* Pravý panel — patra + zařízení */}
        <div className="w-52 shrink-0 border-l border-border bg-card overflow-y-auto flex flex-col">

          {/* Legenda pater */}
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Patra
            </p>
            <div className="space-y-1">
              {/* Všechna patra button */}
              <button
                onClick={() => setActiveFloor(null)}
                className={cn("w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
                  activeFloor === null ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted/50")}>
                <span className="w-3 h-3 rounded-sm shrink-0 bg-gradient-to-b from-blue-400 to-yellow-400" />
                Všechna patra
              </button>
              {Array.from({ length: floorCount }, (_, i) => {
                const floorDevices = data?.devices.filter(d => (d.floor_level ?? 0) === i) ?? [];
                const label = i === 0 ? "Přízemí" : `${i}. NP`;
                const base  = +(i * floorHeight).toFixed(1);
                const top   = +(base + floorHeight).toFixed(1);
                return (
                  <button key={i}
                    onClick={() => setActiveFloor(activeFloor === i ? null : i)}
                    className={cn("w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
                      activeFloor === i ? "bg-primary/10 text-primary font-medium" : "text-muted-foreground hover:bg-muted/50")}>
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background: floorColor(i) }} />
                    <span className="flex-1 text-left">{label}</span>
                    <span className="text-[10px] text-muted-foreground">{floorDevices.length}🖥️</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Zařízení */}
          <div className="px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Zařízení ({data?.devices.length})
            </p>
            {data?.devices.length === 0 ? (
              <p className="text-xs text-muted-foreground">Žádná zařízení</p>
            ) : (
              <div className="space-y-1">
                {data?.devices
                  .filter(d => activeFloor === null || (d.floor_level ?? 0) === activeFloor)
                  .map(dev => (
                    <div key={dev.id}
                      className="flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-muted/30">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0"
                        style={{ background: floorColor(dev.floor_level ?? 0) }} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{dev.alias || dev.hostname}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{dev.location_name}</p>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {/* Nápověda ovládání */}
          <div className="mt-auto px-3 py-3 border-t border-border">
            <p className="text-[10px] text-muted-foreground space-y-0.5">
              <span className="block">🖱️ Tažení = rotace</span>
              <span className="block">⚲ Kolečko = zoom</span>
              <span className="block">Ctrl+tažení = náklon</span>
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
