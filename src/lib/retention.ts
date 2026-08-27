/**
 * Retention math over Launchpoint's first-party Instagram metrics.
 *
 * Pure — no I/O, no Supabase — so the numbers on the page can be unit-tested
 * against fixtures, same arrangement as `research.ts` and its lift math.
 *
 * Why this module exists at all: view count measures *distribution*, not
 * quality. A reel with 300k views tells you the algorithm pushed it; it says
 * nothing about whether the script held anyone. Watch time does. With a
 * transcript on one side and `avgWatchTimeMs` on the other, "which hooks keep
 * people watching" stops being a guess.
 */

/** Raw per-video inputs. Every field is nullable because a post may be pre-
 *  Launchpoint, non-Instagram, or simply not fetched yet. */
export interface RetentionInput {
  avgWatchTimeMs: number | null;
  totalWatchTimeMs: number | null;
  durationSeconds: number | null;
  skipRate: number | null;
  reach: number | null;
  views: number | null;
  saves: number | null;
  shares: number | null;
  earningsUsd: number | null;
}

export interface RetentionMetrics {
  /** Mean fraction of the video watched. 0.5 = the average viewer left
   *  halfway. **Can exceed 1** — see holdRate() below. Null without both a
   *  watch time and a duration. */
  holdRate: number | null;
  /** Percent who skipped, 0–100, straight from Instagram. Lower is better. */
  skipRate: number | null;
  /** Views ÷ reach − 1. Views count replays, reach counts people, so 0.2 means
   *  the average viewer watched 1.2 times. Strong signal on short loops. */
  replayRate: number | null;
  /** Saves per person reached. The highest-intent public signal Instagram
   *  exposes — someone saving a reel means they intend to come back. */
  saveRate: number | null;
  /** Shares per person reached. */
  shareRate: number | null;
  /** Dollars paid per 1,000 views. Null when the post is unpaid — which is
   *  different from $0.00 CPM and must not render as "free". */
  cpmUsd: number | null;
}

const ratio = (numerator: number | null, denominator: number | null): number | null =>
  numerator == null || denominator == null || denominator <= 0 ? null : numerator / denominator;

/**
 * Mean fraction of the video watched.
 *
 * Deliberately **not clamped to 1**. Instagram counts a replay as continued
 * watch time on the same impression, so a short, loopable reel routinely
 * averages more than its own duration — 1.4 is a real and very good number,
 * and clamping it to 1.0 would erase exactly the signal worth finding. The
 * chart formatting handles >100% rather than the math hiding it.
 *
 * Guarded on duration because a 0-second duration (a stale scrape, a photo
 * post) would otherwise produce Infinity and poison every aggregate
 * downstream.
 */
export function holdRate(avgWatchTimeMs: number | null, durationSeconds: number | null): number | null {
  if (avgWatchTimeMs == null || durationSeconds == null || durationSeconds <= 0) return null;
  if (avgWatchTimeMs < 0) return null;
  return avgWatchTimeMs / (durationSeconds * 1000);
}

export function retentionMetrics(input: RetentionInput): RetentionMetrics {
  const { views, reach } = input;
  // Reach can exceed views in Launchpoint's data when the two were sampled at
  // different moments. A negative replay rate is meaningless, so floor it.
  const replay = ratio(views, reach);
  return {
    holdRate: holdRate(input.avgWatchTimeMs, input.durationSeconds),
    skipRate: input.skipRate,
    replayRate: replay == null ? null : Math.max(0, replay - 1),
    saveRate: ratio(input.saves, reach),
    shareRate: ratio(input.shares, reach),
    cpmUsd:
      input.earningsUsd == null || input.earningsUsd <= 0
        ? null
        : ratio(input.earningsUsd * 1000, views),
  };
}

/** Median, not mean.
 *
 *  View counts across a creator's posts span three orders of magnitude — one
 *  1.35M-view outlier sits beside a hundred 2k-view posts. A mean hold rate is
 *  dominated by whichever posts happened to go viral; the median describes the
 *  typical post, which is what a script comparison actually needs. */
export function median(values: number[]): number | null {
  const clean = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 === 1 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

export interface RetentionSummary {
  /** How many of the inputs carried usable first-party insights. Surfaced so a
   *  median over 2 posts is never mistaken for a median over 200. */
  sampleSize: number;
  medianHoldRate: number | null;
  medianSkipRate: number | null;
  medianSaveRate: number | null;
  medianReplayRate: number | null;
  totalViews: number;
  totalReach: number;
  totalEarningsUsd: number;
  /** Blended cost per 1,000 views: total spend over total views, not the mean
   *  of per-post CPMs — averaging ratios would weight a $40 flat fee on a
   *  200-view post the same as one on a 300k-view post. */
  blendedCpmUsd: number | null;
}

export function summarizeRetention(inputs: RetentionInput[]): RetentionSummary {
  const metrics = inputs.map(retentionMetrics);
  const pick = (fn: (m: RetentionMetrics) => number | null): number[] =>
    metrics.map(fn).filter((v): v is number => v != null);

  const totalViews = inputs.reduce((sum, i) => sum + (i.views ?? 0), 0);
  const totalReach = inputs.reduce((sum, i) => sum + (i.reach ?? 0), 0);
  const totalEarningsUsd = inputs.reduce((sum, i) => sum + (i.earningsUsd ?? 0), 0);

  return {
    sampleSize: inputs.filter((i) => i.avgWatchTimeMs != null || i.skipRate != null).length,
    medianHoldRate: median(pick((m) => m.holdRate)),
    medianSkipRate: median(pick((m) => m.skipRate)),
    medianSaveRate: median(pick((m) => m.saveRate)),
    medianReplayRate: median(pick((m) => m.replayRate)),
    totalViews,
    totalReach,
    totalEarningsUsd,
    blendedCpmUsd: totalEarningsUsd > 0 && totalViews > 0 ? (totalEarningsUsd * 1000) / totalViews : null,
  };
}

/**
 * Day-one share of a post's current views, from the daily curve.
 *
 * Instagram front-loads distribution hard: the live corpus shows posts taking
 * ~53% of their lifetime views on day one and decaying to a ~10k/day trickle
 * inside a week. A *low* day-one share on a post that ended up big is the
 * interesting case — it means the reel kept being served after the initial
 * push, which is what a genuinely re-watchable script looks like.
 *
 * Returns null on a single-point series: a post Launchpoint first saw
 * yesterday is trivially 100% day-one and would drag any average toward a
 * conclusion about nothing.
 */
export function dayOneShare(
  series: { date: string; views: number | null }[]
): number | null {
  if (series.length < 2) return null;
  const ordered = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const first = ordered[0].views;
  const last = ordered[ordered.length - 1].views;
  if (first == null || last == null || last <= 0) return null;
  return first / last;
}

/**
 * Whether a post is still meaningfully accumulating views.
 *
 * "Still climbing" is the state the old point-in-time scrape could never
 * detect, and it changes what you do: a rising post is worth boosting or
 * copying now, a flat one is finished and safe to judge. Threshold is a share
 * of current total per day rather than an absolute count, so it means the same
 * thing for a 2k post and a 1.3M one.
 */
export function isStillClimbing(
  series: { date: string; viewsDelta: number | null; views: number | null }[],
  threshold = 0.01
): boolean {
  if (series.length < 2) return false;
  const ordered = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const latest = ordered[ordered.length - 1];
  if (latest.views == null || latest.views <= 0 || latest.viewsDelta == null) return false;
  return latest.viewsDelta / latest.views >= threshold;
}
