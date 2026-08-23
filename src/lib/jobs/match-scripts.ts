import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveScriptMatches, type MatchResolution, type ResolvedMatch } from "@/lib/scripts";
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
}

/** Resolve, then link everything unambiguous. Leaves the rest for review. */
export async function matchScriptPosts(db: SupabaseClient): Promise<MatchRunResult> {
  const ctx = await resolveOpenAssignments(db);
  const { linked, conflicts } = await applyMatches(db, ctx.confirm, ctx.videoById);
  return {
    linked,
    conflicts,
    review: ctx.review.length,
    contested: ctx.review.filter((r) => r.reason === "contested").length,
    lowConfidence: ctx.review.filter((r) => r.reason === "low-confidence").length,
  };
}
