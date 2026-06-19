"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { Cable, TopologyConnection, LocationMapPoint } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Pencil, X, Check, Undo2, MapPin, Building2 } from "lucide-react";

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

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------
export type EditMode =
  | "none"
  | "draw_cable"
  | "draw_connection"
  | "draw_polygon"
  | "edit_polygon";

interface BuildingPolygon {
  id:           number;
  name:         string;
  description:  string | null;
  location_id:  number | null;
  coordinates:  [number, number][];  // [lng, lat]
  color:        string;
  fill_opacity: number;
  stroke_color: string;
  stroke_width: number;
  height_m:     number;
  floor_count:  number;
  location_name?: string;
}

interface Props {
  cables:           Cable[];
  connections:      TopologyConnection[];
  locations:        LocationMapPoint[];
  buildingPolygons: BuildingPolygon[];
  showCables:       boolean;
  showConnections:  boolean;
  showLocations:    boolean;
  showPolygons:     boolean;
  selectedTypes:    Set<string>;
  editMode:         EditMode;
  onEditModeChange:       (mode: EditMode) => void;
  onCableRouteDrawn:      (route: [number, number][]) => void;
  onConnectionDrawn:      (locA: LocationMapPoint, locB: LocationMapPoint) => void;
  onBuildingPolygonDrawn: (loc: LocationMapPoint, coords: [number, number][]) => void;
  onBuildingDelete:       (id: number) => void;
}

