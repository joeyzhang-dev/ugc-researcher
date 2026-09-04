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
export type MatchReviewReason =
  | "contested"
  | "low-confidence"
  | "posted-before-send"
  | "awaiting-siblings";

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
  /** Same-creator uploads inside this video's burst window whose transcripts
   *  have not landed yet. Any one of them could come back as the same reel,
   *  which would make this a trial upload rather than a post — so a non-zero
   *  count is what holds the pair back. */
  pendingSiblings: number;
  reason?: MatchReviewReason;
}

export interface MatchResolution {
  confirm: ResolvedMatch[];
  review: ResolvedMatch[];
  /** Videos excluded as trial-batch members. Reported so the review queue and
   *  the script detail page can drop them from the candidates they offer a
   *  human — the resolver refusing to link one is only half the guarantee. */
  trialVideoIds: Set<string>;
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
// ===========================================================================
// Trial-reel batches
// ===========================================================================

/**
 * Creators run Instagram Trials through a tool that uploads the same reel
 * dozens of times, and those uploads are not posts: a trial reel never
 * graduates and never counts toward a deliverable.
 *
 * The detection lives HERE, next to transcript matching, rather than in
 * performance.ts where it started, because two readers depend on it and they
 * must not be able to disagree. `collapseTrialUploads` drops a detected batch
 * out of every performance figure; `resolveScriptMatches` refuses to link one
 * to a script. A second copy of the heuristic would drift, and the two halves
 * would then disagree about which uploads exist at all. performance.ts
 * re-exports these so its own surface is unchanged.
 */

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

/** The two fields the batch heuristic reads. Both `PerformanceVideo` and
 *  `ResearchVideo` satisfy it, which is what lets one implementation serve
 *  the performance collapse and the matcher's exclusion. */
export interface TrialGroupable {
  transcript_text?: string | null;
  view_count: number | null;
}

/**
 * Partition uploads into same-reel groups, most-viewed first.
 *
 * Greedy against each group's first member: the walk is most-viewed first, so
 * that member is already the group's winner — which is the one
 * `collapseTrialUploads` used to keep. Groups come back in creation order and
 * members in view order, so a caller can read `group[0]` as the batch's best
 * upload without sorting again.
 *
 * `similarity` is injectable only so a caller comparing one creator's whole
 * burst can memoize and pre-tokenize it. The default is the real rule; passing
 * anything else changes the cost, never the policy.
 */
export function groupTrialUploads<T extends TrialGroupable>(
  videos: T[],
  similarity: (a: string, b: string) => number = transcriptSimilarity
): T[][] {
  // Most-viewed first, so the first member of a group is already its winner.
  const ordered = [...videos].sort((a, b) => (b.view_count ?? 0) - (a.view_count ?? 0));
  const groups: T[][] = [];
  for (const v of ordered) {
    const text = v.transcript_text ?? "";
    const group = groups.find((g) => similarity(g[0].transcript_text ?? "", text) >= TRIAL_SAME_REEL);
    if (group) group.push(v);
    else groups.push([v]);
  }
  return groups;
}

/**
 * How far either side of an upload we look for the rest of its batch: ±24h,
 * rolling on the actual instants, never snapped to a calendar day.
 *
 * There is no creator-local time anywhere in this codebase — performance.ts
 * works in UTC instants (`inWindow`, the rolling `trailingWindow`) and in
 * reproducible UTC Monday weeks for its reporting keys, and daily-recap's
 * `collapseByDay` buckets by UTC calendar day for a recap. A calendar day is
 * the wrong shape for a GUARD: 8pm US Eastern is 00:00 UTC, so a burst posted
 * around then straddles the day boundary, and the lone member on the sparse
 * side would have no visible siblings and no detectable batch — reopening
 * exactly the hole this closes. A recap that splits a batch across two days
 * shows a wrong count for a day; a matcher that splits one makes a permanent
 * wrong link.
 */
export const TRIAL_BURST_WINDOW_MS = 24 * 60 * 60 * 1000;

/** An upload as the burst detector reads it: one creator's, under the id it is
 *  reported by. */
export interface TrialUpload extends TrialGroupable {
  id: string;
  posted_at: string | null;
}

/**
 * `transcriptSimilarity`, memoized across one creator's uploads.
 *
 * Every member of a burst is compared against every distinct reel in it, once
 * per member, so the naive call tokenizes the same transcripts thousands of
 * times. Here each transcript is tokenized once and each unordered pair scored
 * once — a live 104-upload burst day is ~5.4k unique pairs, not a million.
 *
 * The counted form is exactly `transcriptMatchScore`: its per-word cap makes a
 * word contribute min(count in a, count in b) hits, over a's token count.
 */
function memoizedSimilarity(): (a: string, b: string) => number {
  const idByText = new Map<string, number>();
  const counts: Map<string, number>[] = [];
  const totals: number[] = [];
  const cache = new Map<string, number>();

  const idOf = (text: string): number => {
    let id = idByText.get(text);
    if (id === undefined) {
      id = counts.length;
      idByText.set(text, id);
      const have = counted(text);
      let total = 0;
      for (const n of have.values()) total += n;
      counts.push(have);
      totals.push(total);
    }
    return id;
  };

  const contains = (a: number, b: number): number => {
    if (totals[a] === 0 || totals[b] === 0) return 0;
    let hit = 0;
    for (const [w, n] of counts[a]) hit += Math.min(n, counts[b].get(w) ?? 0);
    return hit / totals[a];
  };

  return (a, b) => {
    const x = idOf(a);
    const y = idOf(b);
    const key = x < y ? `${x}:${y}` : `${y}:${x}`;
    let score = cache.get(key);
    if (score === undefined) {
      score = Math.min(contains(x, y), contains(y, x));
      cache.set(key, score);
    }
    return score;
  };
}

/**
 * Which of ONE creator's uploads sit inside a trial batch.
 *
 * An upload V is a trial upload when grouping its burst neighbourhood — the
 * same-creator transcribed uploads within `TRIAL_BURST_WINDOW_MS` of it, V
 * included — puts V in a group of at least `TRIAL_MIN_BATCH` members. The
 * neighbourhood is rolled around V rather than cut into fixed buckets, so no
 * boundary can hide a sibling from it.
 *
 * Callers pass one creator's whole library, claimed posts included: a sibling
 * already linked to some script is still evidence that this upload was part of
 * a batch. Untranscribed and undated uploads are never members — an absent
 * transcript is not evidence of duplication (the same call
 * `collapseTrialUploads` makes), and an undated upload has no burst to sit in.
 *
 * Cost is bounded on purpose: an upload with fewer than `TRIAL_MIN_BATCH`
 * neighbours is never similarity-checked at all (a creator posting twice in
 * two days costs nothing), each distinct neighbourhood is grouped once, and
 * similarity is memoized per unordered pair across the whole call.
 */
export function trialUploadIds<T extends TrialUpload>(videos: T[]): Set<string> {
  const trial = new Set<string>();

  const rows: { video: T; at: number }[] = [];
  for (const v of videos) {
    if ((v.transcript_text ?? "").trim().length === 0) continue;
    if (!v.posted_at) continue;
    const at = Date.parse(v.posted_at);
    if (Number.isNaN(at)) continue;
    rows.push({ video: v, at });
  }
  if (rows.length < TRIAL_MIN_BATCH) return trial;
  rows.sort((a, b) => a.at - b.at || a.video.id.localeCompare(b.video.id));

  const similarity = memoizedSimilarity();
  // A neighbourhood is a contiguous run of the time-sorted rows, so both
  // bounds only ever move forward and each distinct run is grouped once.
  const sizesBySlice = new Map<string, Map<string, number>>();
  let lo = 0;
  let hi = 0;

  for (let i = 0; i < rows.length; i++) {
    const at = rows[i].at;
    while (rows[lo].at < at - TRIAL_BURST_WINDOW_MS) lo++;
    // hi lands on at least i on its own: every row up to i is within the
    // window of row i by construction.
    while (hi + 1 < rows.length && rows[hi + 1].at <= at + TRIAL_BURST_WINDOW_MS) hi++;
    if (hi - lo + 1 < TRIAL_MIN_BATCH) continue;

    const key = `${lo}:${hi}`;
    let sizes = sizesBySlice.get(key);
    if (!sizes) {
      sizes = new Map<string, number>();
      const near = rows.slice(lo, hi + 1).map((r) => r.video);
      for (const group of groupTrialUploads(near, similarity)) {
        for (const member of group) sizes.set(member.id, group.length);
      }
      sizesBySlice.set(key, sizes);
    }
    if ((sizes.get(rows[i].video.id) ?? 0) >= TRIAL_MIN_BATCH) trial.add(rows[i].video.id);
  }

  return trial;
}

/**
 * A sibling whose transcript is still coming.
 *
 * "pending" and "fetching" mean the worker has it or shortly will; "failed"
 * and "skipped" are terminal ON THIS READ. `requeueMatchCandidates` runs at
 * the top of the same `matchScriptPosts` call and has already flipped every
 * in-radius failed/skipped row back to "pending", so a row still reading
 * terminal here is one nothing is coming for — usually a deleted post, whose
 * media is simply gone. Treating those as in flight would hold a real post
 * forever, since the requeue re-arms them on every tick.
 */
function inFlight(v: ResearchVideo): boolean {
  return (
    !v.transcript_text &&
    (v.transcript_status === "pending" || v.transcript_status === "fetching")
  );
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
 * Two rules keep a trial reel out of all of this. Creators upload one reel
 * fifteen-plus times in a sitting through the Instagram Trials tool; a trial
 * reel never graduates and never counts as a post, so no member of a batch may
 * ever back a script. Where the batch is visible every member is excluded from
 * the pool outright, by `trialUploadIds` — the same detection /performance
 * collapses by, so the matcher and the numbers cannot disagree about which
 * uploads are real. Where it is NOT visible — fewer than `TRIAL_MIN_BATCH`
 * transcripts back, which is the normal state for hours after a burst, and
 * exactly the shape that used to auto-link against a runner-up of 0.000 — a
 * pair whose video still has an untranscribed sibling inside its burst window
 * is held as `awaiting-siblings` instead of being linked or called contested.
 *
 * The hold goes to review rather than to a silent fourth list on purpose: a
 * real post whose only same-day sibling is a deleted reel — permanently
 * `failed`, and re-armed to `pending` by `requeueMatchCandidates` on every
 * tick — would otherwise be held forever with nobody able to see it.
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
  if (!open.length) return { confirm: [], review: [], trialVideoIds: new Set() };

  const wanted = new Set(open.map((a) => a.research_creator_id));

  // Everything trial-related below is scoped to creators with something open.
  // Nobody is waiting on anyone else's uploads, and this runs on every hourly
  // tick and every review-page load.
  const libraryByCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    if (!wanted.has(v.research_creator_id)) continue;
    (libraryByCreator.get(v.research_creator_id) ??
      libraryByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  // Detection runs over the creator's whole library, claimed posts included: a
  // sibling already linked to some script is still evidence that this upload
  // came out of a batch, and dropping it from the count is what would let a
  // three-upload batch read as a hand-posted pair.
  const trialVideoIds = new Set<string>();
  for (const library of libraryByCreator.values()) {
    for (const id of trialUploadIds(library)) trialVideoIds.add(id);
  }

  // When each still-transcribing upload was posted, per creator — the only
  // thing that can be known about a sibling before its words arrive.
  const inFlightAt = new Map<string, number[]>();
  for (const [creatorId, library] of libraryByCreator) {
    const at: number[] = [];
    for (const v of library) {
      if (!inFlight(v) || !v.posted_at) continue;
      const t = Date.parse(v.posted_at);
      if (!Number.isNaN(t)) at.push(t);
    }
    inFlightAt.set(creatorId, at);
  }

  const poolByCreator = new Map<string, ResearchVideo[]>();
  const pendingSiblings = new Map<string, number>();
  for (const v of videos) {
    if (!v.transcript_text || takenVideoIds.has(v.id)) continue;
    if (!wanted.has(v.research_creator_id)) continue;
    // A trial upload is never a post, so it is never a candidate and never a
    // rival either — it must not be able to contest a real post for its own
    // assignment.
    if (trialVideoIds.has(v.id)) continue;
    const posted = v.posted_at ? Date.parse(v.posted_at) : NaN;
    let waiting = 0;
    if (!Number.isNaN(posted)) {
      for (const t of inFlightAt.get(v.research_creator_id) ?? []) {
        if (Math.abs(t - posted) <= TRIAL_BURST_WINDOW_MS) waiting++;
      }
    }
    pendingSiblings.set(v.id, waiting);
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
        pendingSiblings: pendingSiblings.get(v.id) ?? 0,
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
    } else if (p.pendingSiblings > 0) {
      // Strong enough to link, and we still do not know what this post IS: a
      // sibling inside its burst window is still transcribing, and if it comes
      // back as the same reel then both are trial uploads rather than posts.
      // The pair has already consumed its assignment and its video above, so a
      // weaker rival cannot take the assignment this tick — it is held, not
      // dropped.
      review.push({ ...resolved, reason: "awaiting-siblings" });
    } else if (p.rank - rival < MATCH_AUTO_MARGIN) {
      review.push({ ...resolved, reason: "contested" });
    } else {
      confirm.push(resolved);
    }
  }

  return { confirm, review, trialVideoIds };
}

/* --- library scripts: candidates without an assignment -------------------
 *
 * A script published to a format channel is not assigned to anyone. To keep
 * matching working we synthesise the pairs an assignment used to provide:
 * (published script) x (creator whose niche it fits). The resolver cannot
 * tell these from real open assignments, which is the point — its
 * best-first settling still arbitrates between them and the real ones.
 */

export const VIRTUAL_ASSIGNMENT_PREFIX = "virtual:";

/** uuids contain no colons, so this is unambiguous to parse back. */
export function virtualAssignmentId(scriptId: string, creatorId: string): string {
  return `${VIRTUAL_ASSIGNMENT_PREFIX}${scriptId}:${creatorId}`;
}

export function isVirtualAssignmentId(id: string): boolean {
  return id.startsWith(VIRTUAL_ASSIGNMENT_PREFIX);
}

export function parseVirtualAssignmentId(
  id: string
): { scriptId: string; creatorId: string } | null {
  if (!isVirtualAssignmentId(id)) return null;
  // Exactly two segments. A uuid never contains a colon, so anything other
  // than scriptId:creatorId means this string was not built by
  // virtualAssignmentId — silently keeping only the first two parts would
  // risk attaching a match to the wrong creator instead of failing loudly.
  const parts = id.slice(VIRTUAL_ASSIGNMENT_PREFIX.length).split(":");
  if (parts.length !== 2) return null;
  const [scriptId, creatorId] = parts;
  return scriptId && creatorId ? { scriptId, creatorId } : null;
}

/** One publication of a script to a channel — only what scoping needs. */
export interface ScriptPosting {
  script_id: string;
  posted_at: string;
}

/** A creator and the niche that decides which scripts they are a candidate for. */
export interface ScopedCreator {
  id: string;
  niche: string | null;
}

/**
 * Candidate (script, creator) pairs for every published script.
 *
 * A creator is a candidate when the script's niche matches theirs, or when the
 * script carries no niche at all — a null niche is what makes a script
 * universal, and is how #broad works without a schema for formats.
 *
 * `sent_at` is the EARLIEST posting: a script cross-posted to two channels was
 * available to the creator from the first one, and date proximity should
 * measure against when they could first have seen it.
 *
 * Creators who already hold a real assignment for a script are skipped, so a
 * script sent the old way and published the new way is never scored twice.
 */
export function buildVirtualAssignments(
  scripts: ResearchScript[],
  postings: ScriptPosting[],
  creators: ScopedCreator[],
  existing: ResearchScriptAssignment[]
): ResearchScriptAssignment[] {
  const firstPostingByScript = new Map<string, string>();
  for (const p of postings) {
    const seen = firstPostingByScript.get(p.script_id);
    if (!seen || p.posted_at < seen) firstPostingByScript.set(p.script_id, p.posted_at);
  }
  if (!firstPostingByScript.size) return [];

  const claimed = new Set(existing.map((a) => `${a.script_id}:${a.research_creator_id}`));
  const out: ResearchScriptAssignment[] = [];

  for (const s of scripts) {
    const sentAt = firstPostingByScript.get(s.id);
    if (!sentAt) continue;
    for (const c of creators) {
      if (s.niche !== null && s.niche !== c.niche) continue;
      if (claimed.has(`${s.id}:${c.id}`)) continue;
      out.push({
        id: virtualAssignmentId(s.id, c.id),
        script_id: s.id,
        research_creator_id: c.id,
        research_video_id: null,
        status: "Assigned",
        notes: null,
        assigned_at: sentAt,
        posted_at: null,
        discord_channel_id: null,
        discord_message_id: null,
        sent_at: sentAt,
      });
    }
  }
  return out;
}
