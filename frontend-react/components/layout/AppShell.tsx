"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { useAuth } from "@/lib/auth";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ChevronLeft, ChevronRight } from "lucide-react";

const PUBLIC_ROUTES = ["/login"];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  const pathname = usePathname();
  const router   = useRouter();
  const isPublic = PUBLIC_ROUTES.includes(pathname);

  const [collapsed, setCollapsed] = useState(() => {
    if (typeof window === "undefined") return false;
    return localStorage.getItem("sidebar_collapsed") === "true";
  });

  function toggleSidebar() {
    setCollapsed(v => {
      const next = !v;
      localStorage.setItem("sidebar_collapsed", String(next));
      return next;
    });
  }

  useEffect(() => {
    if (!isLoading && !isAuthenticated && !isPublic) router.push("/login");
    if (!isLoading && isAuthenticated && pathname === "/login") router.push("/dashboard");
  }, [isAuthenticated, isLoading, isPublic, pathname, router]);

  if (isLoading) return (
    <div className="flex h-screen items-center justify-center">
      <div className="flex flex-col items-center gap-3">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">Načítání…</p>
      </div>
    </div>
  );

  if (isPublic) return <>{children}</>;
  if (!isAuthenticated) return null;

  return (
    <div className="flex h-screen overflow-hidden bg-background">

      {/* Sidebar + toggle — společný wrapper */}
      <div className="relative flex shrink-0">
        {/* Sidebar panel */}
        <div className={`overflow-hidden transition-all duration-200 ${collapsed ? "w-0" : "w-52"}`}>
          <Sidebar />
        </div>

        {/* Toggle tlačítko — přilepené k pravému okraji sidebaru */}
        <button
          onClick={toggleSidebar}
          title={collapsed ? "Zobrazit menu" : "Skrýt menu"}
          className="absolute right-0 top-1/2 -translate-y-1/2 translate-x-full z-50
            flex items-center justify-center w-4 h-10
            bg-background border border-l-0 border-border rounded-r-md
            text-muted-foreground hover:text-foreground hover:bg-muted
            shadow-sm transition-colors"
        >
          {collapsed ? <ChevronRight className="h-3 w-3" /> : <ChevronLeft className="h-3 w-3" />}
        </button>
      </div>

      {/* Hlavní obsah */}
      <div className="flex flex-1 flex-col overflow-hidden min-w-0">
        <TopBar />
        <main className="flex-1 overflow-auto p-6">
          {children}
        </main>
      </div>
    </div>
  );
}
