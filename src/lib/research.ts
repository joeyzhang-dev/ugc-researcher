import type { ResearchVideo } from "@/lib/types";

/**
 * Lift math for the Research page: how does each video perform relative to
 * the creator's OWN baseline? Baselines use medians (one viral outlier must
 * not poison them — same reasoning as script-performance.ts) and come in
 * three flavors because accounts grow and decay over time:
 *
 *  - trailing: median of the up-to-10 videos posted immediately BEFORE this
 *    one — "did it beat what the account was doing at the time". Headline.
 *  - overall: median of all other videos — stable, page-wide comparison.
 *  - window: median of other videos posted within ±45 days — context for
 *    old-vs-new posts.
 */

export const TRAILING_COUNT = 10;
/** Trailing baseline needs this many prior posts, else fall back to overall. */
export const TRAILING_MIN = 3;
export const WINDOW_DAYS = 45;

export interface VideoLift {
  video: ResearchVideo;
  /** Trailing lift when computable, else overall. What the score is based on. */
  lift: number | null;
  /** Which baseline `lift` used. */
  liftBasis: "trailing" | "overall" | null;
  trailingLift: number | null;
  overallLift: number | null;
  windowLift: number | null;
  /** (likes + comments + shares) / views, as a percentage. */
  engagementPct: number | null;
  /** 0–10 rating (one decimal) derived from lift. See scoreForLift. */
  score: number | null;
}

export interface CreatorLiftSummary {
  videos: VideoLift[];
  videoCount: number;
  withViews: number;
  medianViews: number | null;
  meanViews: number | null;
  totalViews: number;
  medianEngagementPct: number | null;
  medianScore: number | null;
  /** Videos rated 8.0+ — the ones worth studying (≈2.8× lift or better). */
  topRated: number;
}

