"use client";

import { useMemo, useState } from "react";
import type { PerformanceRow as PerformanceRowData } from "@/lib/jobs/performance";
import { BUCKET_ORDER, comparePerformance } from "@/lib/performance";
import { compareValues, type SortDir } from "@/components/sort-header";
import { PERFORMANCE_GRID as GRID, PerformanceRow as Row } from "@/components/performance-rows";
import { tableWrap, th } from "@/components/ui";

const SORT_KEYS = ["digest", "creator", "posts", "views", "cpm", "delta", "joined"] as const;
type SortKey = (typeof SORT_KEYS)[number];

const COLUMNS: readonly [label: string, key: SortKey, firstDir: SortDir, align: string][] = [
  ["Creator", "creator", "asc", ""],
  ["Posts", "posts", "desc", "text-right"],
  ["Avg views", "views", "desc", "text-right"],
  ["30d CPM", "cpm", "asc", "text-right"],
  ["Change", "delta", "desc", "text-right"],
  ["Joined", "joined", "desc", "text-right"],
  ["Bucket", "digest", "asc", "text-right"],
];

function sortValue(r: PerformanceRowData, key: SortKey): string | number | null {
  const p = r.performance;
  switch (key) {
    case "digest": return p.bucket ? BUCKET_ORDER[p.bucket] : null;
    case "posts": return p.weekly.posts;
    case "views": return p.weekly.avgViews;
    case "cpm": return p.cpm30.cpm ?? p.cpm30.projected;
    case "delta": return (p.delta ?? p.projectedDelta)?.usd ?? null;
    case "joined": return p.weeksSinceJoined;
    default: return r.launchpointName || r.displayName || r.handle;
  }
}

/**
 * The coach's creator table, sorted in the browser.
 *
 * Sorting used to be a link that re-rendered the page on the server, which
 * meant re-loading the whole roster's videos for every click — 2 to 8
 * seconds to reorder fifteen rows that were already on screen. The rows
 * arrive once as props and every sort is a `useMemo` over them.
 */
export function CoachTable({ rows }: { rows: PerformanceRowData[] }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir }>({ key: "digest", dir: "asc" });

  const sorted = useMemo(
    () =>
      [...rows].sort(
        (a, b) =>
          compareValues(sortValue(a, sort.key), sortValue(b, sort.key), sort.dir) ||
          (sort.key === "digest" ? comparePerformance(a.performance, b.performance) : 0) ||
          a.handle.localeCompare(b.handle)
      ),
    [rows, sort]
  );

  const toggle = (key: SortKey, firstDir: SortDir) =>
    setSort((cur) => (cur.key === key ? { key, dir: cur.dir === "asc" ? "desc" : "asc" } : { key, dir: firstDir }));

  return (
    <div className={tableWrap}>
      <div className="min-w-[1000px]">
        <div className={`${GRID} border-b border-black/[0.05] pb-1`}>
          {COLUMNS.map(([label, key, firstDir, align]) => {
            const active = sort.key === key;
            const arrowFirst = align === "text-right";
            const arrow = (
              <svg
                aria-hidden
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={active ? 3 : 2.5}
                className={`shrink-0 ${active ? "" : "text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100"}`}
              >
                {active ? (
                  <path d={sort.dir === "asc" ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
                ) : (
                  <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
                )}
              </svg>
            );
            return (
              <div key={key} className={`${th} !px-0 ${align}`}>
                <button
                  type="button"
                  // Blur on click: a mouse click leaves the button focused
                  // and some browsers draw the focus outline for it — the
                  // border flash on every sort. Keyboard focus keeps a ring
                  // via focus-visible.
                  onClick={(e) => {
                    toggle(key, firstDir);
                    e.currentTarget.blur();
                  }}
                  title={`Sort by ${label.toLowerCase()}`}
                  className={`group inline-flex items-center gap-1 rounded-sm outline-none transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                    active ? "font-semibold text-neutral-900" : "hover:text-neutral-700"
                  }`}
                >
                  {arrowFirst && arrow}
                  {label}
                  {!arrowFirst && arrow}
                </button>
              </div>
            );
          })}
        </div>
        <div className="divide-y divide-black/[0.05]">
          {sorted.map((r) => (
            <Row key={r.creatorId} row={r} showCoach={false} creatorHref={() => null} />
          ))}
        </div>
      </div>
    </div>
  );
}
