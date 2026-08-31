/**
 * Weekly creator performance: posting quota, views, spikes, and the CPM that
 * decides whether a creator is good / decent / bad.
 *
 * Pure — no I/O — so the page and the Discord digest render the same numbers
 * from one function, and every rule below is unit-tested against fixtures.
 *
 * The number that matters is the **true CPM**: dollars Launchpoint actually
 * paid divided by the views of the posts it paid for. That is the figure Joey
 * reads off Launchpoint (`/analytics/videos?creator=…&paid=true`), and it is
 * reproducible from our own rows. Launchpoint's per-account `cpm` is NOT that
 * number — it divides paid earnings by the views of every post, paid or not,
 * so it collapses while payouts lag. Never read it.
 *
 * Why payouts lag: the program's pay structure (`/pay-structures`) settles a
 * post on the views it has at day 14 — $40 flat once it clears 1,000 views,
 * plus $1 per 1,000. So nothing posted in the last two weeks has a true CPM
 * yet. A *projected* CPM from that formula fills the gap, always labelled as
 * projected, and is never allowed to be mistaken for the true one.
 */

import type { ResearchVideo } from "@/lib/types";

/** The subset of a video the math needs. `ResearchVideo` satisfies it. */
export type PerformanceVideo = Pick<
  ResearchVideo,
  "shortcode" | "url" | "posted_at" | "view_count" | "earnings_usd"
>;

export type Bucket = "good" | "decent" | "bad";

/** Posts per week a creator is expected to make. Joey's coaching floor — the
 *  program's own ceiling is 21, a different number on purpose. */
export const QUOTA_POSTS_PER_WEEK = 7;

/** A spike is an absolute ≥ 40k views, not a multiple of the creator's own
 *  median: the baseline post does 1.5–2k, and 40k is also exactly where the
 *  payscale puts CPM under $2, so one number drives both notions of "good". */
export const SPIKE_VIEWS = 40_000;

/** Bucket lines from Joey's call notes: under $2 is good, 1.5k avg views
 *  (≈ $27 CPM) is "super bad". Measured against the roster on 2026-08-29:
 *  per-creator true CPM p10 2.49 / median 23.0 / p75 25.5 / p90 29.9, so $2
 *  and $25 split it into 3 good, 21 decent, 8 bad. Re-measure before moving. */
export const CPM_GOOD_MAX_USD = 2;
export const CPM_BAD_MIN_USD = 25;

/** Days after posting when Launchpoint settles the post's pay. */
export const SETTLE_DAYS = 14;
/** Launchpoint's payouts actually arrive ~3 weeks after posting, not 14
 *  days (checked 2026-08-29: newest paid post was 20 days old). A creator
 *  whose newest payout is older than this has no current true CPM — the
 *  number would describe a creator who has since stopped or changed. */
export const MAX_SETTLE_LAG_DAYS = 45;
/** Fewer paid posts than this and one spike owns the number. */
export const MIN_PAID_SAMPLE = 3;
/** The rolling window behind "updated 30-day creator CPM". */
export const CPM_WINDOW_DAYS = 30;
/** The onboarding read covers the creator's first week of posting. */
export const ONBOARDING_DAYS = 7;
/** Consecutive bad weeks after which the digest tells the coach to decide. */
export const BAD_STREAK_FLAG = 3;

export const DAY_MS = 24 * 60 * 60 * 1000;
export const WEEK_MS = 7 * DAY_MS;

/** The program's Default payscale as published by `/pay-structures`
 *  (2026-08-29). Per creator+program upstream — a trial or a custom group
 *  would differ, which is why it is a parameter and not a constant inside
 *  the math. */
export interface Payscale {
  flatFeeUsd: number;
  /** The flat fee is paid only once the post clears this many views. */
  flatFeeMinViews: number;
  perThousandViewsUsd: number;
  /** Views past this cap earn nothing more. */
  maxViews: number;
}

export const DEFAULT_PAYSCALE: Payscale = {
  flatFeeUsd: 40,
  flatFeeMinViews: 1000,
  perThousandViewsUsd: 1,
  maxViews: 1_000_000,
};

/** Half-open `[start, end)`, both UTC instants. */
export interface Window {
  start: Date;
  end: Date;
}

/** Monday 00:00 UTC of the week containing `at`. Weeks are Monday→Monday in
 *  UTC so "last week" is the same window whichever day, and whichever
 *  timezone, the job or the page happens to run in. */
export function weekStart(at: Date): Date {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d;
}

