import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCoachDigests } from "@/lib/jobs/coach-digest";
import { lastCompleteWeek, parseWeek } from "@/lib/performance";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * Send (or preview) the weekly coach digests.
 *
 * GET /api/jobs/coach-digest?week=YYYY-MM-DD&dry=1&to=<channelId>&weeklyOnly=1
 *
 * - `week`   any day of the week to report on; default the last complete week.
 * - `dry=1`  build everything, post nothing, write nothing.
 * - `to`     post every coach's digest to this one channel instead (a test
 *            channel); the ledger is not written, so the real send still
 *            happens later.
 * - `weeklyOnly=1` skip the onboarding pings.
 * - `resend=1` post a week again even though the ledger has it. Use when a
 *            digest went out wrong; the original ledger row is kept.
 *
 * CRON_SECRET or admin. The hourly cron calls the same function on Monday
 * 09:00 UTC; this route is the manual/preview entry point.
 */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;
  const sp = request.nextUrl.searchParams;
  try {
    const result = await sendCoachDigests(createAdminClient(), {
      week: parseWeek(sp.get("week")) ?? lastCompleteWeek(),
      dryRun: sp.get("dry") === "1",
      toChannelId: sp.get("to") || null,
      weeklyOnly: sp.get("weeklyOnly") === "1",
      // Deliberate re-send of a week already in the ledger. Recorded under its
      // own key; it does not delete or overwrite the original.
      resend: sp.get("resend") === "1",
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
