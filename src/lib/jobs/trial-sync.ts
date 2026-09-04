/**
 * Stamp `research_videos.is_trial_upload`, from two detectors.
 *
 * Ground truth first: the Trial Reels Batcher's `publish_jobs` says exactly
 * which reels it published, joined on shortcode. It covers 7 creators — 442 of
 * its 994 permalinks are not in `research_videos` at all, because the profile
 * scrape only keeps the 35 newest reels and a high-volume trial account pushes
 * its own history out of that window.
 *
 * So the transcript heuristic runs behind it for everyone else, at a measured
 * 0.976 precision. `trial_source` records which answered, because only the
 * heuristic's rows may ever be re-evaluated — a re-run that trampled ground
 * truth would be unrecoverable.
 *
 * A flag is only ever set, never cleared, by this job. Un-flagging is a human
 * decision: the cost of wrongly flagging a real post is that it vanishes from
 * every figure its creator is judged on, so that call does not belong to a
 * heuristic running on a cron.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { fetchPublishedTrials, batcherConfigured } from "@/lib/trial-batcher";
import { trialUploadShortcodes, type PerformanceVideo } from "@/lib/performance";

/** How far back the heuristic looks. Trials older than this are already
 *  flagged or already irrelevant, and the transcript join is the expensive
 *  part of this job. */
export const TRIAL_HEURISTIC_DAYS = 120;

/** PostgREST puts filters in the query string, so a shortcode list has to be
 *  chunked or the URL exceeds what the gateway will accept. */
const CHUNK = 200;

export interface TrialSyncResult {
  /** Rows newly flagged from the batcher's publish log. */
  batcher: number;
  /** Rows newly flagged by the transcript heuristic. */
  heuristic: number;
  /** True when the batcher project is not configured for this deployment, so
   *  only the heuristic ran. Reported rather than silent — a missing key would
   *  otherwise look like "the batcher had nothing new". */
  batcherSkipped: boolean;
}

async function flagChunk(
  admin: SupabaseClient,
  shortcodes: string[],
  patch: Record<string, unknown>
): Promise<number> {
  let flagged = 0;
  for (let i = 0; i < shortcodes.length; i += CHUNK) {
    const slice = shortcodes.slice(i, i + CHUNK);
    // Only rows not already flagged, so a re-run reports 0 rather than
    // re-reporting the whole corpus every hour.
    const { data, error } = await admin
      .from("research_videos")
      .update(patch)
      .in("shortcode", slice)
      .eq("is_trial_upload", false)
      .select("id");
    if (error) throw new Error(`flagging trial uploads: ${error.message}`);
    flagged += (data ?? []).length;
  }
  return flagged;
}

export async function syncTrialUploads(admin: SupabaseClient): Promise<TrialSyncResult> {
  const result: TrialSyncResult = { batcher: 0, heuristic: 0, batcherSkipped: !batcherConfigured() };

  // --- ground truth ------------------------------------------------------
  if (!result.batcherSkipped) {
    const flags = await fetchPublishedTrials();
    // Grouped by batch so trial_batch_id lands with its own rows.
    const byBatch = new Map<string, string[]>();
    for (const f of flags) {
      const key = f.batchId ?? "";
      const list = byBatch.get(key);
      if (list) list.push(f.shortcode);
      else byBatch.set(key, [f.shortcode]);
    }
    for (const [batchId, shortcodes] of byBatch) {
      result.batcher += await flagChunk(admin, shortcodes, {
        is_trial_upload: true,
        trial_batch_id: batchId || null,
        trial_source: "batcher",
      });
    }
  }

  // --- heuristic, per creator -------------------------------------------
  // Per creator, never pooled: one script goes to several creators, and
  // grouping across them folds one creator's reel into another's batch.
  const since = new Date(Date.now() - TRIAL_HEURISTIC_DAYS * 86_400_000).toISOString();
  const { data: creatorRows, error: creatorError } = await admin
    .from("research_creators")
    .select("id")
    .is("archived_at", null);
  if (creatorError) throw new Error(`reading creators: ${creatorError.message}`);

  for (const c of (creatorRows ?? []) as { id: string }[]) {
    const { data: videos, error } = await admin
      .from("research_videos")
      // earnings_usd is load-bearing, not decoration: trialUploadShortcodes
      // refuses to flag a paid post, and omitting the column here made that
      // guard read undefined and silently pass every time.
      .select("shortcode, posted_at, view_count, transcript_text, is_trial_upload, earnings_usd")
      .eq("research_creator_id", c.id)
      .eq("is_trial_upload", false)
      .not("transcript_text", "is", null)
      .gte("posted_at", since);
    if (error) throw new Error(`reading videos for the trial heuristic: ${error.message}`);
    const rows = (videos ?? []) as unknown as PerformanceVideo[];
    if (rows.length === 0) continue;
    const shortcodes = trialUploadShortcodes(rows);
    if (shortcodes.length === 0) continue;
    result.heuristic += await flagChunk(admin, shortcodes, {
      is_trial_upload: true,
      trial_source: "heuristic",
    });
  }

  return result;
}
