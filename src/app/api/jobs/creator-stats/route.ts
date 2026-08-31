import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadCreatorStats } from "@/lib/jobs/creator-stats";
import { creatorCardUrl, warmRecapImage } from "@/lib/recap-image-url";
import { cpmNote, diagnose } from "@/lib/creator-coaching";
import { QUOTA_POSTS_PER_WEEK, lastCompleteWeek, weekKey } from "@/lib/performance";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * One creator's stats, for the Discord bot's `/stats`.
 *
 * GET /api/jobs/creator-stats?handle=<handle>[&asOf=YYYY-MM-DD]
 *
 * The bot is Python on Fly and the performance math is TypeScript here. Rather
 * than port the trial-reel collapse, the CPM windows and the bucket lines into
 * a second language — where they would drift the first time either side
 * changed — the bot asks this route and renders what it is handed. Same rule
 * the digest follows: the page and the ping cannot disagree on a number.
 *
 * The card URL comes back already warmed, because Discord's media proxy gives
 * up on a cold next/og render (see warmRecapImage). `imageUrl` is null when
 * the render did not come up in time; the bot then posts the text without it.
 */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;

  const sp = request.nextUrl.searchParams;
  const handle = sp.get("handle");
  if (!handle) return NextResponse.json({ error: "handle is required" }, { status: 400 });

  const asOfParam = sp.get("asOf");
  const asOf = asOfParam ? new Date(`${asOfParam}T00:00:00Z`) : lastCompleteWeek().start;
  if (Number.isNaN(asOf.getTime())) {
    return NextResponse.json({ error: "asOf must be YYYY-MM-DD" }, { status: 400 });
  }

  try {
    const row = await loadCreatorStats(createAdminClient(), handle, asOf);
    if (!row) return NextResponse.json({ error: `no creator @${handle}` }, { status: 404 });

    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://bludgc.vercel.app").replace(/\/$/, "");
    // Nonce per request: a card that failed to render once must not leave this
    // creator permanently blank in Discord's proxy cache.
    const nonce = Date.now().toString(36);
    const url = creatorCardUrl(appUrl, row.handle, asOf, nonce);
    const imageUrl = url && (await warmRecapImage(url)) ? url : null;

    const s = row.stats;
    const cpm = s.money.cpm30;
    // The coach voice, not the creator one: this endpoint feeds /stats, which
    // only staff can run.
    const coaching = diagnose(s);
    return NextResponse.json({
      handle: row.handle,
      name: row.launchpointName ?? row.displayName ?? row.handle,
      profileUrl: row.profileUrl,
      discordUserId: row.discordUserId,
      discordChannelId: row.discordChannelId,
      coach: row.coach,
      // Stated rather than assumed: a caller reading "108 posts" should not
      // have to guess whether TikTok is in there. It is not.
      platform: row.platform,
      niche: row.niche,
      archived: !!row.archivedAt,
      week: weekKey({ start: asOf, end: asOf }),
      quota: QUOTA_POSTS_PER_WEEK,
      readCase: coaching.case,
      message: coaching.coach,
      cpmNote: cpmNote(cpm.cpm, cpm.projected, cpm.settledWindow),
      imageUrl,
      current: {
        posts: s.current.posts,
        avgViews: s.current.avgViews,
        spikes: s.current.spikes.length,
        trialUploads: s.current.trialUploads,
      },
      totals: s.totals,
      money: {
        earnedUsd: s.money.earnedUsd,
        paidPosts: s.money.paidPosts,
        unpaidPosts: Math.max(s.money.unpaidPosts, 0),
        cpm: cpm.cpm,
        projectedCpm: cpm.projected,
        lowSample: cpm.lowSample,
        deltaUsd: s.money.delta?.usd ?? null,
      },
      topPosts: s.topPosts.map(({ post, week }) => ({
        url: post.url,
        views: post.views,
        week: weekKey(week),
      })),
      trend: s.trend.map(({ week, read }) => ({
        week: weekKey(week),
        posts: read.posts,
        avgViews: read.avgViews,
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
