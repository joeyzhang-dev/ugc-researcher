"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { syncLaunchpoint, type LaunchpointSyncResult } from "@/lib/jobs/launchpoint";
import { hasLaunchpointKey } from "@/lib/launchpoint";
import type { ResearchLaunchpointSync } from "@/lib/types";

const LAUNCHPOINT_PATHS = ["/settings", "/research", "/scripts"];

/**
 * One bounded pass of the sync, for the browser-driven runner.
 *
 * The budget is deliberately short — well under a server action's practical
 * lifetime — because the client loops. The first backfill is ~1,500 posts at
 * 100 API requests/minute, so it takes roughly half an hour of wall clock no
 * matter who drives it; splitting it into 45-second steps means the page shows
 * live progress and can be stopped, instead of one request that either
 * succeeds after 30 minutes or dies with nothing to show.
 */
export async function runLaunchpointSyncStep(): Promise<LaunchpointSyncResult> {
  await requireAdmin();
  const result = await syncLaunchpoint(createAdminClient(), { budgetMs: 45_000 });
  LAUNCHPOINT_PATHS.forEach((p) => revalidatePath(p));
  return result;
}

/** Cheap phases only — creators and posts, a handful of calls. Useful after
 *  onboarding someone, when the retention backfill would be beside the point. */
export async function runLaunchpointMetadataSync(): Promise<LaunchpointSyncResult> {
  await requireAdmin();
  const result = await syncLaunchpoint(createAdminClient(), { metadataOnly: true });
  LAUNCHPOINT_PATHS.forEach((p) => revalidatePath(p));
  return result;
}

export interface LaunchpointStatus {
  configured: boolean;
  phases: ResearchLaunchpointSync[];
  /** Posts Launchpoint knows about that we have matched to a video row. */
  trackedVideos: number;
  /** Of those, how many carry first-party insights. */
  withInsights: number;
  /** Daily snapshots stored. Deliberately a row count, not a distinct-video
   *  count: PostgREST cannot do a cheap distinct count and pulling 45k ids to
   *  dedupe in memory would cost more than the number is worth. Labelled as
   *  snapshots in the UI so it is never read as "videos covered". */
  curvePoints: number;
}

/** Coverage snapshot for the settings panel. Staff may watch; only an admin
 *  may start a run. */
export async function readLaunchpointStatus(): Promise<LaunchpointStatus> {
  await requireStaff();
  const admin = createAdminClient();

  const [{ data: phases }, tracked, insights, curves] = await Promise.all([
    admin.from("research_launchpoint_syncs").select("*"),
    admin
      .from("research_videos")
      .select("id", { count: "exact", head: true })
      .not("launchpoint_post_id", "is", null),
    admin
      .from("research_videos")
      .select("id", { count: "exact", head: true })
      .not("avg_watch_time_ms", "is", null),
    admin
      .from("research_video_metrics_daily")
      .select("research_video_id", { count: "exact", head: true }),
  ]);

  return {
    configured: hasLaunchpointKey(),
    phases: (phases ?? []) as ResearchLaunchpointSync[],
    trackedVideos: tracked.count ?? 0,
    withInsights: insights.count ?? 0,
    curvePoints: curves.count ?? 0,
  };
}
