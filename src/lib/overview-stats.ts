import type { ResearchCreator, ResearchVideo } from "@/lib/types";
import { median } from "@/lib/research";

/**
 * Numbers for the Overview dashboard. All pure; `now` is injectable for tests.
 *
 * We only hold one snapshot of each video's counters (taken at scrape time), so
 * every time series here is attributed to UPLOAD day — "videos posted that day
 * have, today, this many views" — not a daily delta, which the data can't
 * honestly provide.
 */

export interface DayPoint {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  label: string; // e.g. "Aug 17"
  views: number;
  engagement: number; // likes + comments + shares
  likes: number;
  comments: number;
  shares: number;
  posts: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

const dayFloor = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

const isoDay = (t: number): string => {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/**
 * One point per local day over the picked window (ending today). All time
 * (`windowDays` null) spans from the earliest dated video; with none, a single
 * empty day so the chart renders rather than divides by zero.
 */
export function dailySeries(
  videos: ResearchVideo[],
  windowDays: number | null,
  now: Date = new Date()
): DayPoint[] {
  const today = dayFloor(now);
  const dated = videos.filter((v) => v.posted_at != null);

  let start: number;
  if (windowDays != null) {
    start = today - (windowDays - 1) * DAY_MS;
  } else if (dated.length > 0) {
    start = Math.min(...dated.map((v) => dayFloor(new Date(v.posted_at!))));
  } else {
    start = today;
  }

  const count = Math.round((today - start) / DAY_MS) + 1;
  const points: DayPoint[] = Array.from({ length: count }, (_, i) => {
    const t = start + i * DAY_MS;
    return {
      date: isoDay(t),
      label: new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      views: 0,
      engagement: 0,
      likes: 0,
      comments: 0,
      shares: 0,
      posts: 0,
    };
  });

  for (const v of dated) {
    const i = Math.round((dayFloor(new Date(v.posted_at!)) - start) / DAY_MS);
    if (i < 0 || i >= count) continue;
    const p = points[i];
    const likes = v.like_count ?? 0;
    const comments = v.comment_count ?? 0;
    const shares = v.share_count ?? 0;
    p.views += v.view_count ?? 0;
    p.likes += likes;
    p.comments += comments;
    p.shares += shares;
    p.engagement += likes + comments + shares;
    p.posts += 1;
  }
  return points;
}

/** The same series, accumulated — the "Running total" chart mode. */
export function runningTotal(points: DayPoint[]): DayPoint[] {
  const sum = { views: 0, engagement: 0, likes: 0, comments: 0, shares: 0, posts: 0 };
  return points.map((p) => {
    sum.views += p.views;
    sum.engagement += p.engagement;
    sum.likes += p.likes;
    sum.comments += p.comments;
    sum.shares += p.shares;
    sum.posts += p.posts;
    return { ...p, ...sum };
  });
}

export interface StaleCreator {
  creator: ResearchCreator;
  /** Days since their last dated post; null = never posted. */
  daysSince: number | null;
  /** All-time views — what their audience is worth while they sit quiet. */
  totalViews: number;
}

/** Creators quiet for more than this many days need a nudge. */
export const STALE_AFTER_DAYS = 3;

/**
 * Who to nudge: never-posted first, then the biggest audiences first.
 *
 * `lastPostByCreator` is Launchpoint's per-account recency (creator id →
 * last_post_at ISO), merged in as "most recent wins". It exists because the
 * ingested videos only cover Instagram — a creator who posted on TikTok
 * yesterday would otherwise be nudged for being quiet. Absent map or absent
 * entry degrades to the video-derived answer.
 */
export function staleCreators(
  creators: ResearchCreator[],
  videosByCreator: Map<string, ResearchVideo[]>,
  now: Date = new Date(),
  lastPostByCreator?: Map<string, string>
): StaleCreator[] {
  const today = dayFloor(now);
  return creators
    .map((creator) => {
      const vids = (videosByCreator.get(creator.id) ?? []).filter((v) => v.posted_at != null);
      let last = vids.length
        ? Math.max(...vids.map((v) => dayFloor(new Date(v.posted_at!))))
        : null;
      const lp = lastPostByCreator?.get(creator.id);
      if (lp != null) {
        const lpDay = dayFloor(new Date(lp));
        if (!Number.isNaN(lpDay)) last = last == null ? lpDay : Math.max(last, lpDay);
      }
      return {
        creator,
        daysSince: last == null ? null : Math.round((today - last) / DAY_MS),
        totalViews: vids.reduce((sum, v) => sum + (v.view_count ?? 0), 0),
      };
    })
    .filter((r) => r.daysSince == null || r.daysSince > STALE_AFTER_DAYS)
    .sort((a, b) => {
      if ((a.daysSince == null) !== (b.daysSince == null)) return a.daysSince == null ? -1 : 1;
      return b.totalViews - a.totalViews;
    });
}

export type Consistency = "Consistent" | "Sporadic" | "Quiet";

/** Posting cadence over the last 4 weeks: 3+ active weeks reads Consistent,
 *  1–2 Sporadic, none Quiet. */
export function consistencyLabel(videos: ResearchVideo[], now: Date = new Date()): Consistency {
  const today = dayFloor(now);
  const weeks = new Set<number>();
  for (const v of videos) {
    if (v.posted_at == null) continue;
    const age = Math.round((today - dayFloor(new Date(v.posted_at))) / DAY_MS);
    if (age >= 0 && age < 28) weeks.add(Math.floor(age / 7));
  }
  return weeks.size >= 3 ? "Consistent" : weeks.size >= 1 ? "Sporadic" : "Quiet";
}

export interface FormatCallouts {
  working: { name: string; medianViews: number } | null;
  stop: { name: string; medianViews: number; shareOfPosts: number } | null;
}

/** A format needs this many videos before it can headline the summary. */
const CALLOUT_MIN_VIDEOS = 3;

/**
 * What's working / what to stop, computed from format buckets: the categorized
 * formats with enough volume, ranked by median views. Stop needs a second
 * qualifying format — one bucket can't be both the hero and the warning.
 */
export function formatCallouts(videos: ResearchVideo[]): FormatCallouts {
  const byFormat = new Map<string, number[]>();
  let categorized = 0;
  for (const v of videos) {
    if (!v.format_category || v.view_count == null) continue;
    categorized++;
    (byFormat.get(v.format_category) ??
      byFormat.set(v.format_category, []).get(v.format_category)!).push(v.view_count);
  }
  const ranked = [...byFormat.entries()]
    .filter(([, views]) => views.length >= CALLOUT_MIN_VIDEOS)
    .map(([name, views]) => ({
      name,
      medianViews: median(views) ?? 0,
      shareOfPosts: views.length / categorized,
    }))
    .sort((a, b) => b.medianViews - a.medianViews);

  const working = ranked[0] ?? null;
  const stop = ranked.length > 1 ? ranked[ranked.length - 1] : null;
  return {
    working: working ? { name: working.name, medianViews: working.medianViews } : null,
    stop,
  };
}
