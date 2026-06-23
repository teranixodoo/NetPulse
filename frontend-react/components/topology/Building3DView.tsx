"use client";

import { useEffect, useRef, useState } from "react";
import { buildingsApi } from "@/lib/api";
import { ArrowLeft, Loader2, Pencil, X, Check, Undo2 } from "lucide-react";
import { cn } from "@/lib/utils";
import Cookies from "js-cookie";

// Helper: získej JWT token z cookie
function getToken(): string {
  return Cookies.get("np_token") || "";
}

// ---------------------------------------------------------------------------
// Konstanty
// ---------------------------------------------------------------------------
const FLOOR_COLORS = ["#3b82f6","#22c55e","#f59e0b","#ef4444","#8b5cf6","#06b6d4","#f97316","#ec4899"];
function floorColor(i: number) { return FLOOR_COLORS[i % FLOOR_COLORS.length]; }

const WAYPOINT_ICONS: Record<string,string> = {
  junction_box:"🟫", patch_panel:"🔲", conduit:"⬜",
  wall_penetration:"🔵", floor_penetration:"🔴", outlet:"🔌", rack:"🖥️",
  floor:"🏢", office:"🏠", waypoint:"📍",
};
const WAYPOINT_COLORS: Record<string,string> = {
  junction_box:"#92400e", patch_panel:"#374151", conduit:"#9ca3af",
  wall_penetration:"#1d4ed8", floor_penetration:"#dc2626", outlet:"#059669", rack:"#6d28d9",
  floor:"#0f766e", office:"#7c3aed", waypoint:"#6b7280",
};
const CABLE_COLORS: Record<string,string> = {
  fiber:"#eab308", utp:"#3b82f6", coax:"#78716c", other:"#6366f1",
};

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------
interface Floor {
  floor_index: number; location_id: number|null;
  name: string; floor_level: number|null; device_count: number;
}
interface Device {
  id: number; hostname: string; alias: string|null;
  device_type: string; location_name: string; floor_level: number|null;
}
interface Waypoint {
  id: number; name: string; type: string; waypoint_type: string|null;
  height_m: number|null; lat: number|null; lng: number|null; floor_level: number|null;
}
interface Route3DPoint {
  lng: number; lat: number; height_m: number;
  location_id?: number|null; label?: string; waypoint_type?: string|null;
}
interface Cable3D {
  id: number; name: string; cable_type: string; medium: string|null;
  length_m: number|null; status: string; route_3d: Route3DPoint[];
  location_a_name: string|null; location_b_name: string|null;
}
interface Building3DData {
  polygon: {
    id: number; name: string; description: string|null;
    height_m: number; floor_count: number; color: string;
    coordinates: [number,number][]; location_name: string|null;
    floor_location_ids?: Record<string, number|null>;
  };
  floors:  Floor[];
  devices: Device[];
}

interface Props { polygonId: number; polygonName: string; onClose: () => void; }

