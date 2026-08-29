import { NextRequest, NextResponse } from "next/server";
import { scrapeAll } from "@/lib/jobs/scrape-all";
import { createAdminClient } from "@/lib/supabase/admin";
import { matchScriptPosts } from "@/lib/jobs/match-scripts";
import { syncLaunchpoint } from "@/lib/jobs/launchpoint";
import { isDigestHour, sendCoachDigests } from "@/lib/jobs/coach-digest";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 300;

/** Hard stop for the whole tick, leaving headroom under maxDuration for the
 *  response. The Launchpoint sync takes what remains after the scrape. */
const LAUNCHPOINT_BUDGET_MS = 260_000;
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
 *  draining, purely to protect the 300s budget.
 *
 *  The Launchpoint sync runs last, on the same idle condition. Its creator and
 *  post phases finish in a handful of calls; its insight and history phases
 *  are one API call per post against a 100/minute key, so they deliberately do
 *  NOT finish in one tick — they walk `launchpoint_synced_at` oldest-first and
 *  resume where the budget cut them off. `launchpoint.remaining` reports what
 *  is still stale, the same contract as `scrape.remaining`. */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;
  try {
    const startedAt = Date.now();
    // Coach digests first, on the Monday 09:00 UTC tick only: a few Discord
    // calls, and the ledger makes a repeat harmless. Before the scrape so a
    // long drain cannot starve it; non-fatal so a Discord hiccup does not
    // take the scrape down with it.
    let digest: Awaited<ReturnType<typeof sendCoachDigests>> | { failed: string } | null = null;
    if (isDigestHour() && process.env.DISCORD_BOT_TOKEN) {
      try {
        digest = await sendCoachDigests(createAdminClient());
      } catch (error) {
        digest = { failed: error instanceof Error ? error.message : String(error) };
      }
    }
    const scrape = await scrapeAll(false);
    // Only once the scrape queue is empty — mid-drain the budget is spoken for.
    const idle = scrape.remaining === 0;
    const matched = idle ? await matchScriptPosts(createAdminClient()) : null;
    // Launchpoint gets whatever is left of the tick. Its two expensive phases
    // are budget-aware and resume from the table on the next run, so a short
    // remainder here is progress rather than a wasted call.
    const launchpoint = idle
      ? await syncLaunchpoint(createAdminClient(), {
          budgetMs: Math.max(0, LAUNCHPOINT_BUDGET_MS - (Date.now() - startedAt)),
        })
      : null;
    return NextResponse.json({ ...scrape, matched, launchpoint, digest });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
