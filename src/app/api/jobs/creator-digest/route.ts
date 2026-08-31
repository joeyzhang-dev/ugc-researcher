import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendCreatorDaily, sendCreatorWeekly } from "@/lib/jobs/creator-digest";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

/**
 * Send (or preview) the creator recaps.
 *
 * GET /api/jobs/creator-digest?kind=weekly|daily&dry=1&to=<channelId>&force=1
 *
 * - `dry=1`  build everything, post nothing, write no ledger.
 * - `to`     post every creator's message to one channel instead, for review.
 *            The ledger is not written, so the real send still happens later.
 * - `force=1` ignore the research_settings kill switch. For previewing before
 *            the flag is flipped on; it does NOT bypass the ledger.
 */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;
  const sp = request.nextUrl.searchParams;
  const options = {
    dryRun: sp.get("dry") === "1",
    toChannelId: sp.get("to") || null,
    force: sp.get("force") === "1",
  };
  try {
    const admin = createAdminClient();
    const kind = sp.get("kind") ?? "daily";
    const result =
      kind === "weekly" ? await sendCreatorWeekly(admin, options) : await sendCreatorDaily(admin, options);
    return NextResponse.json({ kind, ...result });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : String(error) },
      { status: 500 }
    );
  }
}
