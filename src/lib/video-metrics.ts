/**
 * Shared plumbing for the Launchpoint-sourced video metrics.
 *
 * The page queries all list their columns explicitly rather than using
 * `select("*")`, which is the right call on a table this wide — but it means
 * four separate string literals had to grow the same ten columns. Naming the
 * set once keeps them from drifting, and makes it obvious that
 * `duration_seconds` is not optional here: hold rate is average watch time
 * divided by it, so a select that omits the duration silently renders every
 * retention chip as "—".
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { CurvePoint } from "@/components/retention-view";

/** Append to a research_videos select so the retention panel has what it needs.
 *
 *  `as const` is load-bearing: supabase-js infers the row type from the select
 *  string as a *literal*, so this has to stay a literal type and be spliced in
 *  with a template literal. Plain `"..." + COLUMNS` widens to `string` and the
 *  query silently degrades to GenericStringError[]. */
export const LAUNCHPOINT_VIDEO_COLUMNS =
  "duration_seconds, launchpoint_post_id, launchpoint_title, reach, saves, avg_watch_time_ms, total_watch_time_ms, skip_rate, earnings_usd, paid, launchpoint_synced_at" as const;

/**
 * Whether the Launchpoint columns exist yet.
 *
 * The app and its schema do not always move together — this integration was
 * written against a database nobody could run DDL on — and a select naming a
 * column that does not exist is a hard PostgREST 400, which would take
 * /research and /scripts down entirely rather than merely hiding a few chips.
 * So the pages ask first and fall back to the base column set.
 *
 * Cached per process with a short TTL: one extra HEAD-ish query per minute per
 * warm instance is nothing, and the TTL means the pages light up on their own
 * within a minute of the migration landing — no redeploy, no cache bust.
 */
let columnProbe: { present: boolean; at: number } | null = null;
const PROBE_TTL_MS = 60_000;

/** Test seam — the probe is process-cached, so suites must clear it. */
export function __resetColumnProbe(): void {
  columnProbe = null;
}

export async function launchpointColumnsPresent(supabase: SupabaseClient): Promise<boolean> {
  if (columnProbe && Date.now() - columnProbe.at < PROBE_TTL_MS) return columnProbe.present;
  const { error } = await supabase.from("research_videos").select("launchpoint_post_id").limit(1);
  // 42703 is "undefined_column". Any other error (network, auth) must not be
  // cached as "missing" — assume present and let the real query surface it.
  const present = !error || error.code !== "42703";
  columnProbe = { present, at: Date.now() };
  return present;
}

/**
 * The research_videos select list, with the Launchpoint columns only if the
 * database has them. Returns a plain string, so call sites cast the result
 * through `unknown` — supabase-js can only infer a row type from a literal.
 */
export async function videoSelect(supabase: SupabaseClient, base: string): Promise<string> {
  return (await launchpointColumnsPresent(supabase))
    ? `${base}, ${LAUNCHPOINT_VIDEO_COLUMNS}`
    : base;
}

/**
 * Daily view curves for a set of videos, keyed by video id.
 *
 * Only fetches for the ids passed in — the detail panel reads this map lazily,
 * so pulling the whole roster's history to render one open panel would be
 * wasted work, the same reasoning the segment loaders already use.
 */
export async function loadViewCurves(
  supabase: SupabaseClient,
  videoIds: string[]
): Promise<Record<string, CurvePoint[]>> {
  if (videoIds.length === 0) return {};
  // The table itself may not exist yet; a missing relation is an empty curve,
  // not a page failure.
  const { data, error } = await supabase
    .from("research_video_metrics_daily")
    .select("research_video_id, date, views, views_delta")
    .in("research_video_id", videoIds)
    .order("date", { ascending: true });

  if (error) return {};

  const byVideo: Record<string, CurvePoint[]> = {};
  for (const row of (data ?? []) as (CurvePoint & { research_video_id: string })[]) {
    (byVideo[row.research_video_id] ??= []).push({
      date: row.date,
      views: row.views,
      views_delta: row.views_delta,
    });
  }
  return byVideo;
}
