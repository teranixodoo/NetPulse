"use client";

/**
 * InteractiveLocationMap — editovatelná Leaflet mapa pro EditPanel lokace.
 *
 * Funkce:
 * - Searchbox předvyplněný z adresy formuláře → vyhledá místo, přesune marker
 * - Klik na mapu → přesune marker, aktualizuje lat/lng
 * - Drag markeru → aktualizuje lat/lng (adresa se NEpřepisuje)
 * - Pokud nejsou souřadnice → mapa zobrazí ČR jako výchozí pohled
 *
 * Dynamicky importovat (no SSR):
 *   const InteractiveLocationMap = dynamic(
 *     () => import("@/components/locations/InteractiveLocationMap"),
 *     { ssr: false }
 *   );
 */

import { useEffect, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, useMapEvents, useMap } from "react-leaflet";
import L from "leaflet";
import { Loader2, Search, X } from "lucide-react";

// ---------------------------------------------------------------------------
// Fix Leaflet default icons (webpack/Next.js asset URL issue)
// ---------------------------------------------------------------------------
function fixLeafletIcons() {
  // @ts-ignore
  delete L.Icon.Default.prototype._getIconUrl;
  L.Icon.Default.mergeOptions({
    iconUrl:       "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png",
    iconRetinaUrl: "https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png",
    shadowUrl:     "https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png",
    iconSize:    [25, 41],
    iconAnchor:  [12, 41],
    popupAnchor: [1, -34],
    shadowSize:  [41, 41],
  });
}

// ---------------------------------------------------------------------------
// Výchozí pohled — střed ČR pokud nejsou souřadnice
// ---------------------------------------------------------------------------
const CZ_CENTER: [number, number] = [49.8, 15.5];
const CZ_ZOOM = 7;

