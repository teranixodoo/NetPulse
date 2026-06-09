"use client";

import React, { useState, useEffect } from "react";
import dynamic from "next/dynamic";
import {
  X, Pencil, Save, Trash2, Loader2,
  MapPin, Building2, Home, Server, ChevronRight,
} from "lucide-react";
import {
  useUpdateLocation, useDeleteLocation, useLocations, useConfigList, useCreateLocation,
} from "@/hooks/useNetPulse";
import type { Location } from "@/lib/types";
import { Button, FormField, Input, Select, InlineConfirm } from "@/components/ui";

// Dynamický import — Leaflet nefunguje v SSR (používá window/document)
const LocationMap = dynamic(
  () => import("@/components/locations/LocationMap"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full rounded-lg border border-border bg-muted/30 flex items-center justify-center" style={{ height: 220 }}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);

const InteractiveLocationMap = dynamic(
  () => import("@/components/locations/InteractiveLocationMap"),
  {
    ssr: false,
    loading: () => (
      <div className="w-full rounded-lg border border-border bg-muted/30 flex items-center justify-center" style={{ height: 220 }}>
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    ),
  }
);
import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function LocationTypeIcon({ type, className }: { type: string; className?: string }) {
  const cls = cn("shrink-0", className);
  switch (type) {
    case "building": return <Building2 className={cn(cls, "text-blue-500")} />;
    case "floor":    return <Home      className={cn(cls, "text-green-500")} />;
    case "room":     return <Server    className={cn(cls, "text-amber-500")} />;
    default:         return <MapPin    className={cn(cls, "text-muted-foreground")} />;
  }
}

function Field({ label, value }: { label: string; value?: string | number | null }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="text-sm text-foreground">{value ?? <span className="text-muted-foreground">—</span>}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// View mode
// ---------------------------------------------------------------------------

function ViewPanel({
  loc,
  parentName,
  onEdit,
  onDelete,
  onClose,
}: {
  loc: Location;
  parentName?: string;
  onEdit: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-start justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <LocationTypeIcon type={loc.type} className="h-4 w-4" />
          <div className="min-w-0">
            <h2 className="text-sm font-semibold truncate">{loc.name}</h2>
            {loc.breadcrumb && loc.breadcrumb.length > 1 && (
              <p className="text-[11px] text-muted-foreground flex items-center gap-0.5 truncate">
                {loc.breadcrumb.slice(0, -1).map((b, i) => (
                  <React.Fragment key={i}>
                    {i > 0 && <ChevronRight className="h-2.5 w-2.5 shrink-0" />}
                    <span>{b}</span>
                  </React.Fragment>
                ))}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <Button size="sm" variant="outline" onClick={onEdit}>
            <Pencil className="h-3.5 w-3.5" />
            <span>Upravit</span>
          </Button>
          <button
            onClick={onClose}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

        {/* Základní info */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Základní údaje
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Název"       value={loc.name} />
            <Field label="Typ"         value={loc.type} />
            <Field label="Nadřazená"   value={parentName} />
            <Field label="Stav"        value={loc.active ? "Aktivní" : "Neaktivní"} />
          </div>
        </section>

        <div className="border-t border-border" />

        {/* Adresa */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Adresa
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Ulice"       value={loc.street} />
            <Field label="Město"       value={loc.city} />
            <Field label="PSČ"         value={loc.zip} />
            <Field label="Stát"        value={loc.country} />
            <Field label="RUIAN ID"    value={loc.ruian_id} />
          </div>
        </section>

        <div className="border-t border-border" />

        {/* GPS */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            GPS souřadnice
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Zeměpisná šířka (lat)"  value={loc.lat} />
            <Field label="Zeměpisná délka (lng)"  value={loc.lng} />
          </div>

          {loc.lat != null && loc.lng != null
            && !isNaN(Number(loc.lat)) && !isNaN(Number(loc.lng))
          ? (
            <div className="space-y-2">
              {/* Leaflet mapa — Number() převede případný string z API */}
              <LocationMap
                lat={Number(loc.lat)}
                lng={Number(loc.lng)}
                name={loc.name}
                height={280}
                zoom={18}
              />
              <a
                href={`https://maps.google.com/?q=${loc.lat},${loc.lng}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-xs text-primary hover:underline"
              >
                <MapPin className="h-3 w-3" />
                Otevřít v Google Maps
              </a>
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">
              GPS souřadnice nejsou zadány — mapa není k dispozici.
            </p>
          )}
        </section>

        <div className="border-t border-border" />

        {/* Statistiky */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Statistiky
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="Přímá zařízení"  value={loc.device_count} />
          </div>
        </section>

        {/* Popis */}
        {loc.description && (
          <>
            <div className="border-t border-border" />
            <section className="space-y-2">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Popis / Poznámka
              </p>
              <p className="text-sm text-foreground whitespace-pre-wrap">{loc.description}</p>
            </section>
          </>
        )}

        {/* Meta */}
        <div className="border-t border-border" />
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Meta
          </p>
          <div className="grid grid-cols-2 gap-x-6 gap-y-3">
            <Field label="ID"           value={loc.id} />
            <Field label="Vytvořeno"    value={loc.created_at ? new Date(loc.created_at).toLocaleString("cs-CZ") : undefined} />
          </div>
        </section>
      </div>

      {/* Footer — smazání */}
      <div className="border-t border-border px-4 py-3">
        {confirmDelete ? (
          <InlineConfirm
            message="Opravdu smazat tuto lokaci?"
            onConfirm={onDelete}
            onCancel={() => setConfirmDelete(false)}
          />
        ) : (
          <Button
            size="sm"
            variant="destructive"
            onClick={() => setConfirmDelete(true)}
            className="w-full"
          >
            <Trash2 className="h-3.5 w-3.5" />
            Smazat lokaci
          </Button>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Edit mode
// ---------------------------------------------------------------------------

function EditPanel({
  loc,
  allLocations,
  onSave,
  onCancel,
  isSaving,
  error,
  isCreate = false,
}: {
  loc: Location;
  allLocations: Location[];
  onSave: (data: Partial<Location>) => void;
  onCancel: () => void;
  isSaving: boolean;
  error: string | null;
  isCreate?: boolean;
}) {
  const [name,        setName]        = useState(loc.name);
  const [type,        setType]        = useState(loc.type ?? "other");
  const [parentId,    setParentId]    = useState<number | null>(loc.parent_id ?? null);
  const [street,      setStreet]      = useState(loc.street ?? "");
  const [city,        setCity]        = useState(loc.city ?? "");
  const [zip,         setZip]         = useState(loc.zip ?? "");
  const [country,     setCountry]     = useState(loc.country ?? "CZ");
  const [ruianId,     setRuianId]     = useState<string>(loc.ruian_id?.toString() ?? "");
  const [lat,         setLat]         = useState<string>(loc.lat?.toString() ?? "");
  const [lng,         setLng]         = useState<string>(loc.lng?.toString() ?? "");
  const [description, setDescription] = useState(loc.description ?? "");
  const [active,      setActive]      = useState(loc.active);

  const { data: locationTypes = [] } = useConfigList("location_type");

  // Reset při změně lokace
  useEffect(() => {
    setName(loc.name);
    setType(loc.type ?? "other");
    setParentId(loc.parent_id ?? null);
    setStreet(loc.street ?? "");
    setCity(loc.city ?? "");
    setZip(loc.zip ?? "");
    setCountry(loc.country ?? "CZ");
    setRuianId(loc.ruian_id?.toString() ?? "");
    setLat(loc.lat?.toString() ?? "");
    setLng(loc.lng?.toString() ?? "");
    setDescription(loc.description ?? "");
    setActive(loc.active);
  }, [loc.id]);

  // Při změně nadřazené lokace doplní adresu/GPS — jen pokud je pole prázdné
  useEffect(() => {
    if (parentId == null) return;
    const parent = allLocations.find(l => l.id === parentId);
    if (!parent) return;
    if (!street  && parent.street)          setStreet(parent.street);
    if (!city    && parent.city)            setCity(parent.city);
    if (!zip     && parent.zip)             setZip(parent.zip);
    if (!country && parent.country)         setCountry(parent.country);
    if (!lat     && parent.lat  != null)    setLat(parent.lat.toString());
    if (!lng     && parent.lng  != null)    setLng(parent.lng.toString());
  }, [parentId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Dostupné rodiče — nesmí být sama sebe ani svůj potomek
  const parentOptions = allLocations.filter(l => l.id !== loc.id);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    onSave({
      name:        name.trim(),
      type,
      parent_id:   parentId,
      street:      street.trim()  || null,
      city:        city.trim()    || null,
      zip:         zip.trim()     || null,
      country:     country.trim() || "CZ",
      ruian_id:    ruianId ? parseInt(ruianId) : null,
      lat:         lat  ? parseFloat(lat)  : null,
      lng:         lng  ? parseFloat(lng)  : null,
      description: description.trim() || null,
      active,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2">
          {isCreate
            ? <MapPin className="h-4 w-4 text-green-500" />
            : <Pencil className="h-4 w-4 text-primary" />}
          <h2 className="text-sm font-semibold">
            {isCreate ? "Nová lokace" : "Editace lokace"}
          </h2>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">

        {error && (
          <div className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Základní */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Základní údaje
          </p>
          <FormField label="Název *">
            <Input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Název lokace"
              required
            />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Typ">
              <Select value={type} onChange={e => setType(e.target.value)} className="w-full">
                {locationTypes.length > 0
                  ? locationTypes.map(t => (
                      <option key={t.value} value={t.value}>{t.label}</option>
                    ))
                  : <option value={type}>{type}</option>
                }
              </Select>
            </FormField>
            <FormField label="Stav">
              <Select
                value={active ? "1" : "0"}
                onChange={e => setActive(e.target.value === "1")}
                className="w-full"
              >
                <option value="1">Aktivní</option>
                <option value="0">Neaktivní</option>
              </Select>
            </FormField>
          </div>
          <FormField label="Nadřazená lokace">
            <Select
              value={parentId ?? ""}
              onChange={e => setParentId(e.target.value ? parseInt(e.target.value) : null)}
              className="w-full"
            >
              <option value="">— žádná (top-level) —</option>
              {parentOptions.map(l => (
                <option key={l.id} value={l.id}>{l.name}</option>
              ))}
            </Select>
          </FormField>
        </section>

        <div className="border-t border-border" />

        {/* Adresa */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Adresa
          </p>
          <FormField label="Ulice">
            <Input value={street} onChange={e => setStreet(e.target.value)} placeholder="Např. Václavské náměstí 1" />
          </FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Město">
              <Input value={city} onChange={e => setCity(e.target.value)} placeholder="Praha" />
            </FormField>
            <FormField label="PSČ">
              <Input value={zip} onChange={e => setZip(e.target.value)} placeholder="110 00" />
            </FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Stát">
              <Input value={country} onChange={e => setCountry(e.target.value)} placeholder="CZ" />
            </FormField>
            <FormField label="RUIAN ID">
              <Input
                value={ruianId}
                onChange={e => setRuianId(e.target.value)}
                placeholder="12345678"
                type="number"
              />
            </FormField>
          </div>
        </section>

        <div className="border-t border-border" />

        {/* GPS + interaktivní mapa */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            GPS souřadnice
          </p>

          {/* Interaktivní mapa — vyhledávání, klik, drag */}
          <InteractiveLocationMap
            lat={lat}
            lng={lng}
            street={street}
            city={city}
            zip={zip}
            country={country}
            onCoordsChange={(newLat, newLng) => {
              setLat(newLat);
              setLng(newLng);
            }}
            height={280}
          />

          {/* Manuální inputy — synchronizované s mapou */}
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Zeměpisná šířka (lat)">
              <Input
                value={lat}
                onChange={e => setLat(e.target.value)}
                placeholder="50.0755"
                type="number"
                step="any"
              />
            </FormField>
            <FormField label="Zeměpisná délka (lng)">
              <Input
                value={lng}
                onChange={e => setLng(e.target.value)}
                placeholder="14.4378"
                type="number"
                step="any"
              />
            </FormField>
          </div>
        </section>

        <div className="border-t border-border" />

        {/* Popis */}
        <section className="space-y-3">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Popis / Poznámka
          </p>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Volitelný popis lokace..."
            rows={3}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/50 resize-none"
          />
        </section>
      </div>

      {/* Footer */}
      <div className="border-t border-border px-4 py-3 flex gap-2">
        <Button type="submit" variant="primary" size="sm" className="flex-1" disabled={isSaving}>
          {isSaving
            ? <><Loader2 className="h-3.5 w-3.5 animate-spin" />Ukládám...</>
            : isCreate
              ? <><MapPin className="h-3.5 w-3.5" />Vytvořit lokaci</>
              : <><Save className="h-3.5 w-3.5" />Uložit změny</>}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel} disabled={isSaving}>
          Zrušit
        </Button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// LocationPanel — hlavní export (side drawer)
// ---------------------------------------------------------------------------

export function LocationPanel({
  location,
  onClose,
}: {
  location: Location;
  onClose: () => void;
}) {
  const [editMode, setEditMode] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const updateLocation = useUpdateLocation();
  const deleteLocation = useDeleteLocation();
  const { data: allLocations = [] } = useLocations(false);

  const parentName = allLocations.find(l => l.id === location.parent_id)?.name;

  // Reset edit mode při změně lokace
  useEffect(() => {
    setEditMode(false);
    setSaveError(null);
  }, [location.id]);

  async function handleSave(data: Partial<Location>) {
    setSaveError(null);
    try {
      await updateLocation.mutateAsync({ id: location.id, ...data });
      setEditMode(false);
    } catch (err: any) {
      setSaveError(err?.response?.data?.detail ?? err?.message ?? "Chyba při ukládání");
    }
  }

  async function handleDelete() {
    try {
      await deleteLocation.mutateAsync(location.id);
      onClose();
    } catch (err: any) {
      setSaveError(err?.response?.data?.detail ?? err?.message ?? "Chyba při mazání");
    }
  }

  return (
    <div
      className="border-l-4 border-primary bg-background h-full"
      onClick={e => e.stopPropagation()}
    >
      {editMode ? (
        <EditPanel
          loc={location}
          allLocations={allLocations}
          onSave={handleSave}
          onCancel={() => { setEditMode(false); setSaveError(null); }}
          isSaving={updateLocation.isPending}
          error={saveError}
        />
      ) : (
        <ViewPanel
          loc={location}
          parentName={parentName}
          onEdit={() => setEditMode(true)}
          onDelete={handleDelete}
          onClose={onClose}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateLocationPanel — nová lokace (stejný EditPanel, prázdná data)
// ---------------------------------------------------------------------------

const EMPTY_LOCATION: Location = {
  id:           0,
  name:         "",
  type:         "other",
  parent_id:    null,
  street:       null,
  city:         null,
  zip:          null,
  country:      "CZ",
  ruian_id:     null,
  lat:          null,
  lng:          null,
  description:  null,
  active:       true,
  created_at:   "",
  breadcrumb:   [],
  device_count: 0,
};

export function CreateLocationPanel({
  onClose,
  defaultParentId,
}: {
  onClose: () => void;
  defaultParentId?: number | null;
}) {
  const createLocation = useCreateLocation();
  const { data: allLocations = [] } = useLocations(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const initial: Location = { ...EMPTY_LOCATION, parent_id: defaultParentId ?? null };

  async function handleSave(data: Partial<Location>) {
    setSaveError(null);
    try {
      await createLocation.mutateAsync(data);
      onClose();
    } catch (err: any) {
      setSaveError(err?.response?.data?.detail ?? err?.message ?? "Chyba při vytváření");
    }
  }

  return (
    <div
      className="border-l-4 border-green-500 bg-background h-full"
      onClick={e => e.stopPropagation()}
    >
      <EditPanel
        loc={initial}
        allLocations={allLocations}
        onSave={handleSave}
        onCancel={onClose}
        isSaving={createLocation.isPending}
        error={saveError}
        isCreate
      />
    </div>
  );
}
