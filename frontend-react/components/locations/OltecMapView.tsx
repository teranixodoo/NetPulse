"use client";

/**
 * OltecMapView — mapa areálu OLTEC Hybešova/Václavská
 * Načítá KML soubor, parsuje polygony budov + ohraničení areálu
 * a zobrazuje je v Leaflet mapě.
 *
 * KML soubor je servírován ze /shared/maps/oltec.kml přes Next.js API.
 */

import { useEffect, useRef, useState } from "react";
import L from "leaflet";
import { Loader2, Layers, Eye, EyeOff } from "lucide-react";

// ---------------------------------------------------------------------------
// Oprava Leaflet ikon
// ---------------------------------------------------------------------------
function fixLeafletIcons() {
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
// KML ABGR → CSS hex color
// ---------------------------------------------------------------------------
function kmlColorToHex(kmlColor: string): string {
  if (!kmlColor || kmlColor.length < 8) return "#888888";
  // KML: AABBGGRR → CSS: #RRGGBB
  const r = kmlColor.slice(6, 8);
  const g = kmlColor.slice(4, 6);
  const b = kmlColor.slice(2, 4);
  const a = parseInt(kmlColor.slice(0, 2), 16) / 255;
  return `#${r}${g}${b}`;
}

function kmlAlpha(kmlColor: string): number {
  if (!kmlColor || kmlColor.length < 8) return 0.4;
  return Math.round(parseInt(kmlColor.slice(0, 2), 16) / 255 * 100) / 100;
}

// ---------------------------------------------------------------------------
// Parsování KML
// ---------------------------------------------------------------------------
interface KmlFeature {
  name:        string;
  type:        "Polygon" | "LineString" | "Point";
  coordinates: number[][][];   // pro Polygon: array of rings
  lineCoords:  number[][];     // pro LineString
  fillColor:   string;
  fillOpacity: number;
  strokeColor: string;
  strokeWeight:number;
  description: string;
}

function parseKml(kmlText: string): KmlFeature[] {
  const parser = new DOMParser();
  const doc    = parser.parseFromString(kmlText, "text/xml");
  const ns     = "http://www.opengis.net/kml/2.2";

  // Načteme styly
  const styleMap: Record<string, {
    fillColor: string; fillOpacity: number;
    strokeColor: string; strokeWeight: number;
  }> = {};

  doc.querySelectorAll("Style").forEach(style => {
    const id         = style.getAttribute("id") || "";
    const polyColor  = style.querySelector("PolyStyle > color")?.textContent || "4d888888";
    const lineColor  = style.querySelector("LineStyle > color")?.textContent || "ff000000";
    const lineWidth  = style.querySelector("LineStyle > width")?.textContent || "2";
    styleMap[id] = {
      fillColor:   kmlColorToHex(polyColor),
      fillOpacity: kmlAlpha(polyColor),
      strokeColor: kmlColorToHex(lineColor),
      strokeWeight: parseFloat(lineWidth),
    };
  });

  // StyleMap → normal style
  const styleMapRef: Record<string, string> = {};
  doc.querySelectorAll("StyleMap").forEach(sm => {
    const id = sm.getAttribute("id") || "";
    sm.querySelectorAll("Pair").forEach(pair => {
      const key     = pair.querySelector("key")?.textContent;
      const styleUrl = pair.querySelector("styleUrl")?.textContent?.replace("#", "");
      if (key === "normal" && styleUrl) {
        styleMapRef[id] = styleUrl;
      }
    });
  });

  const features: KmlFeature[] = [];

  doc.querySelectorAll("Placemark").forEach(pm => {
    const name = pm.querySelector("name")?.textContent?.trim() || "";
    const desc = pm.querySelector("description")?.textContent?.trim() || "";

    // Zjisti styl
    const styleUrl = pm.querySelector("styleUrl")?.textContent?.replace("#", "") || "";
    const resolvedStyle = styleMapRef[styleUrl] || styleUrl;
    const style = styleMap[resolvedStyle] || {
      fillColor: "#888888", fillOpacity: 0.4,
      strokeColor: "#333333", strokeWeight: 2,
    };

    // Polygon
    const polygon = pm.querySelector("Polygon");
    if (polygon) {
      const rings: number[][][] = [];
      polygon.querySelectorAll("coordinates").forEach(coordEl => {
        const ring = coordEl.textContent?.trim().split(/\s+/).map(c => {
          const [lng, lat] = c.split(",").map(Number);
          return [lat, lng] as number[];
        }).filter(c => !isNaN(c[0]) && !isNaN(c[1])) || [];
        if (ring.length > 0) rings.push(ring);
      });
      if (rings.length > 0) {
        features.push({ name, type: "Polygon", coordinates: rings,
          lineCoords: [], ...style, description: desc });
      }
    }

    // LineString
    const line = pm.querySelector("LineString");
    if (line) {
      const coordEl  = line.querySelector("coordinates");
      const lineCoords = coordEl?.textContent?.trim().split(/\s+/).map(c => {
        const [lng, lat] = c.split(",").map(Number);
        return [lat, lng] as number[];
      }).filter(c => !isNaN(c[0]) && !isNaN(c[1])) || [];
      if (lineCoords.length > 0) {
        features.push({ name, type: "LineString", coordinates: [],
          lineCoords, ...style, description: desc });
      }
    }
  });

  return features;
}

// ---------------------------------------------------------------------------
// Výchozí střed — areál OLTEC
// ---------------------------------------------------------------------------
const OLTEC_CENTER: [number, number] = [49.1893, 16.5975];
const OLTEC_ZOOM = 17;

// ---------------------------------------------------------------------------
// Tile vrstvy — OSM + Esri satelit
// ---------------------------------------------------------------------------
const TILE_LAYERS = {
  map: {
    label: "🗺️ Mapa",
    url:   "https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png",
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    maxZoom:       22,
    maxNativeZoom: 19,
  },
  satellite: {
    label: "🛰️ Satelit",
    url:   "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    attribution: '&copy; <a href="https://www.esri.com/">Esri</a>',
    maxZoom:       23,
    maxNativeZoom: 23,
  },
} as const;

type TileLayerKey = keyof typeof TILE_LAYERS;

// ---------------------------------------------------------------------------
// Hlavní komponenta
// ---------------------------------------------------------------------------
// Props — stejný vzor jako LocationsMapView
// ---------------------------------------------------------------------------
import type { LocationMapPoint, ConfigItem } from "@/lib/types";

const STATUS_COLORS = {
  ok:      "#22c55e",
  partial: "#f59e0b",
  offline: "#ef4444",
  empty:   "#94a3b8",
};

function getStatusColor(loc: LocationMapPoint): string {
  if (loc.total_devices === 0) return STATUS_COLORS.empty;
  if (loc.offline_count === 0) return STATUS_COLORS.ok;
  if (loc.online_count  === 0) return STATUS_COLORS.offline;
  return STATUS_COLORS.partial;
}

function makeDivIcon(emoji: string, color: string, selected: boolean): L.DivIcon {
  const size   = selected ? 40 : 32;
  const border = selected ? "3px solid #3b82f6" : "2px solid white";
  return L.divIcon({
    className: "",
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:${border};
      box-shadow:0 2px 6px rgba(0,0,0,0.35);
      display:flex;align-items:center;justify-content:center;
      font-size:${selected ? 18 : 14}px;cursor:pointer;
    ">${emoji}</div>`,
    iconSize:    [size, size],
    iconAnchor:  [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

interface OltecMapViewProps {
  locations?:        LocationMapPoint[];
  locationTypes?:    ConfigItem[];
  isLoading?:        boolean;
  onSelectLocation?: (loc: LocationMapPoint | null) => void;
  selectedId?:       number | null;
}

export default function OltecMapView({
  locations     = [],
  locationTypes = [],
  isLoading     = false,
  onSelectLocation,
  selectedId,
}: OltecMapViewProps) {
  fixLeafletIcons();

  const mapDivRef   = useRef<HTMLDivElement>(null);
  const mapRef      = useRef<L.Map | null>(null);
  const tileRef     = useRef<L.TileLayer | null>(null);
  const layersRef   = useRef<L.Layer[]>([]);
  const markersRef  = useRef<Map<number, L.Marker>>(new Map());
  const [activeLayer, setActiveLayer] = useState<TileLayerKey>("map");

  const [loading,    setLoading]    = useState(true);
  const [error,      setError]      = useState<string | null>(null);
  const [showLabels, setShowLabels] = useState(true);
  const labelsRef   = useRef<L.Layer[]>([]);

  // TypeMap pro ikony
  const typeMap = Object.fromEntries(locationTypes.map(t => [t.value, t]));
  const DEFAULT_ICONS: Record<string, string> = {
    region:"🗺️", city:"🏙️", building:"🏢", floor:"📐",
    apartment:"🏠", byt:"🏠", office:"💼", rack:"🖥️",
    soil:"🏚️", outdoor:"📡", other:"📍",
  };
  function getIcon(type: string): string {
    const c = typeMap[type]?.icon;
    return (c && c.trim()) || DEFAULT_ICONS[type] || "📍";
  }
  function getTypeLabel(type: string): string {
    return typeMap[type]?.label || type;
  }

  // Inicializace mapy
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;

    const map = L.map(mapDivRef.current, {
      center:      OLTEC_CENTER,
      zoom:        OLTEC_ZOOM,
      zoomControl: true,
      maxZoom:     23,
    });

    const cfg = TILE_LAYERS["map"];
    const tile = L.tileLayer(cfg.url, {
      attribution:   cfg.attribution,
      maxZoom:       cfg.maxZoom,
      maxNativeZoom: cfg.maxNativeZoom,
    }).addTo(map);
    tileRef.current = tile;

    mapRef.current = map;
    return () => { map.remove(); mapRef.current = null; };
  }, []);

  // Přepínání tile vrstvy (Mapa / Satelit)
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    if (tileRef.current) map.removeLayer(tileRef.current);
    const cfg = TILE_LAYERS[activeLayer];
    tileRef.current = L.tileLayer(cfg.url, {
      attribution:   cfg.attribution,
      maxZoom:       cfg.maxZoom,
      maxNativeZoom: cfg.maxNativeZoom,
    }).addTo(map);
  }, [activeLayer]);

  // Načtení a vykreslení KML
  useEffect(() => {
    if (!mapRef.current) return;

    setLoading(true);
    setError(null);

    fetch("/api/maps/oltec.kml")
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(kmlText => {
        const features = parseKml(kmlText);
        const map = mapRef.current!;

        // Vyčistíme staré vrstvy
        layersRef.current.forEach(l => map.removeLayer(l));
        labelsRef.current.forEach(l => map.removeLayer(l));
        layersRef.current = [];
        labelsRef.current = [];

        features.forEach(f => {
          if (f.type === "Polygon") {
            const latlngs = f.coordinates.map(ring =>
              ring.map(c => L.latLng(c[0], c[1]))
            );
            const poly = L.polygon(latlngs, {
              color:       f.strokeColor,
              weight:      f.strokeWeight > 0 ? Math.min(f.strokeWeight, 4) : 2,
              fillColor:   f.fillColor,
              fillOpacity: f.fillOpacity > 0 ? f.fillOpacity : 0.35,
              opacity:     0.9,
            });

            poly.bindPopup(`
              <div style="font-family:system-ui;min-width:140px">
                <div style="font-weight:600;font-size:14px;margin-bottom:4px">${f.name}</div>
                ${f.description
                  ? `<div style="font-size:12px;color:#64748b">${f.description}</div>`
                  : ""}
              </div>
            `, { closeButton: true });

            poly.addTo(map);
            layersRef.current.push(poly);

            // Popisek uprostřed polygonu
            if (f.name && f.name !== "Čára" && !f.name.startsWith("Čára")) {
              const center = poly.getBounds().getCenter();
              const label = L.marker(center, {
                icon: L.divIcon({
                  className: "",
                  html: `<div style="
                    background:rgba(255,255,255,0.85);
                    border:1px solid #ccc;
                    border-radius:4px;
                    padding:2px 6px;
                    font-size:11px;
                    font-weight:600;
                    white-space:nowrap;
                    color:#1e293b;
                    pointer-events:none;
                  ">${f.name.replace("Budova ", "")}</div>`,
                  iconAnchor: [0, 0],
                }),
                interactive: false,
                zIndexOffset: 1000,
              });
              label.addTo(map);
              labelsRef.current.push(label);
            }

          } else if (f.type === "LineString") {
            const latlngs = f.lineCoords.map(c => L.latLng(c[0], c[1]));
            const line = L.polyline(latlngs, {
              color:   f.strokeColor || "#FF0000",
              weight:  f.strokeWeight > 0 ? f.strokeWeight : 3,
              opacity: 0.9,
              dashArray: f.strokeColor === "#000000" ? "6,4" : undefined,
            });
            line.addTo(map);
            layersRef.current.push(line);
          }
        });

        setLoading(false);
      })
      .catch(err => {
        setError(`Nepodařilo se načíst mapu: ${err.message}`);
        setLoading(false);
      });
  }, []);

  // ---------------------------------------------------------------------------
  // Markery lokací — přidáme nad KML polygony
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;

    // Vyčistíme staré markery
    markersRef.current.forEach(m => map.removeLayer(m));
    markersRef.current.clear();

    locations.forEach(loc => {
      if (!loc.lat || !loc.lng) return;
      const emoji    = getIcon(loc.type);
      const color    = getStatusColor(loc);
      const selected = loc.id === selectedId;
      const icon     = makeDivIcon(emoji, color, selected);

      const marker = L.marker([loc.lat, loc.lng], { icon, zIndexOffset: 500 });

      // Popup s info
      const addr = [loc.street, loc.city].filter(Boolean).join(", ");
      const statusColor = getStatusColor(loc);
      marker.bindPopup(`
        <div style="min-width:180px;font-family:system-ui">
          <div style="font-weight:600;font-size:13px;margin-bottom:3px">${loc.name}</div>
          <div style="font-size:11px;color:#64748b;margin-bottom:5px">${getTypeLabel(loc.type)}${addr ? " · " + addr : ""}</div>
          <div style="border-top:1px solid #e2e8f0;padding-top:4px;font-size:12px">
            <div style="display:flex;justify-content:space-between;margin-bottom:2px">
              <span>Zařízení</span><strong>${loc.total_devices}</strong>
            </div>
            <div style="display:flex;justify-content:space-between;margin-bottom:2px">
              <span style="color:#22c55e">● Online</span><strong>${loc.online_count}</strong>
            </div>
            <div style="display:flex;justify-content:space-between">
              <span style="color:#ef4444">● Offline</span><strong>${loc.offline_count}</strong>
            </div>
          </div>
          ${onSelectLocation ? `
          <div style="margin-top:8px">
            <button onclick="window._oltecSelectLoc(${loc.id})"
              style="width:100%;padding:4px 0;background:#3b82f6;color:white;border:none;border-radius:4px;font-size:12px;cursor:pointer">
              Detail lokace →
            </button>
          </div>` : ""}
        </div>
      `, { closeButton: false, maxWidth: 240 });

      marker.on("mouseover", () => marker.openPopup());
      marker.on("mouseout",  () => marker.closePopup());
      marker.on("click",     () => {
        marker.closePopup();
        onSelectLocation?.(loc);
      });

      marker.addTo(map);
      markersRef.current.set(loc.id, marker);
    });

    // Globální callback pro popup tlačítko
    (window as any)._oltecSelectLoc = (id: number) => {
      const loc = locations.find(l => l.id === id);
      if (loc) onSelectLocation?.(loc);
    };

    return () => { delete (window as any)._oltecSelectLoc; };
  }, [locations, selectedId, locationTypes]); // eslint-disable-line react-hooks/exhaustive-deps

  // Přilet na vybranou lokaci
  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const loc = locations.find(l => l.id === selectedId);
    if (loc && loc.lat && loc.lng) mapRef.current.flyTo([loc.lat, loc.lng], Math.max(mapRef.current.getZoom(), 18), { duration: 0.5 });
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!mapRef.current) return;
    labelsRef.current.forEach(l => {
      if (showLabels) {
        mapRef.current!.addLayer(l);
      } else {
        mapRef.current!.removeLayer(l);
      }
    });
  }, [showLabels]);

  return (
    <div className="relative w-full h-full">
      {/* Toolbar */}
      <div className="absolute top-3 right-4 z-[1000] flex gap-2">
        {/* Přepínač vrstev */}
        <div className="flex rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow overflow-hidden">
          {(Object.keys(TILE_LAYERS) as TileLayerKey[]).map((key) => (
            <button
              key={key}
              onClick={() => setActiveLayer(key)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                activeLayer === key
                  ? "bg-primary text-primary-foreground"
                  : "text-muted-foreground hover:bg-muted"
              }`}
            >
              {TILE_LAYERS[key].label}
            </button>
          ))}
        </div>
        {/* Popisky */}
        <button
          onClick={() => setShowLabels(v => !v)}
          title={showLabels ? "Skrýt popisky" : "Zobrazit popisky"}
          className="flex items-center gap-1.5 h-8 px-3 rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow text-xs font-medium hover:bg-muted transition-colors"
        >
          {showLabels
            ? <><Eye className="h-3.5 w-3.5" />Popisky</>
            : <><EyeOff className="h-3.5 w-3.5" />Popisky</>}
        </button>
      </div>

      {/* Loading */}
      {loading && (
        <div className="absolute inset-0 z-[999] flex items-center justify-center bg-background/60">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-5 w-5 animate-spin" />
            Načítám mapu areálu…
          </div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 z-[999] bg-destructive/10 text-destructive border border-destructive/30 rounded-lg px-4 py-2 text-sm">
          {error}
        </div>
      )}

      {/* Mapa */}
      <div ref={mapDivRef} className="w-full h-full" />
    </div>
  );
}
