import type { SupabaseClient } from "@supabase/supabase-js";
import {
  buildVirtualAssignments,
  MATCH_DATE_RADIUS_DAYS,
  parseVirtualAssignmentId,
  resolveScriptMatches,
  type MatchResolution,
  type ResolvedMatch,
  type ScopedCreator,
  type ScriptPosting,
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

/** PostgREST's "this relation is not in my schema cache" codes — covers both
 *  the REST-layer 404 (PGRST205) and a raw Postgres undefined_table (42P01),
 *  in case a proxy ever forwards the latter unwrapped. */
function isMissingRelation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

/**
 * Like `page`, but a missing relation degrades to an empty result instead of
 * throwing.
 *
 * `research_script_posts` ships its migration in this same change, and that
 * migration is applied separately by a human — so the code can (and, as of
 * writing, does) reach production before the table exists. Every other table
 * this job reads predates the feature and "missing" there would mean
 * something is actually broken, so only this call site gets the soft
 * landing — see `videoSelect()` / `loadViewCurves()` in
 * src/lib/video-metrics.ts for the same pattern applied to columns and to
 * research_video_metrics_daily.
 */
async function pageOptional<T>(db: SupabaseClient, table: string, columns: string): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db.from(table).select(columns).range(from, from + PAGE - 1);
    if (error) {
      if (from === 0 && isMissingRelation(error)) return [];
      throw new Error(`${table}: ${error.message}`);
    }
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

/**
 * Candidate (script, creator) pairs for every script published to a format
 * channel — the synthetic stand-ins for an assignment that a library script
 * never gets. Shared by `resolveOpenAssignments` and `requeueMatchCandidates`
 * so the two never disagree about what is still open: two separate loads of
 * the same postings/membership data would drift the moment one changed.
 *
 * Scope is restricted to our own roster (`kind === 'roster'`), unarchived,
 * right here rather than by the caller — the house pattern `creatorsInScope`
 * uses in src/lib/scrape-queue.ts for the same reason: a filter that lives in
 * one place cannot be forgotten by a second call site. It matters concretely:
 * 18 `kind === 'research'` creators (outside accounts this pool only studies)
 * hold no research_app_creators row at all, so they resolve to `niche: null`
 * — which `buildVirtualAssignments` treats as universal, exactly what makes
 * #broad work. Without this filter, publishing to #broad would generate a
 * virtual pair for every one of those 18, and confirming one would attribute
 * our script to a creator we do not work with and requeue their untranscribed
 * videos for paid transcription. An archived roster creator is excluded for
 * the same reason `creatorsInScope` excludes them everywhere else — archiving
 * is documented as "hides and de-queues", and this queue is not an exception.
 *
 * Niche resolution has no workspace to scope to — unlike `buildSendTargets`,
 * which is called with one `appId` and can prefer a membership in that
 * workspace, this runs globally across every app. So it takes the first
 * membership niche a creator holds, chosen deterministically (memberships are
 * sorted by app_id then research_creator_id before folding, so Postgres's own
 * row order can never flip the answer), then falls back to the niche on the
 * creator's coaching Discord channel for a creator with no membership niche
 * at all.
 */
async function loadVirtualAssignments(
  db: SupabaseClient,
  scripts: ResearchScript[],
  creators: ResearchCreator[],
  existing: ResearchScriptAssignment[]
): Promise<{ virtual: ResearchScriptAssignment[]; deadPublishes: string[] }> {
  const [postings, memberships, channels] = await Promise.all([
    pageOptional<ScriptPosting>(db, "research_script_posts", "script_id, posted_at"),
    page<{ app_id: string; research_creator_id: string; niche: string | null }>(
      db,
      "research_app_creators",
      "app_id, research_creator_id, niche"
    ),
    page<{ research_creator_id: string | null; niche: string | null }>(
      db,
      "research_discord_channels",
      "research_creator_id, niche"
    ),
  ]);

  const sortedMemberships = [...memberships].sort(
    (a, b) => a.app_id.localeCompare(b.app_id) || a.research_creator_id.localeCompare(b.research_creator_id)
  );
  const nicheByCreator = new Map<string, string>();
  for (const m of sortedMemberships) {
    if (m.niche && !nicheByCreator.has(m.research_creator_id)) {
      nicheByCreator.set(m.research_creator_id, m.niche);
    }
  }
  const channelNicheByCreator = new Map<string, string>();
  for (const c of channels) {
    if (c.research_creator_id && c.niche && !channelNicheByCreator.has(c.research_creator_id)) {
      channelNicheByCreator.set(c.research_creator_id, c.niche);
    }
  }

  const roster = creators.filter((c) => c.kind === "roster" && !c.archived_at);
  const scoped: ScopedCreator[] = roster.map((c) => ({
    id: c.id,
    niche: nicheByCreator.get(c.id) ?? channelNicheByCreator.get(c.id) ?? null,
  }));
  const virtual = buildVirtualAssignments(scripts, postings, scoped, existing);

  // A script published with a niche no roster creator holds produces zero
  // virtual pairs and looks identical to a healthy publish everywhere on
  // /scripts — nothing else would ever say so. Measured live: 61 of 146
  // scripts (Finance General + Girly Finance) are in exactly this state.
  // Judged on niche coverage alone, not on candidate count, so a script whose
  // every candidate already has a REAL assignment (a success, not a failure)
  // is never misreported as dead.
  const availableNiches = new Set(scoped.map((c) => c.niche));
  const publishedIds = new Set(postings.map((p) => p.script_id));
  const deadPublishes = scripts
    .filter((s) => publishedIds.has(s.id) && s.niche !== null && !availableNiches.has(s.niche))
    .map((s) => s.id);

  return { virtual, deadPublishes };
}

export interface MatchContext extends MatchResolution {
  scriptById: Map<string, ResearchScript>;
  creatorById: Map<string, ResearchCreator>;
  videoById: Map<string, ResearchVideo>;
  assignmentById: Map<string, ResearchScriptAssignment>;
  /** Published scripts whose niche no roster creator holds — see
   *  `loadVirtualAssignments` for how this is judged. */
  deadPublishes: string[];
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
  const [assignments, videos, scripts, creators] = await Promise.all([
    page<ResearchScriptAssignment>(db, "research_script_assignments", "*"),
    page<ResearchVideo>(
      db,
      "research_videos",
      "id, research_creator_id, transcript_text, transcript_status, posted_at"
    ),
    page<ResearchScript>(db, "research_scripts", "*"),
    page<ResearchCreator>(db, "research_creators", "*"),
  ]);
  // deadPublishes is not this function's concern — resolveOpenAssignments is
  // the one that feeds matchScriptPosts' return value, so reporting it twice
  // here would be redundant, not more correct.
  const { virtual } = await loadVirtualAssignments(db, scripts, creators, assignments);

  const taken = new Set(
    assignments.map((a) => a.research_video_id).filter((id): id is string => !!id)
  );
  const byCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    byCreator.set(v.research_creator_id, [...(byCreator.get(v.research_creator_id) ?? []), v]);
  }

  // Same scope the resolver uses, so requeueing and matching agree on what is
  // still open. MATCH_DATE_RADIUS_DAYS stays applied below — without it a
  // wider candidate set would requeue the entire back catalogue for
  // transcription.
  const open = [...assignments, ...virtual].filter(
    (a) => !a.research_video_id && a.status !== "Skipped"
  );
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

  // Published scripts have no assignment row until a match confirms one — the
  // virtual pairs stand in as candidates so the resolver can settle a library
  // script against a creator's library exactly as it would a real send.
  const { virtual, deadPublishes } = await loadVirtualAssignments(db, scripts, creators, assignments);

  const taken = new Set(
    assignments.map((a) => a.research_video_id).filter((id): id is string => !!id)
  );
  const resolution = resolveScriptMatches(scripts, [...assignments, ...virtual], videos, taken);

  return {
    ...resolution,
    scriptById: new Map(scripts.map((s) => [s.id, s])),
    creatorById: new Map(creators.map((c) => [c.id, c])),
    videoById: new Map(videos.map((v) => [v.id, v])),
    // Includes the virtual rows: /scripts/review looks up every candidate's
    // assignment here, and a virtual candidate missing from the map would
    // render blank or crash the page.
    assignmentById: new Map([...assignments, ...virtual].map((a) => [a.id, a])),
    deadPublishes,
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
    // The date the creator posted, not the date we noticed — a backfill
    // would otherwise stamp hundreds of old posts with today.
    const postedAt = videoById.get(m.videoId)?.posted_at ?? new Date().toISOString();
    const virtual = parseVirtualAssignmentId(m.assignmentId);

    // A published script has no assignment row until someone is shown to have
    // made it — the row is the OUTPUT of matching here, not its input.
    const { error } = virtual
      ? await db.from("research_script_assignments").insert({
          script_id: virtual.scriptId,
          research_creator_id: virtual.creatorId,
          research_video_id: m.videoId,
          status: "Posted",
          assigned_at: postedAt,
          posted_at: postedAt,
        })
      : await db
          .from("research_script_assignments")
          .update({
            research_video_id: m.videoId,
            status: "Posted",
            posted_at: postedAt,
          })
          .eq("id", m.assignmentId)
          // Never overwrite a link a human already made.
          .is("research_video_id", null);

    if (error) {
      // The partial unique index (one video backs one assignment) is what
      // stops two confirmations claiming one video. A wider candidate set
      // makes this collision MORE likely, not less — count it, never throw.
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
  /** Published scripts whose niche no roster creator holds, so the publish
   *  produced zero virtual candidates and would otherwise look identical to
   *  a healthy one on /scripts. See `loadVirtualAssignments`. */
  deadPublishes: number;
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
    deadPublishes: ctx.deadPublishes.length,
  };
}
