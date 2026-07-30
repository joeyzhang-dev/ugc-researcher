import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFormatCategorization, runResearchScrape } from "@/lib/jobs/research";
import {
  creatorsInScope,
  drainOneQueued,
  enqueueCreators,
  readSettings,
  recordRun,
} from "@/lib/scrape-queue";
import { enabledKinds, isRunDue } from "@/lib/scrape-settings";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Stop draining with enough headroom to still return a response. */
const TIME_BUDGET_MS = 240_000;

/** Research jobs.
 *  Scrape:     POST { handle, platform?: "instagram" | "tiktok", resultsLimit?: number }
 *  Scrape all: POST { action: "scrape-all", force?: boolean } — enqueues every
 *              creator the settings cover and drains within a time budget.
 *              Skips unless the configured schedule says a run is due, so a
 *              cron can safely poll far more often than the schedule.
 *              Repeat the call until { remaining: 0 } to finish a long queue.
 *  Categorize: POST { action: "categorize", creatorId?: string } — transcript-aware
 *              format re-detection (run after the transcription worker). */
export async function POST(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;

  let body: {
    action?: string;
    creatorId?: string;
    handle?: string;
    platform?: "instagram" | "tiktok";
    resultsLimit?: number;
    force?: boolean;
  };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  try {
    if (body.action === "categorize") {
      const result = await runFormatCategorization(createAdminClient(), body.creatorId);
      return NextResponse.json(result);
    }
    if (body.action === "scrape-all") {
      return NextResponse.json(await scrapeAll(Boolean(body.force)));
    }
    if (!body.handle) {
      return NextResponse.json({ error: "handle is required" }, { status: 400 });
    }
    const result = await runResearchScrape(createAdminClient(), {
      handle: body.handle,
      platform: body.platform,
      resultsLimit: body.resultsLimit,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * One pass of the scheduled scrape. Enqueues when a run is due, then drains
 * until the queue empties or the time budget runs out — the caller repeats
 * until `remaining` hits 0.
 */
async function scrapeAll(force: boolean) {
  const admin = createAdminClient();
  const settings = await readSettings(admin);

  // An in-flight queue always continues, even outside the schedule; otherwise a
  // long run started at 03:00 would stall the moment it stopped being "due".
  const { count: alreadyQueued } = await admin
    .from("research_creators")
    .select("id", { count: "exact", head: true })
    .not("scrape_queued_at", "is", null);

  if (!alreadyQueued) {
    if (!force && !settings.auto_scrape_enabled) {
      return { skipped: "automatic scraping is disabled", remaining: 0 };
    }
    if (!force && !isRunDue(settings)) {
      return { skipped: "not due yet", remaining: 0 };
    }
    const kinds = enabledKinds(settings);
    if (kinds.length === 0) {
      return { skipped: "no creator pools enabled", remaining: 0 };
    }
    const scope = { kinds };
    const pending = await creatorsInScope(admin, scope);
    if (pending.length === 0) {
      await recordRun(admin, "succeeded", "No creators to scrape");
      return { scraped: 0, failed: 0, remaining: 0 };
    }
    await enqueueCreators(admin, scope);
  }

  const startedAt = Date.now();
  const errors: string[] = [];
  let scraped = 0;
  let remaining = 0;

  for (;;) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) break;
    const step = await drainOneQueued(admin);
    remaining = step.remaining;
    if (step.handle == null) break;
    if (step.ok) scraped++;
    else errors.push(`@${step.handle}: ${step.error}`);
    if (remaining === 0) break;
    if (step.staggerSeconds > 0) {
      await new Promise((r) => setTimeout(r, step.staggerSeconds * 1000));
    }
  }

  // Only stamp the run once the queue is actually drained — stamping on a
  // partial pass would make the next call look "not due" and strand the rest.
  if (remaining === 0) {
    const status = errors.length === 0 ? "succeeded" : scraped > 0 ? "partial" : "failed";
    await recordRun(
      admin,
      status,
      `${scraped} scraped${errors.length ? `, ${errors.length} failed` : ""}`
    );
  }

  return { scraped, failed: errors.length, remaining, errors: errors.slice(0, 10) };
}
