"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin, requireStaff } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { runResearchScrape } from "@/lib/jobs/research";
import {
  drainOneQueued,
  enqueueCreators,
  readSettings,
  writeSettings,
  type EnqueueScope,
} from "@/lib/scrape-queue";
import {
  INTERVAL_MAX, INTERVAL_MIN, RESULTS_MAX, RESULTS_MIN, STAGGER_MAX, STAGGER_MIN,
  clampInt, parseTimeOfDay, type ScheduleMode,
} from "@/lib/scrape-settings";
import type { Platform } from "@/lib/types";

/** Pages that show queue state and need refreshing after a queue change. */
const QUEUE_PATHS = ["/settings", "/research", "/creators"];
const revalidateQueuePaths = () => QUEUE_PATHS.forEach((p) => revalidatePath(p));

/** Persist the scrape settings form. */
export async function saveScrapeSettings(formData: FormData) {
  await requireAdmin();
  const current = await readSettings(createAdminClient());

  const mode = String(formData.get("scheduleMode") ?? "");
  const scheduleMode: ScheduleMode =
    mode === "time_of_day" || mode === "interval" ? mode : current.schedule_mode;

  const rawTime = String(formData.get("timeOfDay") ?? "").trim();
  // Keep the previous value rather than writing something the CHECK rejects.
  const timeOfDay = parseTimeOfDay(rawTime) != null ? rawTime : current.time_of_day;

  await writeSettings(createAdminClient(), {
    auto_scrape_enabled: formData.get("autoScrape") === "on",
    schedule_mode: scheduleMode,
    interval_hours: clampInt(
      formData.get("intervalHours"), INTERVAL_MIN, INTERVAL_MAX, current.interval_hours
    ),
    time_of_day: timeOfDay,
    results_limit: clampInt(
      formData.get("resultsLimit"), RESULTS_MIN, RESULTS_MAX, current.results_limit
    ),
    stagger_seconds: clampInt(
      formData.get("staggerSeconds"), STAGGER_MIN, STAGGER_MAX, current.stagger_seconds
    ),
    scrape_research: formData.get("scrapeResearch") === "on",
    scrape_roster: formData.get("scrapeRoster") === "on",
  });

  revalidatePath("/settings");
}

/**
 * Queue every creator in scope for scraping. Enqueueing is instant; the actual
 * Apify pulls are done by drainScrapeQueue, one creator per call, because a
 * full pass over 30+ creators runs far longer than a single request may live.
 */
export async function enqueueScrapeAll(scope: EnqueueScope) {
  await requireAdmin();
  const queued = await enqueueCreators(createAdminClient(), scope);
  revalidateQueuePaths();
  return queued;
}

/** Drop everything still waiting (does not stop an in-flight scrape). */
export async function clearScrapeQueue() {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_creators")
    .update({ scrape_queued_at: null })
    .not("scrape_queued_at", "is", null);
  if (error) throw new Error(error.message);
  revalidateQueuePaths();
}

export interface DrainStep {
  /** Creators still waiting after this call. */
  remaining: number;
  handle: string | null;
  ok: boolean;
  error: string | null;
  /** Seconds the caller should wait before the next call. */
  staggerSeconds: number;
}

/**
 * Scrape the single oldest queued creator. Returns progress so the caller can
 * loop; splitting the work this way keeps every request comfortably inside
 * maxDuration no matter how long the queue is.
 */
export async function drainScrapeQueue(): Promise<DrainStep> {
  await requireAdmin();
  const admin = createAdminClient();
  const step = await drainOneQueued(admin);
  revalidateQueuePaths();
  return step;
}

/** Re-scrape one creator immediately, bypassing the queue. */
export async function scrapeCreatorNow(id: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { data: creator } = await admin
    .from("research_creators")
    .select("handle, platform")
    .eq("id", id)
    .single();
  if (!creator) throw new Error("Creator not found");

  const settings = await readSettings(admin);
  await runResearchScrape(admin, {
    handle: creator.handle,
    platform: creator.platform as Platform,
    resultsLimit: settings.results_limit,
  });
  revalidatePath(`/research/${id}`);
  revalidateQueuePaths();
}

/** Queue snapshot for the client-side runner (staff may watch, not start). */
export async function readQueueState() {
  await requireStaff();
  const admin = createAdminClient();
  const { count } = await admin
    .from("research_creators")
    .select("id", { count: "exact", head: true })
    .not("scrape_queued_at", "is", null);
  return { remaining: count ?? 0 };
}
