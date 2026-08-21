/* Doc view — the weekly Google-Doc-style grid: niche rows × Script 1..N. */

import { weekKeyUTC } from "@/app/(app)/scripts/cal";

export interface DocGridRow<T> {
  niche: string | null;
  scripts: T[];
}

export interface DocGrid<T> {
  /** Widest batch this week — every row renders this many script columns. */
  columns: number;
  rows: DocGridRow<T>[];
}

/**
 * Shape one week's scripts into the doc layout: one row per niche
 * (alphabetical, unniched last), scripts ordered oldest-first so "Script 1"
 * is the first one written that week.
 */
export function buildDocGrid<T extends { niche: string | null; createdAt: string }>(
  rows: T[]
): DocGrid<T> {
  const byNiche = new Map<string | null, T[]>();
  for (const r of rows) {
    const key = r.niche ?? null;
    (byNiche.get(key) ?? byNiche.set(key, []).get(key)!).push(r);
  }
  const gridRows = [...byNiche.entries()]
    .sort(([a], [b]) => (a === null ? 1 : b === null ? -1 : a.localeCompare(b)))
    .map(([niche, scripts]) => ({
      niche,
      scripts: [...scripts].sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
    }));
  return {
    columns: gridRows.reduce((m, r) => Math.max(m, r.scripts.length), 0),
    rows: gridRows,
  };
}

/**
 * Canonical script numbers: a script's number is its Doc-view position —
 * 1-based, oldest-first, within its UTC week + niche. This is THE number a
 * coach and a creator mean by "#5": the table, the portal, and the Discord
 * cards all stamp the same one, even when a send carries only a subset.
 */
export function assignScriptNumbers(
  scripts: { id: string; niche: string | null; createdAt: string }[]
): Map<string, number> {
  const groups = new Map<string, { id: string; createdAt: string }[]>();
  for (const s of scripts) {
    const key = `${weekKeyUTC(s.createdAt.slice(0, 10))}|${s.niche ?? ""}`;
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(s);
  }
  const numbers = new Map<string, number>();
  for (const group of groups.values()) {
    [...group]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .forEach((s, i) => numbers.set(s.id, i + 1));
  }
  return numbers;
}

/**
 * Scripts written in the doc grid have no typed title — the hook is the
 * identity everywhere the app shows one, so the stored title is just its
 * first line, capped so imports into narrow UI stay sane.
 */
export function titleFromHook(hook: string | null): string | null {
  const line = (hook ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l !== "");
  if (!line) return null;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}
