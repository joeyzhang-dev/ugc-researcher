import { NextRequest, NextResponse } from "next/server";
import { scrapeAll } from "@/lib/jobs/scrape-all";
import { createAdminClient } from "@/lib/supabase/admin";
import { matchScriptPosts } from "@/lib/jobs/match-scripts";
import { authorizeJobRequest } from "../authorize";

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
 *  It lives under /api/jobs deliberately: isPublicPath() allows that prefix
 *  past the staff-session gate, because these routes authorize themselves.
 *  A cron route anywhere else is redirected to /login by the middleware and
 *  never runs — the request carries a bearer token, not a session cookie.
 *
 *  Safe to run often: scrapeAll no-ops unless the configured schedule says a
 *  run is due, and an in-flight queue resumes on the next tick. One pass
 *  drains within a 4-minute budget and reports what is left, so an hourly
 *  cron finishes a long queue across successive ticks.
 *
 *  Script matching runs on every idle tick, not just after a scrape. Posts are
 *  transcribed asynchronously by the Fly worker long after the scrape that
 *  found them, so tying matching to the 12-hourly scrape would leave a new
 *  post unlinked for half a day. It is skipped while a scrape queue is still
 *  draining, purely to protect the 300s budget. */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;
  try {
    const scrape = await scrapeAll(false);
    // Only once the scrape queue is empty — mid-drain the budget is spoken for.
    const matched = scrape.remaining === 0 ? await matchScriptPosts(createAdminClient()) : null;
    return NextResponse.json({ ...scrape, matched });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
