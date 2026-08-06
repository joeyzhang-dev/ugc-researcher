import Link from "next/link";
import type { ResearchVideo } from "@/lib/types";
import { CustomRange } from "@/components/custom-range";

// Recency is the point of the research pool — these presets slice every view by
// how recently a video was posted. The inline buttons stay server-rendered
// links (no client JS); each page supplies hrefForDays so other query params
// are preserved.

/** Inline buttons. Short windows only — the row has to stay narrow enough to
 *  sit beside a page title. */
export const DAY_PRESETS = [1, 2, 3, 7, 30] as const;

/** Offered inside the Custom popover, where width is not a constraint. */
export const CUSTOM_DAY_OPTIONS = [14, 21, 45, 60, 90, 180, 365] as const;

export const MAX_DAYS = 3650;

/** Any window is now valid, not just a preset — Custom accepts a free number.
 *  Kept as a plain number so pages do not need to care which it came from. */
export type DayPreset = number;

/** Parse the `days` search param → a positive day count, or null (= All time).
 *  Anything unparseable, zero, negative or absurd falls back to All time
 *  rather than throwing, since it arrives straight from the URL. */
export function parseDays(raw: string | string[] | undefined | null): DayPreset | null {
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (value == null || value === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const days = Math.round(n);
  if (days < 1) return null;
  return Math.min(days, MAX_DAYS);
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
      <CustomRange
        current={days}
        options={CUSTOM_DAY_OPTIONS}
        isCustom={days != null && !(DAY_PRESETS as readonly number[]).includes(days)}
      />
    </span>
  );
}
