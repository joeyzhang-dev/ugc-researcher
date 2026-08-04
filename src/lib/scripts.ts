import { computeLifts, median, type VideoLift } from "@/lib/research";
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
