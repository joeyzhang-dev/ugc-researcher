/**
 * A creator's day — the read `/my-day` renders.
 *
 * The weekly card answers "how did last week go". This answers "what is
 * happening right now", which is a different question with a different data
 * source: `research_video_metrics_daily` carries per-post day-over-day view
 * deltas, so a reel posted on Tuesday that is still climbing on Friday is
 * visible here and invisible everywhere else.
 *
 * The point of a daily is to be actionable while the week can still change.
 * So the two things it leads with are movement (which is encouraging, and
 * outside their control today) and pace (which is not, and is the only lever
 * they have before Sunday).
 *
 * Pure — `today` is passed in, never read from the clock, so a recap is
 * reproducible and testable.
 */

import {
  DAY_MS,
  QUOTA_POSTS_PER_WEEK,
  collapseTrialUploads,
  weekWindow,
  type PerformanceVideo,
  type Window,
} from "@/lib/performance";

/** One post's movement on a given day. */
export interface DailyMover {
  shortcode: string | null;
  url: string;
  /** Views the post gained on the day being reported. */
  viewsDelta: number;
  /** Total views as of that day. */
  views: number;
  thumbnail?: string | null;
  postedAt: string | null;
}

export interface PaceRead {
  postsThisWeek: number;
  quota: number;
  /** Days of the week still to come, including today. */
  daysLeft: number;
  /** Posts per remaining day needed to finish on target. 0 when already there. */
  perDayNeeded: number;
  onTrack: boolean;
  week: Window;
}

export interface DailyRecap {
  /** The day being reported — yesterday, the last day with settled numbers. */
  day: Date;
  viewsAdded: number;
  /** Posts that moved at all, biggest first. */
  movers: DailyMover[];
  /** What they published on the reported day. */
  postedThatDay: DailyMover[];
  pace: PaceRead;
  /** Consecutive days ending on `day` with at least one post. */
  streakDays: number;
  /** Longest streak seen in the window, for something to beat. */
  bestStreakDays: number;
  /** Trial uploads folded away on the reported day. Shown, never silent. */
  trialUploads: number;
  /** Monday-indexed: did they post on each day of the CURRENT week?
   *
   * Computed here from the collapsed post set rather than in the card, which
   * previously derived it from yesterday's movers — so the strip described the
   * wrong week entirely and marked today as missed while a post sat in it. */
  weekPostDays: boolean[];
  /** Monday-indexed position of today within the current week, so the card can
   *  tell a day still to come from one already gone. */
  todayIndex: number;
}

const dayKey = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * Collapse trial-reel batches within each calendar day.
 *
 * Without this the daily and the weekly disagree about the same creator: the
 * weekly counts published reels (Jas: 16 for the week) while a raw daily would
 * have said "10 posted yesterday" — more in one day than the week contained.
 * Trial batches are uploaded in one sitting, so the day is the right bucket.
 *
 * Posts with no transcript stand alone, exactly as in the weekly collapse:
 * absent data is not evidence of duplication.
 */
export function collapseByDay<T extends PerformanceVideo>(posts: T[]): T[] {
  const byDay = new Map<string, T[]>();
  for (const p of posts) {
    if (!p.posted_at) continue;
    const key = dayKey(new Date(Date.parse(p.posted_at)));
    byDay.set(key, [...(byDay.get(key) ?? []), p]);
  }
  return [...byDay.values()].flatMap((group) => collapseTrialUploads(group).kept as T[]);
}

/** Yesterday in UTC. Today's numbers are still moving and Launchpoint's own
 *  snapshot lags, so a "today" recap would report a half-empty day and read as
 *  a collapse every morning. */
export function reportedDay(today: Date): Date {
  return new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()) - DAY_MS);
}

/**
 * Pace through the CURRENT week — the one still in progress.
 *
 * Deliberately not the completed week the weekly card reports: a target you
 * can still hit is a lever, and a target that closed on Sunday is a verdict.
 */
export function paceRead(postedAtDates: (string | null)[], today: Date): PaceRead {
  const week = weekWindow(today);
  const postsThisWeek = postedAtDates.filter((iso) => {
    if (!iso) return false;
    const t = Date.parse(iso);
    return t >= week.start.getTime() && t < week.end.getTime();
  }).length;

  // Days remaining counts today: there is still time to post.
  const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const daysLeft = Math.max(Math.ceil((week.end.getTime() - startOfToday) / DAY_MS), 0);
  const remaining = Math.max(QUOTA_POSTS_PER_WEEK - postsThisWeek, 0);
  return {
    postsThisWeek,
    quota: QUOTA_POSTS_PER_WEEK,
    daysLeft,
    perDayNeeded: daysLeft > 0 ? Math.ceil(remaining / daysLeft) : remaining,
    onTrack: remaining === 0 || (daysLeft > 0 && remaining / daysLeft <= 1),
    week,
  };
}

