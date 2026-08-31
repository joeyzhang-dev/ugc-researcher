import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCreatorStats } from "@/lib/jobs/creator-stats";
import { MY_CARD_HEIGHT, MY_CARD_WIDTH, MyStatsCard } from "@/lib/my-stats-card";
import { diagnose } from "@/lib/creator-coaching";
import { myCardSignature, signatureMatches } from "@/lib/recap-image-url";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** The creator-facing stats card as a PNG. Signed like the others; its own
 *  subject so a coach-card link cannot be replayed for this render. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const handle = sp.get("handle");
  const asOfParam = sp.get("asOf");
  const nonce = sp.get("n") ?? "";
  if (!handle || !asOfParam) {
    return NextResponse.json({ error: "handle and asOf are required" }, { status: 400 });
  }
  const expected = myCardSignature(handle, asOfParam, nonce);
  if (!expected) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!signatureMatches(sp.get("sig"), expected)) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const asOf = new Date(`${asOfParam}T00:00:00Z`);
  if (Number.isNaN(asOf.getTime())) {
    return NextResponse.json({ error: "asOf must be YYYY-MM-DD" }, { status: 400 });
  }

  const row = await loadCreatorStats(createAdminClient(), handle, asOf);
  if (!row) return NextResponse.json({ error: `no creator @${handle}` }, { status: 404 });

  return new ImageResponse(<MyStatsCard row={row} coaching={diagnose(row.stats)} />, {
    width: MY_CARD_WIDTH,
    height: MY_CARD_HEIGHT,
  });
}
