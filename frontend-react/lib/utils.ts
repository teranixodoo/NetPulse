import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { formatDistanceToNow, format, parseISO } from "date-fns";
import { cs } from "date-fns/locale";

// ---------------------------------------------------------------------------
// Tailwind class merge
// ---------------------------------------------------------------------------
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------------------------------------------------------
// Datum / čas
// ---------------------------------------------------------------------------
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "dd.MM. HH:mm:ss");
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

export function formatDateShort(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return format(parseISO(iso), "dd.MM. HH:mm");
  } catch {
    return iso.slice(0, 16).replace("T", " ");
  }
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return formatDistanceToNow(parseISO(iso), { addSuffix: true, locale: cs });
  } catch {
    return "—";
  }
}

// ---------------------------------------------------------------------------
// Síťové hodnoty
// ---------------------------------------------------------------------------
export function formatRtt(ms: number | null | undefined): string {
  if (ms == null) return "—";
  return `${ms.toFixed(1)} ms`;
}

export function formatUptime(pct: number | null | undefined): string {
  if (pct == null) return "—";
  return `${pct.toFixed(1)} %`;
}

export function normalizeNetwork(input: string): string {
  const trimmed = input.trim();
  if (!trimmed.includes("/")) return `${trimmed}/32`;
  return trimmed;
}

// ---------------------------------------------------------------------------
// Status zařízení
// ---------------------------------------------------------------------------
export type DeviceStatus = "online" | "offline" | "unknown";

export function getDeviceStatus(alive: boolean | null | undefined): DeviceStatus {
  if (alive === true) return "online";
  if (alive === false) return "offline";
  return "unknown";
}

export const STATUS_COLORS: Record<DeviceStatus, string> = {
  online:  "text-green-600 dark:text-green-400",
  offline: "text-red-600 dark:text-red-400",
  unknown: "text-gray-400",
};

export const STATUS_BG: Record<DeviceStatus, string> = {
  online:  "bg-green-50 text-green-700 dark:bg-green-950 dark:text-green-300",
  offline: "bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300",
  unknown: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

export const STATUS_DOT: Record<DeviceStatus, string> = {
  online:  "bg-green-500",
  offline: "bg-red-500",
  unknown: "bg-gray-400",
};

export const STATUS_LABEL: Record<DeviceStatus, string> = {
  online:  "online",
  offline: "offline",
  unknown: "—",
};

// ---------------------------------------------------------------------------
// Uptime barva
// ---------------------------------------------------------------------------
export function uptimeColor(pct: number): string {
  if (pct >= 99) return "text-green-600 dark:text-green-400";
  if (pct >= 90) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

// ---------------------------------------------------------------------------
// Kopírování do schránky
// ---------------------------------------------------------------------------
export async function copyToClipboard(text: string): Promise<void> {
  await navigator.clipboard.writeText(text);
}
