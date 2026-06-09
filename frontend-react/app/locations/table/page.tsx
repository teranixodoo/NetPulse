"use client";

import { useState, useMemo } from "react";
import { ArrowUpDown, ArrowUp, ArrowDown } from "lucide-react";
import { MapPin, ChevronRight, ChevronDown, Building2, Home, Server, PanelRightOpen, Plus } from "lucide-react";
import { useLocationsTable, useLocations } from "@/hooks/useNetPulse";
import { TableSearch } from "@/components/table/DataTable";
import { MetricCard, Button } from "@/components/ui";
import { LocationPanel, CreateLocationPanel } from "@/components/locations/LocationPanel";
import type { Location } from "@/lib/types";

// Ikona podle typu lokace
function LocationTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "building": return <Building2 className="h-3.5 w-3.5 text-blue-500" />;
    case "floor":    return <Home      className="h-3.5 w-3.5 text-green-500" />;
    case "room":     return <Server    className="h-3.5 w-3.5 text-amber-500" />;
    default:         return <MapPin    className="h-3.5 w-3.5 text-muted-foreground" />;
  }
}

// Badge online/offline
function StatBadge({ value, color }: { value: number; color: "green" | "red" | "gray" }) {
  const cls = {
    green: "bg-green-100 text-green-700 dark:bg-green-950/40 dark:text-green-400",
    red:   "bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400",
    gray:  "bg-muted text-muted-foreground",
  }[color];
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {value}
    </span>
  );
}

