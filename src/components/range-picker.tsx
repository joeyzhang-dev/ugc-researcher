import type { ResearchVideo } from "@/lib/types";
import { Segmented } from "@/components/ui";
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

/** Epoch ms cutoff for a window (posted_at >= this is in-window), or null.
 *  `now` is injectable so callers that already have a reference time can pass
 *  it — see withinWindow. */
export function windowStart(days: DayPreset | null, now: number = Date.now()): number | null {
  return days == null ? null : now - days * 24 * 60 * 60 * 1000;
}

/** Keep only videos posted within the window. Undated videos drop out of any
 *  window (they can't be placed in time); All time keeps everything.
 *
 *  `now` must be injectable: rosterRowStats accepts a reference time and used
 *  to honour it for the day strip while this silently read the wall clock, so
 *  its windowed metrics disagreed with its own day cells whenever the two
 *  differed. In production they agree (both default to now); in tests they did
 *  not, which made the suite pass or fail depending on the date it ran. */
export function withinWindow(
  videos: ResearchVideo[],
  days: DayPreset | null,
  now: number = Date.now()
): ResearchVideo[] {
  const start = windowStart(days, now);
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
  const isCustom = days != null && !(DAY_PRESETS as readonly number[]).includes(days);
  const items = [
    { value: "all", label: "All", href: hrefForDays(null) },
    ...DAY_PRESETS.map((d) => ({ value: String(d), label: `${d}d`, href: hrefForDays(d) })),
  ];
  // When Custom holds the window, no preset is active — pass a value no segment
  // owns so the whole preset track reads idle and Custom carries the highlight.
  const value = isCustom ? "custom" : days == null ? "all" : String(days);

  return (
    <span className={`inline-flex shrink-0 items-center gap-1.5 ${className}`}>
      <Segmented items={items} value={value} size="sm" aria-label="Recency window" />
      <CustomRange current={days} options={CUSTOM_DAY_OPTIONS} isCustom={isCustom} />
    </span>
  );
}