// ---------------------------------------------------------------------------
// Vnitřní komponenta: reaguje na klik na mapu
// ---------------------------------------------------------------------------
function MapClickHandler({
  onMapClick,
}: {
  onMapClick: (lat: number, lng: number) => void;
}) {
  useMapEvents({
    click(e) {
      onMapClick(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

// ---------------------------------------------------------------------------
// Vnitřní komponenta: přelétá na nové souřadnice při změně
// ---------------------------------------------------------------------------
function MapFlyTo({ lat, lng, trigger }: { lat: number; lng: number; trigger: number }) {
  const map = useMap();
  const prevTrigger = useRef(-1);
  useEffect(() => {
    if (trigger !== prevTrigger.current) {
      map.flyTo([lat, lng], Math.max(map.getZoom(), 14), { duration: 0.8 });
      prevTrigger.current = trigger;
    }
  }, [trigger, lat, lng, map]);
  return null;
}

// ---------------------------------------------------------------------------
// Draggable marker
// ---------------------------------------------------------------------------
function DraggableMarker({
  position,
  onDragEnd,
}: {
  position: [number, number];
  onDragEnd: (lat: number, lng: number) => void;
}) {
  const markerRef = useRef<L.Marker>(null);

  return (
    <Marker
      position={position}
      draggable={true}
      ref={markerRef}
      eventHandlers={{
        dragend() {
          const m = markerRef.current;
          if (m) {
            const { lat, lng } = m.getLatLng();
            onDragEnd(lat, lng);
          }
        },
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// Nominatim vyhledávání
// ---------------------------------------------------------------------------
async function nominatimSearch(query: string): Promise<{ lat: number; lng: number } | null> {
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=1`;
  const resp = await fetch(url, { headers: { "Accept-Language": "cs" } });
  const data = await resp.json();
  if (!data[0]) return null;
  return { lat: parseFloat(data[0].lat), lng: parseFloat(data[0].lon) };
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------
export interface InteractiveLocationMapProps {
  lat:     string;       // aktuální hodnota z formuláře (může být "")
  lng:     string;       // aktuální hodnota z formuláře (může být "")
  // Adresní pole pro předvyplnění searchboxu
  street:  string;
  city:    string;
  zip:     string;
  country: string;
  // Callbacky — pouze souřadnice (adresa se při dragu/klik NEpřepisuje)
  onCoordsChange: (lat: string, lng: string) => void;
  height?: number; // px, výchozí 220
}

// ---------------------------------------------------------------------------
// Hlavní komponenta
// ---------------------------------------------------------------------------
export default function InteractiveLocationMap({
  lat,
  lng,
  street,
  city,
  zip,
  country,
  onCoordsChange,
  height = 220,
}: InteractiveLocationMapProps) {
  fixLeafletIcons();

  // Sestavíme výchozí text searchboxu z adresních polí formuláře
  const addressHint = [street, city, zip, country].filter(Boolean).join(", ");

  const [searchQuery,  setSearchQuery]  = useState(addressHint);
  const [searching,    setSearching]    = useState(false);
  const [searchError,  setSearchError]  = useState<string | null>(null);
  const [flyTrigger,   setFlyTrigger]   = useState(0);

  // Aktuální poloha markeru — number nebo null
  const markerLat = lat && !isNaN(Number(lat)) ? Number(lat) : null;
  const markerLng = lng && !isNaN(Number(lng)) ? Number(lng) : null;
  const hasCoords = markerLat !== null && markerLng !== null;

  // Aktualizujeme searchbox pokud se změní adresa ve formuláři
  // (ale jen pokud uživatel do searchboxu nic nepsal)
  const lastHint = useRef(addressHint);
  useEffect(() => {
    const newHint = [street, city, zip, country].filter(Boolean).join(", ");
    if (newHint !== lastHint.current) {
      setSearchQuery(newHint);
      lastHint.current = newHint;
    }
  }, [street, city, zip, country]);

  // Společná funkce pro update souřadnic z mapy
  function updateCoords(newLat: number, newLng: number) {
    onCoordsChange(newLat.toFixed(6), newLng.toFixed(6));
  }

  // Klik na mapu nebo drag markeru
  function handleMapClick(newLat: number, newLng: number) {
    updateCoords(newLat, newLng);
  }

  function handleDragEnd(newLat: number, newLng: number) {
    updateCoords(newLat, newLng);
  }

  // Vyhledání adresy
  async function handleSearch() {
    const q = searchQuery.trim();
    if (!q) return;
    setSearching(true);
    setSearchError(null);
    try {
      const result = await nominatimSearch(q);
      if (result) {
        updateCoords(result.lat, result.lng);
        setFlyTrigger(t => t + 1);
      } else {
        setSearchError("Místo nenalezeno");
      }
    } catch {
      setSearchError("Chyba vyhledávání");
    } finally {
      setSearching(false);
    }
  }

  function handleSearchKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      handleSearch();
    }
  }

  const mapCenter: [number, number] = hasCoords
    ? [markerLat!, markerLng!]
    : CZ_CENTER;
  const mapZoom = hasCoords ? 18 : CZ_ZOOM;

  return (
    <div className="space-y-2">
      {/* Searchbox */}
      <div className="flex gap-1.5">
        <div className="relative flex-1">
          <input
            type="text"
            value={searchQuery}
            onChange={e => { setSearchQuery(e.target.value); setSearchError(null); }}
            onKeyDown={handleSearchKeyDown}
            placeholder="Vyhledat adresu nebo místo…"
            className="w-full h-8 rounded-md border border-border bg-background pl-3 pr-7 text-xs placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => { setSearchQuery(""); setSearchError(null); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>
        <button
          type="button"
          onClick={handleSearch}
          disabled={searching || !searchQuery.trim()}
          className="h-8 px-2.5 inline-flex items-center gap-1 rounded-md border border-border bg-background text-xs text-foreground hover:bg-muted disabled:opacity-40 transition-colors"
        >
          {searching
            ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
            : <Search className="h-3.5 w-3.5" />}
        </button>
      </div>

      {searchError && (
        <p className="text-xs text-destructive">{searchError}</p>
      )}

      {/* Mapa */}
      <div
        style={{ height }}
        className="w-full rounded-lg overflow-hidden border border-border"
      >
        <MapContainer
          center={mapCenter}
          zoom={mapZoom}
          style={{ height: "100%", width: "100%" }}
          scrollWheelZoom={false}
        >
          <TileLayer
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          />

          {hasCoords && (
            <>
              <DraggableMarker
                position={[markerLat!, markerLng!]}
                onDragEnd={handleDragEnd}
              />
              <MapFlyTo
                lat={markerLat!}
                lng={markerLng!}
                trigger={flyTrigger}
              />
            </>
          )}

          <MapClickHandler onMapClick={handleMapClick} />
        </MapContainer>
      </div>

      {/* Nápověda */}
      <p className="text-[10px] text-muted-foreground">
        {hasCoords
          ? "Táhni značku nebo klikni na mapu pro upřesnění polohy."
          : "Klikni na mapu nebo vyhledej adresu pro zadání polohy."}
      </p>
    </div>
  );
}