// Jeden řádek lokace
function LocationRow({
  loc,
  depth = 0,
  allLocs,
  searchQuery,
  selectedId,
  onDetail,
}: {
  loc: any;
  depth?: number;
  allLocs: any[];
  searchQuery: string;
  selectedId: number | null;
  onDetail: (loc: any) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const children = useMemo(
    () => allLocs.filter(l => l.parent_id === loc.id),
    [allLocs, loc.id]
  );
  const hasChildren = children.length > 0;
  const isSelected  = selectedId === loc.id;

  return (
    <>
      <tr className={`border-b border-border transition-colors ${isSelected ? "bg-primary/5" : "hover:bg-muted/30"}`}>
        {/* Název */}
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
            <button
              onClick={() => setExpanded(e => !e)}
              className="shrink-0 text-muted-foreground hover:text-foreground"
              disabled={!hasChildren}
            >
              {hasChildren
                ? expanded
                  ? <ChevronDown className="h-3.5 w-3.5" />
                  : <ChevronRight className="h-3.5 w-3.5" />
                : <span className="w-3.5" />}
            </button>
            <LocationTypeIcon type={loc.type} />
            <span className="text-sm font-medium">{loc.name}</span>
            {!loc.active && (
              <span className="text-[10px] text-muted-foreground border border-border rounded px-1">
                neaktivní
              </span>
            )}
          </div>
        </td>
        {/* Typ */}
        <td className="px-3 py-2.5 text-sm text-muted-foreground">{loc.type ?? "—"}</td>
        {/* Nadřazená */}
        <td className="px-3 py-2.5 text-sm text-muted-foreground">{loc.parent_name ?? "—"}</td>
        {/* Podřízených */}
        <td className="px-3 py-2.5 text-center">
          {hasChildren
            ? <StatBadge value={loc.children_count} color="gray" />
            : <span className="text-muted-foreground text-sm">—</span>}
        </td>
        {/* Zařízení přímá */}
        <td className="px-3 py-2.5 text-center text-sm">
          {loc.device_count > 0 ? loc.device_count : <span className="text-muted-foreground">—</span>}
        </td>
        {/* Celkem zař. */}
        <td className="px-3 py-2.5 text-center text-sm font-medium">
          {loc.total_device_count > 0 ? loc.total_device_count : <span className="text-muted-foreground">—</span>}
        </td>
        {/* Online */}
        <td className="px-3 py-2.5 text-center">
          {loc.online_count > 0
            ? <StatBadge value={loc.online_count} color="green" />
            : <span className="text-muted-foreground text-sm">—</span>}
        </td>
        {/* Offline */}
        <td className="px-3 py-2.5 text-center">
          {loc.offline_count > 0
            ? <StatBadge value={loc.offline_count} color="red" />
            : <span className="text-muted-foreground text-sm">—</span>}
        </td>
        {/* Adresa */}
        <td className="px-3 py-2.5 text-sm text-muted-foreground max-w-[200px] truncate">
          {[loc.street, loc.city].filter(Boolean).join(", ") || "—"}
        </td>
        {/* Detail — poslední sloupec */}
        <td className="px-3 py-2.5 text-center">
          <button
            onClick={() => onDetail(loc)}
            title="Zobrazit detail"
            className={`inline-flex items-center gap-1 rounded px-2 py-1 text-xs font-medium transition-colors
              ${isSelected
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-primary/10 hover:text-primary"
              }`}
          >
            <PanelRightOpen className="h-3.5 w-3.5" />
            Detail
          </button>
        </td>
      </tr>
      {/* Podřízené lokace */}
      {expanded && children.map(child => (
        <LocationRow
          key={child.id}
          loc={child}
          depth={depth + 1}
          allLocs={allLocs}
          searchQuery={searchQuery}
          selectedId={selectedId}
          onDetail={onDetail}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Stránka
// ---------------------------------------------------------------------------

export default function LocationsTablePage() {
  const { data: locations = [], isLoading } = useLocationsTable();
  const { data: fullLocations = [] }        = useLocations(false);

  const [search,   setSearch]   = useState("");
  const [sortCol,  setSortCol]  = useState<"name" | "city" | null>(null);
  const [sortDir,  setSortDir]  = useState<"asc" | "desc">("asc");
  const [selectedLocation, setSelectedLocation] = useState<Location | null>(null);
  const [creating, setCreating] = useState(false);

  function toggleSort(col: "name" | "city") {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("asc"); }
  }

  function handleDetail(loc: any) {
    setCreating(false);
    const full = fullLocations.find(l => l.id === loc.id) ?? loc;
    setSelectedLocation(prev => prev?.id === loc.id ? null : full as Location);
  }

  function handleCreate() {
    setSelectedLocation(null);
    setCreating(true);
  }

  // Top-level lokace (bez rodiče)
  const topLevel = useMemo(() => {
    if (!search.trim()) return locations.filter(l => l.parent_id == null);
    const q = search.toLowerCase();
    return locations.filter(l =>
      l.name.toLowerCase().includes(q) ||
      l.type?.toLowerCase().includes(q) ||
      l.city?.toLowerCase().includes(q) ||
      l.street?.toLowerCase().includes(q)
    );
  }, [locations, search]);

  const sortedTopLevel = useMemo(() => {
    if (!sortCol) return topLevel;
    return [...topLevel].sort((a, b) => {
      const av = sortCol === "name" ? a.name : (a.city ?? "");
      const bv = sortCol === "name" ? b.name : (b.city ?? "");
      return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
    });
  }, [topLevel, sortCol, sortDir]);

  // Stats
  const stats = useMemo(() => ({
    total:        locations.length,
    withDevices:  locations.filter(l => l.device_count > 0).length,
    empty:        locations.filter(l => l.total_device_count === 0).length,
    totalDevices: locations.filter(l => l.parent_id == null)
                           .reduce((s, l) => s + l.total_device_count, 0),
  }), [locations]);

  // Pokud je vybrána lokace — sync s čerstvými daty (po uložení)
  const syncedSelectedLocation = useMemo(() => {
    if (!selectedLocation) return null;
    return (fullLocations.find(l => l.id === selectedLocation.id) ?? selectedLocation) as Location;
  }, [selectedLocation, fullLocations]);

  const panelOpen = creating || syncedSelectedLocation !== null;

  return (
    <div className="flex gap-0 h-full">
      {/* Levá část — tabulka */}
      <div className={`flex-1 min-w-0 space-y-4 transition-all duration-200 ${panelOpen ? "pr-0" : ""}`}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              <MapPin className="h-5 w-5" /> Lokace — tabulka
            </h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Přehled všech lokací se statistikami zařízení
            </p>
          </div>
          <Button variant="primary" size="sm" onClick={handleCreate} className="shrink-0 mt-0.5">
            <Plus className="h-3.5 w-3.5" />
            Nová lokace
          </Button>
        </div>

        {/* Stats */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard label="Celkem lokací"   value={stats.total} />
          <MetricCard label="S zařízeními"    value={stats.withDevices} color="green" />
          <MetricCard label="Prázdné"         value={stats.empty} color="red" />
          <MetricCard label="Celkem zařízení" value={stats.totalDevices} />
        </div>

        {/* Vyhledávání */}
        <div className="flex items-center gap-3">
          <TableSearch
            value={search}
            onChange={setSearch}
            placeholder="Hledat lokaci..."
            className="w-72"
          />
          <span className="text-sm text-muted-foreground">{topLevel.length} lokací</span>
        </div>

        {/* Tabulka */}
        <div className="rounded-lg border border-border overflow-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort("name")}>
                  <span className="flex items-center gap-1">Název
                    {sortCol === "name" ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                  </span>
                </th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">Typ</th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground">Nadřazená</th>
                <th className="px-3 py-2.5 text-center font-medium text-muted-foreground">Podřízených</th>
                <th className="px-3 py-2.5 text-center font-medium text-muted-foreground">Zařízení</th>
                <th className="px-3 py-2.5 text-center font-medium text-muted-foreground">Celkem zař.</th>
                <th className="px-3 py-2.5 text-center font-medium text-muted-foreground">Online</th>
                <th className="px-3 py-2.5 text-center font-medium text-muted-foreground">Offline</th>
                <th className="px-3 py-2.5 text-left font-medium text-muted-foreground cursor-pointer hover:text-foreground select-none"
                    onClick={() => toggleSort("city")}>
                  <span className="flex items-center gap-1">Adresa
                    {sortCol === "city" ? (sortDir === "asc" ? <ArrowUp className="h-3 w-3" /> : <ArrowDown className="h-3 w-3" />) : <ArrowUpDown className="h-3 w-3 opacity-40" />}
                  </span>
                </th>
                <th className="px-3 py-2.5 text-center font-medium text-muted-foreground">Detail</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                    Načítám...
                  </td>
                </tr>
              ) : topLevel.length === 0 ? (
                <tr>
                  <td colSpan={10} className="px-3 py-8 text-center text-muted-foreground">
                    Žádné lokace
                  </td>
                </tr>
              ) : sortedTopLevel.map(loc => (
                <LocationRow
                  key={loc.id}
                  loc={loc}
                  depth={0}
                  allLocs={locations}
                  searchQuery={search}
                  selectedId={selectedLocation?.id ?? null}
                  onDetail={handleDetail}
                />
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pravý panel — Detail nebo Nová lokace */}
      {panelOpen && (
        <div className="w-[520px] shrink-0 border-l border-border overflow-hidden flex flex-col">
          {creating ? (
            <CreateLocationPanel
              onClose={() => setCreating(false)}
            />
          ) : syncedSelectedLocation ? (
            <LocationPanel
              location={syncedSelectedLocation}
              onClose={() => setSelectedLocation(null)}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