export function median(nums: number[]): number | null {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Lift → 0–10 rating, one decimal. Log-scaled so each DOUBLING of lift is
 * worth the same step (+2): performing at the creator's baseline (1×) = 5.0,
 * 2× = 7.0, ~2.8× = 8.0, 5.7×+ = 10. Symmetric downward: 0.5× = 3.0.
 * Log scale because lift is a ratio — 10× vs 20× matters far less than 1× vs 2×.
 */
export function scoreForLift(lift: number | null): number | null {
  if (lift == null || lift <= 0) return null;
  const raw = 5 + 2 * Math.log2(lift);
  return Math.round(Math.min(10, Math.max(0, raw)) * 10) / 10;
}

function engagementPct(v: ResearchVideo): number | null {
  if (v.view_count == null || v.view_count <= 0) return null;
  const count = (v.like_count ?? 0) + (v.comment_count ?? 0) + (v.share_count ?? 0);
  return (count / v.view_count) * 100;
}

/** Ratio vs a median baseline; null when the baseline is empty or zero. */
function ratio(views: number, pool: number[]): number | null {
  const base = median(pool);
  return base != null && base > 0 ? views / base : null;
}

/**
 * Compute all lift variants for one creator's videos. Input order doesn't
 * matter; output is sorted by lift (best first), undated/viewless videos last.
 */
export function computeLifts(videos: ResearchVideo[]): VideoLift[] {
  // Chronological list of videos that can participate in baselines.
  const dated = videos
    .filter((v) => v.view_count != null && v.posted_at != null)
    .sort((a, b) => new Date(a.posted_at!).getTime() - new Date(b.posted_at!).getTime());
  const indexOf = new Map(dated.map((v, i) => [v.id, i]));
  const allViews = dated.map((v) => v.view_count!);

  const rows = videos.map((video): VideoLift => {
    const views = video.view_count;
    const i = indexOf.get(video.id);
    if (views == null || i == null) {
      return {
        video, lift: null, liftBasis: null, trailingLift: null,
        overallLift: null, windowLift: null,
        engagementPct: engagementPct(video), score: null,
      };
    }

    const othersViews = allViews.filter((_, j) => j !== i);
    const overallLift = ratio(views, othersViews);

    const prior = dated.slice(Math.max(0, i - TRAILING_COUNT), i);
    const trailingLift =
      prior.length >= TRAILING_MIN ? ratio(views, prior.map((v) => v.view_count!)) : null;

    const t = new Date(video.posted_at!).getTime();
    const windowMs = WINDOW_DAYS * 24 * 60 * 60 * 1000;
    const windowPool = dated
      .filter((v, j) => j !== i && Math.abs(new Date(v.posted_at!).getTime() - t) <= windowMs)
      .map((v) => v.view_count!);
    const windowLift = windowPool.length >= TRAILING_MIN ? ratio(views, windowPool) : null;

    const lift = trailingLift ?? overallLift;
    return {
      video,
      lift,
      liftBasis: trailingLift != null ? "trailing" : overallLift != null ? "overall" : null,
      trailingLift,
      overallLift,
      windowLift,
      engagementPct: engagementPct(video),
      score: scoreForLift(lift),
    };
  });

  return rows.sort((a, b) => (b.lift ?? -1) - (a.lift ?? -1));
}

export function summarizeCreator(videos: ResearchVideo[]): CreatorLiftSummary {
  const lifts = computeLifts(videos);
  const views = videos.map((v) => v.view_count).filter((n): n is number => n != null);
  const engagements = lifts.map((l) => l.engagementPct).filter((n): n is number => n != null);
  const scores = lifts.map((l) => l.score).filter((n): n is number => n != null);

  const totalViews = views.reduce((sum, n) => sum + n, 0);
  return {
    videos: lifts,
    videoCount: videos.length,
    withViews: views.length,
    medianViews: median(views),
    meanViews: views.length > 0 ? totalViews / views.length : null,
    totalViews,
    medianEngagementPct: median(engagements),
    medianScore: median(scores),
    topRated: scores.filter((s) => s >= 8).length,
  };
}

// ===========================================================================
// Format categories
// ===========================================================================

/**
 * Basic format buckets for a creator's videos, detected from the spoken
 * opening line (transcript) first and the caption as fallback — captions often
 * hide the real format (caption "Rebuild yourself" opens as "10 out of 10 ways
 * to rebuild yourself..."). Patterns tolerate WhisperX mishearings of
 * "S-tier" ("as to your", "ask your", "s to your").
 * Returns null when nothing matches confidently — better uncategorized than wrong.
 */
export function detectFormatCategory(
  caption: string | null | undefined,
  transcript?: string | null
): string | null {
  // The first spoken sentence carries the format framing.
  const opening = (transcript ?? "").trim().slice(0, 160).toLowerCase();
  const cap = (caption ?? "").trim().toLowerCase();

  const test = (re: RegExp) => re.test(opening) || re.test(cap);

  // "10/10 ways to X" / "10 out of 10 skills..." listicle.
  if (test(/\b10\s*(?:\/|out of)\s*10\b/)) return "10/10 list";
  // "S-tier habits to X" listicle (+ common transcription mishearings —
  // WhisperX hears "S-tier ways" as "as to your/ask your/s your/best tier ways").
  if (
    /^(?:as to your|ask your|s to your|s your|best tier)\b/.test(opening) ||
    test(/\bs[\s-]?tier\b/)
  ) {
    return "S-tier list";
  }
  // Persona blueprint: live like / habits of a named character.
  if (test(/\b(james bond|batman|bruce wayne|captain america|live like|habits to be more like)\b/)) {
    return "Persona blueprint";
  }
  // "What it (actually) looks like to/when X" — often "...in N simple steps".
  if (test(/\bwhat it (?:actually |really )?looks like\b/)) return "What it looks like";
  // "Top-tier ways to X" — same tier-list framing without the S.
  if (test(/\btop[\s-]?tier\b/)) return "S-tier list";
  // Numbered habit/way lists without a tier framing: "4 habits to become X".
  if (test(/\b(?:\d+|three|four|five|six|seven)\s+(?:habits|ways|things|skills|rules|signs|steps|sides|hobbies|mindsets|moments|scenarios|bets)\b/)) {
    return "Numbered list";
  }
  // "How to X" single-topic method.
  if (test(/^how to\b/) || /^how to\b/.test(cap)) return "How-to method";
  // Generic enumerated listicle — the spoken body counts items ("Number one
  // is…") without a named framing. Last so named formats win.
  if (/\bnumber one is\b/.test(opening)) return "Numbered list";
  return null;
}

/** #hashtags parsed from a caption, lowercased, deduped, in caption order. */
export function extractHashtags(caption: string | null | undefined): string[] {
  if (!caption) return [];
  const seen = new Set<string>();
  // \p{L}\p{N} covers unicode letters/digits; IG allows underscores.
  for (const m of caption.matchAll(/#([\p{L}\p{N}_]+)/gu)) {
    seen.add(m[1].toLowerCase());
  }
  return [...seen];
}
