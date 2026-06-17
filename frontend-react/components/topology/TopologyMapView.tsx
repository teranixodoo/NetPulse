"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import L from "leaflet";
import type { Cable, TopologyConnection, LocationMapPoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Pencil, X, Check, Undo2, MapPin } from "lucide-react";

// ---------------------------------------------------------------------------
// Tile vrstvy
// ---------------------------------------------------------------------------
const TILE_LAYERS = {
  map: {
    label: "🗺️ Mapa",
    url:   "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom: 22, maxNativeZoom: 19,
  },
  satellite: {
    label: "🛰️ Satelit",
    url:   "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: '&copy; Esri',
    maxZoom: 23, maxNativeZoom: 23,
  },
} as const;
type TileKey = keyof typeof TILE_LAYERS;

const DEFAULT_CENTER: [number, number] = [49.1970767, 16.6185331];
const DEFAULT_ZOOM = 14;

function dashArray(style: string): string | undefined {
  if (style === "dashed") return "10 5";
  if (style === "dotted") return "3 6";
  return undefined;
}

function fixIcons() {
  // @ts-ignore
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    iconSize: [25, 41], iconAnchor: [12, 41], popupAnchor: [1, -34], shadowSize: [41, 41],
  });
}

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------
export type EditMode = "none" | "draw_cable" | "draw_connection";

interface Props {
  cables:          Cable[];
  connections:     TopologyConnection[];
  locations:       LocationMapPoint[];
  showCables:      boolean;
  showConnections: boolean;
  showLocations:   boolean;
  selectedTypes:   Set<string>;
  editMode:        EditMode;
  onEditModeChange: (mode: EditMode) => void;
  onCableRouteDrawn: (route: [number, number][]) => void;
  onConnectionDrawn: (locA: LocationMapPoint, locB: LocationMapPoint) => void;
}

