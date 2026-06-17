"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard, Monitor, Network, KeyRound,
  ScrollText, Settings, Radio, Users, List, History, BarChart2,
  HardDrive, Terminal, AlertTriangle, Globe, Settings2, MapPin, Table2, Map, Wifi, GitBranch } from "lucide-react";
import { cn } from "@/lib/utils";
import { useAuth } from "@/lib/auth";
import { ScanStatusWidget } from "./ScanStatusWidget";
import { useMacStats } from "@/hooks/useNetPulse";

const NAV_ITEMS = [
  { href: "/dashboard",         label: "Dashboard",        icon: LayoutDashboard },
  { href: "/devices",           label: "Zařízení",         icon: Monitor },
  { href: "/hosts",             label: "IP Adresy",        icon: List },
  { href: "/graphs",            label: "Grafy",            icon: BarChart2 },
  { href: "/sites",             label: "Sítě",             icon: Globe },
  { href: "/ranges",            label: "IP Rozsahy",       icon: Network },
  { href: "/unknown-networks",  label: "Neznámé sítě",     icon: AlertTriangle },
  { href: "/network-awareness", label: "Network Awareness",icon: Wifi },
  { href: "/credentials",       label: "Přihl. profily",   icon: KeyRound },
  { href: "/scans",             label: "Historie scanů",   icon: History },
  { href: "/backups",           label: "Zálohy",           icon: HardDrive },
  { href: "/users",             label: "Uživatelé",        icon: Users },
  { href: "/settings",          label: "Nastavení",        icon: Settings },
  { href: "/config",            label: "Konfigurace",      icon: Settings2 },
  { href: "/locations",         label: "Lokace strom",     icon: MapPin },
  { href: "/locations/table",   label: "Lokace tabulka",   icon: Table2 },
  { href: "/maps",              label: "Mapy",             icon: Map },
  { href: "/topology",          label: "Topologie",        icon: GitBranch },
  { href: "/outages",           label: "Log výpadků",      icon: AlertTriangle },
  { href: "/change-log",        label: "Log změn",         icon: History },
];

const ADMIN_ITEMS = [
  { href: "/system-logs", label: "System Logs", icon: Terminal },
];

export function Sidebar() {
  const pathname      = usePathname();
  const { user }      = useAuth();
  const { data: macStats } = useMacStats();
  const newMacCount   = macStats?.new_7d ?? 0;

  return (
    <aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-card">
      {/* Logo */}
      <div className="flex h-14 items-center gap-2.5 border-b border-border px-4">
        <Radio className="h-5 w-5 text-primary" />
        <span className="text-base font-semibold tracking-tight">NetPulse</span>
      </div>

      {/* Navigace */}
      <nav className="flex-1 overflow-y-auto py-3">
        <ul className="space-y-0.5 px-2">
          {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
            const active = pathname === href || pathname.startsWith(href + "/");
            const isNA   = href === "/network-awareness";
            return (
              <li key={href}>
                <Link
                  href={href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  <span className="flex-1">{label}</span>
                  {isNA && newMacCount > 0 && (
                    <span className="inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-bold min-w-[18px] h-[18px] px-1">
                      {newMacCount > 99 ? "99+" : newMacCount}
                    </span>
                  )}
                </Link>
              </li>
            );
          })}
        </ul>

        {/* Admin sekce — pouze pro administrátory */}
        {user?.role === "admin" && (
          <>
            <div className="mx-3 my-2 border-t border-border" />
            <ul className="space-y-0.5 px-2">
              {ADMIN_ITEMS.map(({ href, label, icon: Icon }) => {
                const active = pathname === href || pathname.startsWith(href + "/");
                return (
                  <li key={href}>
                    <Link href={href}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
                        active
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground"
                      )}
                    >
                      <Icon className="h-4 w-4 shrink-0" />
                      {label}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </nav>

      {/* Scan status widget dole */}
      <div className="border-t border-border p-3">
        <ScanStatusWidget />
      </div>
    </aside>
  );
}