// ---------------------------------------------------------------------------
// Komponenta
// ---------------------------------------------------------------------------
export default function TopologyMapView({
  cables, connections, locations, buildingPolygons,
  showCables, showConnections, showLocations, showPolygons,
  selectedTypes,
  editMode, onEditModeChange,
  onCableRouteDrawn, onConnectionDrawn,
  onBuildingPolygonDrawn, onBuildingDelete,
}: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef    = useRef<L.Map | null>(null);
  const tileRef   = useRef<L.TileLayer | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  // Draw state pro všechny módy
  const drawRef = useRef<{
    // Kabel draw
    points:   [number, number][];
    markers:  L.CircleMarker[];
    line:     L.Polyline | null;
    preview:  L.Polyline | null;
    // Connection draw
    connStep: number;
    connA:    LocationMapPoint | null;
    // Polygon draw
    polyLoc:  LocationMapPoint | null;
    polyPts:  [number, number][];
    polyMkrs: L.CircleMarker[];
    polyLine: L.Polyline | null;
    polyPrev: L.Polyline | null;
    polyPoly: L.Polygon | null;
  }>({ points: [], markers: [], line: null, preview: null,
       connStep: 0, connA: null,
       polyLoc: null, polyPts: [], polyMkrs: [], polyLine: null, polyPrev: null, polyPoly: null });

  const [activeLayer, setActiveLayer]   = useState<TileKey>("map");
  const [selected,    setSelected]      = useState<any>(null);
  const [drawPoints,  setDrawPoints]    = useState<[number, number][]>([]);
  const [polyPoints,  setPolyPoints]    = useState<[number, number][]>([]);
  const [polyLoc,     setPolyLoc]       = useState<LocationMapPoint | null>(null);
  const [hint,        setHint]          = useState("");

  // ---------------------------------------------------------------------------
  // Inicializace mapy
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
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

  // Tile přepínání
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
  // Edit mód — click handlery
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const dr = drawRef.current;

    // Vyčisti vše
    const clearDraw = () => {
      dr.markers.forEach(m => map.removeLayer(m)); dr.markers = [];
      dr.polyMkrs.forEach(m => map.removeLayer(m)); dr.polyMkrs = [];
      if (dr.line)    { map.removeLayer(dr.line);    dr.line    = null; }
      if (dr.preview) { map.removeLayer(dr.preview); dr.preview = null; }
      if (dr.polyLine){ map.removeLayer(dr.polyLine); dr.polyLine= null; }
      if (dr.polyPrev){ map.removeLayer(dr.polyPrev); dr.polyPrev= null; }
      if (dr.polyPoly){ map.removeLayer(dr.polyPoly); dr.polyPoly= null; }
      dr.points = []; dr.polyPts = []; dr.connStep = 0; dr.connA = null; dr.polyLoc = null;
      setDrawPoints([]); setPolyPoints([]); setPolyLoc(null);
    };

    map.off("click"); map.off("dblclick"); map.off("mousemove");
    clearDraw();
    map.getContainer().style.cursor = editMode !== "none" ? "crosshair" : "";
    setHint("");

    if (editMode === "none") return;

    // --- Kabelová trasa ---
    if (editMode === "draw_cable") {
      setHint("Klikejte pro body trasy · Dvojklik nebo Potvrdit = ukončit");

      map.on("click", (e: L.LeafletMouseEvent) => {
        const pt: [number, number] = [e.latlng.lat, e.latlng.lng];
        dr.points.push(pt);
        setDrawPoints([...dr.points]);
        const m = L.circleMarker(pt, { radius: 5, color: "#f97316", fillColor: "#f97316", fillOpacity: 1, weight: 2 }).addTo(map);
        dr.markers.push(m);
        if (dr.line) map.removeLayer(dr.line);
        if (dr.points.length >= 2)
          dr.line = L.polyline(dr.points, { color: "#f97316", weight: 3, opacity: 0.8, dashArray: "6 4" }).addTo(map);
      });

      map.on("dblclick", (e: L.LeafletMouseEvent) => {
        e.originalEvent.preventDefault();
        if (dr.points.length < 2) { alert("Trasa musí mít alespoň 2 body."); return; }
        onCableRouteDrawn([...dr.points]);
        onEditModeChange("none");
      });

      map.on("mousemove", (e: L.LeafletMouseEvent) => {
        if (dr.points.length === 0) return;
        const last = dr.points[dr.points.length - 1];
        if (dr.preview) map.removeLayer(dr.preview);
        dr.preview = L.polyline([last, [e.latlng.lat, e.latlng.lng]], {
          color: "#f97316", weight: 2, opacity: 0.5, dashArray: "4 4",
        }).addTo(map);
      });
    }

    // --- Spoj (výběr dvou lokací) ---
    if (editMode === "draw_connection") {
      setHint("Klikněte na lokaci A (zelená).");
      dr.connStep = 1;

      map.on("click", (e: L.LeafletMouseEvent) => {
        const pt = e.latlng;
        let closest: LocationMapPoint | null = null;
        let minDist = Infinity;
        for (const loc of locations) {
          if (!loc.lat || !loc.lng) continue;
          const d = map.latLngToContainerPoint(L.latLng(loc.lat, loc.lng))
                       .distanceTo(map.latLngToContainerPoint(pt));
          if (d < 60 && d < minDist) { minDist = d; closest = loc; }
        }
        if (!closest) { setHint("Klikněte blíže k lokaci."); return; }
        const loc = closest as LocationMapPoint;

        if (dr.connStep === 1) {
          dr.connA = loc; dr.connStep = 2;
          const m = L.circleMarker([loc.lat, loc.lng], { radius: 9, color: "#22c55e", fillColor: "#22c55e", fillOpacity: 0.8, weight: 2 }).addTo(map);
          dr.markers.push(m);
          setHint(`A: ${loc.name} · Nyní klikněte na cílovou lokaci (B).`);
        } else if (dr.connStep === 2 && dr.connA) {
          if (loc.id === dr.connA.id) { setHint("Bod B musí být jiná lokace."); return; }
          const m = L.circleMarker([loc.lat, loc.lng], { radius: 9, color: "#ef4444", fillColor: "#ef4444", fillOpacity: 0.8, weight: 2 }).addTo(map);
          dr.markers.push(m);
          onConnectionDrawn(dr.connA, loc);
          onEditModeChange("none");
        }
      });
    }

    // --- Polygon budovy ---
    if (editMode === "draw_polygon") {
      setHint("Klikněte na lokaci typu Budova pro výběr.");

      map.on("click", (e: L.LeafletMouseEvent) => {
        // Krok 1: Pokud nemáme vybranou lokaci — vyber budovu z blízkosti
        if (!dr.polyLoc) {
          const pt = e.latlng;
          let closest: LocationMapPoint | null = null;
          let minDist = Infinity;
          for (const loc of locations) {
            if (loc.type !== "building" || !loc.lat || !loc.lng) continue;
            const d = map.latLngToContainerPoint(L.latLng(loc.lat, loc.lng))
                         .distanceTo(map.latLngToContainerPoint(pt));
            if (d < 80 && d < minDist) { minDist = d; closest = loc; }
          }
          if (!closest) {
            setHint("Žádná lokace typu 'Budova' nenalezena. Klikněte blíže k markeru budovy.");
            return;
          }
          const loc = closest as LocationMapPoint;
          dr.polyLoc = loc;
          setPolyLoc(loc);
          // Zvýrazni vybranou budovu
          const m = L.circleMarker([loc.lat, loc.lng], {
            radius: 12, color: "#f97316", fillColor: "#f97316", fillOpacity: 0.4, weight: 2.5,
          }).addTo(map);
          dr.polyMkrs.push(m);
          setHint(`Budova: ${loc.name} · Klikejte pro body polygonu · Dvojklik = uzavřít`);
          return;
        }

        // Krok 2: Přidávej body polygonu
        const pt: [number, number] = [e.latlng.lat, e.latlng.lng];
        dr.polyPts.push(pt);
        setPolyPoints([...dr.polyPts]);

        const m = L.circleMarker(pt, {
          radius: 5, color: "#f97316", fillColor: "#f97316", fillOpacity: 1, weight: 2, interactive: false,
        }).addTo(map);
        dr.polyMkrs.push(m);

        // Aktualizuj polygon preview
        if (dr.polyPoly) map.removeLayer(dr.polyPoly);
        if (dr.polyLine) map.removeLayer(dr.polyLine);
        if (dr.polyPts.length >= 3) {
          dr.polyPoly = L.polygon(dr.polyPts, {
            color: "#f97316", fillColor: "#f97316", fillOpacity: 0.2, weight: 2, dashArray: "6 4", interactive: false,
          }).addTo(map);
        } else if (dr.polyPts.length >= 2) {
          dr.polyLine = L.polyline(dr.polyPts, {
            color: "#f97316", weight: 2, dashArray: "6 4", interactive: false,
          }).addTo(map);
        }
      });

      map.on("dblclick", (e: L.LeafletMouseEvent) => {
        e.originalEvent.preventDefault();
        if (!dr.polyLoc) { setHint("Nejprve vyberte budovu."); return; }
        if (dr.polyPts.length < 3) { alert("Polygon musí mít alespoň 3 body."); return; }
        onBuildingPolygonDrawn(dr.polyLoc, [...dr.polyPts]);
        onEditModeChange("none");
      });

      map.on("mousemove", (e: L.LeafletMouseEvent) => {
        if (!dr.polyLoc || dr.polyPts.length === 0) return;
        const last = dr.polyPts[dr.polyPts.length - 1];
        if (dr.polyPrev) map.removeLayer(dr.polyPrev);
        dr.polyPrev = L.polyline([last, [e.latlng.lat, e.latlng.lng]], {
          color: "#f97316", weight: 1.5, opacity: 0.5, dashArray: "4 4", interactive: false,
        }).addTo(map);
      });
    }

    return () => {
      map.off("click"); map.off("dblclick"); map.off("mousemove");
      map.getContainer().style.cursor = "";
    };
  }, [editMode, locations]);

  // Undo posledního bodu trasy
  function undoLastPoint() {
    const map = mapRef.current;
    const dr  = drawRef.current;
    if (!map) return;

    if (editMode === "draw_cable" && dr.points.length > 0) {
      const last = dr.markers.pop(); if (last) map.removeLayer(last);
      dr.points.pop(); setDrawPoints([...dr.points]);
      if (dr.line) { map.removeLayer(dr.line); dr.line = null; }
      if (dr.points.length >= 2)
        dr.line = L.polyline(dr.points, { color: "#f97316", weight: 3, opacity: 0.8, dashArray: "6 4" }).addTo(map);
    }

    if (editMode === "draw_polygon" && dr.polyPts.length > 0) {
      // Odeber pouze body polygonu, ne marker budovy (první marker)
      const buildingMarkers = dr.polyLoc ? 1 : 0;
      if (dr.polyMkrs.length > buildingMarkers) {
        const last = dr.polyMkrs.pop(); if (last) map.removeLayer(last);
      }
      dr.polyPts.pop(); setPolyPoints([...dr.polyPts]);
      if (dr.polyPoly) { map.removeLayer(dr.polyPoly); dr.polyPoly = null; }
      if (dr.polyLine) { map.removeLayer(dr.polyLine); dr.polyLine = null; }
      if (dr.polyPts.length >= 3)
        dr.polyPoly = L.polygon(dr.polyPts, { color: "#f97316", fillColor: "#f97316", fillOpacity: 0.2, weight: 2, dashArray: "6 4", interactive: false }).addTo(map);
      else if (dr.polyPts.length >= 2)
        dr.polyLine = L.polyline(dr.polyPts, { color: "#f97316", weight: 2, dashArray: "6 4", interactive: false }).addTo(map);
    }
  }

  function confirmRoute() {
    const dr = drawRef.current;
    if (dr.points.length < 2) { alert("Trasa musí mít alespoň 2 body."); return; }
    onCableRouteDrawn([...dr.points]);
    onEditModeChange("none");
  }

  function confirmPolygon() {
    const dr = drawRef.current;
    if (!dr.polyLoc) { alert("Nejprve vyberte budovu."); return; }
    if (dr.polyPts.length < 3) { alert("Polygon musí mít alespoň 3 body."); return; }
    onBuildingPolygonDrawn(dr.polyLoc, [...dr.polyPts]);
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

    // Polygony budov
    if (showPolygons) {
      buildingPolygons.forEach(bp => {
        if (!bp.coordinates || bp.coordinates.length < 3) return;
        // coordinates jsou [lng, lat] → Leaflet chce [lat, lng]
        const latlngs = bp.coordinates.map(c => [c[1], c[0]] as [number, number]);
        const poly = L.polygon(latlngs, {
          color:       bp.stroke_color,
          weight:      bp.stroke_width,
          fillColor:   bp.color,
          fillOpacity: bp.fill_opacity,
          opacity:     0.9,
        }).addTo(map);

        poly.bindTooltip(
          `<b>🏢 ${bp.name}</b>${bp.description ? `<br>${bp.description}` : ""}` +
          `<br>${bp.floor_count} ${bp.floor_count === 1 ? "patro" : "patra"} · ${bp.height_m}m`,
          { sticky: true }
        );

        // Popisek uprostřed
        const center = poly.getBounds().getCenter();
        const label = L.marker(center, {
          icon: L.divIcon({
            className: "",
            html: `<div style="background:rgba(255,255,255,0.9);border:1px solid #ccc;border-radius:4px;
                              padding:2px 6px;font-size:10px;font-weight:600;white-space:nowrap;
                              color:#1e293b;pointer-events:none;">
                     🏢 ${bp.name}
                   </div>`,
            iconAnchor: [0, 0],
          }),
          interactive: false, zIndexOffset: 900,
        }).addTo(map);
        layersRef.current.push(label);

        // Klik na polygon — menu
        poly.on("click", () => setSelected({ type: "polygon", data: bp }));
        layersRef.current.push(poly);
      });
    }

    // Lokace
    if (showLocations) {
      locations.forEach(loc => {
        if (!loc.lat || !loc.lng) return;
        const isBuilding    = loc.type === "building";
        const isConnDraw    = editMode === "draw_connection";
        const isPolyDraw    = editMode === "draw_polygon";
        const color         = isBuilding ? "#f97316" : (isConnDraw ? "#22c55e" : "#3b82f6");
        const radius        = isBuilding ? 8 : (isConnDraw ? 8 : 6);

        const marker = L.circleMarker([loc.lat, loc.lng], {
          radius, color, fillColor: color,
          fillOpacity: isBuilding ? 0.85 : 0.8,
          weight: isBuilding ? 2.5 : 2,
        }).addTo(map);

        marker.bindTooltip(
          `${isBuilding ? "🏢 " : ""}${loc.name}${isBuilding && !isPolyDraw ? " · klikni pro možnosti" : ""}`,
          { direction: "top", offset: [0, -8] }
        );

        // Klik na budovu v polygon draw módu → nic, handleno v editMode effect
        // Klik mimo draw mód → popup s možnostmi pro budovu, jinak detail
        if (editMode === "none" && isBuilding) {
          marker.on("click", () => setSelected({ type: "building_loc", data: loc }));
        } else if (editMode === "none") {
          marker.on("click", () => setSelected({ type: "location", data: loc }));
        }

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
          (cable.length_m ? `<br>${cable.length_m} m` : ""),
          { sticky: true }
        );
        line.on("click", () => setSelected({ type: "cable", data: cable }));
        layersRef.current.push(line);
        [latlngs[0], latlngs[latlngs.length - 1]].forEach(pt => {
          const dot = L.circleMarker(pt, { radius: 4, color, fillColor: color, fillOpacity: 1, weight: 1 }).addTo(map);
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
        const line = L.polyline([[locA.lat, locA.lng], [locB.lat, locB.lng]], {
          color, weight: conn.category === "wireless" ? 2 : 3, opacity: 0.9,
          dashArray: dashArray(conn.dash_style || "solid"),
        }).addTo(map);
        const labelA = conn.device_a_alias || conn.device_a_name || conn.location_a_name || "A";
        const labelB = conn.device_b_alias || conn.device_b_name || conn.location_b_name || "B";
        line.bindTooltip(
          `<b>${conn.name || conn.type_name || "Spoj"}</b><br>${labelA} ↔ ${labelB}` +
          (conn.current_snr_db != null ? `<br>SNR: ${conn.current_snr_db} dB` : "") +
          (conn.distance_m ? `<br>${Math.round(conn.distance_m)} m` : ""),
          { sticky: true }
        );
        line.on("click", () => setSelected({ type: "connection", data: conn }));
        layersRef.current.push(line);
      });
    }
  }, [cables, connections, locations, buildingPolygons,
      showCables, showConnections, showLocations, showPolygons, selectedTypes, editMode]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  const isDrawing     = editMode !== "none";
  const isCableDraw   = editMode === "draw_cable";
  const isPolyDraw    = editMode === "draw_polygon";
  const isConnDraw    = editMode === "draw_connection";

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
        {!isDrawing ? (
          <>
            <button onClick={() => onEditModeChange("draw_cable")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border
                         bg-background/95 backdrop-blur-sm shadow text-xs font-medium
                         hover:bg-primary hover:text-primary-foreground transition-colors">
              <Pencil className="h-3.5 w-3.5" /> Kreslit trasu kabelu
            </button>
            <button onClick={() => onEditModeChange("draw_connection")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border
                         bg-background/95 backdrop-blur-sm shadow text-xs font-medium
                         hover:bg-primary hover:text-primary-foreground transition-colors">
              <MapPin className="h-3.5 w-3.5" /> Přidat spoj
            </button>
            <button onClick={() => onEditModeChange("draw_polygon")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border
                         bg-background/95 backdrop-blur-sm shadow text-xs font-medium
                         hover:bg-primary hover:text-primary-foreground transition-colors">
              <Building2 className="h-3.5 w-3.5" /> Nakreslit polygon budovy
            </button>
          </>
        ) : (
          <div className="flex items-center gap-1.5 bg-background/95 backdrop-blur-sm
                          border border-amber-400 rounded-lg shadow px-2 py-1">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {isCableDraw  && "✏️ Kreslení trasy kabelu"}
              {isConnDraw   && "🔗 Výběr lokací spoje"}
              {isPolyDraw   && `🏢 Polygon budovy${polyLoc ? `: ${polyLoc.name}` : ""}`}
            </span>

            {/* Počet bodů + Zpět */}
            {(isCableDraw && drawPoints.length > 0) || (isPolyDraw && polyPoints.length > 0) ? (
              <>
                <span className="text-xs text-muted-foreground ml-1">
                  {isCableDraw ? drawPoints.length : polyPoints.length} bodů
                </span>
                <button onClick={undoLastPoint}
                  className="p-1 text-muted-foreground hover:text-foreground" title="Vrátit poslední bod">
                  <Undo2 className="h-3.5 w-3.5" />
                </button>
              </>
            ) : null}

            {/* Potvrdit */}
            {isCableDraw && drawPoints.length >= 2 && (
              <button onClick={confirmRoute}
                className="flex items-center gap-1 h-6 px-2 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700">
                <Check className="h-3 w-3" /> Potvrdit
              </button>
            )}
            {isPolyDraw && polyPoints.length >= 3 && (
              <button onClick={confirmPolygon}
                className="flex items-center gap-1 h-6 px-2 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700">
                <Check className="h-3 w-3" /> Dokončit
              </button>
            )}

            <button onClick={() => onEditModeChange("none")}
              className="p-1 text-muted-foreground hover:text-destructive ml-1" title="Zrušit">
              <X className="h-4 w-4" />
            </button>
          </div>
        )}
      </div>

      {/* Hint */}
      {hint && isDrawing && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-[1000]
                        bg-background/90 border border-border rounded-lg shadow px-4 py-2
                        text-xs text-center text-foreground max-w-sm">
          {hint}
          {(isCableDraw || isPolyDraw) && (
            <span className="block text-muted-foreground mt-0.5">
              Dvojklik nebo tlačítko Potvrdit/Dokončit = uzavřít
            </span>
          )}
        </div>
      )}

      {/* Mapa */}
      <div ref={mapDivRef} className="w-full h-full" />

      {/* Detail panel */}
      {selected && !isDrawing && (
        <div className="absolute bottom-4 left-4 z-[1000] bg-background/95 backdrop-blur-sm
                        border border-border rounded-lg shadow-lg p-4 max-w-xs text-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-foreground">
              {selected.type === "cable"       && "📦 Kabel"}
              {selected.type === "connection"  && "🔗 Spoj"}
              {selected.type === "polygon"     && "🏢 Budova"}
              {selected.type === "building_loc" && "🏢 Budova — možnosti"}
              {selected.type === "location"    && "📍 Lokace"}
            </span>
            <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
          </div>

          {/* Lokace typu budova — menu */}
          {selected.type === "building_loc" && (
            <div className="space-y-2">
              <p className="text-xs font-medium">{selected.data.name}</p>
              <button
                onClick={() => {
                  setSelected(null);
                  onEditModeChange("draw_polygon");
                }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10
                           text-primary text-xs font-medium hover:bg-primary hover:text-primary-foreground transition-colors">
                <Building2 className="h-3.5 w-3.5" />
                Nakreslit polygon budovy
              </button>
            </div>
          )}

          {/* Polygon — detail + smazat */}
          {selected.type === "polygon" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name}</span></p>
              {selected.data.description && <p>{selected.data.description}</p>}
              <p>Patra: {selected.data.floor_count} · Výška: {selected.data.height_m} m</p>
              {selected.data.location_name && <p>Lokace: {selected.data.location_name}</p>}
              <button
                onClick={() => {
                  if (confirm(`Smazat polygon "${selected.data.name}"?`)) {
                    onBuildingDelete(selected.data.id);
                    setSelected(null);
                  }
                }}
                className="mt-2 w-full text-destructive border border-destructive/30 rounded px-2 py-1 text-xs hover:bg-destructive/10">
                🗑️ Smazat polygon
              </button>
            </div>
          )}

          {/* Kabel */}
          {selected.type === "cable" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name}</span></p>
              <p>Typ: {selected.data.cable_type.toUpperCase()}{selected.data.medium ? ` · ${selected.data.medium}` : ""}</p>
              {selected.data.fiber_count && <p>Vlákna: {selected.data.fiber_count}</p>}
              {selected.data.length_m && <p>Délka: {selected.data.length_m} m</p>}
              <p>Stav: <span className={selected.data.status === "active" ? "text-green-500" : "text-amber-500"}>{selected.data.status}</span></p>
            </div>
          )}

          {/* Spoj */}
          {selected.type === "connection" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name || selected.data.type_name}</span></p>
              <p>Typ: {selected.data.type_name}</p>
              {selected.data.device_a_name && <p>A: {selected.data.device_a_alias || selected.data.device_a_name}{selected.data.interface_a ? ` [${selected.data.interface_a}]` : ""}</p>}
              {selected.data.device_b_name && <p>B: {selected.data.device_b_alias || selected.data.device_b_name}{selected.data.interface_b ? ` [${selected.data.interface_b}]` : ""}</p>}
              {selected.data.distance_m && <p>Vzdálenost: {Math.round(selected.data.distance_m)} m</p>}
              {selected.data.current_snr_db != null && <p>SNR: {selected.data.current_snr_db} dB</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