// ---------------------------------------------------------------------------
// Komponenta
// ---------------------------------------------------------------------------
export default function TopologyMapView({
  cables, connections, locations,
  showCables, showConnections, showLocations, selectedTypes,
  editMode, onEditModeChange, onCableRouteDrawn, onConnectionDrawn,
}: Props) {
  const mapDivRef   = useRef<HTMLDivElement>(null);
  const mapRef      = useRef<L.Map | null>(null);
  const tileRef     = useRef<L.TileLayer | null>(null);
  const layersRef   = useRef<L.Layer[]>([]);
  const drawRef     = useRef<{
    points:  [number, number][];
    markers: L.CircleMarker[];
    line:    L.Polyline | null;
    preview: L.Polyline | null;
    connStep: number;
    connA:   LocationMapPoint | null;
  }>({ points: [], markers: [], line: null, preview: null, connStep: 0, connA: null });

  const [activeLayer, setActiveLayer] = useState<TileKey>("map");
  const [selected,    setSelected]    = useState<any>(null);
  const [drawPoints,  setDrawPoints]  = useState<[number, number][]>([]);
  const [hint,        setHint]        = useState<string>("");

  // ---------------------------------------------------------------------------
  // Inicializace mapy
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    fixIcons();
    const map = L.map(mapDivRef.current, {
      center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, maxZoom: 23,
    });
    const cfg = TILE_LAYERS["map"];
    tileRef.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution, maxZoom: cfg.maxZoom, maxNativeZoom: cfg.maxNativeZoom,
    }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Přepínání tile vrstvy
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    const cfg = TILE_LAYERS[activeLayer];
    tileRef.current = L.tileLayer(cfg.url, {
      attribution: cfg.attribution, maxZoom: cfg.maxZoom, maxNativeZoom: cfg.maxNativeZoom,
    }).addTo(map);
  }, [activeLayer]);

  // ---------------------------------------------------------------------------
  // Editační mód — klikání do mapy
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Vyčisti draw stav
    const dr = drawRef.current;
    dr.markers.forEach(m => map.removeLayer(m));
    dr.markers = [];
    if (dr.line)    { map.removeLayer(dr.line);    dr.line    = null; }
    if (dr.preview) { map.removeLayer(dr.preview); dr.preview = null; }
    dr.points = []; dr.connStep = 0; dr.connA = null;
    setDrawPoints([]);

    if (editMode === "none") {
      map.off("click");
      map.off("mousemove");
      map.getContainer().style.cursor = "";
      setHint("");
      return;
    }

    map.getContainer().style.cursor = "crosshair";

    if (editMode === "draw_cable") {
      setHint("Klikejte na mapu pro přidání bodů trasy. Dvojklik = ukončit.");

      map.on("click", (e: L.LeafletMouseEvent) => {
        const pt: [number, number] = [e.latlng.lat, e.latlng.lng];
        dr.points.push(pt);
        setDrawPoints([...dr.points]);

        // Marker bodu
        const m = L.circleMarker(pt, {
          radius: 5, color: "#f97316", fillColor: "#f97316",
          fillOpacity: 1, weight: 2,
        }).addTo(map);
        m.bindTooltip(`Bod ${dr.points.length}`, { permanent: false });
        dr.markers.push(m);

        // Aktualizuj čáru
        if (dr.line) map.removeLayer(dr.line);
        if (dr.points.length >= 2) {
          dr.line = L.polyline(dr.points, {
            color: "#f97316", weight: 3, opacity: 0.8, dashArray: "6 4",
          }).addTo(map);
        }
      });

      map.on("dblclick", (e: L.LeafletMouseEvent) => {
        e.originalEvent.preventDefault();
        if (dr.points.length < 2) {
          alert("Trasa musí mít alespoň 2 body.");
          return;
        }
        onCableRouteDrawn([...dr.points]);
        onEditModeChange("none");
      });

      map.on("mousemove", (e: L.LeafletMouseEvent) => {
        if (dr.points.length === 0) return;
        const last = dr.points[dr.points.length - 1];
        const cur: [number, number] = [e.latlng.lat, e.latlng.lng];
        if (dr.preview) map.removeLayer(dr.preview);
        dr.preview = L.polyline([last, cur], {
          color: "#f97316", weight: 2, opacity: 0.5, dashArray: "4 4",
        }).addTo(map);
      });
    }

    if (editMode === "draw_connection") {
      setHint("Klikněte na první lokaci (bod A).");
      dr.connStep = 1;

      map.on("click", (e: L.LeafletMouseEvent) => {
        // Najdi nejbližší lokaci do 100px
        const pt = e.latlng;
        let closest: LocationMapPoint | null = null;
        let minDist = Infinity;
        for (const loc of locations) {
          if (!loc.lat || !loc.lng) continue;
          const d = map.latLngToContainerPoint(L.latLng(loc.lat, loc.lng))
                       .distanceTo(map.latLngToContainerPoint(pt));
          if (d < 60 && d < minDist) { minDist = d; closest = loc; }
        }

        if (!closest) {
          setHint(dr.connStep === 1
            ? "Žádná lokace nenalezena — klikněte blíže k lokaci (bod A)."
            : "Žádná lokace nenalezena — klikněte blíže k lokaci (bod B).");
          return;
        }

        if (dr.connStep === 1) {
          const loc = closest as LocationMapPoint;
          dr.connA = loc;
          dr.connStep = 2;
          // Zvýrazni bod A
          const m = L.circleMarker([loc.lat!, loc.lng!], {
            radius: 8, color: "#22c55e", fillColor: "#22c55e",
            fillOpacity: 0.8, weight: 2,
          }).addTo(map);
          dr.markers.push(m);
          setHint(`Bod A: ${loc.name}. Nyní klikněte na cílovou lokaci (bod B).`);
        } else if (dr.connStep === 2 && dr.connA) {
          const loc = closest as LocationMapPoint;
          if (loc.id === dr.connA.id) {
            setHint("Bod B musí být jiná lokace než bod A.");
            return;
          }
          // Zvýrazni bod B
          const m = L.circleMarker([loc.lat!, loc.lng!], {
            radius: 8, color: "#ef4444", fillColor: "#ef4444",
            fillOpacity: 0.8, weight: 2,
          }).addTo(map);
          dr.markers.push(m);
          onConnectionDrawn(dr.connA, loc);
          onEditModeChange("none");
        }
      });
    }

    return () => {
      map.off("click");
      map.off("dblclick");
      map.off("mousemove");
      map.getContainer().style.cursor = "";
    };
  }, [editMode, locations]);

  // ---------------------------------------------------------------------------
  // Undo posledního bodu trasy
  // ---------------------------------------------------------------------------
  function undoLastPoint() {
    const map = mapRef.current;
    const dr  = drawRef.current;
    if (!map || dr.points.length === 0) return;
    const last = dr.markers.pop();
    if (last) map.removeLayer(last);
    dr.points.pop();
    setDrawPoints([...dr.points]);
    if (dr.line) { map.removeLayer(dr.line); dr.line = null; }
    if (dr.points.length >= 2) {
      dr.line = L.polyline(dr.points, {
        color: "#f97316", weight: 3, opacity: 0.8, dashArray: "6 4",
      }).addTo(map);
    }
  }

  // Potvrdit trasu (alternativa k double-click)
  function confirmRoute() {
    const dr = drawRef.current;
    if (dr.points.length < 2) { alert("Trasa musí mít alespoň 2 body."); return; }
    onCableRouteDrawn([...dr.points]);
    onEditModeChange("none");
  }

  // ---------------------------------------------------------------------------
  // Vykreslení datových vrstev
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.forEach(l => map.removeLayer(l));
    layersRef.current = [];

    // Lokace
    if (showLocations) {
      locations.forEach(loc => {
        if (!loc.lat || !loc.lng) return;
        const isHighlighted = editMode === "draw_connection";
        const marker = L.circleMarker([loc.lat, loc.lng], {
          radius: isHighlighted ? 8 : 6,
          color:       isHighlighted ? "#22c55e" : "#3b82f6",
          fillColor:   isHighlighted ? "#22c55e" : "#3b82f6",
          fillOpacity: isHighlighted ? 0.9 : 0.8,
          weight: isHighlighted ? 2.5 : 2,
        }).addTo(map);
        marker.bindTooltip(loc.name, { direction: "top", offset: [0, -6] });
        layersRef.current.push(marker);
      });
    }

    // Kabely
    if (showCables) {
      cables.forEach(cable => {
        if (!cable.route || cable.route.length < 2) return;
        const latlngs = cable.route.map(c => [c[1], c[0]] as [number, number]);
        const color = cable.cable_type === "fiber" ? "#eab308"
                    : cable.cable_type === "coax"  ? "#78716c" : "#3b82f6";
        const line = L.polyline(latlngs, {
          color, weight: 3, opacity: 0.85,
          dashArray: cable.status === "planned" ? "6 4" : undefined,
        }).addTo(map);
        line.bindTooltip(
          `<b>${cable.name}</b><br>${cable.cable_type.toUpperCase()}` +
          (cable.medium ? ` · ${cable.medium}` : "") +
          (cable.length_m ? `<br>${cable.length_m} m` : "") +
          (cable.fiber_count ? `<br>${cable.fiber_count} vláken` : ""),
          { sticky: true }
        );
        line.on("click", () => setSelected({ type: "cable", data: cable }));
        layersRef.current.push(line);
        [latlngs[0], latlngs[latlngs.length - 1]].forEach(pt => {
          const dot = L.circleMarker(pt, {
            radius: 4, color, fillColor: color, fillOpacity: 1, weight: 1,
          }).addTo(map);
          layersRef.current.push(dot);
        });
      });
    }

    // Logické spoje
    if (showConnections) {
      connections.forEach(conn => {
        if (!conn.category) return;
        if (selectedTypes.size > 0 && !selectedTypes.has(conn.category)) return;
        const locA = conn.location_a_id ? locations.find(l => l.id === conn.location_a_id) : null;
        const locB = conn.location_b_id ? locations.find(l => l.id === conn.location_b_id) : null;
        if (!locA?.lat || !locA?.lng || !locB?.lat || !locB?.lng) return;

        const color = conn.color || "#6366f1";
        const line = L.polyline(
          [[locA.lat, locA.lng], [locB.lat, locB.lng]],
          { color, weight: conn.category === "wireless" ? 2 : 3, opacity: 0.9,
            dashArray: dashArray(conn.dash_style || "solid") }
        ).addTo(map);
        const labelA = conn.device_a_alias || conn.device_a_name || conn.location_a_name || "A";
        const labelB = conn.device_b_alias || conn.device_b_name || conn.location_b_name || "B";
        line.bindTooltip(
          `<b>${conn.name || conn.type_name || "Spoj"}</b><br>${labelA} ↔ ${labelB}` +
          (conn.interface_a ? `<br>${conn.interface_a} → ${conn.interface_b}` : "") +
          (conn.current_snr_db != null ? `<br>SNR: ${conn.current_snr_db} dB` : "") +
          (conn.distance_m ? `<br>${Math.round(conn.distance_m)} m` : ""),
          { sticky: true }
        );
        line.on("click", () => setSelected({ type: "connection", data: conn }));
        layersRef.current.push(line);

        // WiFi azimut šipky
        if (conn.category === "wireless" && conn.azimuth_a != null) {
          [
            { loc: locA, az: conn.azimuth_a, label: labelA },
            { loc: locB, az: conn.azimuth_b ?? 0, label: labelB },
          ].forEach(({ loc, az, label }) => {
            const icon = L.divIcon({
              className: "",
              html: `<div style="transform:rotate(${az}deg);font-size:18px;line-height:1;filter:drop-shadow(0 1px 2px rgba(0,0,0,.5))">▲</div>`,
              iconSize: [18, 18], iconAnchor: [9, 9],
            });
            const m = L.marker([loc.lat!, loc.lng!], { icon, zIndexOffset: 500 }).addTo(map);
            m.bindTooltip(`${label}<br>Azimut: ${az}°`, { direction: "top" });
            layersRef.current.push(m);
          });
        }
      });
    }
  }, [cables, connections, locations, showCables, showConnections, showLocations, selectedTypes, editMode]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="relative flex-1 h-full">

      {/* Tile přepínač */}
      <div className="absolute top-3 right-3 z-[1000] flex rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow overflow-hidden">
        {(Object.keys(TILE_LAYERS) as TileKey[]).map(key => (
          <button key={key} onClick={() => setActiveLayer(key)}
            className={cn("px-3 py-1.5 text-xs font-medium transition-colors",
              activeLayer === key ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}>
            {TILE_LAYERS[key].label}
          </button>
        ))}
      </div>

      {/* Editační toolbar */}
      <div className="absolute top-3 left-3 z-[1000] flex gap-1.5">
        {editMode === "none" ? (
          <>
            <button
              onClick={() => onEditModeChange("draw_cable")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border
                         bg-background/95 backdrop-blur-sm shadow text-xs font-medium
                         hover:bg-primary hover:text-primary-foreground transition-colors">
              <Pencil className="h-3.5 w-3.5" /> Kreslit trasu kabelu
            </button>
            <button
              onClick={() => onEditModeChange("draw_connection")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border
                         bg-background/95 backdrop-blur-sm shadow text-xs font-medium
                         hover:bg-primary hover:text-primary-foreground transition-colors">
              <MapPin className="h-3.5 w-3.5" /> Přidat spoj
            </button>
          </>
        ) : (
          <div className="flex items-center gap-1.5 bg-background/95 backdrop-blur-sm
                          border border-amber-400 rounded-lg shadow px-2 py-1">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              ✏️ {editMode === "draw_cable" ? "Kreslení trasy" : "Výběr spoje"}
            </span>
            {editMode === "draw_cable" && drawPoints.length > 0 && (
              <>
                <span className="text-xs text-muted-foreground ml-1">
                  {drawPoints.length} {drawPoints.length === 1 ? "bod" : "body"}
                </span>
                <button onClick={undoLastPoint}
                  className="p-1 text-muted-foreground hover:text-foreground" title="Vrátit poslední bod">
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
                <button onClick={confirmRoute}
                  className="flex items-center gap-1 h-6 px-2 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700">
                  <Check className="h-3 w-3" /> Potvrdit
                </button>
              </>
            )}
            <button onClick={() => onEditModeChange("none")}
              className="p-1 text-muted-foreground hover:text-destructive ml-1" title="Zrušit">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Hint pro uživatele */}
      {hint && editMode !== "none" && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-[1000]
                        bg-background/95 backdrop-blur-sm border border-border
                        rounded-lg shadow px-4 py-2 text-xs text-foreground max-w-sm text-center">
          {hint}
          {editMode === "draw_cable" && <span className="block text-muted-foreground mt-0.5">Dvojklik nebo tlačítko Potvrdit = ukončit trasu</span>}
        </div>
      )}

      {/* Mapa */}
      <div ref={mapDivRef} className="w-full h-full" />

      {/* Detail vybraného objektu */}
      {selected && editMode === "none" && (
        <div className="absolute bottom-4 left-4 z-[1000] bg-background/95 backdrop-blur-sm
                        border border-border rounded-lg shadow-lg p-4 max-w-xs text-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-foreground">
              {selected.type === "cable" ? "📦 Kabel" : "🔗 Spoj"}
            </span>
            <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
          </div>
          {selected.type === "cable" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name}</span></p>
              <p>Typ: {selected.data.cable_type.toUpperCase()}{selected.data.medium ? ` · ${selected.data.medium}` : ""}</p>
              {selected.data.fiber_count && <p>Vlákna: {selected.data.fiber_count}</p>}
              {selected.data.length_m && <p>Délka: {selected.data.length_m} m</p>}
              <p>Stav: <span className={selected.data.status === "active" ? "text-green-500" : "text-amber-500"}>{selected.data.status}</span></p>
              {selected.data.location_a_name && <p>Od: {selected.data.location_a_name}</p>}
              {selected.data.location_b_name && <p>Do: {selected.data.location_b_name}</p>}
              {selected.data.notes && <p className="italic">{selected.data.notes}</p>}
            </div>
          )}
          {selected.type === "connection" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name || selected.data.type_name}</span></p>
              <p>Typ: {selected.data.type_name}</p>
              {selected.data.device_a_name && <p>A: {selected.data.device_a_alias || selected.data.device_a_name}{selected.data.interface_a ? ` [${selected.data.interface_a}]` : ""}</p>}
              {selected.data.device_b_name && <p>B: {selected.data.device_b_alias || selected.data.device_b_name}{selected.data.interface_b ? ` [${selected.data.interface_b}]` : ""}</p>}
              {selected.data.distance_m && <p>Vzdálenost: {Math.round(selected.data.distance_m)} m</p>}
              {selected.data.current_snr_db != null && <p>SNR: {selected.data.current_snr_db} dB</p>}
              {selected.data.frequency_ghz && <p>Frekvence: {selected.data.frequency_ghz} GHz</p>}
              <p>Stav: <span className={selected.data.status === "active" ? "text-green-500" : "text-amber-500"}>{selected.data.status}</span></p>
              {selected.data.notes && <p className="italic">{selected.data.notes}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
