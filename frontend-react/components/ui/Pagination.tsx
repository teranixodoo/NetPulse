"use client";
import { useState, useEffect } from "react";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight } from "lucide-react";

// ---------------------------------------------------------------------------
// Univerzální stránkovací hook + komponenta
// ---------------------------------------------------------------------------

export const PAGE_SIZE = 100;

export function usePagination<T>(items: T[], pageSize = PAGE_SIZE) {
  const [page, setPage] = useState(1);
  useEffect(() => { setPage(1); }, [items.length]);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const paged = items.slice((page - 1) * pageSize, page * pageSize);
  return { page, setPage, totalPages, paged, total: items.length };
}

interface PaginationProps {
  page:       number;
  totalPages: number;
  total:      number;
  pageSize?:  number;
  onChange:   (page: number) => void;
  className?: string;
}

export function Pagination({
  page, totalPages, total, pageSize = PAGE_SIZE, onChange, className,
}: PaginationProps) {
  if (totalPages <= 1) return null;
  const from = (page - 1) * pageSize + 1;
  const to   = Math.min(page * pageSize, total);

  function pages(): (number | 0)[] {
    if (totalPages <= 7) return Array.from({ length: totalPages }, (_, i) => i + 1);
    if (page < 5) return [1,2,3,4,5,0,totalPages];
    if (page > totalPages - 4) return [1,0,totalPages-4,totalPages-3,totalPages-2,totalPages-1,totalPages];
    return [1,0,page-1,page,page+1,0,totalPages];
  }

  return (
    <div className={cn("flex items-center justify-between gap-4 py-2 text-sm", className)}>
      <span className="text-xs text-muted-foreground">
        {from}–{to} z {total.toLocaleString("cs-CZ")}
      </span>
      <div className="flex items-center gap-1">
        <button onClick={() => onChange(page - 1)} disabled={page === 1}
          className="flex h-7 w-7 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed">
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
        {pages().map((p, i) => p === 0
          ? <span key={`e${i}`} className="px-1 text-muted-foreground">…</span>
          : <button key={p} onClick={() => onChange(p)}
              className={cn("h-7 min-w-[28px] rounded border px-2 text-xs transition-colors",
                p === page ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted")}>
              {p}
            </button>
        )}
        <button onClick={() => onChange(page + 1)} disabled={page === totalPages}
          className="flex h-7 w-7 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
