"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/overview", label: "Overview" }, // cross-creator highest lifts
  { href: "/research", label: "Research" }, // creators we study / steal from
  { href: "/creators", label: "Our creators" }, // our roster, per app + niche
  { href: "/scripts", label: "Scripts" }, // briefs we write + how they performed
  { href: "/settings", label: "Settings" }, // scrape schedule + manual runs
];

export function AppNav() {
  const pathname = usePathname();
  return (
    <nav className="flex items-center gap-1 rounded-lg border border-neutral-200 bg-neutral-50 p-0.5">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            className={`rounded-md px-3 py-1.5 text-[13px] transition-colors ${
              active
                ? "bg-white font-semibold text-neutral-900 shadow-sm"
                : "text-neutral-500 hover:text-neutral-900"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
