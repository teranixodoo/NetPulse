"use client";

import { useState, useMemo, useEffect } from "react";
import { MapPin, Plus, Pencil, Trash2, ChevronRight,
         Check, X, ChevronDown, ChevronRight as CR } from "lucide-react";
import { useLocations, useCreateLocation, useUpdateLocation,
         useDeleteLocation, useConfigList } from "@/hooks/useNetPulse";
import { Button, Spinner, Select } from "@/components/ui";
import type { Location, ConfigItem } from "@/lib/types";

// ---------------------------------------------------------------------------
// Formulář lokace
// ---------------------------------------------------------------------------
function LocationForm({
  initial, parentId, onSave, onCancel, locationTypes, allLocations,
}: {
  initial?: Partial<Location>;
  parentId?: number | null;
  onSave: (data: Partial<Location>) => Promise<void>;
  onCancel: () => void;
  locationTypes: ConfigItem[];
  allLocations: Location[];
}) {
  const [name,        setName]        = useState(initial?.name        ?? "");
  const [type,        setType]        = useState(initial?.type        ?? "building");
  const [pid,         setPid]         = useState<number | null>(initial?.parent_id ?? parentId ?? null);
  const [street,      setStreet]      = useState(initial?.street      ?? "");
  const [city,        setCity]        = useState(initial?.city        ?? "");
  const [zip,         setZip]         = useState(initial?.zip         ?? "");
  const [country,     setCountry]     = useState(initial?.country     ?? "CZ");
  const [ruianId,     setRuianId]     = useState<string>(initial?.ruian_id?.toString() ?? "");
  const [lat,         setLat]         = useState<string>(initial?.lat?.toString() ?? "");
  const [lng,         setLng]         = useState<string>(initial?.lng?.toString() ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [active,      setActive]      = useState(initial?.active ?? true);
  const [waypointType,setWaypointType]= useState<string>(initial?.waypoint_type ?? "");
  const [heightM,     setHeightM]     = useState<string>(initial?.height_m?.toString() ?? "");
  const [saving,      setSaving]      = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [geocoding,   setGeocoding]   = useState(false);

  // Při změně nadřazené lokace doplní adresu/GPS — jen pokud je pole prázdné
  useEffect(() => {
    if (pid == null) return;
    const parent = allLocations.find(l => l.id === pid);
    if (!parent) return;
    if (!street  && parent.street)          setStreet(parent.street);
    if (!city    && parent.city)            setCity(parent.city);
    if (!zip     && parent.zip)             setZip(parent.zip);
    if (!country && parent.country)         setCountry(parent.country);
    if (!lat     && parent.lat  != null)    setLat(parent.lat.toString());
    if (!lng     && parent.lng  != null)    setLng(parent.lng.toString());
  }, [pid]); // eslint-disable-line react-hooks/exhaustive-deps

  // Geocoding přes Nominatim
  async function geocode() {
    const q = [street, city, zip, country].filter(Boolean).join(", ");
    if (!q) return;
    setGeocoding(true);
    try {
      const resp = await fetch(
        `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(q)}&limit=1`,
        { headers: { "Accept-Language": "cs" } }
      );
      const data = await resp.json();
      if (data[0]) {
        setLat(parseFloat(data[0].lat).toFixed(6));
        setLng(parseFloat(data[0].lon).toFixed(6));
      } else {
        setError("Adresa nenalezena");
      }
    } catch {
      setError("Chyba geocodingu");
    } finally {
      setGeocoding(false);
    }
  }

  async function handleSave() {
    if (!name.trim()) { setError("Název je povinný"); return; }
    setSaving(true); setError(null);
    try {
      await onSave({
        name: name.trim(), type, parent_id: pid,
        street: street || null, city: city || null,
        zip: zip || null, country: country || "CZ",
        ruian_id: ruianId ? parseInt(ruianId) : null,
        lat: lat ? parseFloat(lat) : null,
        lng: lng ? parseFloat(lng) : null,
        description: description || null, active,
        waypoint_type: (type === "waypoint" && waypointType) ? waypointType : null,
        height_m: heightM ? parseFloat(heightM) : null,
      });
    } catch (e: any) {
      setError(e?.response?.data?.detail ?? e?.message ?? "Chyba");
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <div className="col-span-2 sm:col-span-2">
          <label className="text-xs text-muted-foreground">Název *</label>
          <input value={name} onChange={e => setName(e.target.value)}
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Typ</label>
          <select value={type} onChange={e => setType(e.target.value)}
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm">
            {locationTypes.map(lt => (
              <option key={lt.value} value={lt.value}>{lt.label}</option>
            ))}
          </select>
        </div>
        <div className="col-span-2 sm:col-span-1">
          <label className="text-xs text-muted-foreground">Nadřazená lokace</label>
          <select value={pid ?? ""} onChange={e => setPid(e.target.value ? Number(e.target.value) : null)}
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm">
            <option value="">— žádná (kořenová) —</option>
            {allLocations
              .filter(l => l.id !== initial?.id)
              .map(l => (
                <option key={l.id} value={l.id}>
                  {l.breadcrumb.join(" › ")}
                </option>
              ))}
          </select>
        </div>
      </div>

      {/* Adresa */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-3 sm:col-span-2">
          <label className="text-xs text-muted-foreground">Ulice a č.p.</label>
          <input value={street} onChange={e => setStreet(e.target.value)}
            placeholder="Jehnická 5"
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">PSČ</label>
          <input value={zip} onChange={e => setZip(e.target.value)}
            placeholder="602 00"
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </div>
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground">Město</label>
          <input value={city} onChange={e => setCity(e.target.value)}
            placeholder="Brno"
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">Stát</label>
          <input value={country} onChange={e => setCountry(e.target.value)}
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </div>
        <div>
          <label className="text-xs text-muted-foreground">RÚIAN ID</label>
          <input value={ruianId} onChange={e => setRuianId(e.target.value)}
            placeholder="12345678"
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </div>
      </div>

      {/* GPS */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <span className="text-xs text-muted-foreground">GPS souřadnice</span>
          <button onClick={geocode} disabled={geocoding}
            className="text-xs text-primary hover:underline disabled:opacity-50">
            {geocoding ? "Hledám…" : "📍 Zjistit z adresy"}
          </button>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Zeměpisná šířka (lat)</label>
            <input value={lat} onChange={e => setLat(e.target.value)}
              placeholder="49.234567"
              className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm font-mono" />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Zeměpisná délka (lng)</label>
            <input value={lng} onChange={e => setLng(e.target.value)}
              placeholder="16.523456"
              className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm font-mono" />
          </div>
        </div>
      </div>

      {/* Popis + aktivní */}
      <div className="grid grid-cols-3 gap-3">
        <div className="col-span-2">
          <label className="text-xs text-muted-foreground">Poznámka</label>
          <input value={description} onChange={e => setDescription(e.target.value)}
            className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </div>
        <div className="flex items-end pb-1 gap-2">
          <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)}
            className="h-4 w-4" id="loc-active" />
          <label htmlFor="loc-active" className="text-sm">Aktivní</label>
        </div>
      </div>

      {/* Waypoint — specifická pole */}
      {type === "waypoint" && (
        <div className="grid grid-cols-2 gap-3 rounded-md border border-primary/20 bg-primary/5 p-3">
          <div className="col-span-2">
            <p className="text-xs font-semibold text-primary mb-2">📍 Průchozí bod</p>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Typ průchozího bodu</label>
            <select value={waypointType} onChange={e => setWaypointType(e.target.value)}
              className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm">
              <option value="">— vyberte —</option>
              <option value="junction_box">🟫 Montážní/rozbočovací krabice</option>
              <option value="patch_panel">🔲 Patch panel</option>
              <option value="conduit">⬜ Kabelový žlab / trubka</option>
              <option value="wall_penetration">🔵 Průchod stěnou</option>
              <option value="floor_penetration">🔴 Průchod stropem/podlahou</option>
              <option value="outlet">🔌 Zásuvka / vývodka</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Výška nad podlahou (m)</label>
            <input type="number" min={0} max={50} step={0.1}
              value={heightM} onChange={e => setHeightM(e.target.value)}
              placeholder="např. 2.5"
              className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm font-mono" />
          </div>
        </div>
      )}

      {/* floor — výška */}
      {type === "floor" && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="text-xs text-muted-foreground">Výška nad podlahou (m) — volitelně</label>
            <input type="number" min={0} max={50} step={0.1}
              value={heightM} onChange={e => setHeightM(e.target.value)}
              placeholder="např. 0.0"
              className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm font-mono" />
          </div>
        </div>
      )}

      {error && <p className="text-xs text-red-500">{error}</p>}

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={onCancel}>Zrušit</Button>
        <Button size="sm" onClick={handleSave} disabled={saving}>
          {saving ? "Ukládám…" : "Uložit"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Řádek lokace
// ---------------------------------------------------------------------------
function LocationRow({
  loc, depth, locationTypes, allLocations, onAdded,
}: {
  loc: Location;
  depth: number;
  locationTypes: ConfigItem[];
  allLocations: Location[];
  onAdded: () => void;
}) {
  const [expanded,    setExpanded]    = useState(true);
  const [editing,     setEditing]     = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [confirming,  setConfirming]  = useState(false);

  const updateLoc = useUpdateLocation();
  const deleteLoc = useDeleteLocation();
  const createLoc = useCreateLocation();

  const typeLabel = locationTypes.find(t => t.value === loc.type)?.label ?? loc.type;
  const children  = allLocations.filter(l => l.parent_id === loc.id);

  const addressLine = [loc.street, loc.city].filter(Boolean).join(", ");

  if (editing) {
    return (
      <div style={{ paddingLeft: depth * 20 }} className="mb-2">
        <LocationForm
          initial={loc}
          locationTypes={locationTypes}
          allLocations={allLocations}
          onSave={async (data) => {
            await updateLoc.mutateAsync({ id: loc.id, ...data });
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div>
      <div
        style={{ paddingLeft: depth * 20 }}
        className="flex items-center gap-2 py-2 px-3 rounded hover:bg-muted/20 group"
      >
        {/* Rozbalit/sbalit */}
        <button onClick={() => setExpanded(v => !v)}
          className={`w-4 h-4 text-muted-foreground shrink-0 ${children.length === 0 ? "opacity-0" : ""}`}>
          {expanded ? <ChevronDown size={14} /> : <CR size={14} />}
        </button>

        <MapPin size={14} className="text-primary shrink-0" />

        {/* Info */}
        <div className="flex-1 min-w-0">
          <span className="font-medium text-sm">{loc.name}</span>
          <span className="ml-2 text-xs text-muted-foreground">{typeLabel}</span>
          {addressLine && (
            <span className="ml-2 text-xs text-muted-foreground">{addressLine}</span>
          )}
          {loc.lat && loc.lng && (
            <span className="ml-2 text-xs text-blue-500 font-mono">
              {loc.lat.toFixed(4)}, {loc.lng.toFixed(4)}
            </span>
          )}
          {loc.device_count > 0 && (
            <span className="ml-2 text-xs bg-primary/10 text-primary rounded px-1">
              {loc.device_count} zař.
            </span>
          )}
        </div>

        {!loc.active && (
          <span className="text-xs text-muted-foreground bg-muted rounded px-1">neaktivní</span>
        )}

        {/* Akce */}
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
          <Button size="icon" variant="ghost"
            onClick={() => setAddingChild(v => !v)}>
            <Plus size={13} />
          </Button>
          <Button size="icon" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </Button>
          {!confirming ? (
            <Button size="icon" variant="ghost" onClick={() => setConfirming(true)}>
              <Trash2 size={13} className="text-red-500" />
            </Button>
          ) : (
            <>
              <Button size="sm" variant="destructive"
                onClick={async () => { await deleteLoc.mutateAsync(loc.id); }}>
                Smazat
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                Zrušit
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Formulář pro přidání podřízené */}
      {addingChild && (
        <div style={{ paddingLeft: (depth + 1) * 20 }} className="mb-2 pr-3">
          <LocationForm
            parentId={loc.id}
            locationTypes={locationTypes}
            allLocations={allLocations}
            onSave={async (data) => {
              await createLoc.mutateAsync(data);
              setAddingChild(false);
              onAdded();
            }}
            onCancel={() => setAddingChild(false)}
          />
        </div>
      )}

      {/* Podřízené lokace */}
      {expanded && children.map(child => (
        <LocationRow
          key={child.id}
          loc={child}
          depth={depth + 1}
          locationTypes={locationTypes}
          allLocations={allLocations}
          onAdded={onAdded}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function LocationsPage() {
  const { data: locations = [], isLoading, refetch } = useLocations(false);
  const { data: locationTypes = [] }                 = useConfigList("location_type");
  const createLoc                                    = useCreateLocation();
  const [showAdd, setShowAdd]                        = useState(false);
  const [search,  setSearch]                         = useState("");

  // Kořenové lokace (bez rodiče)
  const roots = useMemo(() =>
    locations.filter(l => l.parent_id === null)
      .filter(l => !search || l.breadcrumb.join(" ").toLowerCase().includes(search.toLowerCase())),
    [locations, search]
  );

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <MapPin size={20} className="text-primary" /> Lokace
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Fyzická umístění zařízení — budovy, byty, racky
          </p>
        </div>
        <Button className="gap-1" onClick={() => setShowAdd(v => !v)}>
          <Plus size={14} /> Přidat lokaci
        </Button>
      </div>

      {/* Formulář přidání kořenové lokace */}
      {showAdd && (
        <LocationForm
          locationTypes={locationTypes}
          allLocations={locations}
          onSave={async (data) => {
            await createLoc.mutateAsync(data);
            setShowAdd(false);
          }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {/* Vyhledávání */}
      <input
        value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Hledat lokaci…"
        className="h-9 w-72 rounded-md border border-input bg-background px-3 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
      />

      {/* Strom lokací */}
      <div className="rounded-lg border border-border bg-card">
        {isLoading ? (
          <div className="flex justify-center py-8"><Spinner className="h-6 w-6" /></div>
        ) : roots.length === 0 ? (
          <div className="py-12 text-center text-sm text-muted-foreground">
            {search ? "Žádné lokace nenalezeny" : "Zatím žádné lokace — přidejte první"}
          </div>
        ) : (
          <div className="py-2">
            {roots.map(loc => (
              <LocationRow
                key={loc.id}
                loc={loc}
                depth={0}
                locationTypes={locationTypes}
                allLocations={locations}
                onAdded={() => refetch()}
              />
            ))}
          </div>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {locations.length} lokací celkem · GPS souřadnice lze zjistit automaticky z adresy
      </p>
    </div>
  );
}
