import { computeLifts, median, type VideoLift } from "@/lib/research";
import { summarizeRetention, type RetentionInput, type RetentionSummary } from "@/lib/retention";
import type {
  ResearchScript,
  ResearchScriptAssignment,
  ResearchVideo,
} from "@/lib/types";

/**
 * Per-script performance, and matching a script to the video it produced.
 *
 * The headline number is LIFT, not raw views. A script handed to a 25k-follower
 * creator and a 100-follower creator will always look better on the big
 * account if you rank by views, which tells you nothing about the script.
 * Lift measures each post against its own creator's baseline, so a script that
 * makes small accounts overperform correctly beats one that merely rode a
 * large account.
 *
 * Medians throughout, for the same reason the rest of the app uses them: one
 * viral post must not make a mediocre script look great.
 *
 * Since the Launchpoint integration there is a second headline available:
 * RETENTION. Lift still answers "did this script outperform the account it ran
 * on", which is a question about distribution. Hold rate answers "did the
 * words keep the person who saw it", which is a question about the writing —
 * and it is the one a script rewrite can actually act on. Both are reported;
 * neither replaces the other, and retention is only present for roster posts
 * Launchpoint has synced.
 */

export interface ScriptPerf {
  script: ResearchScript;
  /** Assignments that produced a video we can measure. */
  posts: number;
  /** Assigned but nothing posted yet. */
  pending: number;
  skipped: number;
  /** Distinct creators who ran it. */
  creators: number;
  medianLift: number | null;
  medianScore: number | null;
  medianViews: number | null;
  totalViews: number;
  /** Best post by lift. */
  best: VideoLift | null;
  /** First-party retention across this script's posts. `sampleSize` is how
   *  many of them actually carry Launchpoint insights — check it before
   *  trusting a median, since a script with one synced post will happily
   *  report one. */
  retention: RetentionSummary;
  /** Every measurable post, best first. */
  rows: VideoLift[];
}

/**
 * Roll up performance for each script.
 *
 * Lift has to be computed per creator over that creator's *whole* library —
 * not just their scripted posts — because the baseline is "what this account
 * normally does". Passing only the scripted videos would measure them against
 * each other and lose the point entirely.
 */
export function summarizeScripts(
  scripts: ResearchScript[],
  assignments: ResearchScriptAssignment[],
  videosByCreator: Map<string, ResearchVideo[]>
): ScriptPerf[] {
  // One lift computation per creator, reused across every script they ran.
  const liftByVideoId = new Map<string, VideoLift>();
  for (const vids of videosByCreator.values()) {
    for (const row of computeLifts(vids)) liftByVideoId.set(row.video.id, row);
  }

  const byScript = new Map<string, ResearchScriptAssignment[]>();
  for (const a of assignments) {
    (byScript.get(a.script_id) ?? byScript.set(a.script_id, []).get(a.script_id)!).push(a);
  }

  return scripts
    .map((script) => {
      const mine = byScript.get(script.id) ?? [];
      const rows = mine
        .map((a) => (a.research_video_id ? liftByVideoId.get(a.research_video_id) : null))
        .filter((r): r is VideoLift => !!r)
        .sort((a, b) => (b.lift ?? -1) - (a.lift ?? -1));

      const retentionInputs: RetentionInput[] = rows.map((r) => ({
        avgWatchTimeMs: r.video.avg_watch_time_ms,
        totalWatchTimeMs: r.video.total_watch_time_ms,
        durationSeconds: r.video.duration_seconds,
        skipRate: r.video.skip_rate,
        reach: r.video.reach,
        views: r.video.view_count,
        saves: r.video.saves,
        shares: r.video.share_count,
        earningsUsd: r.video.earnings_usd,
      }));

      const lifts = rows.map((r) => r.lift).filter((n): n is number => n != null);
      const scores = rows.map((r) => r.score).filter((n): n is number => n != null);
      const views = rows.map((r) => r.video.view_count).filter((n): n is number => n != null);

      return {
        script,
        posts: rows.length,
        pending: mine.filter((a) => a.status === "Assigned").length,
        skipped: mine.filter((a) => a.status === "Skipped").length,
        creators: new Set(mine.map((a) => a.research_creator_id)).size,
        medianLift: median(lifts),
        medianScore: median(scores),
        medianViews: median(views),
        totalViews: views.reduce((s, n) => s + n, 0),
        best: rows.find((r) => r.lift != null) ?? null,
        retention: summarizeRetention(retentionInputs),
        rows,
      };
    })
    .sort((a, b) => {
      // Scripts with no data yet sort last rather than pretending to be zero.
      if ((a.posts === 0) !== (b.posts === 0)) return a.posts === 0 ? 1 : -1;
      return (b.medianScore ?? -1) - (a.medianScore ?? -1);
    });
}

