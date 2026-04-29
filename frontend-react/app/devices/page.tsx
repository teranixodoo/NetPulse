"use client";

import { useState, useMemo, useCallback } from "react";
import { Trash2, Download } from "lucide-react";
import { useDevices, useHosts, useDeleteDevice, getErrorMessage } from "@/hooks/useNetPulse";
import { DataTable, TableSearch } from "@/components/table/DataTable";
import { getDeviceColumns, type DeviceRow } from "@/components/devices/DeviceColumns";
import { DevicePanel } from "@/components/devices/DevicePanel";
import { AddDeviceForm } from "@/components/devices/AddDeviceForm";
import { Button, Select } from "@/components/ui";
import type { Row } from "@tanstack/react-table";
import type { Device } from "@/lib/types";

const DEVICE_TYPES = ["Router","Switch","AP","Server","IP Kamera","Počítač","Jiné"];

export default function DevicesPage() {
  const { data: devices = [], isLoading: devicesLoading } = useDevices();
  const { data: hosts   = [], isLoading: hostsLoading   } = useHosts();
  const deleteDevice = useDeleteDevice();

  const [globalFilter,   setGlobalFilter]   = useState("");
  const [typeFilter,     setTypeFilter]     = useState("");
  const [statusFilter,   setStatusFilter]   = useState("");
  const [vendorFilter,   setVendorFilter]   = useState("");
  const [activeTabs, setActiveTabs] = useState<Record<number, string>>({});
  const [expandedRowId,  setExpandedRowId]  = useState<number | null>(null);

  // Host mapa pro rychlý lookup
  const hostMap = useMemo(() => {
    const m = new Map<string, (typeof hosts)[0]>();
    for (const h of hosts) m.set(h.ip.split("/")[0], h);
    return m;
  }, [hosts]);

  // Sloučená data
  const rows = useMemo<DeviceRow[]>(() => {
    return devices.map((d) => ({
      ...d,
      hostInfo: hostMap.get(d.ip.split("/")[0]),
    }));
  }, [devices, hostMap]);

  // Filtrace
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (typeFilter   && r.device_type !== typeFilter) return false;
      if (vendorFilter && r.vendor !== vendorFilter)    return false;
      if (statusFilter === "online"  && r.hostInfo?.currently_alive !== true)  return false;
      if (statusFilter === "offline" && r.hostInfo?.currently_alive !== false) return false;
      if (statusFilter === "unknown" && r.hostInfo?.currently_alive != null)   return false;
      return true;
    });
  }, [rows, typeFilter, vendorFilter, statusFilter]);

  // Unikátní výrobci pro filtr
  const vendors = useMemo(
    () => [...new Set(rows.map((r) => r.vendor).filter(Boolean))] as string[],
    [rows]
  );

  // Sloupce
  const columns = useMemo(() => getDeviceColumns(), []);

  // Sub-row renderer — detail panel
  const renderSubRow = useCallback(
    (row: Row<DeviceRow>) => {
      const id    = row.original.id;
      // Hledáme v rows - obsahuje aktuální data + hostInfo, obnovuje se po refetchi
      const fresh = rows.find((r) => r.id === id) ?? row.original;
      return (
        <DevicePanel
          key={`panel-${id}`}
          device={fresh as unknown as Device}
          hostInfo={fresh.hostInfo}
          hosts={hosts}
          onClose={() => setExpandedRowId(null)}
          defaultTab={(activeTabs[id] ?? "info") as any}
          onTabChange={(tab: string) => setActiveTabs(prev => ({ ...prev, [id]: tab }))}
        />
      );
    },
    [hosts, rows]
  );

  // Klik na řádek — toggle expand
  const handleRowClick = useCallback((row: DeviceRow) => {
    setExpandedRowId((prev) => (prev === row.id ? null : row.id));
  }, []);

  // Export CSV
  function exportCsv(selectedDevices: DeviceRow[]) {
    const data = selectedDevices.length > 0 ? selectedDevices : filteredRows;
    const headers = ["ID","Hostname","Alias","IP","Typ","Výrobce","MAC","S/N","Uptime%","RTT_ms","Vytvořeno"];
    const csvRows = data.map((d) => [
      d.id, d.hostname, d.alias ?? "", d.ip, d.device_type,
      d.vendor ?? "", d.mac ?? "", d.serial_number ?? "",
      d.hostInfo?.uptime_pct?.toFixed(1) ?? "",
      d.hostInfo?.avg_rtt_ms?.toFixed(1) ?? "",
      d.created_at,
    ].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","));
    const csv = [headers.join(","), ...csvRows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement("a");
    a.href = url; a.download = "netpulse_zarizeni.csv"; a.click();
    URL.revokeObjectURL(url);
  }

  // Bulk akce
  const renderBulkActions = useCallback(
    (selected: DeviceRow[], clearSelection: () => void) => (
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="destructive"
          onClick={async () => {
            if (!confirm(`Smazat ${selected.length} zařízení?`)) return;
            try {
              await Promise.all(selected.map((d) => deleteDevice.mutateAsync(d.id)));
              clearSelection();
            } catch (err) {
              alert(getErrorMessage(err));
            }
          }}
        >
          <Trash2 className="h-3.5 w-3.5" />
          Smazat ({selected.length})
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { exportCsv(selected); clearSelection(); }}
        >
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
      </div>
    ),
    [deleteDevice, filteredRows]
  );

  // Toolbar
  const renderToolbar = useCallback(() => (
    <div className="flex flex-wrap items-center gap-2">
      <TableSearch
        value={globalFilter}
        onChange={setGlobalFilter}
        placeholder="Hostname, IP, alias, MAC, výrobce…"
        className="w-72"
      />
      <Select
        value={statusFilter}
        onChange={(e) => setStatusFilter(e.target.value)}
        className="w-36"
      >
        <option value="">Vše — stav</option>
        <option value="online">🟢 Online</option>
        <option value="offline">🔴 Offline</option>
        <option value="unknown">⚫ Neznámý</option>
      </Select>
      <Select
        value={typeFilter}
        onChange={(e) => setTypeFilter(e.target.value)}
        className="w-36"
      >
        <option value="">Vše — typ</option>
        {DEVICE_TYPES.map((t) => <option key={t}>{t}</option>)}
      </Select>
      {vendors.length > 0 && (
        <Select
          value={vendorFilter}
          onChange={(e) => setVendorFilter(e.target.value)}
          className="w-36"
        >
          <option value="">Vše — výrobce</option>
          {vendors.map((v) => <option key={v}>{v}</option>)}
        </Select>
      )}
      <div className="flex-1" />
      <Button
        size="sm"
        variant="outline"
        onClick={() => exportCsv([])}
      >
        <Download className="h-3.5 w-3.5" />
        Export CSV
      </Button>
    </div>
  ), [globalFilter, statusFilter, typeFilter, vendorFilter, vendors, filteredRows]);

  return (
    <div className="space-y-4">
      {/* Přidat zařízení — collapsible nahoře */}
      <AddDeviceForm hosts={hosts} devices={devices} />

      {/* Tabulka */}
      <DataTable<DeviceRow>
        data={filteredRows}
        columns={columns}
        isLoading={devicesLoading || hostsLoading}
        globalFilter={globalFilter}
        onGlobalFilterChange={setGlobalFilter}
        getRowId={(row) => String(row.id)}
        renderSubRow={renderSubRow}
        renderToolbar={renderToolbar}
        renderBulkActions={renderBulkActions}
        onRowClick={handleRowClick}
        selectedRowId={expandedRowId ? String(expandedRowId) : null}
        emptyMessage="Žádná zařízení — přidejte první zařízení výše."
      />
    </div>
  );
}
