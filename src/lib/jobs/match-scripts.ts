import type { SupabaseClient } from "@supabase/supabase-js";
import {
  MATCH_DATE_RADIUS_DAYS,
  resolveScriptMatches,
  type MatchResolution,
  type ResolvedMatch,
} from "@/lib/scripts";
import type { ResearchCreator, ResearchScript, ResearchScriptAssignment, ResearchVideo } from "@/lib/types";

/**
 * Linking the video each creator actually posted from a script.
 *
 * Every per-script number on /scripts is derived from this link, and for a long
 * time it was only ever set by hand, one assignment at a time. That does not
 * scale: 1,036 of 1,073 assignments were still unlinked, so nearly every script
 * read "0 posts" while the posts themselves sat in the database, scraped and
 * transcribed. This closes that gap without giving up the guarantee that made
 * linking manual — see `resolveScriptMatches` for how ambiguity is quarantined.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** PostgREST caps a response; assignments and videos both exceed one page. */
const PAGE = 1000;

async function page<T>(db: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export interface MatchContext extends MatchResolution {
  scriptById: Map<string, ResearchScript>;
  creatorById: Map<string, ResearchCreator>;
  videoById: Map<string, ResearchVideo>;
  assignmentById: Map<string, ResearchScriptAssignment>;
}

/**
 * Score every open assignment against its creator's library.
 *
 * Read-only — the caller decides what to do with `confirm` and `review`. The
 * review queue recomputes this on each page load rather than persisting
 * candidates, so a newly transcribed post shows up without a backfill step.
 */
/**
 * Re-queue transcription for posts that could settle an open assignment.
 *
 * The 30-day ingest window is right for the bulk of the corpus — an old reel's
 * transcript answers nothing — but it is wrong for one specific case: a post
 * that is the likely output of an assignment still waiting to be matched. That
 * transcript is the *only* thing that can close the assignment, however old the
 * post is.
 *
 * Measured on the live corpus when this was written: 42 untranscribed videos
 * stood between 170 open assignments and a match. Transcribing everything to
 * find them would have cost 300+ Whisper calls; this finds them exactly.
 *
 * A video qualifies when it belongs to the assignment's creator, is not already
 * claimed, has no transcript, and was posted within the matcher's own date
 * radius of the send. Anything already `transcribed` or `fetching` is left
 * alone — this only revives `skipped` and `failed` rows.
 */
export async function requeueMatchCandidates(db: SupabaseClient): Promise<{
  requeued: number;
  unblocks: number;
}> {
  const [assignments, videos] = await Promise.all([
    page<ResearchScriptAssignment>(db, "research_script_assignments", "*"),
    page<ResearchVideo>(
      db,
      "research_videos",
      "id, research_creator_id, transcript_text, transcript_status, posted_at"
    ),
  ]);

  const taken = new Set(
    assignments.map((a) => a.research_video_id).filter((id): id is string => !!id)
  );
  const byCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    byCreator.set(v.research_creator_id, [...(byCreator.get(v.research_creator_id) ?? []), v]);
  }

  const open = assignments.filter((a) => !a.research_video_id && a.status !== "Skipped");
  const wanted = new Set<string>();
  let unblocks = 0;

  for (const a of open) {
    const sent = a.sent_at ?? a.assigned_at;
    const sentMs = sent ? Date.parse(sent) : NaN;
    if (Number.isNaN(sentMs)) continue;

    const nearby = (byCreator.get(a.research_creator_id) ?? []).filter((v) => {
      if (v.transcript_text || taken.has(v.id)) return false;
      if (v.transcript_status === "transcribed" || v.transcript_status === "fetching") return false;
      if (!v.posted_at) return false;
      const lag = Date.parse(v.posted_at) - sentMs;
      return lag >= -DAY_MS && lag <= MATCH_DATE_RADIUS_DAYS * DAY_MS;
    });
    if (nearby.length === 0) continue;
    unblocks++;
    for (const v of nearby) wanted.add(v.id);
  }

  for (const id of wanted) {
    const { error } = await db
      .from("research_videos")
      .update({ transcript_status: "pending", error_message: null })
      .eq("id", id);
    if (error) throw new Error(`re-queueing ${id}: ${error.message}`);
  }

  return { requeued: wanted.size, unblocks };
}

