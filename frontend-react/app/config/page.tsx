"use client";

import { useState } from "react";
import { Settings2, Plus, Pencil, Trash2, Check, X } from "lucide-react";
import {
  useConfigList,
  useCreateConfigItem, useUpdateConfigItem, useDeleteConfigItem,
} from "@/hooks/useNetPulse";
import { Button, Spinner } from "@/components/ui";
import type { ConfigItem } from "@/lib/types";

// ---------------------------------------------------------------------------
// Kategorie
// ---------------------------------------------------------------------------
const CATEGORIES: { key: string; label: string; description: string; hasIcon: boolean }[] = [
  { key: "device_type",   label: "Typy zařízení",  description: "Kategorie pro evidenci zařízení",      hasIcon: false },
  { key: "location_type", label: "Typy lokací",     description: "Hierarchie umístění zařízení",         hasIcon: true  },
];

// ---------------------------------------------------------------------------
// Řádek položky
// ---------------------------------------------------------------------------
function ConfigItemRow({ item, hasIcon, onUpdated, onDeleted }: {
  item:      ConfigItem;
  hasIcon:   boolean;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const [editing,    setEditing]    = useState(false);
  const [label,      setLabel]      = useState(item.label);
  const [icon,       setIcon]       = useState(item.icon ?? "");
  const [sortOrder,  setSortOrder]  = useState(item.sort_order);
  const [active,     setActive]     = useState(item.active);
  const [confirming, setConfirming] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const updateItem = useUpdateConfigItem();
  const deleteItem = useDeleteConfigItem();

  async function handleSave() {
    try {
      await updateItem.mutateAsync({
        id: item.id, category: item.category,
        label, icon: icon.trim() || null, sort_order: sortOrder, active,
      });
      setEditing(false);
      setError(null);
      onUpdated();
    } catch (e: any) {
      setError(e?.message ?? "Chyba");
    }
  }

  async function handleDelete() {
    try {
      await deleteItem.mutateAsync({ id: item.id, category: item.category });
      onDeleted();
    } catch (e: any) {
      setError(e?.message ?? "Nelze smazat");
      setConfirming(false);
    }
  }

  if (editing) {
    return (
      <tr className="border-b border-border bg-muted/10">
        <td className="px-4 py-2 text-muted-foreground font-mono text-xs">{item.value}</td>
        <td className="px-4 py-2">
          <input value={label} onChange={(e) => setLabel(e.target.value)}
            className="h-8 w-full rounded border border-input bg-background px-2 text-sm" />
        </td>
        {hasIcon && (
          <td className="px-4 py-2">
            <div className="flex items-center gap-2">
              <input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="🏢"
                className="h-8 w-20 rounded border border-input bg-background px-2 text-sm text-center"
                title="Zadej emoji nebo text ikony pro mapu"
              />
              {icon && <span className="text-lg">{icon}</span>}
            </div>
          </td>
        )}
        <td className="px-4 py-2">
          <input type="number" value={sortOrder} onChange={(e) => setSortOrder(Number(e.target.value))}
            className="h-8 w-20 rounded border border-input bg-background px-2 text-sm" />
        </td>
        <td className="px-4 py-2">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)}
            className="h-4 w-4" />
        </td>
        <td className="px-4 py-2">
          <div className="flex gap-1">
            <Button size="sm" onClick={handleSave} disabled={updateItem.isPending}>
              <Check size={12} />
            </Button>
            <Button size="sm" variant="ghost" onClick={() => { setEditing(false); setError(null); }}>
              <X size={12} />
            </Button>
          </div>
          {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
        </td>
      </tr>
    );
  }

  return (
    <tr className={`border-b border-border hover:bg-muted/20 ${!item.active ? "opacity-50" : ""}`}>
      <td className="px-4 py-2 font-mono text-xs text-muted-foreground">{item.value}</td>
      <td className="px-4 py-2 text-sm font-medium">{item.label}</td>
      {hasIcon && (
        <td className="px-4 py-2 text-center text-lg">
          {item.icon
            ? <span title={item.icon}>{item.icon}</span>
            : <span className="text-xs text-muted-foreground">—</span>}
        </td>
      )}
      <td className="px-4 py-2 text-sm text-muted-foreground text-center">{item.sort_order}</td>
      <td className="px-4 py-2">
        <span className={`inline-block h-2 w-2 rounded-full ${item.active ? "bg-green-500" : "bg-muted-foreground"}`} />
      </td>
      <td className="px-4 py-2">
        <div className="flex gap-1">
          <Button size="icon" variant="ghost" onClick={() => setEditing(true)}>
            <Pencil size={13} />
          </Button>
          {!confirming ? (
            <Button size="icon" variant="ghost" onClick={() => setConfirming(true)}>
              <Trash2 size={13} className="text-red-500" />
            </Button>
          ) : (
            <div className="flex gap-1">
              <Button size="sm" variant="destructive" onClick={handleDelete}
                disabled={deleteItem.isPending}>Smazat</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>Zrušit</Button>
            </div>
          )}
        </div>
        {error && <p className="text-xs text-red-500 mt-1">{error}</p>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Panel kategorie
// ---------------------------------------------------------------------------
function CategoryPanel({ category, description, hasIcon }: {
  category:    string;
  description: string;
  hasIcon:     boolean;
}) {
  const { data: items = [], isLoading, refetch } = useConfigList(category, false);
  const createItem = useCreateConfigItem();
  const [showAdd,  setShowAdd]  = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newIcon,  setNewIcon]  = useState("");
  const [newOrder, setNewOrder] = useState(0);
  const [addError, setAddError] = useState<string | null>(null);

  async function handleAdd() {
    if (!newLabel.trim() || !newValue.trim()) return;
    try {
      await createItem.mutateAsync({
        category,
        value:      newValue.trim(),
        label:      newLabel.trim(),
        icon:       newIcon.trim() || null,
        sort_order: newOrder,
      });
      setNewLabel(""); setNewValue(""); setNewIcon(""); setNewOrder(0);
      setShowAdd(false); setAddError(null);
    } catch (e: any) {
      setAddError(e?.response?.data?.detail ?? e?.message ?? "Chyba");
    }
  }

  if (isLoading) return <div className="flex justify-center py-8"><Spinner className="h-6 w-6" /></div>;

  const colSpan = hasIcon ? 6 : 5;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">{description}</p>
        <Button size="sm" className="gap-1" onClick={() => setShowAdd((v) => !v)}>
          <Plus size={13} /> Přidat
        </Button>
      </div>

      {showAdd && (
        <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-2">
          <div className={`grid gap-2 ${hasIcon ? "grid-cols-4" : "grid-cols-3"}`}>
            <div>
              <label className="text-xs text-muted-foreground">Hodnota (ID)</label>
              <input value={newValue} onChange={(e) => setNewValue(e.target.value.toLowerCase().replace(/\s/g,'_'))}
                placeholder="napr_router"
                className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Název (zobrazovaný)</label>
              <input value={newLabel} onChange={(e) => setNewLabel(e.target.value)}
                placeholder="Router"
                className="mt-1 h-8 w-full rounded border border-input bg-background px-2 text-sm" />
            </div>
            {hasIcon && (
              <div>
                <label className="text-xs text-muted-foreground">Ikona (emoji)</label>
                <div className="flex items-center gap-1 mt-1">
                  <input value={newIcon} onChange={(e) => setNewIcon(e.target.value)}
                    placeholder="🏢"
                    className="h-8 w-16 rounded border border-input bg-background px-2 text-sm text-center" />
                  {newIcon && <span className="text-lg">{newIcon}</span>}
                </div>
              </div>
            )}
            <div>
              <label className="text-xs text-muted-foreground">Pořadí</label>
              <input type="number" value={newOrder} onChange={(e) => setNewOrder(Number(e.target.value))}
                className="mt-1 h-8 w-20 rounded border border-input bg-background px-2 text-sm" />
            </div>
          </div>
          {addError && <p className="text-xs text-red-500">{addError}</p>}
          <div className="flex gap-2 justify-end">
            <Button size="sm" variant="ghost" onClick={() => { setShowAdd(false); setAddError(null); }}>Zrušit</Button>
            <Button size="sm" onClick={handleAdd} disabled={!newLabel || !newValue || createItem.isPending}>
              Uložit
            </Button>
          </div>
        </div>
      )}

      <div className="rounded-lg border border-border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/30 text-xs text-muted-foreground">
              <th className="text-left px-4 py-2 w-32">Hodnota</th>
              <th className="text-left px-4 py-2">Název</th>
              {hasIcon && <th className="text-center px-4 py-2 w-20">Ikona</th>}
              <th className="text-center px-4 py-2 w-20">Pořadí</th>
              <th className="text-left px-4 py-2 w-16">Aktivní</th>
              <th className="px-4 py-2 w-24"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item: ConfigItem) => (
              <ConfigItemRow
                key={item.id}
                item={item}
                hasIcon={hasIcon}
                onUpdated={() => refetch()}
                onDeleted={() => refetch()}
              />
            ))}
            {items.length === 0 && (
              <tr><td colSpan={colSpan} className="px-4 py-8 text-center text-muted-foreground text-sm">
                Žádné položky
              </td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hlavní stránka
// ---------------------------------------------------------------------------
export default function ConfigPage() {
  const [activeTab, setActiveTab] = useState(CATEGORIES[0].key);
  const active = CATEGORIES.find((c) => c.key === activeTab)!;

  return (
    <div className="space-y-6 p-6">
      <div>
        <h1 className="text-xl font-semibold flex items-center gap-2">
          <Settings2 size={20} className="text-primary" /> Konfigurace
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Správa číselníků a konfigurace systému
        </p>
      </div>

      {/* Záložky */}
      <div className="flex gap-1 border-b border-border">
        {CATEGORIES.map((cat) => (
          <button
            key={cat.key}
            onClick={() => setActiveTab(cat.key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === cat.key
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground"
            }`}
          >
            {cat.label}
          </button>
        ))}
      </div>

      {/* Obsah */}
      <CategoryPanel
        key={activeTab}
        category={active.key}
        description={active.description}
        hasIcon={active.hasIcon}
      />
    </div>
  );
}
