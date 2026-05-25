import React from "react";
// components/ui/index.tsx — Základní UI komponenty

import { cn, STATUS_BG, STATUS_DOT, STATUS_LABEL, type DeviceStatus } from "@/lib/utils";
import { Loader2 } from "lucide-react";

// ---------------------------------------------------------------------------
// StatusDot — barevná tečka online/offline/unknown
// ---------------------------------------------------------------------------
export function StatusDot({
  status,
  className,
}: {
  status: DeviceStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-block h-2 w-2 shrink-0 rounded-full",
        STATUS_DOT[status],
        status === "online" && "shadow-[0_0_4px_1px_rgba(22,163,74,0.4)]",
        className
      )}
    />
  );
}

// ---------------------------------------------------------------------------
// StatusBadge — pill s textem online/offline/unknown
// ---------------------------------------------------------------------------
export function StatusBadge({
  status,
  className,
}: {
  status: DeviceStatus;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium",
        STATUS_BG[status],
        className
      )}
    >
      <StatusDot status={status} className="h-1.5 w-1.5" />
      {STATUS_LABEL[status]}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Badge — obecný label
// ---------------------------------------------------------------------------
export function Badge({
  children,
  variant = "default",
  className,
}: {
  children: React.ReactNode;
  variant?: "default" | "outline" | "secondary" | "destructive";
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        variant === "default" &&
          "bg-primary/10 text-primary",
        variant === "outline" &&
          "border border-border text-muted-foreground",
        variant === "secondary" &&
          "bg-secondary text-secondary-foreground",
        variant === "destructive" &&
          "bg-destructive/10 text-destructive",
        className
      )}
    >
      {children}
    </span>
  );
}

// ---------------------------------------------------------------------------
// MetricCard — karta s číslem a popiskem
// ---------------------------------------------------------------------------
export function MetricCard({
  label,
  value,
  sub,
  color,
}: {
  label: string;
  value: string | number;
  sub?: string;
  color?: "default" | "green" | "red" | "amber";
}) {
  const valueColor = {
    default: "text-foreground",
    green:   "text-green-600 dark:text-green-400",
    red:     "text-red-600 dark:text-red-400",
    amber:   "text-amber-600 dark:text-amber-400",
  }[color ?? "default"];

  return (
    <div className="rounded-lg border border-border bg-card p-4">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <p className={cn("mt-1 text-2xl font-semibold tabular-nums", valueColor)}>{value}</p>
      {sub && <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------
export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-4 w-4 animate-spin text-muted-foreground", className)} />;
}

// ---------------------------------------------------------------------------
// Empty state
// ---------------------------------------------------------------------------
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
      {Icon && (
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
      )}
      <div>
        <p className="font-medium">{title}</p>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------
type ButtonVariant = "primary" | "secondary" | "ghost" | "destructive" | "outline";
type ButtonSize = "sm" | "md" | "lg" | "icon";

export function Button({
  children,
  variant = "secondary",
  size = "md",
  className,
  disabled,
  onClick,
  type = "button",
}: {
  children: React.ReactNode;
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
  disabled?: boolean;
  onClick?: (e?: React.MouseEvent<HTMLButtonElement>) => void;
  type?: "button" | "submit" | "reset";
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50",
        "disabled:pointer-events-none disabled:opacity-50",
        variant === "primary" &&
          "bg-primary text-primary-foreground hover:bg-primary/90",
        variant === "secondary" &&
          "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        variant === "ghost" &&
          "hover:bg-accent hover:text-accent-foreground",
        variant === "outline" &&
          "border border-border bg-background hover:bg-accent",
        variant === "destructive" &&
          "bg-destructive/10 text-destructive hover:bg-destructive/20",
        size === "sm"   && "h-7 px-2.5 text-xs",
        size === "md"   && "h-9 px-3.5 text-sm",
        size === "lg"   && "h-10 px-5 text-sm",
        size === "icon" && "h-8 w-8",
        className
      )}
    >
      {children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------
export function Input({
  className,
  error,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { error?: string }) {
  return (
    <div className="w-full">
      <input
        className={cn(
          "w-full rounded-md border bg-background px-3 py-2 text-sm",
          "placeholder:text-muted-foreground",
          "focus:outline-none focus:ring-2 focus:ring-primary/50",
          error ? "border-destructive" : "border-border",
          className
        )}
        {...props}
      />
      {error && <p className="mt-1 text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Select
// ---------------------------------------------------------------------------
export function Select({
  className,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cn(
        "h-9 rounded-md border border-border bg-background px-3 py-0 text-sm",
        "focus:outline-none focus:ring-2 focus:ring-primary/50",
        "text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Label
// ---------------------------------------------------------------------------
export function Label({
  children,
  htmlFor,
  className,
}: {
  children: React.ReactNode;
  htmlFor?: string;
  className?: string;
}) {
  return (
    <label
      htmlFor={htmlFor}
      className={cn("block text-xs font-medium text-muted-foreground", className)}
    >
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// FormField wrapper
// ---------------------------------------------------------------------------
export function FormField({
  label,
  error,
  children,
  className,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("space-y-1", className)}>
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Divider
// ---------------------------------------------------------------------------
export function Divider({ className }: { className?: string }) {
  return <div className={cn("border-t border-border", className)} />;
}

// ---------------------------------------------------------------------------
// Confirm dialog (simple inline)
// ---------------------------------------------------------------------------
export function InlineConfirm({
  message,
  onConfirm,
  onCancel,
}: {
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="flex items-center gap-3 rounded-md bg-destructive/10 px-3 py-2">
      <p className="flex-1 text-sm text-destructive">{message}</p>
      <Button size="sm" variant="destructive" onClick={onConfirm}>Smazat</Button>
      <Button size="sm" variant="ghost" onClick={onCancel}>Zrušit</Button>
    </div>
  );
}

export { Pagination, usePagination, PAGE_SIZE } from "./Pagination";
