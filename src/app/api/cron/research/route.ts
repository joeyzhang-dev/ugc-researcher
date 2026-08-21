import { NextRequest, NextResponse } from "next/server";
import { scrapeAll } from "@/lib/jobs/scrape-all";
import { authorizeJobRequest } from "../../jobs/authorize";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/** The scheduled scrape entry point (vercel.json → crons).
 *
 *  Vercel Cron issues a **GET**, which is why this exists rather than the cron
 *  pointing straight at /api/jobs/research — that route is POST-only and would
 *  answer a cron with 405 forever. Vercel attaches
 *  `Authorization: Bearer $CRON_SECRET` automatically because CRON_SECRET is
 *  set on the project, and authorizeJobRequest already accepts exactly that.
 *
 *  Safe to run often: scrapeAll no-ops unless the configured schedule says a
 *  run is due, and an in-flight queue resumes on the next tick. One pass
 *  drains within a 4-minute budget and reports what is left, so an hourly
 *  cron finishes a long queue across successive ticks. */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;
  try {
    return NextResponse.json(await scrapeAll(false));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
