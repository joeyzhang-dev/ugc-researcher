import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFormatCategorization, runResearchScrape } from "@/lib/jobs/research";
import { scrapeAll } from "@/lib/jobs/scrape-all";
import { matchScriptPosts } from "@/lib/jobs/match-scripts";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Research jobs.
 *  Scrape:     POST { handle, platform?: "instagram" | "tiktok", resultsLimit?: number }
 *  Scrape all: POST { action: "scrape-all", force?: boolean } — enqueues every
 *              creator the settings cover and drains within a time budget.
 *              Skips unless the configured schedule says a run is due, so a
 *              cron can safely poll far more often than the schedule.
 *              Repeat the call until { remaining: 0 } to finish a long queue.
 *  Categorize: POST { action: "categorize", creatorId?: string } — transcript-aware
 *              format re-detection (run after the transcription worker).
 *  Match:      POST { action: "match-scripts" } — link each open assignment to
 *              the post it produced, where the transcript match is unambiguous.
 *              Idempotent; anything doubtful is left for /scripts/review. */
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
    if (body.action === "match-scripts") {
      return NextResponse.json(await matchScriptPosts(createAdminClient()));
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