export function weekWindow(at: Date): Window {
  const start = weekStart(at);
  return { start, end: new Date(start.getTime() + WEEK_MS) };
}

/** The most recent *complete* Monday→Monday week as of `now`. */
export function lastCompleteWeek(now: Date = new Date()): Window {
  const thisWeek = weekStart(now);
  return { start: new Date(thisWeek.getTime() - WEEK_MS), end: thisWeek };
}

export function previousWeek(w: Window): Window {
  return { start: new Date(w.start.getTime() - WEEK_MS), end: new Date(w.end.getTime() - WEEK_MS) };
}

/** `YYYY-MM-DD` of a window's Monday — the URL/API key for a week. */
export function weekKey(w: Window): string {
  return w.start.toISOString().slice(0, 10);
}

/** Parse a `YYYY-MM-DD` (any day) into the week containing it; null when
 *  malformed so callers fall back to the last complete week. */
export function parseWeek(raw: string | undefined | null): Window | null {
  if (!raw || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const t = Date.parse(`${raw}T00:00:00Z`);
  return Number.isNaN(t) ? null : weekWindow(new Date(t));
}

const postedAt = (v: PerformanceVideo): number | null =>
  v.posted_at == null ? null : Date.parse(v.posted_at);

export function inWindow(videos: PerformanceVideo[], w: Window): PerformanceVideo[] {
  const s = w.start.getTime();
  const e = w.end.getTime();
  return videos.filter((v) => {
    const t = postedAt(v);
    return t != null && t >= s && t < e;
  });
}

/** Posts made in the `days` days ending at `asOf` (exclusive). */
export function trailingWindow(asOf: Date, days: number): Window {
  return { start: new Date(asOf.getTime() - days * DAY_MS), end: asOf };
}

const isPaid = (v: PerformanceVideo): boolean => (v.earnings_usd ?? 0) > 0;

/**
 * True CPM: paid dollars per 1,000 views over the posts that were paid.
 *
 * A ratio of sums, never a mean of per-post CPMs — a $40 flat fee on a
 * 900-view post is a $44 CPM on its own and would swamp a 400k-view hit.
 * Null, not $0, until something in the set has actually been paid: an unpaid
 * creator is unknown, not free.
 */
export function trueCpm(videos: PerformanceVideo[]): number | null {
  const paid = videos.filter(isPaid);
  const views = paid.reduce((sum, v) => sum + (v.view_count ?? 0), 0);
  if (views <= 0) return null;
  const earnings = paid.reduce((sum, v) => sum + (v.earnings_usd ?? 0), 0);
  return (earnings * 1000) / views;
}

/** What the payscale will pay a post with these views. */
export function projectedEarnings(views: number, payscale: Payscale = DEFAULT_PAYSCALE): number {
  const counted = Math.min(Math.max(views, 0), payscale.maxViews);
  const flat = counted >= payscale.flatFeeMinViews ? payscale.flatFeeUsd : 0;
  return flat + (counted / 1000) * payscale.perThousandViewsUsd;
}

/**
 * Projected CPM over every post in the set, paid or not — real earnings where
 * Launchpoint has settled the post, the payscale's answer where it has not.
 * Uses *current* views, so for an unsettled post it drifts toward the truth
 * until day 14 and past it afterwards; callers label it "projected".
 */
export function projectedCpm(
  videos: PerformanceVideo[],
  payscale: Payscale = DEFAULT_PAYSCALE
): number | null {
  const viewed = videos.filter((v) => (v.view_count ?? 0) > 0);
  const views = viewed.reduce((sum, v) => sum + v.view_count!, 0);
  if (views <= 0) return null;
  const earnings = viewed.reduce(
    (sum, v) => sum + (isPaid(v) ? v.earnings_usd! : projectedEarnings(v.view_count!, payscale)),
    0
  );
  return (earnings * 1000) / views;
}

/** Average views per post at which the payscale yields this CPM (for posts
 *  that clear the flat-fee floor): `flat * 1000 / (cpm − perThousand)`. */
export function viewsAtCpm(cpm: number, payscale: Payscale = DEFAULT_PAYSCALE): number {
  return (payscale.flatFeeUsd * 1000) / (cpm - payscale.perThousandViewsUsd);
}

/** The bucket lines as average views per post: $2 ⇔ 40,000, $25 ⇔ 1,667. */
export const GOOD_AVG_VIEWS = viewsAtCpm(CPM_GOOD_MAX_USD);
export const BAD_AVG_VIEWS = viewsAtCpm(CPM_BAD_MIN_USD);

/**
 * Buckets are judged on average views per post, not on the CPM directly.
 *
 * For any post over 1,000 views the two are the same test — CPM under this
 * payscale is `40000 / views + 1`, so $2 is 40k and $25 is 1.67k, exactly
 * Joey's "frequent 40k+ spikes" and "1,500 and under is super bad". Under
 * 1,000 views they diverge: the flat fee is withheld, a 149-view post costs
 * $0.15, and its CPM is a "good" $1.00. A creator averaging 149 views is the
 * worst case there is, not the best, and Launchpoint's own paid-only number
 * would call him good. Views keep the bucket honest where the price breaks.
 */
export function bucketForViews(avgViews: number | null): Bucket | null {
  if (avgViews == null || !Number.isFinite(avgViews)) return null;
  if (avgViews >= GOOD_AVG_VIEWS) return "good";
  if (avgViews <= BAD_AVG_VIEWS) return "bad";
  return "decent";
}

function avgViews(videos: PerformanceVideo[]): number | null {
  const viewed = videos.filter((v) => v.view_count != null);
  return viewed.length > 0
    ? viewed.reduce((sum, v) => sum + v.view_count!, 0) / viewed.length
    : null;
}

export interface PostRef {
  shortcode: string | null;
  url: string;
  views: number;
}

/** "How did they do last week" — posts, views, spikes. All true numbers:
 *  views are known the day a post goes up, nothing here waits on a payout. */
export interface WeeklyRead {
  posts: number;
  quota: number;
  /** Below quota is flagged regardless of bucket. */
  belowQuota: boolean;
  views: number;
  avgViews: number | null;
  /** What this week's posts will cost per 1k views under the payscale —
   *  the leading indicator, weeks before the payout confirms it. Under a
   *  $40 + $1/1k payscale this is a transform of avgViews, put in the
   *  dollars the coach thinks in. Always labelled projected. */
  projectedCpm: number | null;
  /** Posts at or above SPIKE_VIEWS, best first. */
  spikes: PostRef[];
  /** The week's most-viewed post, for the embed's hyperlink. */
  bestPost: PostRef | null;
}

export function weeklyRead(
  videos: PerformanceVideo[],
  week: Window,
  payscale: Payscale = DEFAULT_PAYSCALE
): WeeklyRead {
  const posts = inWindow(videos, week);
  const refs: PostRef[] = posts
    .map((v) => ({ shortcode: v.shortcode, url: v.url, views: v.view_count ?? 0 }))
    .sort((a, b) => b.views - a.views);
  const views = refs.reduce((sum, r) => sum + r.views, 0);
  return {
    posts: posts.length,
    quota: QUOTA_POSTS_PER_WEEK,
    belowQuota: posts.length < QUOTA_POSTS_PER_WEEK,
    views,
    avgViews: posts.length > 0 ? views / posts.length : null,
    projectedCpm: projectedCpm(posts, payscale),
    spikes: refs.filter((r) => r.views >= SPIKE_VIEWS),
    bestPost: refs[0] ?? null,
  };
}

/** The rolling 30-day CPM as of an instant. */
export interface CpmRead {
  /** True CPM over 30 days of *settled* posts — the 30 days ending at the
   *  creator's newest payout. Null until one is paid, or when the newest
   *  payout is older than MAX_SETTLE_LAG_DAYS. */
  cpm: number | null;
  paidPosts: number;
  /** The settled window `cpm` describes — ends at the newest paid post. */
  settledWindow: Window | null;
  /** Fewer than MIN_PAID_SAMPLE paid posts: one spike owns the number, so
   *  the page mutes the change and the streak does not count it. */
  lowSample: boolean;
  /** Average views of the settled (paid) posts — what the bucket is judged
   *  on when the true read is usable. */
  settledAvgViews: number | null;
  /** Projected over every post of the calendar window (the `days` before
   *  `asOf`) — the fallback while `cpm` is null, and a preview of where the
   *  true number is heading. */
  projected: number | null;
  /** Posts in the calendar window. */
  posts: number;
  /** Average views of every post in the calendar window — the bucket basis
   *  while the true read is missing or a low sample. */
  avgViews: number | null;
}

/** The average views a read should be bucketed on: the settled posts when
 *  the true read is usable, the whole calendar month otherwise. */
export function bucketBasis(read: CpmRead): { avgViews: number | null; source: "true" | "projected" | null } {
  if (read.cpm != null && !read.lowSample) return { avgViews: read.settledAvgViews, source: "true" };
  if (read.avgViews != null) return { avgViews: read.avgViews, source: "projected" };
  return { avgViews: null, source: null };
}

/**
 * Why the true window ends at the newest payout rather than at `asOf`:
 * payouts land ~3 weeks after posting, so a calendar window of the last 30
 * days holds only ~one week of settled posts. Two paid posts and a single
 * spike aging out swung Liam's number by $10 in a week while nothing about
 * him had changed. Anchoring on the payout frontier keeps a full month of
 * settled posts in the read, and it moves when new payouts arrive — which
 * is the only time the truth actually changes. (Liam, 2026-08-29: the
 * calendar window said $12.33 over 2 posts; this says $1.49 over all 8,
 * which is what Launchpoint's own paid-only summary shows.)
 */
export function cpmRead(
  videos: PerformanceVideo[],
  asOf: Date,
  days: number = CPM_WINDOW_DAYS,
  payscale: Payscale = DEFAULT_PAYSCALE
): CpmRead {
  const calendar = inWindow(videos, trailingWindow(asOf, days));
  const frontier = videos
    .filter((v) => isPaid(v) && postedAt(v) != null && postedAt(v)! < asOf.getTime())
    .reduce<number | null>((max, v) => (max == null || postedAt(v)! > max ? postedAt(v)! : max), null);
  const fresh = frontier != null && asOf.getTime() - frontier <= MAX_SETTLE_LAG_DAYS * DAY_MS;
  const settledWindow: Window | null = fresh
    ? { start: new Date(frontier! + 1 - days * DAY_MS), end: new Date(frontier! + 1) }
    : null;
  const settled = settledWindow ? inWindow(videos, settledWindow).filter(isPaid) : [];
  return {
    cpm: trueCpm(settled),
    paidPosts: settled.length,
    settledWindow,
    lowSample: settled.length > 0 && settled.length < MIN_PAID_SAMPLE,
    settledAvgViews: avgViews(settled),
    projected: projectedCpm(calendar, payscale),
    posts: calendar.length,
    avgViews: avgViews(calendar),
  };
}

export interface Delta {
  usd: number;
  pct: number;
}

/** Change between two readings; null unless both exist. For CPM, negative
 *  is the good direction — it costs less to reach a thousand people. */
export function delta(current: number | null, previous: number | null): Delta | null {
  if (current == null || previous == null || previous === 0) return null;
  return { usd: current - previous, pct: ((current - previous) / previous) * 100 };
}

/** The one-off read taken over a creator's first week of posting. */
export interface OnboardingRead {
  joinedAt: Date | null;
  /** First-week posts. */
  posts: number;
  avgViews: number | null;
  cpm: number | null;
  projected: number | null;
  /** The first week has closed, so the bucket will not change. The bucket
   *  is judged on views, which are known the day a post goes up; payouts
   *  only confirm the CPM later. */
  final: boolean;
  bucket: Bucket | null;
  /** Whether `cpm` is true (every first-week post paid) or still projected. */
  source: "true" | "projected" | null;
}

export function onboardingRead(
  videos: PerformanceVideo[],
  joinedAt: Date | null,
  asOf: Date,
  payscale: Payscale = DEFAULT_PAYSCALE
): OnboardingRead {
  if (joinedAt == null) {
    return {
      joinedAt: null, posts: 0, avgViews: null, cpm: null, projected: null, final: false, bucket: null, source: null,
    };
  }
  const firstWeek: Window = { start: joinedAt, end: new Date(joinedAt.getTime() + ONBOARDING_DAYS * DAY_MS) };
  const posts = inWindow(videos, firstWeek).filter((v) => postedAt(v)! < asOf.getTime());
  const cpm = trueCpm(posts);
  const projected = projectedCpm(posts, payscale);
  const allPaid = posts.length > 0 && posts.every(isPaid);
  return {
    joinedAt,
    posts: posts.length,
    avgViews: avgViews(posts),
    cpm,
    projected,
    final: asOf.getTime() >= firstWeek.end.getTime(),
    bucket: bucketForViews(avgViews(posts)),
    source: allPaid ? "true" : projected != null ? "projected" : null,
  };
}

/** Whole weeks between joining and the end of `week`; null when unknown,
 *  0 when the creator joined inside the week being read. */
export function weeksSinceJoined(joinedAt: Date | null, week: Window): number | null {
  if (joinedAt == null) return null;
  return Math.max(0, Math.floor((week.end.getTime() - joinedAt.getTime()) / WEEK_MS));
}

/**
 * Consecutive weekly readings, ending with `week`, whose bucket was `bad`.
 * Each week is judged on the rolling CPM as of its end — true where one
 * exists, projected otherwise, because a creator who has never been paid is
 * still a creator whose first weeks can look bad. Stops at the creator's
 * joining week, so a three-week streak means three weeks *as a creator*.
 */
export function badStreak(
  videos: PerformanceVideo[],
  week: Window,
  joinedAt: Date | null,
  payscale: Payscale = DEFAULT_PAYSCALE
): number {
  let streak = 0;
  let w = week;
  while (joinedAt == null || w.end.getTime() > joinedAt.getTime()) {
    const read = cpmRead(videos, w.end, CPM_WINDOW_DAYS, payscale);
    // A low-sample true read is not evidence either way — bucketBasis falls
    // through to the whole month, which sees every post.
    if (bucketForViews(bucketBasis(read).avgViews) !== "bad") break;
    streak++;
    w = previousWeek(w);
    // A creator with no joining date cannot be walked back forever; nothing
    // Launchpoint tracks predates the window this many weeks deep anyway.
    if (joinedAt == null && streak >= 52) break;
  }
  return streak;
}

export interface CreatorPerformance {
  week: Window;
  weekly: WeeklyRead;
  /** Rolling 30-day CPM as of the end of `week`. */
  cpm30: CpmRead;
  /** The same reading one week earlier — what "vs last week" compares to. */
  cpm30Prev: CpmRead;
  /** Change in the true 30-day CPM; null unless both weeks have one. */
  delta: Delta | null;
  /** Change in the projection — always available, so the embed can still
   *  say which way a never-paid creator is moving. */
  projectedDelta: Delta | null;
  /** Judged on average views (see bucketForViews) over the settled posts
   *  when the true read is usable, the calendar month otherwise. */
  bucket: Bucket | null;
  bucketSource: "true" | "projected" | null;
  onboarding: OnboardingRead;
  weeksSinceJoined: number | null;
  badStreak: number;
  /** `badStreak` has reached the line where the coach must decide. */
  flagged: boolean;
}

export function creatorPerformance(input: {
  videos: PerformanceVideo[];
  joinedAt: Date | null;
  week: Window;
  payscale?: Payscale;
}): CreatorPerformance {
  const payscale = input.payscale ?? DEFAULT_PAYSCALE;
  const { videos, joinedAt, week } = input;
  const cpm30 = cpmRead(videos, week.end, CPM_WINDOW_DAYS, payscale);
  const cpm30Prev = cpmRead(videos, previousWeek(week).end, CPM_WINDOW_DAYS, payscale);
  const basis = bucketBasis(cpm30);
  const streak = badStreak(videos, week, joinedAt, payscale);
  return {
    week,
    weekly: weeklyRead(videos, week, payscale),
    cpm30,
    cpm30Prev,
    delta: delta(cpm30.cpm, cpm30Prev.cpm),
    projectedDelta: delta(cpm30.projected, cpm30Prev.projected),
    bucket: bucketForViews(basis.avgViews),
    bucketSource: basis.source,
    onboarding: onboardingRead(videos, joinedAt, week.end, payscale),
    weeksSinceJoined: weeksSinceJoined(joinedAt, week),
    badStreak: streak,
    flagged: streak >= BAD_STREAK_FLAG,
  };
}

/** Digest order: the coach acts on bad first. */
export const BUCKET_ORDER: Record<Bucket, number> = { bad: 0, decent: 1, good: 2 };

/**
 * Sort for the digest and the page's default: bad → decent → good, unknown
 * last; inside a bucket the biggest CPM rise (the worst news) first, using
 * the true delta where it exists and the projected one otherwise.
 */
export function comparePerformance(a: CreatorPerformance, b: CreatorPerformance): number {
  const ba = a.bucket ? BUCKET_ORDER[a.bucket] : 3;
  const bb = b.bucket ? BUCKET_ORDER[b.bucket] : 3;
  if (ba !== bb) return ba - bb;
  const da = (a.delta ?? a.projectedDelta)?.usd ?? Number.NEGATIVE_INFINITY;
  const db = (b.delta ?? b.projectedDelta)?.usd ?? Number.NEGATIVE_INFINITY;
  return db - da;
}
