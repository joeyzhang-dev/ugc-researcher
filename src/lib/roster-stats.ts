import type { ResearchVideo } from "@/lib/types";
import { withinWindow } from "@/components/range-picker";

/**
 * Per-creator numbers for the roster table: a 7-day posting strip plus
 * window-vs-all-time view and engagement figures. Pure — the page hands in the
 * videos and the RangePicker window; `now` is injectable for tests.
 *
 * Days bucket by LOCAL calendar day (this is a localhost tool — "posted
 * Tuesday" should mean Joey's Tuesday, not UTC's).
 */

export interface DayCell {
  /** Weekday initial ("M", "T", …) for the column caption. */
  label: string;
  /** Videos posted that local calendar day. */
  count: number;
}

export interface RosterRowStats {
  /** Exactly 7 cells, oldest first, ending today. */
  days: DayCell[];
  postsLast7: number;
  /** Mean views per video inside the picked window; null with no viewed videos. */
  avgViews: number | null;
  allAvgViews: number | null;
  /** Total views inside the window / across everything. */
  views: number;
  allViews: number;
  /** Aggregate (likes+comments+shares) ÷ views ×100; null when views total 0. */
  engPct: number | null;
  allEngPct: number | null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Local-midnight timestamp for the day `date` falls in. */
const dayFloor = (date: Date): number =>
  new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();

function metrics(videos: ResearchVideo[]): {
  avg: number | null;
  total: number;
  engPct: number | null;
} {
  const viewed = videos.filter((v) => v.view_count != null);
  const total = viewed.reduce((sum, v) => sum + v.view_count!, 0);
  const interactions = viewed.reduce(
    (sum, v) => sum + (v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0),
    0
  );
  return {
    avg: viewed.length > 0 ? total / viewed.length : null,
    total,
    engPct: total > 0 ? (interactions / total) * 100 : null,
  };
}

export function rosterRowStats(
  videos: ResearchVideo[],
  windowDays: number | null,
  now: Date = new Date()
): RosterRowStats {
  const today = dayFloor(now);
  const days: DayCell[] = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(today - (6 - i) * DAY_MS);
    return { label: day.toLocaleDateString("en-US", { weekday: "narrow" }), count: 0 };
  });
  for (const v of videos) {
    if (v.posted_at == null) continue;
    const offset = Math.floor((today - dayFloor(new Date(v.posted_at))) / DAY_MS);
    if (offset >= 0 && offset <= 6) days[6 - offset].count++;
  }

  const windowed = metrics(withinWindow(videos, windowDays));
  const allTime = metrics(videos);
  return {
    days,
    postsLast7: days.reduce((sum, d) => sum + d.count, 0),
    avgViews: windowed.avg,
    allAvgViews: allTime.avg,
    views: windowed.total,
    allViews: allTime.total,
    engPct: windowed.engPct,
    allEngPct: allTime.engPct,
  };
}
