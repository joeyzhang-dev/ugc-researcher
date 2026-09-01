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
import { transcriptMatchScore } from "@/lib/scripts";

/** The subset of a video the math needs. `ResearchVideo` satisfies it. */
export type PerformanceVideo = Pick<
  ResearchVideo,
  "shortcode" | "url" | "posted_at" | "view_count" | "earnings_usd"
> & {
  /** Only populated for videos inside `transcriptHorizon` (plus a creator's
   *  onboarding week) — that is every window the collapse is applied to,
   *  and pulling transcripts for the whole ~40k-post corpus would multiply
   *  the loader's payload for no gain. Absent, the post stands alone. */
  transcript_text?: string | null;
  /** As above: horizon posts only, for the top-posts strip. */
  thumbnail_url?: string | null;
};

export type Bucket = "good" | "decent" | "bad";

/** Posts per week a creator is expected to make. Joey's coaching floor — the
 *  program's own ceiling is 21, a different number on purpose. */
export const QUOTA_POSTS_PER_WEEK = 7;

/** A spike is an absolute ≥ 40k views, not a multiple of the creator's own
 *  median: the baseline post does 1.5–2k, and 40k is also exactly where the
 *  payscale puts CPM under $2, so one number drives both notions of "good". */
export const SPIKE_VIEWS = 40_000;

/** How many of the week's posts the recap celebrates. Five is enough to show
 *  a pattern ("her hooks are landing") rather than one lucky reel. */
export const TOP_POSTS = 5;

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

/**
 * How far back a loader must attach transcripts for the trial-reel collapse
 * to mean the same thing in every window `creatorPerformance` reads.
 *
 * The collapse only sees a post's words where the loader fetched them; a post
 * without a transcript stands alone. So the horizon decides which windows are
 * actually collapsed. `cpm30` reaches 30 days back from the week's end,
 * `cpm30Prev` 37, and a bad streak of `BAD_STREAK_FLAG` weeks reads a 30-day
 * window ending two weeks earlier still — 51 days. Eight weeks (56) covers
 * all of them with a week to spare, and is also the trend `/stats` draws, so
 * the coach digest and the creator's own panel collapse the same posts.
 *
 * Before this existed (2026-08-31 → 2026-09-02) the digest loader fetched the
 * reporting week only: `cpm30` was collapsed for one week of its four,
 * `cpm30Prev` not at all, and a creator running trials showed a projected-CPM
 * "improvement" that was nothing but the mismatch.
 */
export const TRANSCRIPT_HORIZON_WEEKS = 8;

/** The `TRANSCRIPT_HORIZON_WEEKS` ending with `week` — the posts a loader
 *  must carry transcripts for. */
export function transcriptHorizon(week: Window): Window {
  return { start: new Date(week.end.getTime() - TRANSCRIPT_HORIZON_WEEKS * WEEK_MS), end: week.end };
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
  /** Populated for posts inside the reporting week, so the recap card can
   *  show the reel rather than just link it. */
  thumbnail?: string | null;
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
  /** The week's best few, most-viewed first — one line each in the recap. */
  topPosts: PostRef[];
  /** Uploads folded away as trial-reel repeats. Surfaced so a coach can see
   *  the raw effort behind a small post count. */
  trialUploads: number;
}

/* --- trial reels ---------------------------------------------------------- */

/**
 * How alike two transcripts are, symmetrically (0–1).
 *
 * `transcriptMatchScore` is deliberately asymmetric — it asks "how much of the
 * script survived into the transcript", which is the right question when
 * matching a script to a post. Here both sides are transcripts of the same
 * length, and we want "are these the same video", so we take the weaker of the
 * two directions: a short clip fully contained in a long ramble is not the
 * same reel, and only requiring both directions rules that out.
 */
export function transcriptSimilarity(a: string, b: string): number {
  return Math.min(transcriptMatchScore(a, b), transcriptMatchScore(b, a));
}

/** Above this, two posts are the same reel uploaded twice. Measured against
 *  the live corpus (2026-08-31): a real trial batch scores ~1.0 across its
 *  members, while two genuinely different scripts by the same creator on the
 *  same theme topped out around 0.5. */
export const TRIAL_SAME_REEL = 0.8;

