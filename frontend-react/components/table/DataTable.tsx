"use client";

import React, { useState, useMemo, useCallback } from "react";
import {
  useReactTable,
  getCoreRowModel,
  getSortedRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  flexRender,
  type ColumnDef,
  type SortingState,
  type RowSelectionState,
  type ColumnFiltersState,
  type Row,
} from "@tanstack/react-table";
import {
  ChevronUp, ChevronDown, ChevronsUpDown,
  Search, X, ChevronRight, ChevronLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button, Spinner } from "@/components/ui";

// ---------------------------------------------------------------------------
// Typy
// ---------------------------------------------------------------------------
export interface DataTableProps<T> {
  data: T[];
  columns: ColumnDef<T, unknown>[];
  isLoading?: boolean;
  globalFilter?: string;
  onGlobalFilterChange?: (value: string) => void;
  getRowId?: (row: T) => string;
  renderSubRow?: (row: Row<T>) => React.ReactNode;
  renderToolbar?: (table: ReturnType<typeof useReactTable<T>>) => React.ReactNode;
  renderBulkActions?: (selectedRows: T[], clearSelection: () => void) => React.ReactNode;
  onRowClick?: (row: T) => void;
  selectedRowId?: string | null;
  emptyMessage?: string;
  stickyHeader?: boolean;
  pageSize?: number;        // počet řádků na stránku (0 = bez stránkování)
  /** Stránkování na serveru — data = jedna stránka, footer řídí API */
  serverPagination?: {
    pageIndex:    number;
    pageCount:    number;
    total:        number;
    onPageChange: (pageIndex: number) => void;
  };
  serverSorting?: {
    sorting:         SortingState;
    onSortingChange: (updater: any) => void;
  };
}

// ---------------------------------------------------------------------------
// Sort ikona
// ---------------------------------------------------------------------------
function SortIcon({ sorted }: { sorted: false | "asc" | "desc" }) {
  if (sorted === "asc") return <ChevronUp className="h-3.5 w-3.5" />;
  if (sorted === "desc") return <ChevronDown className="h-3.5 w-3.5" />;
  return <ChevronsUpDown className="h-3.5 w-3.5 opacity-30" />;
}