export async function resolveOpenAssignments(db: SupabaseClient): Promise<MatchContext> {
  const [scripts, assignments, videos, creators] = await Promise.all([
    page<ResearchScript>(db, "research_scripts", "*"),
    page<ResearchScriptAssignment>(db, "research_script_assignments", "*"),
    page<ResearchVideo>(
      db,
      "research_videos",
      "id, research_creator_id, url, shortcode, caption, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_text, format_category"
    ),
    page<ResearchCreator>(db, "research_creators", "*"),
  ]);

  const taken = new Set(
    assignments.map((a) => a.research_video_id).filter((id): id is string => !!id)
  );
  const resolution = resolveScriptMatches(scripts, assignments, videos, taken);

  return {
    ...resolution,
    scriptById: new Map(scripts.map((s) => [s.id, s])),
    creatorById: new Map(creators.map((c) => [c.id, c])),
    videoById: new Map(videos.map((v) => [v.id, v])),
    assignmentById: new Map(assignments.map((a) => [a.id, a])),
  };
}

/**
 * Write the links.
 *
 * One update per assignment keyed by primary key, because the partial unique
 * index on `research_video_id` means a batch upsert would abort the whole
 * batch on a single collision. Collisions should not happen — resolution is
 * global and already excludes taken videos — but a concurrent manual link is
 * possible, and losing one row is better than losing three hundred.
 */
export async function applyMatches(
  db: SupabaseClient,
  matches: ResolvedMatch[],
  videoById: Map<string, ResearchVideo>
): Promise<{ linked: number; conflicts: number }> {
  let linked = 0;
  let conflicts = 0;

  for (const m of matches) {
    const { error } = await db
      .from("research_script_assignments")
      .update({
        research_video_id: m.videoId,
        status: "Posted",
        // The date the creator posted, not the date we noticed — a backfill
        // would otherwise stamp hundreds of old posts with today.
        posted_at: videoById.get(m.videoId)?.posted_at ?? new Date().toISOString(),
      })
      .eq("id", m.assignmentId)
      // Never overwrite a link a human already made.
      .is("research_video_id", null);

    if (error) {
      if (error.code === "23505") conflicts++;
      else throw new Error(error.message);
      continue;
    }
    linked++;
  }

  return { linked, conflicts };
}

export interface MatchRunResult {
  linked: number;
  conflicts: number;
  review: number;
  contested: number;
  lowConfidence: number;
  /** Held back because the post predates the script that supposedly made it. */
  backdated: number;
  /** Untranscribed posts asked for on this pass because they are the only
   *  thing standing between an open assignment and a match. */
  requeuedForTranscription: number;
}

/** Resolve, then link everything unambiguous. Leaves the rest for review. */
export async function matchScriptPosts(db: SupabaseClient): Promise<MatchRunResult> {
  // Ask for the transcripts that could settle something before matching. They
  // will not exist for this pass — the worker polls every 60s — but they will
  // for the next one, which is why this runs on a schedule rather than once.
  const requeue = await requeueMatchCandidates(db);
  const ctx = await resolveOpenAssignments(db);
  const { linked, conflicts } = await applyMatches(db, ctx.confirm, ctx.videoById);
  return {
    linked,
    conflicts,
    review: ctx.review.length,
    contested: ctx.review.filter((r) => r.reason === "contested").length,
    lowConfidence: ctx.review.filter((r) => r.reason === "low-confidence").length,
    backdated: ctx.review.filter((r) => r.reason === "posted-before-send").length,
    requeuedForTranscription: requeue.requeued,
  };
}
