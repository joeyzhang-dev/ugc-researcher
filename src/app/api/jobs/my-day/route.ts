import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadDailyRecap } from "@/lib/jobs/daily-recap";
import { dailyCardUrl, warmRecapImage } from "@/lib/recap-image-url";
import { QUOTA_POSTS_PER_WEEK } from "@/lib/performance";
import { authorizeJobRequest } from "../authorize";

export const maxDuration = 120;
export const dynamic = "force-dynamic";

/**
 * The caller's own day, for `/my-day`.
 *
 * Keyed on `discordUserId` for the same reason `/my-stats` is: the id comes
 * from the interaction Discord signed, so it is the one identifier a creator
 * cannot put words into.
 */
export async function GET(request: NextRequest) {
  const denied = await authorizeJobRequest(request);
  if (denied) return denied;

  const discordUserId = request.nextUrl.searchParams.get("discordUserId");
  if (!discordUserId) {
    return NextResponse.json({ error: "discordUserId is required" }, { status: 400 });
  }

  try {
    const row = await loadDailyRecap(createAdminClient(), discordUserId);
    if (!row) {
      return NextResponse.json(
        { error: "not-linked", message: "no creator is linked to this Discord account" },
        { status: 404 }
      );
    }

    const r = row.recap;
    const day = r.day.toISOString().slice(0, 10);
    const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://bludgc.vercel.app").replace(/\/$/, "");
    const nonce = Date.now().toString(36);
    const url = dailyCardUrl(appUrl, discordUserId, day, nonce);
    const imageUrl = url && (await warmRecapImage(url)) ? url : null;

    const remaining = Math.max(QUOTA_POSTS_PER_WEEK - r.pace.postsThisWeek, 0);
    const message =
      remaining === 0
        ? "Target already hit this week — everything from here is upside."
        : r.pace.daysLeft === 0
          ? `The week closed at ${r.pace.postsThisWeek}/${QUOTA_POSTS_PER_WEEK}. Fresh start tomorrow.`
          : `${remaining} to go with ${r.pace.daysLeft} day${r.pace.daysLeft === 1 ? "" : "s"} left — about ${r.pace.perDayNeeded} a day gets you there.`;

    return NextResponse.json({
      handle: row.handle,
      name: row.name,
      day,
      imageUrl,
      message,
      viewsAdded: r.viewsAdded,
      postedThatDay: r.postedThatDay.length,
      streakDays: r.streakDays,
      bestStreakDays: r.bestStreakDays,
      pace: {
        postsThisWeek: r.pace.postsThisWeek,
        quota: r.pace.quota,
        daysLeft: r.pace.daysLeft,
        perDayNeeded: r.pace.perDayNeeded,
        onTrack: r.pace.onTrack,
      },
      movers: r.movers.map((m) => ({ url: m.url, viewsDelta: m.viewsDelta, views: m.views })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
