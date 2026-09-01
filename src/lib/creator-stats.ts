/**
 * One creator's performance panel — the numbers behind `/stats`.
 *
 * Pure, like `performance.ts`, and built ON it rather than beside it: every
 * week in the series is a `weeklyRead`, so the trial-reel collapse, the spike
 * threshold and the quota all mean exactly what they mean in the weekly recap.
 * A creator who reads "16 posts" in the coach digest must read 16 here too.
 *
 * The panel answers a different question from the digest, though. The digest
 * asks "who needs attention this week"; this asks "what is going on with this
 * person" — which is a question about *direction*, so the series is the point
 * and the single week is just its last bar.
 */

import {
  DEFAULT_PAYSCALE,
  TRANSCRIPT_HORIZON_WEEKS,
  collapseTrialUploads,
  WEEK_MS,
  cpmRead,
  delta,
  weekWindow,
  weeklyRead,
  type CpmRead,
  type Delta,
  type PerformanceVideo,
  type PostRef,
  type WeeklyRead,
  type Window,
} from "@/lib/performance";

/** How many weeks of history the trend shows. Eight is a program quarter and
 *  fits the card without the bars turning into hairlines. It is also the
 *  transcript horizon the digest loader uses, on purpose: the `/stats` loader
 *  fetches transcripts for exactly these weeks, so tying the two keeps the
 *  coach's numbers and the creator's own collapsed over the same posts. */
export const TREND_WEEKS = TRANSCRIPT_HORIZON_WEEKS;

export interface WeekPoint {
  week: Window;
  read: WeeklyRead;
}

export interface MoneyRead {
  /** Everything Launchpoint has actually paid this creator, all time. */
  earnedUsd: number;
  paidPosts: number;
  /** Posts with views but no payout yet — the pipeline, not a shortfall.
   *  Payouts settle on day-14 views and land ~3 weeks after posting. */
  unpaidPosts: number;
  /** The rolling 30-day read, same one the digest and /performance show. */
  cpm30: CpmRead;
  cpm30Prev: CpmRead;
  delta: Delta | null;
}

export interface CreatorStats {
  /** Oldest week first, so the series reads left to right. */
  trend: WeekPoint[];
  /** The most recent complete week — the last bar in `trend`. */
  current: WeeklyRead;
  money: MoneyRead;
  /** Best posts across the whole trend window, most-viewed first. */
  topPosts: { post: PostRef; week: Window }[];
  /** Totals across the trend window, after the trial collapse. */
  totals: { posts: number; views: number; trialUploads: number; spikes: number };
}

/** The `TREND_WEEKS` complete weeks ending with the one containing `asOf`. */
export function trendWindows(asOf: Date, count: number = TREND_WEEKS): Window[] {
  const last = weekWindow(asOf);
  return Array.from({ length: count }, (_, i) => {
    const start = new Date(last.start.getTime() - (count - 1 - i) * WEEK_MS);
    return { start, end: new Date(start.getTime() + WEEK_MS) };
  });
}

/** Money is read over ALL of a creator's videos, not just the trend window:
 *  earnings are lifetime, and the 30-day CPM has its own settled window that
 *  routinely reaches back further than eight weeks. */
export function moneyRead(videos: PerformanceVideo[], asOf: Date): MoneyRead {
  const paid = videos.filter((v) => (v.earnings_usd ?? 0) > 0);
  // "Awaiting payout" is a count of WORK in the pipeline, so it counts
  // published reels. Left raw it read 166 for a creator with 57 paid posts —
  // almost all of it trial uploads that will never be paid separately.
  const withViews = collapseTrialUploads(videos).kept.filter((v) => (v.view_count ?? 0) > 0);
  const now = cpmRead(videos, asOf);
  const prev = cpmRead(videos, new Date(asOf.getTime() - WEEK_MS));
  return {
    earnedUsd: paid.reduce((sum, v) => sum + (v.earnings_usd ?? 0), 0),
    paidPosts: paid.length,
    unpaidPosts: withViews.length - paid.length,
    cpm30: now,
    cpm30Prev: prev,
    delta: delta(now.cpm, prev.cpm),
  };
}

export function creatorStats(input: {
  videos: PerformanceVideo[];
  asOf: Date;
  weeks?: number;
  topPosts?: number;
}): CreatorStats {
  const { videos, asOf, weeks = TREND_WEEKS, topPosts = 5 } = input;
  const windows = trendWindows(asOf, weeks);
  const trend = windows.map((week) => ({
    week,
    read: weeklyRead(videos, week, DEFAULT_PAYSCALE),
  }));

  // Top posts come from the per-week reads rather than from the raw videos, so
  // a trial upload can never be celebrated as a best post — the collapse has
  // already picked each batch's published winner.
  const ranked = trend
    .flatMap(({ week, read }) => read.topPosts.map((post) => ({ post, week })))
    .sort((a, b) => b.post.views - a.post.views)
    .slice(0, topPosts);

  return {
    trend,
    current: trend[trend.length - 1].read,
    money: moneyRead(videos, asOf),
    topPosts: ranked,
    totals: {
      posts: trend.reduce((s, p) => s + p.read.posts, 0),
      views: trend.reduce((s, p) => s + p.read.views, 0),
      trialUploads: trend.reduce((s, p) => s + p.read.trialUploads, 0),
      spikes: trend.reduce((s, p) => s + p.read.spikes.length, 0),
    },
  };
}
