"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Map, Building2 } from "lucide-react";

const MAP_TABS = [
  { href: "/maps/locations", label: "Mapa lokalit", icon: Building2 },
  // Budoucí mapy:
  // { href: "/maps/coverage",  label: "Mapa pokrytí", icon: Radio },
];

export default function MapsLayout({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();

  return (
    <div className="flex flex-col h-full">
      {/* Header se záložkami */}
      <div className="flex items-center gap-4 px-6 py-3 border-b border-border bg-background shrink-0">
        <div className="flex items-center gap-2 text-foreground">
          <Map className="h-5 w-5 text-primary" />
          <span className="text-base font-semibold">Mapy</span>
        </div>
        <div className="flex gap-1">
          {MAP_TABS.map(({ href, label, icon: Icon }) => {
            const active = pathname.startsWith(href);
            return (
              <Link
                key={href}
                href={href}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors
                  ${active
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground hover:bg-muted"
                  }`}
              >
                <Icon className="h-3.5 w-3.5" />
                {label}
              </Link>
            );
          })}
        </div>
      </div>

      {/* Obsah mapy — full height */}
      <div className="flex-1 min-h-0">
        {children}
      </div>
    </div>
  );
}
