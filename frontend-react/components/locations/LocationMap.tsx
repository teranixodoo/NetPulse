"use client";

/**
 * LocationMap — Leaflet mapa pro detail lokace
 * Dynamicky importovaný (no SSR) kvůli Next.js + Leaflet kompatibilitě.
 *
 * Použití:
 *   import LocationMapDynamic from "@/components/locations/LocationMap";
 *   <LocationMapDynamic lat={50.0755} lng={14.4378} name="Praha" />
 */

import { useEffect, useRef } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";

// Fix: Next.js bundler nedokáže správně zpracovat výchozí ikony Leafletu
// (webpack přepíše URL assetů) — nastavíme ikony ručně
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

// Pomocná komponenta: při změně souřadnic flyTo na novou pozici
function MapUpdater({ lat, lng }: { lat: number; lng: number }) {
  const map = useMap();
  const prevRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    const prev = prevRef.current;
    if (!prev || prev.lat !== lat || prev.lng !== lng) {
      map.flyTo([lat, lng], map.getZoom(), { duration: 0.8 });
      prevRef.current = { lat, lng };
    }
  }, [lat, lng, map]);

  return null;
}

export interface LocationMapProps {
  lat:      number;
  lng:      number;
  name?:    string;
  height?:  number; // px, výchozí 220
  zoom?:    number; // výchozí 15
}

export default function LocationMap({
  lat,
  lng,
  name,
  height = 220,
  zoom   = 15,
}: LocationMapProps) {
  // Oprava ikon při každém renderu (idempotentní)
  fixLeafletIcons();

  return (
    <div
      style={{ height }}
      className="w-full rounded-lg overflow-hidden border border-border"
    >
      <MapContainer
        center={[lat, lng]}
        zoom={zoom}
        style={{ height: "100%", width: "100%" }}
        scrollWheelZoom={false}
        attributionControl={true}
      >
        <TileLayer
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        />
        <Marker position={[lat, lng]}>
          {name && (
            <Popup>
              <span className="text-sm font-medium">{name}</span>
              <br />
              <span className="text-xs text-gray-500">
                {lat.toFixed(5)}, {lng.toFixed(5)}
              </span>
            </Popup>
          )}
        </Marker>
        <MapUpdater lat={lat} lng={lng} />
      </MapContainer>
    </div>
  );
}
