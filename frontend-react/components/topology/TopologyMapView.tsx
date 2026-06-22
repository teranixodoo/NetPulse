"use client";

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import type { Cable, TopologyConnection, LocationMapPoint } from "@/lib/types";
import { locationsGpsApi } from "@/lib/api";
import { cn } from "@/lib/utils";
import { Pencil, X, Check, Undo2, MapPin, Building2, Move } from "lucide-react";

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

export type EditMode =
  | "none"
  | "draw_cable"
  | "draw_connection"
  | "draw_polygon"
  | "drag_location";

interface BuildingPolygon {
  id: number; name: string; description: string | null;
  location_id: number | null; coordinates: [number, number][];
  color: string; fill_opacity: number; stroke_color: string;
  stroke_width: number; height_m: number; floor_count: number;
  location_name?: string;
}

interface Props {
  cables: Cable[]; connections: TopologyConnection[];
  locations: LocationMapPoint[]; buildingPolygons: BuildingPolygon[];
  showCables: boolean; showConnections: boolean;
  showLocations: boolean; showPolygons: boolean;
  selectedTypes: Set<string>;
  editMode: EditMode; onEditModeChange: (mode: EditMode) => void;
  onCableRouteDrawn: (route: [number, number][]) => void;
  onConnectionDrawn: (locA: LocationMapPoint, locB: LocationMapPoint) => void;
  onBuildingPolygonDrawn: (loc: LocationMapPoint, coords: [number, number][]) => void;
  onBuildingDelete: (id: number) => void;
  onLocationMoved: (loc: LocationMapPoint, lat: number, lng: number) => void;
  onPolygonAction: (action: "view3d" | "properties" | "edit_shape", polygon: any) => void;
}

const DEPTH_COLORS = ["#3b82f6","#f97316","#8b5cf6","#06b6d4","#10b981","#f59e0b","#ef4444"];
function depthColor(depth: number) { return DEPTH_COLORS[Math.min(depth, DEPTH_COLORS.length-1)]; }