// ===========================================================================
// Matching a script to the video it produced
// ===========================================================================

/** Words too common to carry any signal about which script a video came from. */
const STOP = new Set([
  "the","a","an","and","or","but","if","so","because","that","this","these","those",
  "i","you","he","she","it","we","they","me","him","her","us","them","my","your",
  "his","its","our","their","is","are","was","were","be","been","being","am","do",
  "does","did","have","has","had","will","would","can","could","should","to","of",
  "in","on","at","for","with","from","by","as","not","no","yes","just","like","get",
  "got","up","out","about","what","when","where","who","how","why","all","any",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * How much of the script's wording shows up in the transcript, 0–1.
 *
 * Containment rather than Jaccard: a creator riffs, ad-libs and rambles well
 * past the brief, so the transcript is usually much longer than the script.
 * Jaccard would punish that length difference and rank a faithful long take
 * below a short unrelated clip. What actually matters is "did they say the
 * script", i.e. how much of the script is present.
 *
 * Term frequency is capped per word so a script repeating "locked in" ten
 * times can't score itself up on a transcript that says it once.
 */
export function transcriptMatchScore(scriptBody: string, transcript: string): number {
  const a = tokens(scriptBody);
  const b = tokens(transcript);
  if (a.length === 0 || b.length === 0) return 0;

  const have = new Map<string, number>();
  for (const w of b) have.set(w, (have.get(w) ?? 0) + 1);

  let hit = 0;
  const used = new Map<string, number>();
  for (const w of a) {
    const budget = have.get(w) ?? 0;
    const spent = used.get(w) ?? 0;
    if (spent < budget) {
      hit++;
      used.set(w, spent + 1);
    }
  }
  return hit / a.length;
}

export interface MatchCandidate {
  video: ResearchVideo;
  score: number;
}

/**
 * Rank a creator's videos by how well each transcript matches a script.
 *
 * Only ever suggests — the link is confirmed by a human, because a creator
 * running two similar scripts would otherwise get them silently swapped.
 */
export function suggestMatches(
  scriptBody: string,
  videos: ResearchVideo[],
  { limit = 5, minScore = 0.25 }: { limit?: number; minScore?: number } = {}
): MatchCandidate[] {
  if (!scriptBody.trim()) return [];
  return videos
    .filter((v) => v.transcript_text)
    .map((video) => ({ video, score: transcriptMatchScore(scriptBody, video.transcript_text!) }))
    .filter((c) => c.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ===========================================================================
// Resolving every open assignment at once
// ===========================================================================

/** A pair below this is never worth a human's attention. */
export const MATCH_REVIEW_MIN = 0.25;
/** A pair must clear this to be linked without a human looking at it. */
export const MATCH_AUTO_MIN = 0.5;
/**
 * How far the winner must beat its nearest rival to count as unambiguous.
 *
 * The failure this guards is the one that matters: two near-identical scripts
 * competing for one video. Observed live, a real pair scored 0.97 and 0.91 for
 * the same post — a gap far too small to call, and exactly the "silently
 * swapped" case that kept linking manual in the first place.
 */
export const MATCH_AUTO_MARGIN = 0.12;

/**
 * Date proximity.
 *
 * A script is handed over and, if it gets used, posted within days. Containment
 * alone cannot tell two near-identical scripts apart — the live corpus has a
 * pair scoring 0.97 and 0.91 on the same post — but *when* each was sent
 * usually can. Full credit inside the radius, decaying after; a post that
 * predates its own script is demoted hard, because a script cannot have
 * produced a video that already existed when it was written.
 *
 * Deliberately a modifier, never a source of confidence: `MATCH_AUTO_MIN`
 * still gates on the TEXT score alone, so no pair is ever auto-linked because
 * its timing looked good. Date only reorders candidates and widens margins
 * between rivals that the words could not separate.
 */
export const MATCH_DATE_RADIUS_DAYS = 21;

/** How much proximity is allowed to move a pair's ranking. At 0.35 a
 *  worst-case date costs a third of the score — enough to break a tie, not
 *  enough to bury a strong textual match under a weak one. */
export const MATCH_DATE_WEIGHT = 0.35;

/** Posts can lag a send, but a post *before* it cannot be its output. A day of
 *  slack absorbs timezone skew and same-day sends. */
const PRE_SEND_GRACE_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 0–1 closeness between when a script went out and when a post appeared.
 *
 * Returns 1 when either date is missing: absent data is not evidence against a
 * pair, and penalising it would quietly punish every assignment sent before
 * send tracking existed.
 */
export function dateProximity(
  sentAt: string | null,
  postedAt: string | null,
  radiusDays = MATCH_DATE_RADIUS_DAYS
): number {
  if (!sentAt || !postedAt) return 1;
  const sent = new Date(sentAt).getTime();
  const posted = new Date(postedAt).getTime();
  if (Number.isNaN(sent) || Number.isNaN(posted)) return 1;

  const lag = posted - sent;
  if (lag < -PRE_SEND_GRACE_MS) return 0;
  if (lag <= radiusDays * DAY_MS) return 1;

  // Linear decay from the radius out to three times it, floored rather than
  // zeroed: a late post is unlikely, not impossible.
  const overshoot = lag - radiusDays * DAY_MS;
  const span = 2 * radiusDays * DAY_MS;
  return Math.max(0.2, 1 - overshoot / span);
}

/** Text score adjusted for timing — the value pairs are ranked and compared by. */
export function rankScore(textScore: number, proximity: number): number {
  return textScore * (1 - MATCH_DATE_WEIGHT + MATCH_DATE_WEIGHT * proximity);
}

/** Why a pair needs eyes on it rather than being linked outright. */
export type MatchReviewReason = "contested" | "low-confidence" | "posted-before-send";

export interface ResolvedMatch {
  assignmentId: string;
  scriptId: string;
  creatorId: string;
  videoId: string;
  /** Text containment alone — what the reviewer sees, and the only thing the
   *  auto-link confidence gate looks at. */
  score: number;
  /** 0–1 timing closeness between the send and the post. */
  proximity: number;
  /** `score` adjusted for timing. Pairs are ordered and compared by this. */
  rank: number;
  /** Best rank any rival pair reached for this video or this assignment. */
  runnerUp: number;
  reason?: MatchReviewReason;
}

export interface MatchResolution {
  confirm: ResolvedMatch[];
  review: ResolvedMatch[];
}

/** Pre-tokenized transcript, so a creator's library is tokenized once. */
function counted(text: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const w of tokens(text)) m.set(w, (m.get(w) ?? 0) + 1);
  return m;
}

/** transcriptMatchScore against an already-tokenized transcript. */
function scoreTokens(scriptTokens: string[], have: Map<string, number>): number {
  if (scriptTokens.length === 0 || have.size === 0) return 0;
  let hit = 0;
  const used = new Map<string, number>();
  for (const w of scriptTokens) {
    const spent = used.get(w) ?? 0;
    if (spent < (have.get(w) ?? 0)) {
      hit++;
      used.set(w, spent + 1);
    }
  }
  return hit / scriptTokens.length;
}

/**
 * Match every open assignment to the video it produced, in one pass.
 *
 * Resolution is global rather than per-assignment on purpose. A video can back
 * only one assignment (there is a partial unique index enforcing it), so
 * picking each assignment's favourite independently lets whoever runs first
 * claim a video the next assignment wanted more. Scoring every pair and
 * settling them best-first means the strongest claim wins outright.
 *
 * Nothing is linked unless it is both strong AND clearly better than its
 * nearest rival; everything else is returned for a human to confirm. That
 * keeps the original guarantee — two similar scripts are never silently
 * swapped — while sparing the ~600 open assignments that have no rival at all.
 *
 * `takenVideoIds` are videos already linked to some assignment; they are never
 * offered again.
 */
export function resolveScriptMatches(
  scripts: ResearchScript[],
  assignments: ResearchScriptAssignment[],
  videos: ResearchVideo[],
  takenVideoIds: Set<string>
): MatchResolution {
  const scriptById = new Map(scripts.map((s) => [s.id, s]));

  // Only assignments still waiting on a post. A Skipped creator isn't posting
  // it, and an already-linked one is settled.
  const open = assignments.filter(
    (a) => !a.research_video_id && a.status !== "Skipped" && scriptById.has(a.script_id)
  );
  if (!open.length) return { confirm: [], review: [] };

  const wanted = new Set(open.map((a) => a.research_creator_id));
  const poolByCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    if (!v.transcript_text || takenVideoIds.has(v.id)) continue;
    if (!wanted.has(v.research_creator_id)) continue;
    (poolByCreator.get(v.research_creator_id) ??
      poolByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  const scriptTokens = new Map<string, string[]>();
  const transcriptTokens = new Map<string, Map<string, number>>();

  // Every candidate pair worth considering, plus each side's best rival.
  type Pair = ResolvedMatch;
  const pairs: Pair[] = [];
  const bestForVideo = new Map<string, number>();
  const bestForAssignment = new Map<string, number>();
  const runnerUpForVideo = new Map<string, number>();
  const runnerUpForAssignment = new Map<string, number>();

  const note = (
    best: Map<string, number>,
    runner: Map<string, number>,
    key: string,
    score: number
  ) => {
    const top = best.get(key);
    if (top == null || score > top) {
      if (top != null) runner.set(key, Math.max(runner.get(key) ?? 0, top));
      best.set(key, score);
    } else {
      runner.set(key, Math.max(runner.get(key) ?? 0, score));
    }
  };

  for (const a of open) {
    const s = scriptById.get(a.script_id)!;
    let toks = scriptTokens.get(s.id);
    if (!toks) {
      toks = tokens([s.hook, s.body].filter(Boolean).join(" "));
      scriptTokens.set(s.id, toks);
    }
    if (!toks.length) continue;

    for (const v of poolByCreator.get(a.research_creator_id) ?? []) {
      let have = transcriptTokens.get(v.id);
      if (!have) {
        have = counted(v.transcript_text!);
        transcriptTokens.set(v.id, have);
      }
      const score = scoreTokens(toks, have);
      if (score < MATCH_REVIEW_MIN) continue;
      // sent_at is when the creator actually received it; assigned_at is when
      // the row was created, which can predate the send by days.
      const proximity = dateProximity(a.sent_at ?? a.assigned_at, v.posted_at);
      const rank = rankScore(score, proximity);
      pairs.push({
        assignmentId: a.id,
        scriptId: s.id,
        creatorId: a.research_creator_id,
        videoId: v.id,
        score,
        proximity,
        rank,
        runnerUp: 0,
      });
      // Rivalry is judged on rank: two scripts the words cannot separate are
      // separated here by which one was actually sent near the post.
      note(bestForVideo, runnerUpForVideo, v.id, rank);
      note(bestForAssignment, runnerUpForAssignment, a.id, rank);
    }
  }

  // Settle best-first so the strongest claim on a contested video wins.
  pairs.sort((x, y) => y.rank - x.rank || x.videoId.localeCompare(y.videoId));

  const confirm: ResolvedMatch[] = [];
  const review: ResolvedMatch[] = [];
  const usedAssignments = new Set<string>();
  const usedVideos = new Set<string>();

  for (const p of pairs) {
    if (usedAssignments.has(p.assignmentId) || usedVideos.has(p.videoId)) continue;
    usedAssignments.add(p.assignmentId);
    usedVideos.add(p.videoId);

    // A rival is any *other* pair touching this video or this assignment.
    const rival = Math.max(
      runnerUpForVideo.get(p.videoId) ?? 0,
      runnerUpForAssignment.get(p.assignmentId) ?? 0
    );
    const resolved: ResolvedMatch = { ...p, runnerUp: rival };

    if (p.score < MATCH_AUTO_MIN) {
      // Confidence is still judged on the words alone. Good timing must never
      // promote a weak textual match.
      review.push({ ...resolved, reason: "low-confidence" });
    } else if (p.proximity === 0) {
      // The post predates its own script. Almost always a stale assignment or
      // a recycled script, never a real link — but a human should say so.
      review.push({ ...resolved, reason: "posted-before-send" });
    } else if (p.rank - rival < MATCH_AUTO_MARGIN) {
      review.push({ ...resolved, reason: "contested" });
    } else {
      confirm.push(resolved);
    }
  }

  return { confirm, review };
}
