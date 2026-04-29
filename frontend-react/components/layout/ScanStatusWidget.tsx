"use client";

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, RefreshCw } from "lucide-react";
import { scanApi } from "@/lib/api";
import { formatRelative } from "@/lib/utils";
import { cn } from "@/lib/utils";

export function ScanStatusWidget() {
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ["scan-status"],
    queryFn:  scanApi.getStatus,
    refetchInterval: 5_000, // každých 5s
  });

  const trigger = useMutation({
    mutationFn: scanApi.trigger,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["scan-status"] });
      qc.invalidateQueries({ queryKey: ["hosts"] });
    },
  });

  const isScanning = status?.running || status?.is_scanning;

  return (
    <div className="space-y-2">
      {isScanning ? (
        <div className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground flex items-center gap-1">
              <RefreshCw className="h-3 w-3 animate-spin" />
              Scan probíhá…
            </span>
            <span className="text-muted-foreground">
              {status?.done_ips ?? 0}/{status?.total_ips ?? 0}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full rounded-full bg-primary transition-all duration-500"
              style={{ width: `${status?.progress ?? 0}%` }}
            />
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">
          Poslední scan:{" "}
          <span className="text-foreground">
            {formatRelative(status?.last_scan)}
          </span>
        </p>
      )}

      <button
        onClick={() => trigger.mutate()}
        disabled={isScanning || trigger.isPending}
        className={cn(
          "flex w-full items-center justify-center gap-1.5 rounded-md",
          "border border-border px-3 py-1.5 text-xs font-medium",
          "transition-colors hover:bg-accent hover:text-foreground",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        <Play className="h-3 w-3" />
        Skenovat nyní
      </button>
    </div>
  );
}
