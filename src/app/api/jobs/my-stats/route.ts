import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { findCreatorByDiscordUserId, loadCreatorStats } from "@/lib/jobs/creator-stats";
import { myCardUrl, warmRecapImage } from "@/lib/recap-image-url";
import { cpmNote, diagnose } from "@/lib/creator-coaching";
import { QUOTA_POSTS_PER_WEEK, lastCompleteWeek } from "@/lib/performance";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * The caller's OWN stats, for `/my-stats`.
 *
 * Keyed on `discordUserId` and nothing else. The bot takes that id from the
 * interaction Discord signed, so it is the one identifier the creator cannot
 * put words into — a handle parameter here would let any creator read any
 * other creator's earnings, which is the whole reason this is a separate route
 * from `/api/jobs/creator-stats` rather than a flag on it.
 *
 * Returns the creator-facing voice of the coaching line, never the coach's.
 */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;

  const discordUserId = request.nextUrl.searchParams.get("discordUserId");
  if (!discordUserId) {
    return NextResponse.json({ error: "discordUserId is required" }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const creator = await findCreatorByDiscordUserId(admin, discordUserId);
    if (!creator) {
      return NextResponse.json(
        { error: "not-linked", message: "no creator is linked to this Discord account" },
        { status: 404 }
      );
    }

    const asOf = lastCompleteWeek().start;
    const row = await loadCreatorStats(admin, creator.handle as string, asOf);
    if (!row) return NextResponse.json({ error: "not-linked" }, { status: 404 });

    const coaching = diagnose(row.stats);
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://bludgc.vercel.app").replace(/\/$/, "");
    const nonce = Date.now().toString(36);
    const url = myCardUrl(appUrl, row.handle, asOf, nonce);
    const imageUrl = url && (await warmRecapImage(url)) ? url : null;

    const s = row.stats;
    const best = s.trend.reduce((m, p) => Math.max(m, p.read.avgViews ?? 0), 0);
    return NextResponse.json({
      handle: row.handle,
      name: row.launchpointName ?? row.displayName ?? row.handle,
      platform: row.platform,
      quota: QUOTA_POSTS_PER_WEEK,
      imageUrl,
      // Only the creator-facing voice crosses this boundary. The coach's
      // diagnosis ("call or offboard") must never reach the person it is about.
      message: coaching.creator,
      tone: coaching.tone,
      cpmNote: cpmNote(s.money.cpm30.cpm, s.money.cpm30.projected),
      current: {
        posts: s.current.posts,
        avgViews: s.current.avgViews,
        spikes: s.current.spikes.length,
      },
      totals: s.totals,
      personalBestAvgViews: best,
      money: {
        earnedUsd: s.money.earnedUsd,
        paidPosts: s.money.paidPosts,
        unpaidPosts: Math.max(s.money.unpaidPosts, 0),
        cpm: s.money.cpm30.cpm,
        projectedCpm: s.money.cpm30.projected,
      },
      topPosts: s.topPosts.map(({ post }) => ({ url: post.url, views: post.views })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
