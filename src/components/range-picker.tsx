import Link from "next/link";
import type { ResearchVideo } from "@/lib/types";

// Recency is the point of the research pool — these presets slice every view by
// how recently a video was posted. Server-rendered segmented buttons (no client
// JS); each page supplies hrefForDays so other query params are preserved.

export const DAY_PRESETS = [7, 14, 21, 30] as const;
export type DayPreset = (typeof DAY_PRESETS)[number];

/** Parse the `days` search param → a valid preset, or null (= All time). */
export function parseDays(raw: string | string[] | undefined | null): DayPreset | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const n = Number(value);
  return (DAY_PRESETS as readonly number[]).includes(n) ? (n as DayPreset) : null;
}

/** Epoch ms cutoff for a window (posted_at >= this is in-window), or null. */
export function windowStart(days: DayPreset | null): number | null {
  return days == null ? null : Date.now() - days * 24 * 60 * 60 * 1000;
}

/** Keep only videos posted within the window. Undated videos drop out of any
 *  window (they can't be placed in time); All time keeps everything. */
export function withinWindow(videos: ResearchVideo[], days: DayPreset | null): ResearchVideo[] {
  const start = windowStart(days);
  if (start == null) return videos;
  return videos.filter((v) => v.posted_at != null && new Date(v.posted_at).getTime() >= start);
}

export function RangePicker({
  days,
  hrefForDays,
  className = "",
}: {
  days: DayPreset | null;
  hrefForDays: (d: DayPreset | null) => string;
  className?: string;
}) {
  const base = "rounded-md px-2.5 py-1 text-xs transition-colors";
  const active = "bg-neutral-900 font-medium text-white";
  const idle = "text-neutral-500 hover:text-neutral-900";
  return (
    <span
      className={`inline-flex shrink-0 rounded-lg border border-neutral-200 bg-white p-0.5 ${className}`}
    >
      <Link
        href={hrefForDays(null)}
        scroll={false}
        className={`${base} ${days == null ? active : idle}`}
      >
        All
      </Link>
      {DAY_PRESETS.map((d) => (
        <Link
          key={d}
          href={hrefForDays(d)}
          scroll={false}
          className={`${base} ${days === d ? active : idle}`}
        >
          {d}d
        </Link>
      ))}
    </span>
  );
}