/** A batch has to be more than a pair before we call it a trial run. Posting
 *  the same reel twice is something creators do by hand; twenty times is the
 *  trial-reel tool. */
export const TRIAL_MIN_BATCH = 3;

export interface TrialCollapse {
  /** One representative per distinct reel — the best-performing upload of
   *  each batch, which is the one Instagram actually published. */
  kept: PerformanceVideo[];
  /** How many uploads were folded away. Reported, never silently dropped. */
  suppressed: number;
}

/**
 * Collapse trial-reel batches down to one post each.
 *
 * Creators run Instagram Trials through a tool that uploads the same reel
 * dozens of times: measured live, one creator's week held 104 uploads carrying
 * 17 distinct transcripts, one of them repeated 59 times. Counted raw, that
 * creator "posted 104 times" and their average views collapsed toward the
 * trial noise floor (~2k) no matter how well the published cut did (83k).
 *
 * Neither Launchpoint nor Instagram flags a trial for us — checked both
 * (2026-08-31): no field on `/posts`, and `crossPostGroupId` turned out to be
 * the Instagram↔TikTok cross-post pair, size 1–2, not the batch. So the batch
 * is identified by what actually distinguishes it: the same words, over and
 * over, from one creator inside one week.
 *
 * The representative is the highest-view upload because that is the one that
 * won the trial and got published — in the 59-upload batch it took 83k views
 * and 72k reach while its siblings sat at ~2k. Keeping the max, rather than
 * summing, is what makes "avg views" mean "how did their reel do".
 *
 * Anything without a transcript stands alone. A missing transcript is not
 * evidence of duplication, and guessing would quietly delete real posts.
 */
export function collapseTrialUploads(videos: PerformanceVideo[]): TrialCollapse {
  const withText: PerformanceVideo[] = [];
  const kept: PerformanceVideo[] = [];
  for (const v of videos) {
    if ((v.transcript_text ?? "").trim().length > 0) withText.push(v);
    else kept.push(v);
  }

  // Most-viewed first, so the first member of a group is already its winner.
  const ordered = [...withText].sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0));
  const groups: PerformanceVideo[][] = [];
  for (const v of ordered) {
    const text = v.transcript_text ?? "";
    const group = groups.find((g) => transcriptSimilarity(g[0].transcript_text ?? "", text) >= TRIAL_SAME_REEL);
    if (group) group.push(v);
    else groups.push([v]);
  }

  let suppressed = 0;
  for (const group of groups) {
    kept.push(group[0]);
    // A pair is not a trial run; keep both and count neither as suppressed.
    if (group.length >= TRIAL_MIN_BATCH) suppressed += group.length - 1;
    else for (const extra of group.slice(1)) kept.push(extra);
  }
  return { kept, suppressed };
}

export function weeklyRead(
  videos: PerformanceVideo[],
  week: Window,
  payscale: Payscale = DEFAULT_PAYSCALE
): WeeklyRead {
  // Trial-reel batches collapse to one post each BEFORE anything is counted:
  // posts, views, average and spikes all describe reels the creator actually
  // shipped, not uploads the trial tool made.
  const { kept: posts, suppressed: trialUploads } = collapseTrialUploads(inWindow(videos, week));
  const refs: PostRef[] = posts
    .map((v) => ({
      shortcode: v.shortcode,
      url: v.url,
      views: v.view_count ?? 0,
      thumbnail: v.thumbnail_url ?? null,
    }))
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
    topPosts: refs.slice(0, TOP_POSTS),
    trialUploads,
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
  /**
   * The settled month before `settledWindow` — the same `days`, ending where
   * the settled window starts — which is what "how is my CPM moving" has to
   * compare against.
   *
   * Not "the same read a week ago": payouts lag posting by ~3 weeks, so the
   * newest paid post is always older than the reporting week, and a read as
   * of last Monday sees exactly the same paid posts as a read as of this
   * Monday. Compared that way the true number could never move on the
   * latest week, and the first coach dashboard showed "no new payouts" on
   * every single row (2026-09-02). Month against prior month is the
   * comparison Joey actually asked for.
   */
  priorCpm: number | null;
  priorPaidPosts: number;
  priorWindow: Window | null;
  priorLowSample: boolean;
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
  // Published reels only. Every count and average below is about how the
  // creator's WORK performed, and a trial batch is one piece of work uploaded
  // twenty times — leaving it raw drags the average toward the trial noise
  // floor and hands each upload its own flat-fee projection.
  const calendar = collapseTrialUploads(inWindow(videos, trailingWindow(asOf, days))).kept;
  return cpmReadOver(videos, calendar, asOf, days, payscale);
}

