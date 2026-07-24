import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFormatCategorization, runResearchScrape } from "@/lib/jobs/research";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** Research jobs.
 *  Scrape:     POST { handle, platform?: "instagram" | "tiktok", resultsLimit?: number }
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