// ---------------------------------------------------------------------------
// Hlavní DataTable komponenta
// ---------------------------------------------------------------------------
export function DataTable<T>({
  data,
  columns,
  isLoading,
  globalFilter = "",
  onGlobalFilterChange,
  getRowId,
  renderSubRow,
  renderToolbar,
  renderBulkActions,
  onRowClick,
  selectedRowId,
  emptyMessage = "Žádná data",
  stickyHeader = true,
  pageSize = 100,
  serverPagination,
  serverSorting,
}: DataTableProps<T>) {
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null);

  const tableColumns = useMemo<ColumnDef<T, unknown>[]>(() => {
    const cols: ColumnDef<T, unknown>[] = [];

    // Checkbox sloupec
    if (renderBulkActions) {
      cols.push({
        id: "__select",
        size: 40,
        header: ({ table }) => (
          <input
            type="checkbox"
            checked={table.getIsAllPageRowsSelected()}
            ref={(el) => {
              if (el) el.indeterminate = table.getIsSomePageRowsSelected();
            }}
            onChange={table.getToggleAllPageRowsSelectedHandler()}
            className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
            onClick={(e) => e.stopPropagation()}
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            onClick={(e) => e.stopPropagation()}
            className="h-4 w-4 rounded border-border accent-primary cursor-pointer"
          />
        ),
      });
    }

    // Expand tlačítko (pokud renderSubRow existuje)
    if (renderSubRow) {
      cols.push({
        id: "__expand",
        size: 36,
        header: () => null,
        cell: ({ row }) => {
          const id = row.id;
          const isExpanded = expandedRowId === id;
          return (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setExpandedRowId(isExpanded ? null : id);
              }}
              className={cn(
                "flex items-center justify-center rounded p-0.5 transition-colors",
                "hover:bg-accent",
                isExpanded && "text-primary"
              )}
            >
              <ChevronRight
                className={cn(
                  "h-4 w-4 transition-transform duration-150",
                  isExpanded && "rotate-90"
                )}
              />
            </button>
          );
        },
      });
    }

    return [...cols, ...columns];
  }, [columns, renderBulkActions, renderSubRow, expandedRowId]);

  const [pagination, setPagination] = useState({ pageIndex: 0, pageSize });
  // Reset na první stránku při změně dat nebo filtru
  React.useEffect(() => { setPagination(p => ({ ...p, pageIndex: 0 })); }, [data.length, globalFilter]);

  const table = useReactTable<T>({
    data,
    columns: tableColumns,
    state: { sorting: serverSorting?.sorting ?? sorting, rowSelection, columnFilters, globalFilter, pagination },
    onSortingChange: serverSorting?.onSortingChange ?? setSorting,
    onRowSelectionChange: setRowSelection,
    onColumnFiltersChange: setColumnFilters,
    onGlobalFilterChange,
    onPaginationChange: setPagination,
    manualSorting: !!serverSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    ...(serverPagination ? {} : { getPaginationRowModel: getPaginationRowModel() }),
    getRowId,
    enableRowSelection: !!renderBulkActions,
    globalFilterFn: "includesString",
  });

  const selectedRows = useMemo(
    () => table.getSelectedRowModel().rows.map((r) => r.original),
    [table, rowSelection]
  );

  const clearSelection = useCallback(() => setRowSelection({}), []);

  const rows = table.getRowModel().rows;

  return (
    <div className="flex flex-col gap-0">
      {/* Toolbar slot */}
      {renderToolbar && (
        <div className="mb-3">
          {renderToolbar(table)}
        </div>
      )}

      {/* Bulk actions bar */}
      {selectedRows.length > 0 && renderBulkActions && (
        <div className="mb-2 flex items-center gap-2 rounded-md border border-amber-200
                        bg-amber-50 px-3 py-2 dark:border-amber-900 dark:bg-amber-950/40">
          <span className="text-sm font-medium text-amber-800 dark:text-amber-300">
            {selectedRows.length} vybráno
          </span>
          <div className="flex-1" />
          {renderBulkActions(selectedRows, clearSelection)}
          <Button size="sm" variant="ghost" onClick={clearSelection}>
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>
      )}

      {/* Tabulka */}
      <div className="relative overflow-auto rounded-lg border border-border">
        <table className="w-full border-collapse text-sm">
          <thead className={cn(stickyHeader && "sticky top-0 z-10")}>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id} className="border-b border-border bg-muted/50">
                {hg.headers.map((header) => {
                  const canSort = header.column.getCanSort();
                  const sorted = header.column.getIsSorted();
                  return (
                    <th
                      key={header.id}
                      style={{ width: header.getSize() !== 150 ? header.getSize() : undefined }}
                      className={cn(
                        "px-3 py-2.5 text-left text-xs font-medium text-muted-foreground",
                        "select-none whitespace-nowrap",
                        canSort && "cursor-pointer hover:text-foreground"
                      )}
                      onClick={canSort ? header.column.getToggleSortingHandler() : undefined}
                    >
                      <div className="flex items-center gap-1">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        {canSort && <SortIcon sorted={sorted} />}
                      </div>
                    </th>
                  );
                })}
              </tr>
            ))}
          </thead>

          <tbody>
            {isLoading ? (
              <tr>
                <td
                  colSpan={tableColumns.length}
                  className="py-16 text-center text-muted-foreground"
                >
                  <div className="flex items-center justify-center gap-2">
                    <Spinner />
                    <span className="text-sm">Načítání…</span>
                  </div>
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={tableColumns.length}
                  className="py-16 text-center text-sm text-muted-foreground"
                >
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const isSelected = selectedRowId === row.id;
                const isExpanded = expandedRowId === row.id;
                const isChecked = row.getIsSelected();
                return (
                  <React.Fragment key={row.id}>
                    <tr
                      onClick={() => onRowClick?.(row.original)}
                      className={cn(
                        "border-b border-border transition-colors",
                        "hover:bg-muted/40",
                        isSelected && "bg-primary/10 hover:bg-primary/10",
                        isChecked && !isSelected && "bg-muted/30",
                        onRowClick && "cursor-pointer"
                      )}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td
                          key={cell.id}
                          className="px-3 py-2.5 align-middle"
                          style={{
                            width: cell.column.getSize() !== 150
                              ? cell.column.getSize()
                              : undefined,
                          }}
                        >
                          {flexRender(cell.column.columnDef.cell, cell.getContext())}
                        </td>
                      ))}
                    </tr>

                    {/* Inline sub-row (detail/edit panel) */}
                    {isExpanded && renderSubRow && (
                      <tr className="border-b border-border bg-muted/10">
                        <td
                          colSpan={tableColumns.length}
                          className="p-0"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div className="animate-in slide-in-from-top-1 duration-150">
                            {renderSubRow(row)}
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination / Footer */}
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>
          {serverPagination
            ? `Stránka ${serverPagination.pageIndex + 1} z ${serverPagination.pageCount} · celkem ${serverPagination.total.toLocaleString("cs-CZ")} · na stránce ${rows.length}`
            : pageSize > 0 && table.getPageCount() > 1
            ? `Stránka ${table.getState().pagination.pageIndex + 1} z ${table.getPageCount()} · celkem ${table.getFilteredRowModel().rows.length.toLocaleString("cs-CZ")}`
            : `Zobrazeno ${rows.length} z ${data.length} záznamů`}
          {selectedRows.length > 0 && ` · ${selectedRows.length} vybráno`}
        </span>
        {serverPagination && serverPagination.pageCount > 1 && (
          <div className="flex items-center gap-1">
            <button
              onClick={() => serverPagination.onPageChange(serverPagination.pageIndex - 1)}
              disabled={serverPagination.pageIndex <= 0}
              className="flex h-6 w-6 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40"
            >
              <ChevronLeft className="h-3 w-3" />
            </button>
            <span className="px-2 tabular-nums">
              {serverPagination.pageIndex + 1} / {serverPagination.pageCount}
            </span>
            <button
              onClick={() => serverPagination.onPageChange(serverPagination.pageIndex + 1)}
              disabled={serverPagination.pageIndex >= serverPagination.pageCount - 1}
              className="flex h-6 w-6 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40"
            >
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        )}
        {!serverPagination && pageSize > 0 && table.getPageCount() > 1 && (
          <div className="flex items-center gap-1">
            <button onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}
              className="flex h-6 w-6 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40">
              <ChevronLeft className="h-3 w-3" />
            </button>
            {(() => {
              const total = table.getPageCount();
              const cur   = table.getState().pagination.pageIndex;
              const pages = total <= 7
                ? Array.from({ length: total }, (_, i) => i)
                : cur < 4 ? [0,1,2,3,4,-1,total-1]
                : cur > total-5 ? [0,-1,total-5,total-4,total-3,total-2,total-1]
                : [0,-1,cur-1,cur,cur+1,-1,total-1];
              return pages.map((p, i) => p === -1
                ? <span key={`e${i}`} className="px-0.5">…</span>
                : <button key={p} onClick={() => table.setPageIndex(p)}
                    className={`h-6 min-w-[24px] rounded border px-1 text-xs ${
                      p === cur ? "border-primary bg-primary text-primary-foreground" : "border-border hover:bg-muted"
                    }`}>{p+1}</button>
              );
            })()}
            <button onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}
              className="flex h-6 w-6 items-center justify-center rounded border border-border hover:bg-muted disabled:opacity-40">
              <ChevronRight className="h-3 w-3" />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Global search input — samostatná komponenta pro použití v toolbaru
// ---------------------------------------------------------------------------
export function TableSearch({
  value,
  onChange,
  placeholder = "Hledat…",
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  return (
    <div className={cn("relative", className)}>
      <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "h-9 w-full rounded-md border border-border bg-background",
          "pl-8 pr-8 text-sm placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-2 focus:ring-primary/50"
        )}
      />
      {value && (
        <button
          onClick={() => onChange("")}
          className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground
                     hover:text-foreground transition-colors"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