/**
 * The same read over a whole team: every member's videos pooled.
 *
 * A ratio of sums, exactly like a creator's — the team's paid dollars over
 * the views those dollars bought — so a coach's number is the money number,
 * not an average of ten CPMs where a 149-view creator's "$1.00" would count
 * as much as a 400k-view one's. The settled window ends at the TEAM's newest
 * payout.
 *
 * Trial batches are collapsed per creator, never across them: one script is
 * handed to several creators, so two creators reading the same words are two
 * posts, and pooling before collapsing would fold one creator's reel into
 * another's.
 */
export function teamCpmRead(
  videosByCreator: PerformanceVideo[][],
  asOf: Date,
  days: number = CPM_WINDOW_DAYS,
  payscale: Payscale = DEFAULT_PAYSCALE
): CpmRead {
  const calendar = videosByCreator.flatMap(
    (videos) => collapseTrialUploads(inWindow(videos, trailingWindow(asOf, days))).kept
  );
  return cpmReadOver(videosByCreator.flat(), calendar, asOf, days, payscale);
}

/** Shared body of `cpmRead` / `teamCpmRead`: `calendar` is the already
 *  collapsed set for the projection, `videos` the raw set the settled read
 *  is taken from. */
function cpmReadOver(
  videos: PerformanceVideo[],
  calendar: PerformanceVideo[],
  asOf: Date,
  days: number,
  payscale: Payscale
): CpmRead {
  const frontier = videos
    .filter((v) => isPaid(v) && postedAt(v) != null && postedAt(v)! < asOf.getTime())
    .reduce<number | null>((max, v) => (max == null || postedAt(v)! > max ? postedAt(v)! : max), null);
  const fresh = frontier != null && asOf.getTime() - frontier <= MAX_SETTLE_LAG_DAYS * DAY_MS;
  const settledWindow: Window | null = fresh
    ? { start: new Date(frontier! + 1 - days * DAY_MS), end: new Date(frontier! + 1) }
    : null;
  // The ONE deliberate exception: the settled set is not collapsed.
  //
  // trueCpm is dollars actually paid divided by the views those same dollars
  // were paid for. Measured 2026-08-31, 1 of 8 trial uploads in a window had
  // been paid ($42.93) — so dropping trials here would delete real earnings
  // from the numerator while leaving the ratio's own denominator behind, and
  // understate money a creator genuinely received. It is filtered to paid
  // posts already, which is what keeps the trial floor out of it.
  const settled = settledWindow ? inWindow(videos, settledWindow).filter(isPaid) : [];
  const priorWindow: Window | null = settledWindow
    ? { start: new Date(settledWindow.start.getTime() - days * DAY_MS), end: settledWindow.start }
    : null;
  const prior = priorWindow ? inWindow(videos, priorWindow).filter(isPaid) : [];
  return {
    cpm: trueCpm(settled),
    paidPosts: settled.length,
    settledWindow,
    lowSample: settled.length > 0 && settled.length < MIN_PAID_SAMPLE,
    settledAvgViews: avgViews(settled),
    priorCpm: trueCpm(prior),
    priorPaidPosts: prior.length,
    priorWindow,
    priorLowSample: prior.length > 0 && prior.length < MIN_PAID_SAMPLE,
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
  // Collapsed like every other post count: a creator who runs trials in their
  // first week would otherwise be recorded as shipping twenty pieces of work
  // when they shipped one, and judged on the trial floor's view average.
  const posts = collapseTrialUploads(
    inWindow(videos, firstWeek).filter((v) => postedAt(v)! < asOf.getTime())
  ).kept;
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
  /** The week before, so this week's posts have something to be compared to. */
  weeklyPrev: WeeklyRead;
  /** Rolling 30-day CPM as of the end of `week`. */
  cpm30: CpmRead;
  /** The settled month against the settled month before it (see
   *  `CpmRead.priorCpm`); null until both have paid posts. */
  delta: Delta | null;
  /** This week's posts against last week's, on the payscale projection —
   *  the leading indicator, weeks before a payout confirms it. Null when
   *  either week has no viewed posts. */
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
  const weekly = weeklyRead(videos, week, payscale);
  const weeklyPrev = weeklyRead(videos, previousWeek(week), payscale);
  const basis = bucketBasis(cpm30);
  const streak = badStreak(videos, week, joinedAt, payscale);
  return {
    week,
    weekly,
    weeklyPrev,
    cpm30,
    delta: delta(cpm30.cpm, cpm30.priorCpm),
    projectedDelta: delta(weekly.projectedCpm, weeklyPrev.projectedCpm),
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

/* --- teams ---------------------------------------------------------------- */

/**
 * One coach's team for one week — the coach's own read, built from the same
 * per-creator reads the digest and /performance show, so the team's numbers
 * and its members' never disagree.
 *
 * "Is my team good" is answered the way a creator's is: the pooled true CPM
 * where enough of the team's posts have settled, the pooled projection
 * otherwise, and the bucket on average views (see `bucketForViews`). Bucket
 * counts sit beside it because a $3 team can be two stars carrying eight
 * strugglers, and the coach's job is the eight.
 */
export interface TeamPerformance {
  week: Window;
  creators: number;
  /** This week: reels shipped (trial batches collapsed per creator). */
  posts: number;
  quota: number;
  belowQuota: number;
  views: number;
  avgViews: number | null;
  /** What this week's posts will cost per 1k views — the leading indicator. */
  projectedCpm: number | null;
  spikes: number;
  trialUploads: number;
  /** Pooled rolling 30-day read as of the week's end. */
  cpm30: CpmRead;
  /** Settled month vs the settled month before (`CpmRead.priorCpm`). */
  delta: Delta | null;
  /** This week's posts vs last week's, on the projection. */
  projectedDelta: Delta | null;
  /** Last week's projected CPM, for the label beside the delta. */
  projectedCpmPrev: number | null;
  bucket: Bucket | null;
  bucketSource: "true" | "projected" | null;
  /** How many creators sit in each bucket; `unread` had no read at all. */
  buckets: Record<Bucket | "unread", number>;
  flagged: number;
}

export function teamPerformance(input: {
  members: { performance: CreatorPerformance; videos: PerformanceVideo[] }[];
  week: Window;
  payscale?: Payscale;
}): TeamPerformance {
  const payscale = input.payscale ?? DEFAULT_PAYSCALE;
  const { members, week } = input;
  const videosByCreator = members.map((m) => m.videos);
  const weekPosts = videosByCreator.flatMap((v) => collapseTrialUploads(inWindow(v, week)).kept);
  const prevWeekPosts = videosByCreator.flatMap(
    (v) => collapseTrialUploads(inWindow(v, previousWeek(week))).kept
  );
  const weekly = members.map((m) => m.performance.weekly);
  const views = weekly.reduce((sum, w) => sum + w.views, 0);
  const posts = weekly.reduce((sum, w) => sum + w.posts, 0);
  const cpm30 = teamCpmRead(videosByCreator, week.end, CPM_WINDOW_DAYS, payscale);
  const projected = projectedCpm(weekPosts, payscale);
  const projectedPrev = projectedCpm(prevWeekPosts, payscale);
  const basis = bucketBasis(cpm30);
  const buckets: TeamPerformance["buckets"] = { good: 0, decent: 0, bad: 0, unread: 0 };
  for (const m of members) buckets[m.performance.bucket ?? "unread"]++;
  return {
    week,
    creators: members.length,
    posts,
    quota: members.length * QUOTA_POSTS_PER_WEEK,
    belowQuota: weekly.filter((w) => w.belowQuota).length,
    views,
    avgViews: posts > 0 ? views / posts : null,
    projectedCpm: projected,
    spikes: weekly.reduce((sum, w) => sum + w.spikes.length, 0),
    trialUploads: weekly.reduce((sum, w) => sum + w.trialUploads, 0),
    cpm30,
    delta: delta(cpm30.cpm, cpm30.priorCpm),
    projectedDelta: delta(projected, projectedPrev),
    projectedCpmPrev: projectedPrev,
    bucket: bucketForViews(basis.avgViews),
    bucketSource: basis.source,
    buckets,
    flagged: members.filter((m) => m.performance.flagged).length,
  };
}
