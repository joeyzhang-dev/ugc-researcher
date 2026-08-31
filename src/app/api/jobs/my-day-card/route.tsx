import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadDailyRecap } from "@/lib/jobs/daily-recap";
import { DAILY_CARD_HEIGHT, DAILY_CARD_WIDTH, DailyCard } from "@/lib/daily-card";
import { dailyCardSignature, signatureMatches } from "@/lib/recap-image-url";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/** The daily card as a PNG. Signed on the Discord id, since this card is only
 *  ever rendered for the person who asked for it. */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const u = sp.get("u");
  const day = sp.get("day");
  const nonce = sp.get("n") ?? "";
  if (!u || !day) return NextResponse.json({ error: "u and day are required" }, { status: 400 });

  const expected = dailyCardSignature(u, day, nonce);
  if (!expected) return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  if (!signatureMatches(sp.get("sig"), expected)) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  // `day` is the reported day (yesterday); the loader works from "today", so
  // it is advanced by one to reproduce the same recap deterministically.
  const asToday = new Date(`${day}T12:00:00Z`);
  if (Number.isNaN(asToday.getTime())) {
    return NextResponse.json({ error: "day must be YYYY-MM-DD" }, { status: 400 });
  }
  asToday.setUTCDate(asToday.getUTCDate() + 1);

  const row = await loadDailyRecap(createAdminClient(), u, asToday);
  if (!row) return NextResponse.json({ error: "not-linked" }, { status: 404 });

  return new ImageResponse(<DailyCard row={row} />, {
    width: DAILY_CARD_WIDTH,
    height: DAILY_CARD_HEIGHT,
  });
}
