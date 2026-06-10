"use client";

import { useEffect, useRef, useState, useMemo, useCallback } from "react";
import L from "leaflet";
import "leaflet.markercluster";
import { Search, X, ChevronLeft, ChevronRight,
         Wifi, WifiOff, Building2, Loader2 } from "lucide-react";
import type { LocationMapPoint, ConfigItem } from "@/lib/types";

// ---------------------------------------------------------------------------
// Fix default Leaflet icons
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
// Výchozí střed — Brno (přednastaven dle požadavku)
// ---------------------------------------------------------------------------
const DEFAULT_CENTER: [number, number] = [49.1970767, 16.6185331];
const DEFAULT_ZOOM = 14;

// ---------------------------------------------------------------------------
// DivIcon — barevný kroužek s emoji ikonou
// ---------------------------------------------------------------------------
const STATUS_COLORS = {
  ok:      "#22c55e",
  partial: "#f59e0b",
  offline: "#ef4444",
  empty:   "#94a3b8",
};

function getStatusColor(loc: LocationMapPoint): string {
  if (loc.total_devices === 0) return STATUS_COLORS.empty;
  if (loc.offline_count === 0) return STATUS_COLORS.ok;
  if (loc.online_count === 0)  return STATUS_COLORS.offline;
  return STATUS_COLORS.partial;
}

function makeDivIcon(emoji: string, color: string, selected: boolean): L.DivIcon {
  const size   = selected ? 44 : 36;
  const border = selected ? "3px solid #3b82f6" : "2px solid white";
  return L.divIcon({
    className: "",
    html: `<div style="
      width:${size}px;height:${size}px;border-radius:50%;
      background:${color};border:${border};
      box-shadow:0 2px 6px rgba(0,0,0,0.35);
      display:flex;align-items:center;justify-content:center;
      font-size:${selected ? 20 : 16}px;cursor:pointer;
      transition:all 0.15s;
    ">${emoji}</div>`,
    iconSize:    [size, size],
    iconAnchor:  [size / 2, size / 2],
    popupAnchor: [0, -(size / 2 + 4)],
  });
}

// ---------------------------------------------------------------------------
// Popup HTML (jen pro hover — bez tlačítka Detail)
// ---------------------------------------------------------------------------
function buildPopupHtml(loc: LocationMapPoint, typeLabel: string): string {
  const addr = [loc.street, loc.city].filter(Boolean).join(", ") || loc.country || "";
  const statusColor = getStatusColor(loc);
  return `
    <div style="min-width:190px;font-family:system-ui,sans-serif;">
      <div style="font-weight:600;font-size:13px;margin-bottom:3px;">${loc.name}</div>
      <div style="font-size:11px;color:#64748b;margin-bottom:6px;">${typeLabel}${addr ? " · " + addr : ""}</div>
      ${loc.parent_name ? `<div style="font-size:11px;color:#64748b;margin-bottom:5px;">↑ ${loc.parent_name}</div>` : ""}
      <div style="border-top:1px solid #e2e8f0;padding-top:5px;">
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
          <span>Celkem zařízení</span><strong>${loc.total_devices}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:2px;">
          <span style="color:#22c55e;">● Online</span><strong>${loc.online_count}</strong>
        </div>
        <div style="display:flex;justify-content:space-between;font-size:12px;margin-bottom:4px;">
          <span style="color:#ef4444;">● Offline</span><strong>${loc.offline_count}</strong>
        </div>
        ${loc.children_count > 0 ? `
        <div style="display:flex;justify-content:space-between;font-size:11px;color:#64748b;">
          <span>Podřízených lok.</span><strong>${loc.children_count}</strong>
        </div>` : ""}
        <div style="display:flex;align-items:center;gap:5px;margin-top:4px;padding-top:4px;border-top:1px solid #e2e8f0;">
          <div style="width:8px;height:8px;border-radius:50%;background:${statusColor};flex-shrink:0;"></div>
          <span style="font-size:10px;color:#64748b;">
            ${loc.total_devices === 0 ? "Bez zařízení"
              : loc.offline_count === 0 ? "Vše online"
              : loc.online_count === 0  ? "Vše offline"
              : `${loc.online_count}/${loc.total_devices} online`}
          </span>
          <span style="margin-left:auto;font-size:10px;color:#94a3b8;">klik = detail</span>
        </div>
      </div>
    </div>
  `;
}

