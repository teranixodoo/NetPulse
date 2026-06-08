"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import { Search, X, MapPin, Plus, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Location } from "@/lib/types";

interface LocationComboboxProps {
  locations:   Location[];
  value:       number | null;
  onChange:    (id: number | null) => void;
  onCreateNew?: (name: string) => void;
  placeholder?: string;
  className?:  string;
}

export function LocationCombobox({
  locations,
  value,
  onChange,
  onCreateNew,
  placeholder = "Vyhledat lokaci...",
  className,
}: LocationComboboxProps) {
  const [open,   setOpen]   = useState(false);
  const [search, setSearch] = useState("");
  const inputRef  = useRef<HTMLInputElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Zavření při kliknutí mimo
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Aktuálně vybraná lokace
  const selected = useMemo(
    () => locations.find(l => l.id === value) ?? null,
    [locations, value]
  );

  // Filtrování podle search
  const filtered = useMemo(() => {
    if (!search.trim()) return locations;
    const q = search.toLowerCase();
    return locations.filter(l =>
      l.name.toLowerCase().includes(q) ||
      l.breadcrumb?.join(" ").toLowerCase().includes(q)
    );
  }, [locations, search]);

  function handleSelect(loc: Location) {
    onChange(loc.id);
    setOpen(false);
    setSearch("");
  }

  function handleClear(e: React.MouseEvent) {
    e.stopPropagation();
    onChange(null);
    setSearch("");
  }

  function handleOpen() {
    setOpen(true);
    setTimeout(() => inputRef.current?.focus(), 50);
  }

  const showCreateNew = onCreateNew && search.trim().length > 1 &&
    !filtered.some(l => l.name.toLowerCase() === search.toLowerCase());

  return (
    <div ref={wrapperRef} className={cn("relative", className)}>
      {/* Trigger */}
      <div
        onClick={handleOpen}
        className={cn(
          "flex items-center gap-2 h-9 w-full rounded-md border border-input",
          "bg-background px-3 text-sm cursor-pointer",
          "hover:border-primary/50 transition-colors",
          open && "ring-2 ring-primary/50 border-primary/50"
        )}
      >
        <MapPin size={14} className="text-muted-foreground shrink-0" />
        <span className={cn("flex-1 truncate", !selected && "text-muted-foreground")}>
          {selected
            ? (selected.breadcrumb?.join(" › ") ?? selected.name)
            : placeholder}
        </span>
        {selected ? (
          <X size={14} className="text-muted-foreground hover:text-foreground shrink-0"
            onClick={handleClear} />
        ) : (
          <ChevronDown size={14} className="text-muted-foreground shrink-0" />
        )}
      </div>

      {/* Dropdown */}
      {open && (
        <div className={cn(
          "absolute z-50 mt-1 w-full rounded-md border border-border",
          "bg-background shadow-lg border border-border",
        )}>
          {/* Search input */}
          <div className="flex items-center gap-2 border-b border-border px-3 py-2 bg-background">
            <Search size={14} className="text-muted-foreground shrink-0" />
            <input
              ref={inputRef}
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Hledat..."
              className="flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onKeyDown={e => {
                if (e.key === "Escape") { setOpen(false); setSearch(""); }
                if (e.key === "Enter" && filtered.length === 1) handleSelect(filtered[0]);
              }}
            />
            {search && (
              <X size={12} className="text-muted-foreground cursor-pointer"
                onClick={() => setSearch("")} />
            )}
          </div>

          {/* Seznam lokací */}
          <div className="max-h-60 overflow-y-auto py-1">
            {/* Možnost "bez lokace" */}
            <div
              onClick={() => { onChange(null); setOpen(false); setSearch(""); }}
              className={cn(
                "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer bg-background",
                "hover:bg-muted text-muted-foreground",
                !value && "bg-muted/30"
              )}
            >
              — bez lokace —
            </div>

            {filtered.length === 0 && !showCreateNew && (
              <div className="px-3 py-4 text-center text-sm text-muted-foreground">
                Žádná lokace nenalezena
              </div>
            )}

            {filtered.map(loc => (
              <div
                key={loc.id}
                onClick={() => handleSelect(loc)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer bg-background",
                  "hover:bg-muted",
                  value === loc.id && "bg-primary/10 text-primary font-medium"
                )}
              >
                <MapPin size={12} className="text-muted-foreground shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="truncate">{loc.name}</div>
                  {loc.breadcrumb && loc.breadcrumb.length > 1 && (
                    <div className="text-xs text-muted-foreground truncate">
                      {loc.breadcrumb.slice(0, -1).join(" › ")}
                    </div>
                  )}
                </div>
              </div>
            ))}

            {/* Vytvořit novou */}
            {showCreateNew && (
              <div
                onClick={() => { onCreateNew!(search.trim()); setOpen(false); setSearch(""); }}
                className="flex items-center gap-2 px-3 py-1.5 text-sm cursor-pointer
                           hover:bg-muted/50 text-primary border-t border-border mt-1 pt-2"
              >
                <Plus size={12} className="shrink-0" />
                Vytvořit „{search.trim()}"
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
