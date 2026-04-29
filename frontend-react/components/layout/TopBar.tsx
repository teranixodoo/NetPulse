"use client";

import { usePathname } from "next/navigation";
import { LogOut, User } from "lucide-react";
import { useAuth } from "@/lib/auth";

const PAGE_TITLES: Record<string, string> = {
  "/dashboard":   "Dashboard",
  "/devices":     "Evidence zařízení",
  "/hosts":       "Detailní výpis IP adres",
  "/graphs":     "Grafy ICMP",
  "/ranges":      "IP Rozsahy",
  "/credentials": "Přihlašovací profily",
  "/logs":        "Log výpadků",
  "/users":       "Správa uživatelů",
  "/settings":    "Nastavení",
};

export function TopBar() {
  const { user, logout } = useAuth();
  const pathname = usePathname();
  const title = PAGE_TITLES[pathname] ?? "NetPulse";

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-card px-6">
      <h1 className="text-base font-semibold">{title}</h1>

      <div className="flex items-center gap-3">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <User className="h-4 w-4" />
          <span>{user?.username}</span>
          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
            {user?.role}
          </span>
        </div>
        <button
          onClick={logout}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm
                     text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <LogOut className="h-4 w-4" />
          Odhlásit
        </button>
      </div>
    </header>
  );
}