// ---------------------------------------------------------------------------
// Nominatim suggest item
// ---------------------------------------------------------------------------
interface GeoSuggest {
  display_name: string;
  lat: string;
  lon: string;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface LocationsMapViewProps {
  locations:        LocationMapPoint[];
  locationTypes:    ConfigItem[];
  isLoading:        boolean;
  onSelectLocation: (loc: LocationMapPoint | null) => void;
  selectedId:       number | null;
}

// ---------------------------------------------------------------------------
// Hlavní komponenta
// ---------------------------------------------------------------------------
export default function LocationsMapView({
  locations,
  locationTypes,
  isLoading,
  onSelectLocation,
  selectedId,
}: LocationsMapViewProps) {
  fixLeafletIcons();

  const mapRef     = useRef<L.Map | null>(null);
  const mapDivRef  = useRef<HTMLDivElement>(null);
  const clusterRef = useRef<L.MarkerClusterGroup | null>(null);
  const markersRef = useRef<Map<number, L.Marker>>(new Map());

  // Sidebar
  const [sidebarOpen,  setSidebarOpen]  = useState(true);
  const [searchQuery,  setSearchQuery]  = useState("");
  const [activeTypes,  setActiveTypes]  = useState<Set<string>>(new Set());
  const [deviceFilter, setDeviceFilter] = useState<"all" | "with_offline" | "empty">("all");

  // Geocoding searchbox v mapě
  const [geoQuery,     setGeoQuery]     = useState("");
  const [geoResults,   setGeoResults]   = useState<GeoSuggest[]>([]);
  const [geoSearching, setGeoSearching] = useState(false);
  const geoDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // TypeMap
  const typeMap = useMemo(() =>
    Object.fromEntries(locationTypes.map(t => [t.value, t])),
    [locationTypes]
  );

  const DEFAULT_ICONS: Record<string, string> = {
    region: "🗺️", city: "🏙️", building: "🏢", floor: "📐",
    apartment: "🏠", byt: "🏠", office: "💼", rack: "🖥️",
    soil: "🏚️", outdoor: "📡", other: "📍",
  };

  function getIcon(type: string): string {
    const configured = typeMap[type]?.icon;
    return (configured && configured.trim()) || DEFAULT_ICONS[type] || "📍";
  }

  function getTypeLabel(type: string): string {
    return typeMap[type]?.label || type;
  }

  // Filtrování lokací
  const filtered = useMemo(() => {
    const q = searchQuery.toLowerCase().trim();
    return locations.filter(loc => {
      if (activeTypes.size > 0 && !activeTypes.has(loc.type)) return false;
      if (deviceFilter === "with_offline" && loc.offline_count === 0) return false;
      if (deviceFilter === "empty" && loc.total_devices > 0) return false;
      if (q) {
        const name = loc.name.toLowerCase();
        const city = (loc.city ?? "").toLowerCase();
        const addr = (loc.street ?? "").toLowerCase();
        if (!name.includes(q) && !city.includes(q) && !addr.includes(q)) return false;
      }
      return true;
    });
  }, [locations, activeTypes, deviceFilter, searchQuery]);

  // ---------------------------------------------------------------------------
  // Geocoding s debounce
  // ---------------------------------------------------------------------------
  const handleGeoInput = useCallback((val: string) => {
    setGeoQuery(val);
    setGeoResults([]);
    if (geoDebounceRef.current) clearTimeout(geoDebounceRef.current);
    if (!val.trim() || val.length < 3) return;
    geoDebounceRef.current = setTimeout(async () => {
      setGeoSearching(true);
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(val)}&limit=5&addressdetails=0`;
        const resp = await fetch(url, { headers: { "Accept-Language": "cs" } });
        const data: GeoSuggest[] = await resp.json();
        setGeoResults(data);
      } catch {}
      finally { setGeoSearching(false); }
    }, 400);
  }, []);

  function handleGeoSelect(item: GeoSuggest) {
    const lat = parseFloat(item.lat);
    const lng = parseFloat(item.lon);
    if (mapRef.current) {
      mapRef.current.flyTo([lat, lng], 16, { duration: 0.8 });
    }
    setGeoQuery(item.display_name.split(",")[0]);
    setGeoResults([]);
  }

  // ---------------------------------------------------------------------------
  // Inicializace mapy
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!mapDivRef.current || mapRef.current) return;

    const map = L.map(mapDivRef.current, {
      center:      DEFAULT_CENTER,
      zoom:        DEFAULT_ZOOM,
      zoomControl: true,
    });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(map);

    const cluster = (L as any).markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 50,
      iconCreateFunction: (c: any) => {
        const count = c.getChildCount();
        return L.divIcon({
          className: "",
          html: `<div style="
            width:40px;height:40px;border-radius:50%;
            background:#3b82f6;color:white;
            border:3px solid white;
            box-shadow:0 2px 8px rgba(0,0,0,0.3);
            display:flex;align-items:center;justify-content:center;
            font-size:13px;font-weight:600;cursor:pointer;
          ">${count}</div>`,
          iconSize: [40, 40], iconAnchor: [20, 20],
        });
      },
    });

    map.addLayer(cluster);
    mapRef.current     = map;
    clusterRef.current = cluster;

    (window as any)._netpulseSelectLoc = (id: number) => {
      const loc = locations.find(l => l.id === id);
      if (loc) onSelectLocation(loc);
    };

    return () => {
      delete (window as any)._netpulseSelectLoc;
      map.remove();
      mapRef.current     = null;
      clusterRef.current = null;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Aktualizace markerů
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const cluster = clusterRef.current;
    const map     = mapRef.current;
    if (!cluster || !map) return;

    cluster.clearLayers();
    markersRef.current.clear();

    (window as any)._netpulseSelectLoc = (id: number) => {
      const loc = locations.find(l => l.id === id);
      if (loc) onSelectLocation(loc);
    };

    filtered.forEach(loc => {
      const emoji    = getIcon(loc.type);
      const color    = getStatusColor(loc);
      const selected = loc.id === selectedId;
      const divIcon  = makeDivIcon(emoji, color, selected);

      const marker = L.marker([loc.lat, loc.lng], { icon: divIcon });
      const popupContent = buildPopupHtml(loc, getTypeLabel(loc.type));

      // Popup na HOVER
      marker.bindPopup(popupContent, {
        maxWidth:    260,
        closeButton: false,
        autoClose:   true,
        // Malé zpoždění aby se nezavřel při přejíždění přes okraj markeru
      });
      marker.on("mouseover", () => { marker.openPopup(); });
      marker.on("mouseout",  () => { marker.closePopup(); });

      // Click = otevři detail panel (popup se zavře automaticky díky autoClose)
      marker.on("click", () => {
        marker.closePopup();
        onSelectLocation(loc);
      });

      cluster.addLayer(marker);
      markersRef.current.set(loc.id, marker);
    });

    if (filtered.length > 0 && filtered.length < locations.length) {
      try {
        const group = L.featureGroup(filtered.map(l => L.marker([l.lat, l.lng])));
        map.fitBounds(group.getBounds().pad(0.1));
      } catch {}
    }
  }, [filtered, selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Přilet na vybranou lokaci (bez otevření popupu — popup je na hover)
  useEffect(() => {
    if (!selectedId || !mapRef.current) return;
    const loc = locations.find(l => l.id === selectedId);
    if (loc) {
      mapRef.current.flyTo([loc.lat, loc.lng], Math.max(mapRef.current.getZoom(), 15), { duration: 0.6 });
    }
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------------------------------------------------------------------------
  // Sidebar helpers
  // ---------------------------------------------------------------------------
  const availableTypes = useMemo(() =>
    locationTypes.filter(t => locations.some(l => l.type === t.value)),
    [locationTypes, locations]
  );

  function toggleType(value: string) {
    setActiveTypes(prev => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value); else next.add(value);
      return next;
    });
  }

  const sidebarSearchResults = useMemo(() => {
    if (!searchQuery.trim()) return [];
    const q = searchQuery.toLowerCase();
    return locations
      .filter(l => l.name.toLowerCase().includes(q) || (l.city ?? "").toLowerCase().includes(q))
      .slice(0, 6);
  }, [searchQuery, locations]);

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------
  return (
    <div className="flex h-full relative">

      {/* ── Sidebar ── */}
      <div className={`flex-none border-r border-border bg-background overflow-y-auto transition-all duration-200
        ${sidebarOpen ? "w-64" : "w-0 overflow-hidden"}`}>
        {sidebarOpen && (
          <div className="p-3 space-y-4 w-64">

            {/* Vyhledávání v lokacích (filtr tabulky) */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Filtr lokací
              </p>
              <div className="relative">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Název lokace, město…"
                  className="w-full h-8 rounded-md border border-border bg-background pl-7 pr-7 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
                />
                {searchQuery && (
                  <button onClick={() => setSearchQuery("")}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              {sidebarSearchResults.length > 0 && (
                <div className="mt-1 rounded-md border border-border bg-background shadow-sm overflow-hidden">
                  {sidebarSearchResults.map(loc => (
                    <button key={loc.id}
                      onClick={() => {
                        onSelectLocation(loc);
                        if (mapRef.current) mapRef.current.flyTo([loc.lat, loc.lng], 17, { duration: 0.6 });
                        setSearchQuery("");
                      }}
                      className="w-full text-left px-3 py-2 text-xs hover:bg-muted/50 border-b border-border last:border-0">
                      <div className="font-medium truncate">{getIcon(loc.type)} {loc.name}</div>
                      {loc.city && <div className="text-muted-foreground">{loc.city}</div>}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Filtr typů */}
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Typy lokací
                </p>
                {activeTypes.size > 0 && (
                  <button onClick={() => setActiveTypes(new Set())}
                    className="text-[10px] text-primary hover:underline">Vše</button>
                )}
              </div>
              <div className="space-y-1">
                {availableTypes.map(t => (
                  <button key={t.value} onClick={() => toggleType(t.value)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors
                      ${activeTypes.has(t.value) || activeTypes.size === 0
                        ? "text-foreground" : "text-muted-foreground opacity-50"}`}>
                    <span className="text-base leading-none">{getIcon(t.value)}</span>
                    <span className="flex-1 text-left">{t.label}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {locations.filter(l => l.type === t.value).length}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            {/* Filtr zařízení */}
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                Stav zařízení
              </p>
              <div className="space-y-1">
                {([
                  ["all",          "Vše",          Wifi],
                  ["with_offline", "S offline",    WifiOff],
                  ["empty",        "Bez zařízení", Building2],
                ] as const).map(([val, label, Icon]) => (
                  <button key={val} onClick={() => setDeviceFilter(val)}
                    className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors
                      ${deviceFilter === val
                        ? "bg-primary/10 text-primary font-medium"
                        : "hover:bg-muted/50 text-muted-foreground"}`}>
                    <Icon className="h-3.5 w-3.5" />
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {/* Statistika */}
            <div className="border-t border-border pt-3">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-2">
                Zobrazeno
              </p>
              <div className="space-y-1 text-xs text-muted-foreground">
                <div className="flex justify-between">
                  <span>Lokací na mapě</span>
                  <strong className="text-foreground">{filtered.length}</strong>
                </div>
                <div className="flex justify-between">
                  <span>Celkem lokací s GPS</span>
                  <strong className="text-foreground">{locations.length}</strong>
                </div>
              </div>
            </div>

          </div>
        )}
      </div>

      {/* Toggle sidebar */}
      <button
        onClick={() => setSidebarOpen(o => !o)}
        className="absolute top-3 z-[1000] flex items-center justify-center w-5 h-10 bg-background border border-border rounded-r-md shadow-sm hover:bg-muted transition-colors"
        style={{ left: sidebarOpen ? "256px" : "0px", transition: "left 0.2s" }}
        title={sidebarOpen ? "Skrýt panel" : "Zobrazit panel"}
      >
        {sidebarOpen
          ? <ChevronLeft className="h-3 w-3 text-muted-foreground" />
          : <ChevronRight className="h-3 w-3 text-muted-foreground" />}
      </button>

      {/* ── Mapa ── */}
      <div className="flex-1 relative">

        {/* Geocoding searchbox — overlay nad mapou */}
        <div className="absolute top-3 left-1/2 -translate-x-1/2 z-[1000] w-80">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <input
              type="text"
              value={geoQuery}
              onChange={e => handleGeoInput(e.target.value)}
              placeholder="Hledat místo na mapě…"
              className="w-full h-9 rounded-lg border border-border bg-background/95 backdrop-blur-sm pl-9 pr-8 text-sm shadow-md placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
            />
            {geoSearching && (
              <Loader2 className="absolute right-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 animate-spin text-muted-foreground" />
            )}
            {geoQuery && !geoSearching && (
              <button onClick={() => { setGeoQuery(""); setGeoResults([]); }}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
          </div>

          {/* Našeptávač výsledků */}
          {geoResults.length > 0 && (
            <div className="mt-1 rounded-lg border border-border bg-background/95 backdrop-blur-sm shadow-lg overflow-hidden">
              {geoResults.map((item, i) => (
                <button key={i} onClick={() => handleGeoSelect(item)}
                  className="w-full text-left px-3 py-2.5 text-xs hover:bg-muted/60 border-b border-border last:border-0 transition-colors">
                  <div className="font-medium truncate">{item.display_name.split(",")[0]}</div>
                  <div className="text-muted-foreground truncate text-[10px] mt-0.5">
                    {item.display_name.split(",").slice(1, 3).join(",")}
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Loading overlay */}
        {isLoading && (
          <div className="absolute inset-0 z-[999] flex items-center justify-center bg-background/60">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        )}

        {/* Leaflet container */}
        <div ref={mapDivRef} className="w-full h-full" />

        {/* Legenda */}
        <div className="absolute bottom-6 right-4 z-[999] bg-background/90 backdrop-blur-sm border border-border rounded-lg px-3 py-2 space-y-1 shadow-md">
          {[
            ["#22c55e", "Vše online"],
            ["#f59e0b", "Částečně offline"],
            ["#ef4444", "Offline"],
            ["#94a3b8", "Bez zařízení"],
          ].map(([color, label]) => (
            <div key={label} className="flex items-center gap-2 text-xs">
              <div className="w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
              <span className="text-muted-foreground">{label}</span>
            </div>
          ))}
        </div>

      </div>
    </div>
  );
}
