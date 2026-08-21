/* Creator portal data shaping — pure, unit-tested (tests/creator-portal.test.ts).
   Week semantics are the scripts explorer's: UTC weeks keyed by Monday, the
   batch labeled by its latest send day. */

import { weekKeyUTC, weekLabel } from "@/app/(app)/scripts/cal";

/** Where the portal lives for links minted server-side (Discord cards). The
 *  worker mirrors this default in discord_bot/config.py — keep them in sync. */
const APP_BASE_URL = (process.env.NEXT_PUBLIC_APP_URL ?? "https://bludgc.vercel.app").replace(/\/+$/, "");

export function portalUrl(shareToken: string): string {
  return `${APP_BASE_URL}/c/${shareToken}`;
}

export interface PortalScript {
  id: string;
  hook: string | null;
  body: string | null;
  inspoUrl: string | null;
  demo: string | null;
  songs: string | null;
  niche: string | null;
  createdAt: string;
  /** Canonical Doc-view #N — matches the Discord card and the scripts table. */
  number?: number | null;
}

export interface PortalWeek {
  key: string;
  label: string;
  scripts: PortalScript[];
}

/** Newest week first; scripts inside a week oldest-first (doc order). */
export function groupScriptsByWeek(scripts: PortalScript[], now: Date = new Date()): PortalWeek[] {
  const weeks = new Map<string, PortalScript[]>();
  for (const s of scripts) {
    const key = weekKeyUTC(s.createdAt.slice(0, 10));
    (weeks.get(key) ?? weeks.set(key, []).get(key)!).push(s);
  }
  return [...weeks.entries()]
    .sort(([a], [b]) => b.localeCompare(a))
    .map(([key, group]) => {
      const ordered = [...group].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const latestDay = ordered[ordered.length - 1].createdAt.slice(0, 10);
      return { key, label: weekLabel(key, latestDay, now), scripts: ordered };
    });
}
