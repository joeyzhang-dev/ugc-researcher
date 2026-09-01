import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadPerformanceReport, type PerformanceRow } from "@/lib/jobs/performance";
import { lastCompleteWeek, parseWeek } from "@/lib/performance";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * The weekly coach digest, as data.
 *
 * GET /api/jobs/performance-digest?week=YYYY-MM-DD (any day of the week;
 * defaults to the last complete Monday→Monday week). CRON_SECRET or admin.
 *
 * The Discord bot fetches this and renders one embed per coach — the math
 * stays here, in TypeScript, next to its tests, rather than being
 * reimplemented in Python. Passing the week explicitly means a retry
 * produces the identical digest.
 *
 * `/api/jobs` is a public prefix in `isPublicPath()` — this route authorizes
 * itself, and anywhere else the middleware would 307 it to /login.
 */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;

  const week = parseWeek(request.nextUrl.searchParams.get("week")) ?? lastCompleteWeek();
  try {
    const report = await loadPerformanceReport(createAdminClient(), week);
    return NextResponse.json({
      week: { start: report.week.start.toISOString(), end: report.week.end.toISOString(), key: report.weekKey },
      totals: report.totals,
      parked: report.parked,
      coaches: report.groups.map((g) => ({
        coach: g.coach,
        creators: g.rows.map(digestLine),
      })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** One creator, flattened for an embed line. `mention` is the Discord
 *  markup that renders the blue name (and, in an embed, never pings). */
function digestLine(r: PerformanceRow) {
  const p = r.performance;
  return {
    creatorId: r.creatorId,
    handle: r.handle,
    displayName: r.displayName,
    mention: r.discordUserId ? `<@${r.discordUserId}>` : null,
    profileUrl: r.profileUrl ?? `https://www.instagram.com/${r.handle}/`,
    channelId: r.discordChannelId,
    bucket: p.bucket,
    bucketSource: p.bucketSource,
    flagged: p.flagged,
    badStreak: p.badStreak,
    weeksSinceJoined: p.weeksSinceJoined,
    week: {
      posts: p.weekly.posts,
      quota: p.weekly.quota,
      belowQuota: p.weekly.belowQuota,
      views: p.weekly.views,
      avgViews: p.weekly.avgViews,
      projectedCpm: p.weekly.projectedCpm,
      spikes: p.weekly.spikes,
      bestPost: p.weekly.bestPost,
    },
    cpm30: {
      cpm: p.cpm30.cpm,
      settledThrough: p.cpm30.settledWindow?.end.toISOString() ?? null,
      lowSample: p.cpm30.lowSample,
      projected: p.cpm30.projected,
      paidPosts: p.cpm30.paidPosts,
      posts: p.cpm30.posts,
      prior: p.cpm30.priorCpm,
      priorPaidPosts: p.cpm30.priorPaidPosts,
      priorThrough: p.cpm30.priorWindow?.end.toISOString() ?? null,
      delta: p.delta,
      projectedDelta: p.projectedDelta,
      previousWeekProjectedCpm: p.weeklyPrev.projectedCpm,
    },
    onboarding: {
      joinedAt: p.onboarding.joinedAt?.toISOString() ?? null,
      posts: p.onboarding.posts,
      avgViews: p.onboarding.avgViews,
      bucket: p.onboarding.bucket,
      source: p.onboarding.source,
      final: p.onboarding.final,
      cpm: p.onboarding.cpm,
      projected: p.onboarding.projected,
    },
  };
}