export default function TopologyMapView({
  cables, connections, locations, buildingPolygons,
  showCables, showConnections, showLocations, showPolygons,
  selectedTypes, editMode, onEditModeChange,
  onCableRouteDrawn, onConnectionDrawn,
  onBuildingPolygonDrawn, onBuildingDelete, onLocationMoved, onPolygonAction,
}: Props) {
  const mapDivRef = useRef<HTMLDivElement>(null);
  const mapRef    = useRef<L.Map | null>(null);
  const tileRef   = useRef<L.TileLayer | null>(null);
  const layersRef = useRef<L.Layer[]>([]);

  const drawRef = useRef<{
    points: [number,number][]; markers: L.CircleMarker[];
    line: L.Polyline|null; preview: L.Polyline|null;
    connStep: number; connA: LocationMapPoint|null;
    polyLoc: LocationMapPoint|null; polyPts: [number,number][];
    polyMkrs: L.CircleMarker[]; polyLine: L.Polyline|null;
    polyPrev: L.Polyline|null; polyPoly: L.Polygon|null;
  }>({ points:[], markers:[], line:null, preview:null,
       connStep:0, connA:null,
       polyLoc:null, polyPts:[], polyMkrs:[], polyLine:null, polyPrev:null, polyPoly:null });

  const [activeLayer,  setActiveLayer]  = useState<TileKey>("map");
  const [selected,     setSelected]     = useState<any>(null);
  const [drawPoints,   setDrawPoints]   = useState<[number,number][]>([]);
  const [polyPoints,   setPolyPoints]   = useState<[number,number][]>([]);
  const [polyLoc,      setPolyLoc]      = useState<LocationMapPoint|null>(null);
  const [hint,         setHint]         = useState("");
  // Rozbalené lokace — budovy a sub-budovy
  const [expandedLocs, setExpandedLocs] = useState<Set<number>>(new Set());

  function toggleExpanded(id: number) {
    setExpandedLocs(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  // Auto-expand regionů
  useEffect(() => {
    const regionIds = locations.filter(l => l.type === "region").map(l => l.id);
    if (regionIds.length === 0) return;
    setExpandedLocs(prev => {
      const next = new Set(prev);
      regionIds.forEach(id => next.add(id));
      return next;
    });
  }, [locations.map(l=>l.id).join(",")]); // eslint-disable-line

  // Inicializace mapy
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;
    const map = L.map(mapDivRef.current, { center: DEFAULT_CENTER, zoom: DEFAULT_ZOOM, maxZoom: 23 });
    const cfg = TILE_LAYERS["map"];
    tileRef.current = L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: cfg.maxZoom, maxNativeZoom: cfg.maxNativeZoom }).addTo(map);
    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    const cfg = TILE_LAYERS[activeLayer];
    tileRef.current = L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: cfg.maxZoom, maxNativeZoom: cfg.maxNativeZoom }).addTo(map);
  }, [activeLayer]);

  // Draw módy
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const dr = drawRef.current;
    const clearDraw = () => {
      dr.markers.forEach(m => map.removeLayer(m)); dr.markers = [];
      dr.polyMkrs.forEach(m => map.removeLayer(m)); dr.polyMkrs = [];
      [dr.line,dr.preview,dr.polyLine,dr.polyPrev,dr.polyPoly].forEach(l => { if(l) map.removeLayer(l); });
      dr.line=dr.preview=dr.polyLine=dr.polyPrev=dr.polyPoly=null;
      dr.points=[]; dr.polyPts=[]; dr.connStep=0; dr.connA=null; dr.polyLoc=null;
      setDrawPoints([]); setPolyPoints([]); setPolyLoc(null);
    };
    map.off("click"); map.off("dblclick"); map.off("mousemove");
    clearDraw();
    const isDrag = editMode === "drag_location";
    map.getContainer().style.cursor = (editMode !== "none" && !isDrag) ? "crosshair" : "";
    setHint("");
    if (editMode === "none" || isDrag) return;

    if (editMode === "draw_cable") {
      setHint("Klikejte pro body trasy · Dvojklik = ukončit");
      map.on("click", (e: L.LeafletMouseEvent) => {
        const pt: [number,number] = [e.latlng.lat, e.latlng.lng];
        dr.points.push(pt); setDrawPoints([...dr.points]);
        const m = L.circleMarker(pt, {radius:5,color:"#f97316",fillColor:"#f97316",fillOpacity:1,weight:2}).addTo(map);
        dr.markers.push(m);
        if (dr.line) map.removeLayer(dr.line);
        if (dr.points.length >= 2)
          dr.line = L.polyline(dr.points, {color:"#f97316",weight:3,opacity:0.8,dashArray:"6 4"}).addTo(map);
      });
      map.on("dblclick", (e: L.LeafletMouseEvent) => {
        e.originalEvent.preventDefault();
        if (dr.points.length < 2) { alert("Alespoň 2 body."); return; }
        onCableRouteDrawn([...dr.points]); onEditModeChange("none");
      });
      map.on("mousemove", (e: L.LeafletMouseEvent) => {
        if (dr.points.length === 0) return;
        const last = dr.points[dr.points.length-1];
        if (dr.preview) map.removeLayer(dr.preview);
        dr.preview = L.polyline([last,[e.latlng.lat,e.latlng.lng]], {color:"#f97316",weight:2,opacity:0.5,dashArray:"4 4"}).addTo(map);
      });
    }

    if (editMode === "draw_connection") {
      setHint("Klikněte na lokaci A."); dr.connStep = 1;
      map.on("click", (e: L.LeafletMouseEvent) => {
        const pt = e.latlng;
        let closest: LocationMapPoint|null = null; let minDist = Infinity;
        for (const loc of locations) {
          const lat = loc.inherited_lat ?? loc.lat; const lng = loc.inherited_lng ?? loc.lng;
          if (!lat || !lng) continue;
          const d = map.latLngToContainerPoint(L.latLng(lat,lng)).distanceTo(map.latLngToContainerPoint(pt));
          if (d < 60 && d < minDist) { minDist=d; closest=loc; }
        }
        if (!closest) { setHint("Klikněte blíže k lokaci."); return; }
        const loc = closest as LocationMapPoint;
        const lat = loc.inherited_lat ?? loc.lat ?? 0;
        const lng = loc.inherited_lng ?? loc.lng ?? 0;
        if (dr.connStep === 1) {
          dr.connA=loc; dr.connStep=2;
          const m = L.circleMarker([lat,lng],{radius:9,color:"#22c55e",fillColor:"#22c55e",fillOpacity:0.8,weight:2}).addTo(map);
          dr.markers.push(m); setHint(`A: ${loc.name} · Klikněte na cílovou lokaci (B).`);
        } else if (dr.connStep === 2 && dr.connA) {
          if (loc.id === dr.connA.id) { setHint("Bod B musí být jiná lokace."); return; }
          const m = L.circleMarker([lat,lng],{radius:9,color:"#ef4444",fillColor:"#ef4444",fillOpacity:0.8,weight:2}).addTo(map);
          dr.markers.push(m); onConnectionDrawn(dr.connA, loc); onEditModeChange("none");
        }
      });
    }

    if (editMode === "draw_polygon") {
      setHint("Klikněte na marker budovy nebo bloku pro výběr.");
      map.on("click", (e: L.LeafletMouseEvent) => {
        if (!dr.polyLoc) {
          // Výběr budovy/bloku — jakákoli lokace type=building
          const pt = e.latlng;
          let closest: LocationMapPoint|null = null; let minDist = Infinity;
          for (const loc of locations) {
            if (loc.type !== "building") continue;
            const lat = loc.inherited_lat ?? loc.lat; const lng = loc.inherited_lng ?? loc.lng;
            if (!lat || !lng) continue;
            const d = map.latLngToContainerPoint(L.latLng(lat,lng)).distanceTo(map.latLngToContainerPoint(pt));
            if (d < 80 && d < minDist) { minDist=d; closest=loc; }
          }
          if (!closest) { setHint("Klikněte blíže k markeru budovy nebo bloku."); return; }
          const loc = closest as LocationMapPoint;
          dr.polyLoc=loc; setPolyLoc(loc);
          const m = L.circleMarker([loc.inherited_lat??loc.lat??0, loc.inherited_lng??loc.lng??0],
            {radius:12,color:"#f97316",fillColor:"#f97316",fillOpacity:0.4,weight:2.5}).addTo(map);
          dr.polyMkrs.push(m);
          // Zobraz hierarchii
          const hierarchy = loc.depth > 0 && loc.parent_name
            ? `${loc.parent_name} → ${loc.name}` : loc.name;
          setHint(`Vybrán: ${hierarchy} · Klikejte pro body polygonu · Dvojklik = uzavřít`);
          return;
        }
        const pt: [number,number] = [e.latlng.lat, e.latlng.lng];
        dr.polyPts.push(pt); setPolyPoints([...dr.polyPts]);
        const m = L.circleMarker(pt,{radius:5,color:"#f97316",fillColor:"#f97316",fillOpacity:1,weight:2,interactive:false}).addTo(map);
        dr.polyMkrs.push(m);
        if (dr.polyPoly) map.removeLayer(dr.polyPoly);
        if (dr.polyLine) map.removeLayer(dr.polyLine);
        if (dr.polyPts.length >= 3)
          dr.polyPoly = L.polygon(dr.polyPts,{color:"#f97316",fillColor:"#f97316",fillOpacity:0.2,weight:2,dashArray:"6 4",interactive:false}).addTo(map);
        else if (dr.polyPts.length >= 2)
          dr.polyLine = L.polyline(dr.polyPts,{color:"#f97316",weight:2,dashArray:"6 4",interactive:false}).addTo(map);
      });
      map.on("dblclick", (e: L.LeafletMouseEvent) => {
        e.originalEvent.preventDefault();
        if (!dr.polyLoc) { setHint("Nejprve vyberte budovu."); return; }
        if (dr.polyPts.length < 3) { alert("Polygon musí mít alespoň 3 body."); return; }
        onBuildingPolygonDrawn(dr.polyLoc, [...dr.polyPts]); onEditModeChange("none");
      });
      map.on("mousemove", (e: L.LeafletMouseEvent) => {
        if (!dr.polyLoc || dr.polyPts.length === 0) return;
        const last = dr.polyPts[dr.polyPts.length-1];
        if (dr.polyPrev) map.removeLayer(dr.polyPrev);
        dr.polyPrev = L.polyline([last,[e.latlng.lat,e.latlng.lng]],{color:"#f97316",weight:1.5,opacity:0.5,dashArray:"4 4",interactive:false}).addTo(map);
      });
    }

    return () => { map.off("click"); map.off("dblclick"); map.off("mousemove"); map.getContainer().style.cursor=""; };
  }, [editMode, locations]);

  function undoLastPoint() {
    const map = mapRef.current; const dr = drawRef.current;
    if (!map) return;
    if (editMode === "draw_cable" && dr.points.length > 0) {
      const last = dr.markers.pop(); if(last) map.removeLayer(last);
      dr.points.pop(); setDrawPoints([...dr.points]);
      if(dr.line){map.removeLayer(dr.line);dr.line=null;}
      if(dr.points.length>=2) dr.line=L.polyline(dr.points,{color:"#f97316",weight:3,opacity:0.8,dashArray:"6 4"}).addTo(map);
    }
    if (editMode === "draw_polygon" && dr.polyPts.length > 0) {
      const bldMkrs = dr.polyLoc ? 1 : 0;
      if(dr.polyMkrs.length>bldMkrs){const last=dr.polyMkrs.pop();if(last)map.removeLayer(last);}
      dr.polyPts.pop(); setPolyPoints([...dr.polyPts]);
      if(dr.polyPoly){map.removeLayer(dr.polyPoly);dr.polyPoly=null;}
      if(dr.polyLine){map.removeLayer(dr.polyLine);dr.polyLine=null;}
      if(dr.polyPts.length>=3) dr.polyPoly=L.polygon(dr.polyPts,{color:"#f97316",fillColor:"#f97316",fillOpacity:0.2,weight:2,dashArray:"6 4",interactive:false}).addTo(map);
      else if(dr.polyPts.length>=2) dr.polyLine=L.polyline(dr.polyPts,{color:"#f97316",weight:2,dashArray:"6 4",interactive:false}).addTo(map);
    }
  }

  // Vykreslení vrstev
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    layersRef.current.forEach(l => map.removeLayer(l));
    layersRef.current = [];

    const isDrag = editMode === "drag_location";

    // Polygony budov
    if (showPolygons) {
      buildingPolygons.forEach(bp => {
        if (!bp.coordinates || bp.coordinates.length < 3) return;
        const latlngs = bp.coordinates.map(c => [c[1],c[0]] as [number,number]);
        const poly = L.polygon(latlngs, {
          color:bp.stroke_color, weight:bp.stroke_width,
          fillColor:bp.color, fillOpacity:bp.fill_opacity, opacity:0.9,
        }).addTo(map);
        poly.bindTooltip(
          `<b>🏢 ${bp.name}</b>${bp.description?`<br>${bp.description}`:""}` +
          (bp.location_name?`<br>📍 ${bp.location_name}`:"") +
          `<br>${bp.floor_count} patra · ${bp.height_m}m`, {sticky:true}
        );
        poly.on("click", () => setSelected({type:"polygon", data:bp}));
        layersRef.current.push(poly);
      });
    }

    // Lokace — viditelné: top-level + potomci rozbalených
    if (showLocations) {
      // Výpočet viditelných lokací (rekurzivní expand)
      const visibleIds = new Set<number>();
      locations.forEach(loc => { if (loc.is_top_level) visibleIds.add(loc.id); });
      let changed = true;
      while (changed) {
        changed = false;
        locations.forEach(loc => {
          if (!visibleIds.has(loc.id) && loc.parent_id && expandedLocs.has(loc.parent_id)) {
            visibleIds.add(loc.id); changed = true;
          }
        });
      }

      locations.forEach(loc => {
        if (!visibleIds.has(loc.id)) return;
        const lat = loc.inherited_lat ?? loc.lat;
        const lng = loc.inherited_lng ?? loc.lng;
        if (!lat || !lng) return;

        const isBuilding   = loc.type === "building";
        const hasChildren  = loc.children_count > 0;
        const isExpanded   = expandedLocs.has(loc.id);
        const color        = isBuilding ? depthColor(loc.depth) : depthColor(loc.depth + 1);
        const radius       = isBuilding ? (loc.depth === 0 ? 9 : 7) : 5;
        const hasOwnGps    = loc.has_own_gps;

        if (isDrag) {
          const draggable = new L.Marker([lat, lng], {
            draggable: true,
            icon: L.divIcon({
              className: "",
              html: `<div style="width:20px;height:20px;border-radius:50%;background:${color};border:2px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.4);cursor:grab;display:flex;align-items:center;justify-content:center;font-size:10px;">⊕</div>`,
              iconSize:[20,20], iconAnchor:[10,10],
            }),
            zIndexOffset: 1000,
          }).addTo(map);
          draggable.bindTooltip(`${loc.name}<br><small>Přetáhni pro změnu GPS</small>`, {direction:"top"});
          draggable.on("dragend", async (e) => {
            const pos = (e.target as L.Marker).getLatLng();
            try { await locationsGpsApi.updateGps(loc.id, pos.lat, pos.lng); onLocationMoved(loc, pos.lat, pos.lng); }
            catch { alert("Chyba při ukládání souřadnic"); }
          });
          layersRef.current.push(draggable);
          return;
        }

        const marker = L.circleMarker([lat, lng], {
          radius, color, fillColor: color,
          fillOpacity: hasOwnGps ? 0.85 : 0.4,
          weight: isBuilding ? 2.5 : 2,
          dashArray: hasOwnGps ? undefined : "3 3",
          bubblingMouseEvents: false,
        }).addTo(map);

        // Badge pro potomky
        if (hasChildren) {
          const badge = L.marker([lat, lng], {
            icon: L.divIcon({
              className: "",
              html: `<div style="position:absolute;top:-14px;right:-10px;width:16px;height:16px;border-radius:50%;background:${isExpanded?"#22c55e":"#64748b"};border:1.5px solid white;display:flex;align-items:center;justify-content:center;font-size:9px;color:white;font-weight:700;cursor:pointer;">${isExpanded?"▲":loc.children_count}</div>`,
              iconSize:[16,16], iconAnchor:[-radius,radius],
            }),
            interactive: true, zIndexOffset: 800,
          }).addTo(map);
          badge.on("click", (e) => { L.DomEvent.stopPropagation(e); toggleExpanded(loc.id); });
          layersRef.current.push(badge);
        }

        if (editMode === "none") {
          if (isBuilding) {
            // Budovy a sub-budovy — menu panel
            marker.on("click", () => setSelected({type:"building_loc", data:loc}));
          } else {
            marker.on("click", () => setSelected({type:"location", data:loc}));
          }
        }

        layersRef.current.push(marker);
      });
    }

    // Kabely
    if (showCables) {
      cables.forEach(cable => {
        if (!cable.route || cable.route.length < 2) return;
        const latlngs = cable.route.map(c => [c[1],c[0]] as [number,number]);
        const color = cable.cable_type==="fiber"?"#eab308":cable.cable_type==="coax"?"#78716c":"#3b82f6";
        const line = L.polyline(latlngs, {color,weight:3,opacity:0.85,dashArray:cable.status==="planned"?"6 4":undefined}).addTo(map);
        line.bindTooltip(`<b>${cable.name}</b><br>${cable.cable_type.toUpperCase()}${cable.medium?` · ${cable.medium}`:""}${cable.length_m?`<br>${cable.length_m} m`:""}`,{sticky:true});
        line.on("click", () => setSelected({type:"cable", data:cable}));
        layersRef.current.push(line);
        [latlngs[0],latlngs[latlngs.length-1]].forEach(pt => {
          const dot = L.circleMarker(pt,{radius:4,color,fillColor:color,fillOpacity:1,weight:1}).addTo(map);
          layersRef.current.push(dot);
        });
      });
    }

    // Logické spoje
    if (showConnections) {
      connections.forEach(conn => {
        if (!conn.category) return;
        if (selectedTypes.size > 0 && !selectedTypes.has(conn.category)) return;
        const locA = conn.location_a_id ? locations.find(l=>l.id===conn.location_a_id) : null;
        const locB = conn.location_b_id ? locations.find(l=>l.id===conn.location_b_id) : null;
        const latA = locA?.inherited_lat??locA?.lat; const lngA = locA?.inherited_lng??locA?.lng;
        const latB = locB?.inherited_lat??locB?.lat; const lngB = locB?.inherited_lng??locB?.lng;
        if (!latA||!lngA||!latB||!lngB) return;
        const color = conn.color||"#6366f1";
        const line = L.polyline([[latA,lngA],[latB,lngB]],{color,weight:conn.category==="wireless"?2:3,opacity:0.9,dashArray:dashArray(conn.dash_style||"solid")}).addTo(map);
        const labelA = conn.device_a_alias||conn.device_a_name||conn.location_a_name||"A";
        const labelB = conn.device_b_alias||conn.device_b_name||conn.location_b_name||"B";
        line.bindTooltip(`<b>${conn.name||conn.type_name||"Spoj"}</b><br>${labelA} ↔ ${labelB}${conn.current_snr_db!=null?`<br>SNR: ${conn.current_snr_db} dB`:""}${conn.distance_m?`<br>${Math.round(conn.distance_m)} m`:""}`,{sticky:true});
        line.on("click", () => setSelected({type:"connection", data:conn}));
        layersRef.current.push(line);
      });
    }
  }, [cables, connections, locations, buildingPolygons,
      showCables, showConnections, showLocations, showPolygons,
      selectedTypes, editMode, expandedLocs]);

  const isDrawing  = editMode !== "none" && editMode !== "drag_location";
  const isCable    = editMode === "draw_cable";
  const isPoly     = editMode === "draw_polygon";
  const isConn     = editMode === "draw_connection";
  const isDrag     = editMode === "drag_location";

  return (
    <div className="relative flex-1 h-full">

      {/* Tile přepínač */}
      <div className="absolute top-3 right-3 z-[1000] flex rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow overflow-hidden">
        {(Object.keys(TILE_LAYERS) as TileKey[]).map(key => (
          <button key={key} onClick={() => setActiveLayer(key)}
            className={cn("px-3 py-1.5 text-xs font-medium transition-colors",
              activeLayer===key?"bg-primary text-primary-foreground":"text-muted-foreground hover:bg-muted")}>
            {TILE_LAYERS[key].label}
          </button>
        ))}
      </div>

      {/* Toolbar */}
      <div className="absolute top-3 left-3 z-[1000] flex gap-1.5 flex-wrap">
        {!isDrawing && !isDrag ? (
          <>
            <button onClick={() => onEditModeChange("draw_cable")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow text-xs font-medium hover:bg-primary hover:text-primary-foreground transition-colors">
              <Pencil className="h-3.5 w-3.5" /> Kreslit trasu kabelu
            </button>
            <button onClick={() => onEditModeChange("draw_connection")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow text-xs font-medium hover:bg-primary hover:text-primary-foreground transition-colors">
              <MapPin className="h-3.5 w-3.5" /> Přidat spoj
            </button>
            <button onClick={() => onEditModeChange("draw_polygon")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow text-xs font-medium hover:bg-primary hover:text-primary-foreground transition-colors">
              <Building2 className="h-3.5 w-3.5" /> Nakreslit polygon
            </button>
            <button onClick={() => onEditModeChange("drag_location")}
              className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow text-xs font-medium hover:bg-amber-500 hover:text-white transition-colors">
              <Move className="h-3.5 w-3.5" /> Upravit GPS
            </button>
          </>
        ) : isDrag ? (
          <div className="flex items-center gap-2 bg-background/95 backdrop-blur-sm border border-amber-400 rounded-lg shadow px-3 py-1.5">
            <Move className="h-3.5 w-3.5 text-amber-600" />
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">Přetahuj markery pro změnu GPS</span>
            <button onClick={() => onEditModeChange("none")} className="ml-2 p-1 text-muted-foreground hover:text-destructive"><X className="h-4 w-4"/></button>
          </div>
        ) : (
          <div className="flex items-center gap-1.5 bg-background/95 backdrop-blur-sm border border-amber-400 rounded-lg shadow px-2 py-1">
            <span className="text-xs font-medium text-amber-700 dark:text-amber-400">
              {isCable && "✏️ Kreslení trasy kabelu"}
              {isConn  && "🔗 Výběr lokací spoje"}
              {isPoly  && `🏢 Polygon${polyLoc ? `: ${polyLoc.depth > 0 && polyLoc.parent_name ? `${polyLoc.parent_name} → ` : ""}${polyLoc.name}` : ""}`}
            </span>
            {((isCable && drawPoints.length>0)||(isPoly && polyPoints.length>0)) && (
              <>
                <span className="text-xs text-muted-foreground ml-1">{isCable?drawPoints.length:polyPoints.length} bodů</span>
                <button onClick={undoLastPoint} className="p-1 text-muted-foreground hover:text-foreground" title="Zpět"><Undo2 className="h-3.5 w-3.5"/></button>
              </>
            )}
            {isCable && drawPoints.length>=2 && (
              <button onClick={() => { onCableRouteDrawn([...drawRef.current.points]); onEditModeChange("none"); }}
                className="flex items-center gap-1 h-6 px-2 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700">
                <Check className="h-3 w-3"/> Potvrdit
              </button>
            )}
            {isPoly && polyPoints.length>=3 && (
              <button onClick={() => { const dr=drawRef.current; if(dr.polyLoc){onBuildingPolygonDrawn(dr.polyLoc,[...dr.polyPts]);onEditModeChange("none");} }}
                className="flex items-center gap-1 h-6 px-2 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700">
                <Check className="h-3 w-3"/> Dokončit
              </button>
            )}
            <button onClick={() => onEditModeChange("none")} className="p-1 text-muted-foreground hover:text-destructive ml-1"><X className="h-4 w-4"/></button>
          </div>
        )}
      </div>

      {/* Hint */}
      {hint && isDrawing && (
        <div className="absolute bottom-16 left-1/2 -translate-x-1/2 z-[1000] bg-background/90 border border-border rounded-lg shadow px-4 py-2 text-xs text-center text-foreground max-w-sm">
          {hint}
          {(isCable||isPoly) && <span className="block text-muted-foreground mt-0.5">Dvojklik nebo Potvrdit/Dokončit = uzavřít</span>}
        </div>
      )}

      {/* GPS drag legenda */}
      {isDrag && (
        <div className="absolute bottom-4 right-4 z-[1000] bg-background/90 border border-border rounded-lg shadow px-3 py-2 text-xs space-y-1">
          <p className="font-medium">Legenda GPS</p>
          <p className="text-muted-foreground">● Plný = vlastní GPS</p>
          <p className="text-muted-foreground">◌ Přerušovaný = zděděné GPS</p>
        </div>
      )}

      {/* Mapa */}
      <div ref={mapDivRef} className="w-full h-full" />

      {/* Detail panel */}
      {selected && !isDrawing && !isDrag && (
        <div className="absolute bottom-4 left-4 z-[1000] bg-background/95 backdrop-blur-sm border border-border rounded-lg shadow-lg p-4 max-w-xs text-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="font-semibold text-foreground">
              {selected.type==="cable"        && "📦 Kabel"}
              {selected.type==="connection"   && "🔗 Spoj"}
              {selected.type==="polygon"      && "🏢 Polygon"}
              {selected.type==="building_loc" && "🏢 Budova / Blok"}
              {selected.type==="location"     && "📍 Lokace"}
            </span>
            <button onClick={() => setSelected(null)} className="text-muted-foreground hover:text-foreground text-lg leading-none">×</button>
          </div>

          {/* Budova nebo blok — menu */}
          {selected.type === "building_loc" && (
            <div className="space-y-2">
              {/* Hierarchie breadcrumb */}
              <div className="text-xs text-muted-foreground">
                {selected.data.depth > 0 && selected.data.parent_name && (
                  <span className="text-muted-foreground">{selected.data.parent_name} → </span>
                )}
                <span className="font-medium text-foreground">{selected.data.name}</span>
                {selected.data.depth > 0 && (
                  <span className="ml-1 text-[10px] bg-muted px-1 rounded">blok</span>
                )}
              </div>
              <div className="text-xs text-muted-foreground">
                Zařízení: {selected.data.total_devices} ({selected.data.online_count} online)
              </div>
              {selected.data.children_count > 0 && (
                <button onClick={() => { toggleExpanded(selected.data.id); setSelected(null); }}
                  className="w-full flex items-center justify-between px-3 py-1.5 rounded-md bg-muted/50 text-xs hover:bg-muted transition-colors">
                  <span>{expandedLocs.has(selected.data.id) ? "▲ Skrýt podřízené" : "▼ Zobrazit podřízené"}</span>
                  <span className="text-muted-foreground">{selected.data.children_count} lokací</span>
                </button>
              )}
              <button onClick={() => { setSelected(null); onEditModeChange("draw_polygon"); }}
                className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary hover:text-primary-foreground transition-colors">
                <Building2 className="h-3.5 w-3.5"/> Nakreslit polygon
              </button>
            </div>
          )}

          {/* Ostatní lokace */}
          {selected.type === "location" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name}</span></p>
              <p>Typ: {selected.data.type}</p>
              {selected.data.parent_name && <p>Nadřazená: {selected.data.parent_name}</p>}
              <p>GPS: {selected.data.has_own_gps?"vlastní":"zděděné"}</p>
              <p>Zařízení: {selected.data.total_devices} ({selected.data.online_count} online)</p>
              {selected.data.children_count > 0 && (
                <button onClick={() => { toggleExpanded(selected.data.id); setSelected(null); }}
                  className="mt-1 w-full px-2 py-1 rounded border border-border text-xs hover:bg-muted">
                  {expandedLocs.has(selected.data.id)?"▲ Skrýt potomky":"▼ Zobrazit potomky"}
                </button>
              )}
            </div>
          )}

          {/* Polygon — plné menu */}
          {selected.type === "polygon" && (
            <div className="space-y-2">
              <div className="text-xs">
                <p className="font-medium text-foreground">{selected.data.name}</p>
                {selected.data.description && <p className="text-muted-foreground mt-0.5">{selected.data.description}</p>}
                {selected.data.location_name && (
                  <p className="text-muted-foreground mt-1">📍 {selected.data.location_name}</p>
                )}
                <p className="text-muted-foreground mt-1">
                  {selected.data.floor_count} patra · {selected.data.height_m} m
                </p>
              </div>
              <div className="space-y-1.5 pt-1 border-t border-border">
                <button onClick={() => { onPolygonAction("view3d", selected.data); setSelected(null); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-primary/10 text-primary text-xs font-medium hover:bg-primary hover:text-primary-foreground transition-colors">
                  🏗️ Zobrazit ve 3D
                </button>
                <button onClick={() => { onPolygonAction("properties", selected.data); setSelected(null); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 text-foreground text-xs hover:bg-muted transition-colors">
                  ⚙️ Vlastnosti
                </button>
                <button onClick={() => { onPolygonAction("edit_shape", selected.data); setSelected(null); }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-muted/50 text-foreground text-xs hover:bg-muted transition-colors">
                  ✏️ Upravit tvar
                </button>
                <button onClick={() => { if(confirm(`Smazat polygon "${selected.data.name}"?`)){onBuildingDelete(selected.data.id);setSelected(null);} }}
                  className="w-full flex items-center gap-2 px-3 py-2 rounded-md text-destructive border border-destructive/30 text-xs hover:bg-destructive/10 transition-colors">
                  🗑️ Smazat polygon
                </button>
              </div>
            </div>
          )}

          {selected.type==="cable" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name}</span></p>
              <p>Typ: {selected.data.cable_type.toUpperCase()}{selected.data.medium?` · ${selected.data.medium}`:""}</p>
              {selected.data.length_m && <p>Délka: {selected.data.length_m} m</p>}
              <p>Stav: <span className={selected.data.status==="active"?"text-green-500":"text-amber-500"}>{selected.data.status}</span></p>
            </div>
          )}

          {selected.type==="connection" && (
            <div className="space-y-1 text-xs text-muted-foreground">
              <p><span className="text-foreground font-medium">{selected.data.name||selected.data.type_name}</span></p>
              {selected.data.device_a_name && <p>A: {selected.data.device_a_alias||selected.data.device_a_name}</p>}
              {selected.data.device_b_name && <p>B: {selected.data.device_b_alias||selected.data.device_b_name}</p>}
              {selected.data.distance_m && <p>Vzdálenost: {Math.round(selected.data.distance_m)} m</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