// ---------------------------------------------------------------------------
// Komponenta
// ---------------------------------------------------------------------------
export default function Building3DView({ polygonId, polygonName, onClose }: Props) {
  const mapDivRef  = useRef<HTMLDivElement>(null);
  const mapRef     = useRef<any>(null);
  const markersRef = useRef<any[]>([]);

  const [data,        setData]        = useState<Building3DData|null>(null);
  const [loading,     setLoading]     = useState(true);
  const [error,       setError]       = useState<string|null>(null);
  const [activeFloor, setActiveFloor] = useState<number|null>(null);
  const [waypoints,   setWaypoints]   = useState<Waypoint[]>([]);
  const [cables3d,    setCables3d]    = useState<Cable3D[]>([]);
  const [selCable,    setSelCable]    = useState<Cable3D|null>(null);

  // Draw
  type DrawMode = "none"|"draw_cable";
  const [drawMode,     setDrawMode]     = useState<DrawMode>("none");
  const [drawFloor,    setDrawFloor]    = useState(0);
  const [route3d,      setRoute3d]      = useState<Route3DPoint[]>([]);
  const [cableName,    setCableName]    = useState("");
  const [cableType,    setCableType]    = useState("fiber");
  const [cableLocA,    setCableLocA]    = useState<number|"">("");
  const [cableLocB,    setCableLocB]    = useState<number|"">("");
  const [showSaveForm, setShowSaveForm] = useState(false);
  const [savingCable,  setSavingCable]  = useState(false);

  // Načti 3D data budovy
  useEffect(() => {
    buildingsApi.get3d(polygonId)
      .then(setData)
      .catch(e => setError(e?.message || "Chyba načítání"))
      .finally(() => setLoading(false));
  }, [polygonId]);

  // Načti waypoints
  useEffect(() => {
    if (!data?.polygon) return;
    const locIds = Object.values(data.polygon.floor_location_ids || {})
      .filter((v): v is number => v !== null && v !== undefined);
    if (!locIds.length) return;
    const wpToken = getToken();
    fetch("/api/backend/locations/map",
      wpToken ? { headers: { "Authorization": `Bearer ${wpToken}` } } : {}
    )
      .then(r => r.json())
      .then((locs: any[]) => setWaypoints(locs.filter(l => l.type === "waypoint" && locIds.includes(l.parent_id))))
      .catch(() => {});
  }, [data]);

  // Načti kabely pro tuto budovu (C3)
  useEffect(() => {
    if (!data?.polygon) return;
    const coords = data.polygon.coordinates;
    const lngs   = coords.map(c => c[0]);
    const lats   = coords.map(c => c[1]);
    const bbox   = {
      minLng: Math.min(...lngs) - 0.002, maxLng: Math.max(...lngs) + 0.002,
      minLat: Math.min(...lats) - 0.002, maxLat: Math.max(...lats) + 0.002,
    };

    // Zkus různé klíče tokenu
    const token = getToken();

    fetch("/api/backend/topology/cables", {
      headers: token ? { "Authorization": `Bearer ${token}` } : {}
    })
      .then(r => r.json())
      .then((all: any[]) => {
        const filtered = all.filter(c => {
          // Kabel s route_3d — filtruj dle bbox
          if (c.route_3d?.length >= 2) {
            return c.route_3d.some((pt: any) =>
              pt.lng >= bbox.minLng && pt.lng <= bbox.maxLng &&
              pt.lat >= bbox.minLat && pt.lat <= bbox.maxLat
            );
          }
          // Kabel s route (2D) — filtruj dle bbox, zobraz jako 2D projekci
          if (c.route?.length >= 2) {
            return c.route.some((pt: any) => {
              const lat = Array.isArray(pt) ? pt[0] : pt.lat;
              const lng = Array.isArray(pt) ? pt[1] : pt.lng;
              return lng >= bbox.minLng && lng <= bbox.maxLng &&
                     lat >= bbox.minLat && lat <= bbox.maxLat;
            });
          }
          return false;
        });
        // Pro kabely bez route_3d vytvoř dummy route_3d z route (2D, výška 1.5m)
        const normalized = filtered.map(c => {
          if (c.route_3d?.length >= 2) return c;
          if (c.route?.length >= 2) {
            const route_3d = c.route.map((pt: any) => {
              const lat = Array.isArray(pt) ? pt[0] : pt.lat;
              const lng = Array.isArray(pt) ? pt[1] : pt.lng;
              return { lat, lng, height_m: 1.5 };
            });
            return { ...c, route_3d };
          }
          return c;
        });
        setCables3d(normalized);
      })
      .catch(err => console.warn("Cables load error:", err));
  }, [data]);

  // Init MapLibre
  useEffect(() => {
    if (!data || !mapDivRef.current || mapRef.current) return;
    import("maplibre-gl").then(({ default: maplibregl }) => {
      const coords    = data.polygon.coordinates;
      const centerLng = coords.reduce((s,c) => s+c[0], 0) / coords.length;
      const centerLat = coords.reduce((s,c) => s+c[1], 0) / coords.length;

      const map = new maplibregl.Map({
        container: mapDivRef.current!,
        style: { version:8, sources:{ osm:{ type:"raster", tiles:["https://a.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}.png"], tileSize:256, attribution:"© OpenStreetMap" }}, layers:[{ id:"osm", type:"raster", source:"osm" }]},
        center: [centerLng, centerLat], zoom:18, pitch:55, bearing:-20, maxZoom:19,
        antialias: true,
        failIfMajorPerformanceCaveat: false,  // WebGL1 fallback
      });
      mapRef.current = map;

      map.on("load", () => {
        const floorH = data.polygon.height_m / Math.max(data.polygon.floor_count, 1);
        const ring   = [...coords.map(c => [c[0],c[1]]), coords[0]];

        // Patra (fill-extrusion)
        for (let i = 0; i < data.polygon.floor_count; i++) {
          const base = i * floorH, top = base + floorH;
          map.addSource(`floor-${i}`, { type:"geojson", data:{ type:"Feature", geometry:{ type:"Polygon", coordinates:[ring] }, properties:{ height:top, base_height:base }}});
          map.addLayer({ id:`floor-extrusion-${i}`, type:"fill-extrusion", source:`floor-${i}`,
            paint:{ "fill-extrusion-height":top, "fill-extrusion-base":base, "fill-extrusion-color":floorColor(i), "fill-extrusion-opacity":0.85 }});
        }

        // Klik na mapu — draw mód
        map.on("click", (e: any) => {
          if (mapRef.current?._drawMode !== "draw_cable") return;
          const fi = mapRef.current._drawFloor ?? 0;
          const fH = data.polygon.height_m / Math.max(data.polygon.floor_count, 1);
          const defaultH = fi * fH + fH * 0.5;
          // Waypoint snap
          const wp = mapRef.current._pendingWaypoint;
          if (wp) {
            mapRef.current._pendingWaypoint = null;
            addRoutePoint(map, { lng:wp.lng, lat:wp.lat, height_m:wp.height_m??defaultH, location_id:wp.id, label:wp.name, waypoint_type:wp.waypoint_type });
            return;
          }
          addRoutePoint(map, { lng:e.lngLat.lng, lat:e.lngLat.lat, height_m:defaultH });
        });

        // Markery zařízení
        data.devices.forEach(dev => {
          const fi = dev.floor_level ?? 0;
          const el = document.createElement("div");
          el.innerHTML = `<div style="background:${floorColor(fi)};color:white;border:2px solid white;border-radius:50%;width:22px;height:22px;display:flex;align-items:center;justify-content:center;font-size:11px;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,.4);">💻</div>`;
          el.title = dev.alias || dev.hostname;
          const mk = new maplibregl.Marker({ element:el })
            .setLngLat([centerLng+(Math.random()-.5)*.0001, centerLat+(Math.random()-.5)*.0001])
            .setPopup(new maplibregl.Popup({ offset:12 }).setHTML(`<b>${dev.alias||dev.hostname}</b><br>${dev.device_type||""}<br><small>${dev.location_name}</small>`))
            .addTo(map);
          markersRef.current.push(mk);
        });
      });
    });

    return () => {
      markersRef.current.forEach(m => m.remove()); markersRef.current = [];
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
    };
  }, [data]);

  // C3 — vykresli kabely po načtení mapy i dat
  useEffect(() => {
    if (!cables3d.length) return;
    const tryRender = () => {
      const map = mapRef.current;
      if (!map) return;
      if (map.isStyleLoaded()) {
        renderCables3D(map, cables3d);
      } else {
        map.once("idle", () => renderCables3D(map, cables3d));
      }
    };
    // Zkus ihned, pak po 500ms a 2s (pro případ pomalého načtení)
    tryRender();
    const t1 = setTimeout(tryRender, 500);
    const t2 = setTimeout(tryRender, 2000);
    return () => { clearTimeout(t1); clearTimeout(t2); };
  }, [cables3d]);

  function renderCables3D(map: any, cables: Cable3D[]) {
    import("maplibre-gl").then(({ default: maplibregl }) => {
      cables.forEach((cable) => {
        if (!cable.route_3d?.length) return;
        const sid   = `cable-3d-${cable.id}`;
        const lid   = `cable-3d-line-${cable.id}`;
        const color = CABLE_COLORS[cable.cable_type] || "#6366f1";
        const coords = cable.route_3d.map((p: any) => [p.lng, p.lat]);

        // Aktualizuj nebo vytvoř source
        if (map.getSource(sid)) {
          (map.getSource(sid) as any).setData({
            type:"Feature", geometry:{ type:"LineString", coordinates:coords }, properties:{},
          });
          return;
        }

        map.addSource(sid, { type:"geojson", data:{ type:"Feature",
          geometry:{ type:"LineString", coordinates: coords },
          properties:{ cable_id:cable.id, name:cable.name, color },
        }});
        map.addLayer({ id:lid, type:"line", source:sid,
          paint:{ "line-color":color, "line-width":3, "line-opacity":0.9 },
          layout:{ "line-cap":"round", "line-join":"round" },
        });

        // Klikatelný popup kabelu
        map.on("click", lid, () => setSelCable(cable));
        map.on("mouseenter", lid, () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", lid, () => { map.getCanvas().style.cursor = ""; });

        // Waypoint markery na trase
        cable.route_3d.forEach((pt, pi) => {
          if (!pt.waypoint_type && !pt.label) return;
          const el = document.createElement("div");
          const icon  = WAYPOINT_ICONS[pt.waypoint_type || ""] || "📍";
          const bgCol = WAYPOINT_COLORS[pt.waypoint_type || ""] || "#6b7280";
          el.innerHTML = `<div style="background:${bgCol};color:white;border:2px solid white;border-radius:4px;width:20px;height:20px;display:flex;align-items:center;justify-content:center;font-size:10px;cursor:pointer;box-shadow:0 2px 4px rgba(0,0,0,.4);">${icon}</div>`;
          el.title = pt.label || "";
          const mk: any = new maplibregl.Marker({ element:el })
            .setLngLat([pt.lng, pt.lat])
            .setPopup(new maplibregl.Popup({ offset:12 }).setHTML(
              `<div style="font-size:11px;"><b>${pt.label||""}</b><br>${cable.name}<br><small>Výška: ${pt.height_m?.toFixed(1)}m</small></div>`
            ))
            .addTo(map);
          mk._isCableWp = true;
          markersRef.current.push(mk);
        });
      });
    });
  }

  // Aktualizace opacity při změně activeFloor
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !data) return;
    for (let i = 0; i < data.polygon.floor_count; i++) {
      const lid = `floor-extrusion-${i}`;
      if (map.getLayer(lid))
        map.setPaintProperty(lid, "fill-extrusion-opacity", activeFloor===null||activeFloor===i ? 0.85 : 0.25);
    }
  }, [activeFloor, data]);

  // Waypoint markery pro draw mód
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    // Odstranit staré
    markersRef.current.filter((m: any) => m._isWpDraw).forEach((m: any) => m.remove());
    markersRef.current = markersRef.current.filter((m: any) => !m._isWpDraw);
    if (drawMode !== "draw_cable") return;
    import("maplibre-gl").then(({ default: maplibregl }) => {
      waypoints.filter(wp => wp.floor_level===drawFloor||wp.floor_level===null).forEach(wp => {
        if (!wp.lat||!wp.lng) return;
        const color = WAYPOINT_COLORS[wp.waypoint_type||""]||"#6b7280";
        const icon  = WAYPOINT_ICONS[wp.waypoint_type||""]||"📍";
        const el = document.createElement("div");
        el.innerHTML = `<div style="background:${color};color:white;border:2px solid white;border-radius:4px;width:24px;height:24px;display:flex;align-items:center;justify-content:center;font-size:12px;cursor:pointer;box-shadow:0 2px 6px rgba(0,0,0,.5);">${icon}</div>`;
        el.title = wp.name;
        el.addEventListener("click", e => { e.stopPropagation(); if(mapRef.current) mapRef.current._pendingWaypoint = wp; });
        const mk: any = new maplibregl.Marker({ element:el })
          .setLngLat([wp.lng, wp.lat])
          .setPopup(new maplibregl.Popup({ offset:14 }).setHTML(`<div style="font-size:11px;"><b>${wp.name}</b><br>${WAYPOINT_ICONS[wp.waypoint_type||""]||""} ${wp.waypoint_type||""}<br>Výška: ${wp.height_m??'?'}m</div>`))
          .addTo(map);
        mk._isWpDraw = true;
        markersRef.current.push(mk);
      });
    });
  }, [drawMode, drawFloor, waypoints]);

  // Sync draw state do mapRef
  useEffect(() => {
    if (mapRef.current) { mapRef.current._drawMode=drawMode; mapRef.current._drawFloor=drawFloor; }
  }, [drawMode, drawFloor]);

  // Přidej bod trasy
  function addRoutePoint(map: any, pt: Route3DPoint) {
    import("maplibre-gl").then(({ default: maplibregl }) => {
      const newRoute = [...(mapRef.current._route3d||[]), pt];
      mapRef.current._route3d = newRoute;
      setRoute3d([...newRoute]);
      // Marker
      const el = document.createElement("div");
      el.innerHTML = `<div style="background:#f97316;color:white;border:2px solid white;border-radius:50%;width:18px;height:18px;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:bold;">${newRoute.length}</div>`;
      const mk: any = new maplibregl.Marker({ element:el }).setLngLat([pt.lng, pt.lat]).addTo(map);
      mk._isDrawPt = true;
      markersRef.current.push(mk);
      // Linie
      const sid = "draw-cable-line";
      if (map.getSource(sid)) {
        (map.getSource(sid) as any).setData({ type:"Feature", geometry:{ type:"LineString", coordinates:newRoute.map(p=>[p.lng,p.lat]) }, properties:{} });
      } else if (newRoute.length >= 2) {
        map.addSource(sid, { type:"geojson", data:{ type:"Feature", geometry:{ type:"LineString", coordinates:newRoute.map(p=>[p.lng,p.lat]) }, properties:{} }});
        map.addLayer({ id:"draw-cable-layer", type:"line", source:sid,
          paint:{ "line-color":"#f97316","line-width":3,"line-opacity":.9,"line-dasharray":[2,1] }});
      }
    });
  }

  function undoLastPoint() {
    const newRoute = route3d.slice(0,-1);
    setRoute3d(newRoute);
    if (mapRef.current) {
      mapRef.current._route3d = newRoute;
      // Odstranit poslední marker
      const last = [...markersRef.current].reverse().find((m: any) => m._isDrawPt);
      if (last) { last.remove(); markersRef.current = markersRef.current.filter(m => m !== last); }
      const map = mapRef.current;
      if (map.getSource("draw-cable-line"))
        (map.getSource("draw-cable-line") as any).setData({ type:"Feature", geometry:{ type:"LineString", coordinates:newRoute.map(p=>[p.lng,p.lat]) }, properties:{} });
    }
  }

  function cancelDraw() {
    setDrawMode("none"); setRoute3d([]); setShowSaveForm(false);
    setCableLocA(""); setCableLocB("");
    if (mapRef.current) {
      mapRef.current._route3d = []; mapRef.current._drawMode = "none";
      const map = mapRef.current;
      if (map.getLayer("draw-cable-layer")) map.removeLayer("draw-cable-layer");
      if (map.getSource("draw-cable-line"))  map.removeSource("draw-cable-line");
      markersRef.current.filter((m: any) => m._isDrawPt).forEach((m: any) => m.remove());
      markersRef.current = markersRef.current.filter((m: any) => !m._isDrawPt);
    }
  }

  async function saveCable() {
    if (!cableName.trim() || route3d.length < 2) return;
    setSavingCable(true);
    try {
      let length_m = 0;
      for (let i = 1; i < route3d.length; i++) {
        const a = route3d[i-1], b = route3d[i];
        const R = 6371000;
        const dLat = (b.lat-a.lat)*Math.PI/180, dLng = (b.lng-a.lng)*Math.PI/180;
        const h = Math.sin(dLat/2)**2 + Math.cos(a.lat*Math.PI/180)*Math.cos(b.lat*Math.PI/180)*Math.sin(dLng/2)**2;
        const d2d = 2*R*Math.asin(Math.sqrt(h));
        length_m += Math.sqrt(d2d**2 + (b.height_m-a.height_m)**2);
      }
      const token = getToken();
      const resp = await fetch("/api/backend/topology/cables", {
        method:"POST",
        headers:{ "Content-Type":"application/json", "Authorization":`Bearer ${token}` },
        body: JSON.stringify({
          name: cableName.trim(), cable_type: cableType,
          length_m: Math.round(length_m),
          route: route3d.map(p => [p.lat, p.lng]),
          route_3d: route3d, status:"active",
          location_a_id: cableLocA || null,
          location_b_id: cableLocB || null,
        }),
      });
      if (!resp.ok) throw new Error(await resp.text());
      const saved = await resp.json();
      setCables3d(prev => [...prev, { ...saved, route_3d:route3d }]);
      // Vykresli ihned
      if (mapRef.current?.isStyleLoaded()) renderCables3D(mapRef.current, [{ ...saved, route_3d:route3d }]);
      cancelDraw(); setCableName("");
    } catch(e: any) {
      alert("Chyba uložení kabelu: " + e.message);
    } finally { setSavingCable(false); }
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  if (loading) return (
    <div className="fixed inset-0 z-[3000] flex items-center justify-center bg-background/80">
      <div className="flex flex-col items-center gap-3">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
        <p className="text-sm text-muted-foreground">Načítám 3D data…</p>
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
        <button onClick={onClose} className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
          <ArrowLeft className="h-4 w-4" /> Zpět na 2D
        </button>
        <div className="w-px h-5 bg-border" />
        <span className="font-semibold text-sm">{data?.polygon.name}</span>
        <div className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
          <span>{floorCount} pater · {data?.polygon.height_m} m</span>
          <span>{data?.devices.length} zařízení</span>
          {cables3d.length > 0 && <span className="text-primary font-medium">{cables3d.length} kabelů</span>}
        </div>
      </div>

      {/* Draw toolbar */}
      {drawMode === "none" ? (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-muted/20">
          <button onClick={() => { setDrawMode("draw_cable"); setRoute3d([]); if(mapRef.current) mapRef.current._route3d=[]; }}
            className="flex items-center gap-1.5 h-7 px-3 rounded-md border border-border bg-background text-xs font-medium hover:bg-primary hover:text-primary-foreground transition-colors">
            <Pencil className="h-3.5 w-3.5" /> Kreslit trasu kabelu
          </button>
          {cables3d.length > 0 && (
            <span className="text-xs text-muted-foreground">· {cables3d.length} uložených tras · klikni na trasu pro detail</span>
          )}
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-2 border-b border-amber-400/50 bg-amber-50/10 flex-wrap">
          <span className="text-xs font-semibold text-amber-700 dark:text-amber-400">✏️ Kreslení trasy</span>
          <div className="flex items-center gap-1">
            <span className="text-xs text-muted-foreground">Patro:</span>
            <select value={drawFloor} onChange={e => setDrawFloor(Number(e.target.value))}
              className="h-6 rounded border border-border bg-background px-1 text-xs">
              {Array.from({length:floorCount},(_,i) => {
                const fl = data?.floors[i];
                return <option key={i} value={i}>{fl?.name||(i===0?"Přízemí":`${i}. NP`)} ({+(i*floorHeight).toFixed(1)}m)</option>;
              })}
            </select>
          </div>
          <span className="text-xs text-muted-foreground">{route3d.length} bodů</span>
          {route3d.length > 0 && (
            <button onClick={undoLastPoint} className="flex items-center gap-1 h-6 px-2 rounded bg-muted text-xs hover:bg-muted/80">
              <Undo2 className="h-3 w-3" /> Zpět
            </button>
          )}
          {route3d.length >= 2 && !showSaveForm && (
            <button onClick={() => setShowSaveForm(true)}
              className="flex items-center gap-1 h-6 px-2 rounded bg-green-600 text-white text-xs font-medium hover:bg-green-700">
              <Check className="h-3 w-3" /> Dokončit
            </button>
          )}
          <button onClick={cancelDraw} className="flex items-center gap-1 h-6 px-2 rounded bg-muted text-xs hover:text-destructive ml-auto">
            <X className="h-3 w-3" /> Zrušit
          </button>
          {showSaveForm && (
            <div className="w-full flex flex-col gap-2 mt-1 p-2 rounded-md border border-border bg-background">
              <div className="flex items-center gap-2">
                <input value={cableName} onChange={e => setCableName(e.target.value)}
                  placeholder="Název kabelu *"
                  className="flex-1 h-7 rounded border border-border bg-background px-2 text-xs focus:outline-none focus:ring-1 focus:ring-primary/50" />
                <select value={cableType} onChange={e => setCableType(e.target.value)}
                  className="h-7 rounded border border-border bg-background px-2 text-xs">
                  <option value="fiber">Optika</option>
                  <option value="utp">UTP</option>
                  <option value="coax">Koax</option>
                  <option value="other">Ostatní</option>
                </select>
                <button onClick={saveCable} disabled={savingCable||!cableName.trim()}
                  className="flex items-center gap-1 h-7 px-3 rounded bg-primary text-primary-foreground text-xs font-medium disabled:opacity-50">
                  {savingCable ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
                  Uložit
                </button>
                <button onClick={() => setShowSaveForm(false)} className="h-7 px-2 rounded border border-border text-xs hover:bg-muted">Zpět</button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-xs text-muted-foreground shrink-0">🟢 Bod A:</span>
                <select value={cableLocA} onChange={e => setCableLocA(e.target.value ? Number(e.target.value) : "")}
                  className="flex-1 h-7 rounded border border-border bg-background px-2 text-xs">
                  <option value="">— bez vazby —</option>
                  {waypoints.map(w => (
                    <option key={w.id} value={w.id}>
                      {WAYPOINT_ICONS[w.type]||WAYPOINT_ICONS[w.waypoint_type||""]||"📍"} {w.name}
                    </option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground shrink-0">🔴 Bod B:</span>
                <select value={cableLocB} onChange={e => setCableLocB(e.target.value ? Number(e.target.value) : "")}
                  className="flex-1 h-7 rounded border border-border bg-background px-2 text-xs">
                  <option value="">— bez vazby —</option>
                  {waypoints.map(w => (
                    <option key={w.id} value={w.id}>
                      {WAYPOINT_ICONS[w.type]||WAYPOINT_ICONS[w.waypoint_type||""]||"📍"} {w.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* 3D mapa */}
        <div ref={mapDivRef} className="flex-1" style={{ cursor: drawMode!=="none" ? "crosshair" : "grab" }} />

        {/* Pravý panel */}
        <div className="w-60 shrink-0 border-l border-border bg-card overflow-y-auto flex flex-col">

          {/* Patra */}
          <div className="px-3 py-2 border-b border-border">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">Patra</p>
            <div className="space-y-1">
              <button onClick={() => setActiveFloor(null)}
                className={cn("w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
                  activeFloor===null?"bg-primary/10 text-primary font-medium":"text-muted-foreground hover:bg-muted/50")}>
                <span className="w-3 h-3 rounded-sm shrink-0 bg-gradient-to-b from-blue-400 to-yellow-400" />
                Všechna patra
              </button>
              {Array.from({length:floorCount},(_,i) => {
                const fl       = data?.floors[i];
                const base     = +(i*floorHeight).toFixed(1);
                const top      = +(base+floorHeight).toFixed(1);
                const flWps    = waypoints.filter(w => w.floor_level===i);
                const flCables = cables3d.filter(c => c.route_3d?.some(p => {
                  const fBase = i*floorHeight, fTop = (i+1)*floorHeight;
                  return p.height_m >= fBase && p.height_m <= fTop;
                }));
                return (
                  <button key={i}
                    onClick={() => { setActiveFloor(activeFloor===i?null:i); if(drawMode==="draw_cable") setDrawFloor(i); }}
                    className={cn("w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
                      activeFloor===i?"bg-primary/10 text-primary font-medium":
                      drawMode==="draw_cable"&&drawFloor===i?"bg-amber-100/50 dark:bg-amber-900/20 text-amber-700 dark:text-amber-400":
                      "text-muted-foreground hover:bg-muted/50")}>
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background:floorColor(i) }} />
                    <span className="flex-1 text-left truncate">{fl?.name||(i===0?"Přízemí":`${i}. NP`)}</span>
                    <span className="text-[10px] text-muted-foreground shrink-0 space-x-1">
                      {(fl?.device_count||0)>0 && <span>{fl?.device_count}💻</span>}
                      {flWps.length>0 && <span>{flWps.length}📍</span>}
                      {flCables.length>0 && <span>{flCables.length}🔌</span>}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Kabely v budově (C3) */}
          {cables3d.length > 0 && (
            <div className="px-3 py-2 border-b border-border">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Kabely ({cables3d.length})
              </p>
              <div className="space-y-1">
                {cables3d.map(cable => (
                  <button key={cable.id}
                    onClick={() => setSelCable(selCable?.id===cable.id ? null : cable)}
                    className={cn("w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors",
                      selCable?.id===cable.id?"bg-primary/10 text-primary font-medium":"text-muted-foreground hover:bg-muted/50")}>
                    <span className="w-3 h-3 rounded-sm shrink-0" style={{ background:CABLE_COLORS[cable.cable_type]||"#6366f1" }} />
                    <span className="flex-1 text-left truncate">{cable.name}</span>
                    <span className="text-[10px] shrink-0">{cable.cable_type.toUpperCase()}</span>
                  </button>
                ))}
              </div>
              {selCable && (
                <div className="mt-2 p-2 rounded-md bg-muted/30 text-xs space-y-0.5">
                  <p className="font-medium">{selCable.name}</p>
                  <p className="text-muted-foreground">{selCable.cable_type.toUpperCase()}{selCable.medium?` · ${selCable.medium}`:""}</p>
                  {selCable.length_m && <p className="text-muted-foreground">Délka: {selCable.length_m} m</p>}
                  <p className="text-muted-foreground">{selCable.route_3d?.length} bodů trasy</p>
                </div>
              )}
            </div>
          )}

          {/* Průchozí body */}
          {waypoints.length > 0 && (
            <div className="px-3 py-2 border-b border-border">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Průchozí body ({waypoints.length})
              </p>
              <div className="space-y-1">
                {waypoints
                  .filter(w => activeFloor===null||w.floor_level===activeFloor)
                  .map(wp => (
                    <div key={wp.id} className="flex items-center gap-1.5 px-2 py-1 rounded text-xs hover:bg-muted/30">
                      <span>{WAYPOINT_ICONS[wp.waypoint_type||""]||"📍"}</span>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{wp.name}</p>
                        <p className="text-[10px] text-muted-foreground">{wp.height_m!=null?`${wp.height_m}m nad podlahou`:"výška ?"}</p>
                      </div>
                    </div>
                  ))}
              </div>
            </div>
          )}

          {/* Zařízení */}
          <div className="px-3 py-2">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
              Zařízení ({data?.devices.length})
            </p>
            {(data?.devices.length??0)===0 ? (
              <p className="text-xs text-muted-foreground">Žádná zařízení</p>
            ) : (
              <div className="space-y-1">
                {data?.devices
                  .filter(d => activeFloor===null||(d.floor_level??0)===activeFloor)
                  .map(dev => (
                    <div key={dev.id} className="flex items-center gap-2 px-2 py-1 rounded text-xs hover:bg-muted/30">
                      <span className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background:floorColor(dev.floor_level??0) }} />
                      <div className="flex-1 min-w-0">
                        <p className="font-medium truncate">{dev.alias||dev.hostname}</p>
                        <p className="text-[10px] text-muted-foreground truncate">{dev.location_name}</p>
                      </div>
                    </div>
                  ))}
              </div>
            )}
          </div>

          {/* Nápověda */}
          <div className="mt-auto px-3 py-3 border-t border-border">
            {drawMode==="draw_cable" ? (
              <p className="text-[10px] text-amber-600 dark:text-amber-400 space-y-0.5">
                <span className="block font-medium">Kreslení kabelu:</span>
                <span className="block">🖱️ Klikni = přidej bod</span>
                <span className="block">📍 Klikni na waypoint = přichyť</span>
                <span className="block">Vyber patro = změň výšku</span>
              </p>
            ) : (
              <p className="text-[10px] text-muted-foreground space-y-0.5">
                <span className="block">🖱️ Tažení = rotace</span>
                <span className="block">⚲ Kolečko = zoom</span>
                <span className="block">Ctrl+tažení = náklon</span>
              </p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
