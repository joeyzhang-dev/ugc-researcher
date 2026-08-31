import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCreatorStats } from "@/lib/jobs/creator-stats";
import { CREATOR_CARD_HEIGHT, CREATOR_CARD_WIDTH, CreatorCard } from "@/lib/creator-card";
import { creatorCardSignature, signatureMatches } from "@/lib/recap-image-url";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * One creator's stats card as a PNG.
 *
 * GET /api/jobs/creator-card?handle=<handle>&asOf=YYYY-MM-DD&sig=<hmac>&n=<nonce>
 *
 * Same shape and same reasoning as the recap card route: Discord's CDN fetches
 * this itself with no session, so it lives under the self-authorizing
 * `/api/jobs` prefix and gates on an HMAC instead. The signature is over a
 * distinct `creator` subject, so a recap signature cannot be replayed here to
 * read a slice of the data it was not issued for.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const handle = sp.get("handle");
  const asOfParam = sp.get("asOf");
  const nonce = sp.get("n") ?? "";

  if (!handle || !asOfParam) {
    return NextResponse.json({ error: "handle and asOf are required" }, { status: 400 });
  }
  const expected = creatorCardSignature(handle, asOfParam, nonce);
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  if (!signatureMatches(sp.get("sig"), expected)) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const asOf = new Date(`${asOfParam}T00:00:00Z`);
  if (Number.isNaN(asOf.getTime())) {
    return NextResponse.json({ error: "asOf must be YYYY-MM-DD" }, { status: 400 });
  }

  const row = await loadCreatorStats(createAdminClient(), handle, asOf);
  if (!row) return NextResponse.json({ error: `no creator @${handle}` }, { status: 404 });

  return new ImageResponse(<CreatorCard row={row} />, {
    width: CREATOR_CARD_WIDTH,
    height: CREATOR_CARD_HEIGHT,
  });
}
