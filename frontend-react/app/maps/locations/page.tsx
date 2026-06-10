"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useLocationsMap, useConfigList, useLocations } from "@/hooks/useNetPulse";
import { LocationPanel } from "@/components/locations/LocationPanel";
import type { LocationMapPoint, Location } from "@/lib/types";

// Dynamický import — Leaflet nefunguje v SSR
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

export default function LocationsMapPage() {
  const { data: mapPoints = [],    isLoading }   = useLocationsMap();
  const { data: locationTypes = [] } = useConfigList("location_type", false);
  const { data: allLocations = [] }              = useLocations(false);
  const [selectedMapPoint, setSelectedMapPoint]  = useState<LocationMapPoint | null>(null);

  // Najdeme plná data lokace pro LocationPanel (pro edit, delete atd.)
  const selectedLocation = useMemo<Location | null>(() => {
    if (!selectedMapPoint) return null;
    return (allLocations.find(l => l.id === selectedMapPoint.id) ?? null) as Location | null;
  }, [selectedMapPoint, allLocations]);

  function handleSelectLocation(loc: LocationMapPoint | null) {
    setSelectedMapPoint(loc);
  }

  return (
    <div className="flex h-full">
      {/* Mapa — zabere zbývající šířku */}
      <div className="flex-1 min-w-0 relative">
        <LocationsMapView
          locations={mapPoints}
          locationTypes={locationTypes}
          isLoading={isLoading}
          onSelectLocation={handleSelectLocation}
          selectedId={selectedMapPoint?.id ?? null}
        />
      </div>

      {/* Detail panel — side drawer */}
      {selectedLocation && (
        <div className="w-[520px] shrink-0 border-l border-border overflow-hidden flex flex-col">
          <LocationPanel
            location={selectedLocation}
            onClose={() => setSelectedMapPoint(null)}
          />
        </div>
      )}
    </div>
  );
}
