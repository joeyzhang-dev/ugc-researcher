import { NextRequest, NextResponse } from "next/server";
import { ImageResponse } from "next/og";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPerformanceReport, type PerformanceRow } from "@/lib/jobs/performance";
import { lastCompleteWeek, parseWeek } from "@/lib/performance";
import { CARD_WIDTH, RecapCard, cardHeight, topPostCount } from "@/lib/recap-card";
import { recapImageSignature } from "@/lib/recap-image-url";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * The weekly recap card as a PNG.
 *
 * GET /api/jobs/recap-image?coach=<name>&week=YYYY-MM-DD&sig=<hmac>
 *
 * Discord's CDN fetches this URL itself when it unfurls the message, from its
 * own servers with no session, so this route cannot sit behind the staff gate
 * — it lives under `/api/jobs` (public per `isPublicPath`) and authorizes
 * itself instead. The card shows every creator's posting numbers, so "public"
 * has to mean "unguessable": `sig` is an HMAC of the exact coach+week being
 * requested, keyed on CRON_SECRET. Without it there is no route to enumerate
 * a team's performance by guessing a category name.
 *
 * The signature covers coach, week and the `n` cache-buster together, so a
 * link leaked for one week does not open any other week, and the nonce cannot
 * be swapped for a different one.
 */
export async function GET(request: NextRequest) {
  const sp = request.nextUrl.searchParams;
  const coach = sp.get("coach");
  const weekParam = sp.get("week");
  const sig = sp.get("sig");
  // Opaque cache-buster; only meaningful as part of the signature.
  const nonce = sp.get("n") ?? "";

  if (!coach || !weekParam) {
    return NextResponse.json({ error: "coach and week are required" }, { status: 400 });
  }

  const expected = recapImageSignature(coach, weekParam, nonce);
  if (!expected) {
    return NextResponse.json({ error: "CRON_SECRET is not configured" }, { status: 503 });
  }
  // Length-checked before comparing so a short guess cannot throw.
  if (!sig || sig.length !== expected.length || !timingSafeEqual(sig, expected)) {
    return NextResponse.json({ error: "bad signature" }, { status: 403 });
  }

  const week = parseWeek(weekParam) ?? lastCompleteWeek();
  const report = await loadPerformanceReport(createAdminClient(), week);
  const group = report.groups.find((g) => g.coach === coach);
  const rows: PerformanceRow[] = group?.rows ?? [];

  if (rows.length === 0) {
    return NextResponse.json({ error: `no creators for coach ${coach}` }, { status: 404 });
  }

  return new ImageResponse(<RecapCard coach={coach} week={week} rows={rows} />, {
    width: CARD_WIDTH,
    height: cardHeight(rows.length, topPostCount(rows)),
  });
}

/** Constant-time compare over equal-length strings. */
function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