/**
 * Consecutive days with at least one post, ending on `day`.
 *
 * A streak that has already broken reads 0 rather than reaching back to find
 * an older one — the number has to mean "right now" or it is just trivia.
 */
export function streak(postedAtDates: (string | null)[], day: Date): number {
  const days = new Set(
    postedAtDates.filter(Boolean).map((iso) => dayKey(new Date(Date.parse(iso as string))))
  );
  let n = 0;
  const cursor = new Date(day.getTime());
  while (days.has(dayKey(cursor))) {
    n++;
    cursor.setTime(cursor.getTime() - DAY_MS);
  }
  return n;
}

/** The longest run of consecutive posting days anywhere in the data — the
 *  record to beat, which is what makes a streak worth keeping. */
export function bestStreak(postedAtDates: (string | null)[]): number {
  const days = [
    ...new Set(postedAtDates.filter(Boolean).map((iso) => dayKey(new Date(Date.parse(iso as string))))),
  ].sort();
  let best = 0;
  let run = 0;
  let prev: number | null = null;
  for (const key of days) {
    const t = Date.parse(`${key}T00:00:00Z`);
    run = prev != null && t - prev === DAY_MS ? run + 1 : 1;
    prev = t;
    if (run > best) best = run;
  }
  return best;
}

export function dailyRecap(input: {
  /** Every recent post of theirs, for pace and streak. Trial batches are
   *  collapsed per day so these counts match the weekly card's. */
  posts: (PerformanceVideo & { thumbnail?: string | null })[];
  /** Yesterday's row per post, from research_video_metrics_daily. */
  metrics: { shortcode: string | null; views: number; viewsDelta: number }[];
  today: Date;
  maxMovers?: number;
}): DailyRecap {
  const { posts: rawPosts, metrics, today, maxMovers = 5 } = input;
  const day = reportedDay(today);
  // Counts come from the collapsed set so /my-day and /my-stats never disagree
  // about how much someone posted.
  const posts = collapseByDay(rawPosts);
  const byShortcode = new Map(posts.filter((p) => p.shortcode).map((p) => [p.shortcode as string, p]));
  const kept = new Set(posts.map((p) => p.shortcode));
  const suppressed = rawPosts.length - posts.length;

  const movers: DailyMover[] = metrics
    // Movement is reported for published reels only, for the same reason the
    // counts are: a trial batch's siblings would otherwise dominate the list.
    .filter((m) => m.shortcode && m.viewsDelta > 0 && (kept.has(m.shortcode) || !byShortcode.size))
    .map((m) => {
      const post = byShortcode.get(m.shortcode as string);
      return {
        shortcode: m.shortcode,
        url: post?.url ?? `https://www.instagram.com/reel/${m.shortcode}/`,
        viewsDelta: m.viewsDelta,
        views: m.views,
        thumbnail: post?.thumbnail ?? null,
        postedAt: post?.posted_at ?? null,
      };
    })
    .sort((a, b) => b.viewsDelta - a.viewsDelta);

  const week = weekWindow(today);
  const weekPostDays = Array.from({ length: 7 }, () => false);
  for (const p of posts) {
    if (!p.posted_at) continue;
    const t = new Date(Date.parse(p.posted_at));
    if (t >= week.start && t < week.end) weekPostDays[(t.getUTCDay() + 6) % 7] = true;
  }

  const dayStr = dayKey(day);
  const postedThatDay = movers.filter((m) => m.postedAt && dayKey(new Date(Date.parse(m.postedAt))) === dayStr);
  const dates = posts.map((p) => p.posted_at);

  return {
    day,
    viewsAdded: movers.reduce((s, m) => s + m.viewsDelta, 0),
    movers: movers.slice(0, maxMovers),
    postedThatDay,
    pace: paceRead(dates, today),
    streakDays: streak(dates, day),
    bestStreakDays: bestStreak(dates),
    trialUploads: Math.max(suppressed, 0),
    weekPostDays,
    todayIndex: (today.getUTCDay() + 6) % 7,
  };
}
