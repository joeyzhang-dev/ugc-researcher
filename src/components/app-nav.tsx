"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

/* The app's *section* axis — the six pages. Lives in the workspace rail as a
   vertical list so there's exactly one place to change page. Icons are thin
   line marks (Discord is its filled brand glyph) sized to share the rail's
   36px glyph column, so collapsed they line up under the workspace marks. */

/* ---------------------------------------------------------------------------
   Shared rail primitives. Defined here (the lowest node in the rail's import
   graph — this file imports none of the other shell components) and reused by
   workspace-switcher + workspace-rail so every rail row shares one geometry:
   a 36px glyph column centred in the 64px collapsed rail, with a label that
   only fades in once the rail expands on hover / keyboard focus.
   ------------------------------------------------------------------------ */

/** One rail row: 36px glyph + label, house focus ring, haptic press. */
export const RAIL_ROW =
  "group/row relative flex w-full items-center gap-3 rounded-xl px-[14px] py-2 transition active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas";

/** 36px glyph cell — the mark stays put; only the label slides in on expand. */
export const RAIL_GLYPH = "flex h-9 w-9 shrink-0 items-center justify-center";

/** Row label — hidden until the rail expands (hover or keyboard focus-within). */
export const RAIL_LABEL =
  "min-w-0 flex-1 truncate whitespace-nowrap text-left text-[13px] opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

type SectionTab = { href: string; label: string; icon: ReactNode };

const SECTION_TABS: SectionTab[] = [
  {
    href: "/overview", // cross-creator highest lifts
    label: "Overview",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
        <rect x="3" y="3" width="7.5" height="7.5" rx="1.6" />
        <rect x="13.5" y="3" width="7.5" height="7.5" rx="1.6" />
        <rect x="3" y="13.5" width="7.5" height="7.5" rx="1.6" />
        <rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.6" />
      </svg>
    ),
  },
  {
    href: "/research", // creators we study / steal from
    label: "Research",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
        <circle cx="11" cy="11" r="7" />
        <path d="m20.5 20.5-3.7-3.7" />
      </svg>
    ),
  },
  {
    href: "/creators", // our roster, per app + niche
    label: "Our creators",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
        <circle cx="9" cy="8" r="3.3" />
        <path d="M2.8 19.6c.8-3 3.2-4.8 6.2-4.8s5.4 1.8 6.2 4.8" />
        <circle cx="17.2" cy="9" r="2.4" />
        <path d="M15.8 14.5c2.4.3 4.5 1.9 5.4 4.2" />
      </svg>
    ),
  },
  {
    href: "/scripts", // briefs we write + how they performed
    label: "Scripts",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
        <path d="M14 3v4a1 1 0 0 0 1 1h4" />
        <path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9l-6-6Z" />
        <path d="M8.5 13h7M8.5 16.5h5" />
      </svg>
    ),
  },
  {
    href: "/discord", // the Folk UGC server: channels + feeds
    label: "Discord",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
        <path
          fill="currentColor"
          d="M19.3 5.4A16.3 16.3 0 0 0 15.1 4l-.2.4a13 13 0 0 1 3.7 1.2 15.1 15.1 0 0 0-12.8 0A13 13 0 0 1 9.5 4.4L9.3 4A16.3 16.3 0 0 0 5.1 5.4C2.6 9 1.9 12.6 2.2 16.1a16.5 16.5 0 0 0 5 2.6l.6-.9c-.9-.3-1.7-.7-2.4-1.2l.6-.4a11.8 11.8 0 0 0 10.1 0l.6.4c-.8.5-1.6.9-2.4 1.2l.6.9a16.5 16.5 0 0 0 5-2.6c.4-4.1-.6-7.7-3.2-10.7ZM9 14.1c-.8 0-1.5-.8-1.5-1.7s.7-1.7 1.5-1.7 1.5.8 1.5 1.7-.7 1.7-1.5 1.7Zm6 0c-.8 0-1.5-.8-1.5-1.7s.7-1.7 1.5-1.7 1.5.8 1.5 1.7-.7 1.7-1.5 1.7Z"
        />
      </svg>
    ),
  },
  {
    href: "/settings", // scrape schedule + manual runs
    label: "Settings",
    icon: (
      <svg width="20" height="20" viewBox="0 0 24 24" {...stroke}>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.1a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H2a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H8a1.6 1.6 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V8a1.6 1.6 0 0 0 1.5 1h.1a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1Z" />
      </svg>
    ),
  },
];

/** Vertical section nav, rendered inside the workspace rail. Active state comes
 *  from the path; the engaged item takes an accent tint + accent edge bar so
 *  "which page" reads differently from "which workspace" (a neutral bar). */
export function AppNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Sections" className="flex flex-col gap-0.5">
      {SECTION_TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            title={t.label}
            aria-current={active ? "page" : undefined}
            className={`${RAIL_ROW} ${
              active
                ? "bg-accent/[0.1] text-accent"
                : "text-neutral-500 hover:bg-neutral-900/[0.04] hover:text-neutral-900"
            }`}
          >
            <span
              aria-hidden
              className={`absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-accent transition-opacity ${
                active ? "opacity-100" : "opacity-0"
              }`}
            />
            <span
              className={`${RAIL_GLYPH} ${
                active ? "text-accent" : "text-neutral-400 group-hover/row:text-neutral-700"
              }`}
            >
              {t.icon}
            </span>
            <span className={`${RAIL_LABEL} ${active ? "font-medium" : ""}`}>{t.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
