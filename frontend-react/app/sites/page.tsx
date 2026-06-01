"use client";

import { useState } from "react";
import { Globe, Plus, Pencil, Trash2, RefreshCw } from "lucide-react";
import { useSites, useCreateSite, useUpdateSite, useDeleteSite } from "@/hooks/useNetPulse";
import { Button, Spinner } from "@/components/ui";
import { getErrorMessage } from "@/hooks/useNetPulse";
import type { Site } from "@/lib/types";

const COLORS = ["#6366f1","#22c55e","#f59e0b","#ef4444","#06b6d4","#a855f7","#f97316","#14b8a6"];

function SiteForm({ initial, onSave, onCancel }: {
  initial?: Partial<Site>;
  onSave:   (d: { name: string; description?: string; color: string }) => Promise<void>;
  onCancel: () => void;
}) {
  const [name, setName]   = useState(initial?.name ?? "");
  const [desc, setDesc]   = useState(initial?.description ?? "");
  const [color, setColor] = useState(initial?.color ?? "#6366f1");
  const [saving, setSaving] = useState(false);

  async function handleSubmit() {
    if (!name.trim()) return;
    setSaving(true);
    try { await onSave({ name: name.trim(), description: desc || undefined, color }); }
    catch (e) { alert(getErrorMessage(e)); }
    finally { setSaving(false); }
  }

  return (
    <div className="space-y-3 p-4 border border-border rounded-lg bg-card">
      <div className="flex gap-3">
        <input
          value={name} onChange={(e) => setName(e.target.value)}
          placeholder="Název sítě"
          className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
        />
        <input
          value={desc} onChange={(e) => setDesc(e.target.value)}
          placeholder="Popis (volitelný)"
          className="flex-1 h-9 rounded-md border border-input bg-background px-3 text-sm"
        />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-xs text-muted-foreground">Barva:</span>
        {COLORS.map((c) => (
          <button key={c} onClick={() => setColor(c)}
            className="h-6 w-6 rounded-full border-2 transition-all"
            style={{ backgroundColor: c, borderColor: color === c ? "#fff" : "transparent",
                     outline: color === c ? `2px solid ${c}` : "none" }}
          />
        ))}
        <div className="flex gap-2 ml-auto">
          <Button size="sm" variant="ghost" onClick={onCancel}>Zrušit</Button>
          <Button size="sm" onClick={handleSubmit} disabled={saving || !name.trim()}>
            {saving ? <Spinner className="h-4 w-4" /> : "Uložit"}
          </Button>
        </div>
      </div>
    </div>
  );
}

function SiteRow({ site }: { site: Site }) {
  const [editing, setEditing]     = useState(false);
  const [confirming, setConfirming] = useState(false);
  const updateSite = useUpdateSite();
  const deleteSite = useDeleteSite();

  async function handleUpdate(d: { name: string; description?: string; color: string }) {
    await updateSite.mutateAsync({ id: site.id, ...d, active: site.active });
    setEditing(false);
  }

  async function handleDelete() {
    await deleteSite.mutateAsync(site.id);
    setConfirming(false);
  }

  if (editing) return (
    <SiteForm initial={site} onSave={handleUpdate} onCancel={() => setEditing(false)} />
  );

  return (
    <div className="flex items-center gap-4 px-4 py-3 border border-border rounded-lg bg-card">
      <div className="h-4 w-4 rounded-full shrink-0" style={{ backgroundColor: site.color }} />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="font-medium text-sm">{site.name}</span>
          {site.id === 1 && (
            <span className="text-[10px] bg-muted px-1.5 py-0.5 rounded text-muted-foreground">výchozí</span>
          )}
          {!site.active && (
            <span className="text-[10px] bg-red-100 dark:bg-red-950/40 px-1.5 py-0.5 rounded text-red-600">neaktivní</span>
          )}
        </div>
        {site.description && <p className="text-xs text-muted-foreground mt-0.5">{site.description}</p>}
      </div>
      <span className="text-xs text-muted-foreground shrink-0">{site.range_count} rozsahů</span>
      <div className="flex gap-1 shrink-0">
        <Button size="icon" variant="ghost" onClick={() => setEditing(true)}>
          <Pencil size={14} />
        </Button>
        {site.id !== 1 && !confirming && (
          <Button size="icon" variant="ghost" onClick={() => setConfirming(true)}>
            <Trash2 size={14} className="text-red-500" />
          </Button>
        )}
        {confirming && (
          <div className="flex gap-1">
            <Button size="sm" variant="destructive" onClick={handleDelete}>Smazat</Button>
            <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Zrušit</Button>
          </div>
        )}
      </div>
    </div>
  );
}

export default function SitesPage() {
  const { data: sites = [], isLoading } = useSites();
  const createSite = useCreateSite();
  const [showAdd, setShowAdd] = useState(false);

  async function handleCreate(d: { name: string; description?: string; color: string }) {
    await createSite.mutateAsync(d);
    setShowAdd(false);
  }

  return (
    <div className="space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold flex items-center gap-2">
            <Globe size={20} className="text-primary" /> Sítě
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Logické sítě pro oddělení různých infrastruktur
          </p>
        </div>
        <Button size="sm" className="gap-2" onClick={() => setShowAdd((v) => !v)}>
          <Plus size={14} /> Přidat síť
        </Button>
      </div>

      {showAdd && (
        <SiteForm onSave={handleCreate} onCancel={() => setShowAdd(false)} />
      )}

      {isLoading ? (
        <div className="flex justify-center py-12"><Spinner className="h-8 w-8" /></div>
      ) : (
        <div className="space-y-2">
          {sites.map((s: Site) => <SiteRow key={s.id} site={s} />)}
        </div>
      )}
    </div>
  );
}
