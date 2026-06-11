"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";
import { Loader2 } from "lucide-react";
import { useLocationsMap, useConfigList, useLocations } from "@/hooks/useNetPulse";
import { LocationPanel } from "@/components/locations/LocationPanel";
import type { LocationMapPoint, Location } from "@/lib/types";

// Dynamický import — Leaflet nefunguje v SSR
const OltecMapView = dynamic(
  () => import("@/components/locations/OltecMapView"),
  {
    ssr: false,
    loading: () => (
      <div className="flex-1 flex items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-primary" />
      </div>
    ),
  }
);

// Název top-level lokace OLTEC — filtrujeme podle něj
const OLTEC_ROOT_NAME = "OLTEC - Hybešova46/Václavská6";

export default function OltecMapPage() {
  const { data: mapPoints  = [], isLoading } = useLocationsMap();
  const { data: locationTypes = [] }         = useConfigList("location_type", false);
  const { data: allLocations  = [] }         = useLocations(false);
  const [selectedMapPoint, setSelectedMapPoint] = useState<LocationMapPoint | null>(null);

  // Najdeme ID root lokace OLTEC
  const oltecRootId = useMemo(() =>
    allLocations.find(l => l.name === OLTEC_ROOT_NAME)?.id ?? null,
    [allLocations]
  );

  // Rekurzivně sbíráme IDs — OLTEC root + všechny podřízené
  const oltecIds = useMemo(() => {
    if (!oltecRootId) return new Set<number>();
    const ids = new Set<number>();
    const queue = [oltecRootId];
    while (queue.length) {
      const id = queue.shift()!;
      ids.add(id);
      allLocations
        .filter(l => l.parent_id === id)
        .forEach(l => { if (l.id) queue.push(l.id); });
    }
    return ids;
  }, [oltecRootId, allLocations]);

  // Filtrujeme mapPoints pouze na OLTEC a podřízené
  const oltecPoints = useMemo(() =>
    mapPoints.filter(p => oltecIds.has(p.id)),
    [mapPoints, oltecIds]
  );

  // Plná data lokace pro LocationPanel
  const selectedLocation = useMemo<Location | null>(() => {
    if (!selectedMapPoint) return null;
    return (allLocations.find(l => l.id === selectedMapPoint.id) ?? null) as Location | null;
  }, [selectedMapPoint, allLocations]);

  return (
    <div className="flex h-full">
      <div className="flex-1 min-w-0 relative">
        <OltecMapView
          locations={oltecPoints}
          locationTypes={locationTypes}
          isLoading={isLoading}
          onSelectLocation={(loc) => setSelectedMapPoint(
            prev => prev?.id === loc?.id ? null : loc
          )}
          selectedId={selectedMapPoint?.id ?? null}
        />
      </div>

      {/* Detail panel */}
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
