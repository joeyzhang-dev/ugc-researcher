import {
  buildVirtualAssignments,
  type ScopedCreator,
  type ScriptPosting,
} from "@/lib/scripts";
import type { ResearchCreator, ResearchScript, ResearchScriptAssignment } from "@/lib/types";

/* --- who a published script is a candidate for, without the I/O -----------
 *
 * `loadVirtualAssignments` in src/lib/jobs/match-scripts.ts is this judgement
 * plus six table reads. It is split out because /scripts needs the same answer
 * and cannot afford those reads: `resolveOpenAssignments` pages every
 * research_videos row — ~40k rows and ~40 PostgREST round trips, transcripts
 * included — which is right for an hourly job and unacceptable on a page
 * render. The page already holds all but two of the inputs, so fetching those
 * two lets it compute the identical candidate set, and the "Match review (N)"
 * badge can count what the queue will actually show instead of promising fewer
 * than it holds.
 *
 * Nothing here reads the database, so both callers get the same answer from
 * the same rows by construction — the alternative (two loaders that happen to
 * agree today) is exactly the drift this replaces.
 */

/** PostgREST's "this relation is not in my schema cache" codes — covers both
 *  the REST-layer 404 (PGRST205) and a raw Postgres undefined_table (42P01),
 *  in case a proxy ever forwards the latter unwrapped. */
export function isMissingRelation(error: { code?: string } | null | undefined): boolean {
  return error?.code === "PGRST205" || error?.code === "42P01";
}

export interface VirtualAssignmentInput {
  /** Every script, unfiltered by workspace — the match queue is global. */
  scripts: ResearchScript[];
  /** Every creator. Roster scope is applied in here, not by the caller. */
  creators: ResearchCreator[];
  /** The real assignment rows: a creator already holding one for a script is
   *  not a candidate for it, so nothing is scored twice. */
  existing: ResearchScriptAssignment[];
  /** research_script_posts — a publish of a script to a format channel. */
  postings: ScriptPosting[];
  /** research_app_creators. */
  memberships: { app_id: string; research_creator_id: string; niche: string | null }[];
  /** research_discord_channels — EVERY channel, not only the tracked ones,
   *  since this is only a niche lookup and a parked channel still says which
   *  niche its creator is on. */
  channels: { research_creator_id: string | null; niche: string | null }[];
}

/**
 * Candidate (script, creator) pairs for every script published to a format
 * channel — the synthetic stand-ins for an assignment that a library script
 * never gets.
 *
 * Scope is restricted to our own roster (`kind === 'roster'`), unarchived,
 * right here rather than by the caller — the house pattern `creatorsInScope`
 * uses in src/lib/scrape-queue.ts, for the reason it uses it: a filter that
 * lives in one place cannot be forgotten by a second call site. It matters
 * concretely: 18 `kind === 'research'` creators (outside accounts this pool
 * only studies) hold no research_app_creators row at all, so they resolve to
 * `niche: null` — which `buildVirtualAssignments` treats as universal, exactly
 * what makes #broad work. Without this filter, publishing to #broad would
 * generate a virtual pair for every one of those 18, and confirming one would
 * attribute our script to a creator we do not work with and requeue their
 * untranscribed videos for paid transcription. An archived roster creator is
 * excluded for the same reason `creatorsInScope` excludes them everywhere
 * else — archiving is documented as "hides and de-queues", and this queue is
 * not an exception.
 *
 * Niche resolution has no workspace to scope to — unlike `buildSendTargets`,
 * which is called with one `appId` and can prefer a membership in that
 * workspace, this runs globally across every app. So it takes the first
 * membership niche a creator holds, chosen deterministically (memberships are
 * sorted by app_id then research_creator_id before folding, so the order rows
 * happen to arrive in can never flip the answer), then falls back to the niche
 * on the creator's coaching Discord channel for a creator with no membership
 * niche at all.
 */
export function scopeVirtualAssignments({
  scripts,
  creators,
  existing,
  postings,
  memberships,
  channels,
}: VirtualAssignmentInput): { virtual: ResearchScriptAssignment[]; deadPublishes: string[] } {
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
