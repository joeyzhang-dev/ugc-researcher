/**
 * Load one creator's daily recap.
 *
 * The extra read over `/my-stats` is `research_video_metrics_daily`, which is
 * where the day-over-day view deltas live. It is scoped to a single date and a
 * single creator's posts — the table holds 32k rows and grows every day, so an
 * unscoped read would be the whole corpus to answer a question about one
 * person's yesterday.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { dailyRecap, reportedDay, type DailyRecap } from "@/lib/daily-recap";
import { findCreatorByDiscordUserId } from "@/lib/jobs/creator-stats";

export interface DailyRecapRow {
  handle: string;
  name: string;
  avatarUrl: string | null;
  recap: DailyRecap;
}

/** Posts are read back far enough to establish a streak and this week's pace,
 *  not the whole history: 60 days covers both with room to spare. */
const POST_LOOKBACK_DAYS = 60;

export async function loadDailyRecap(
  client: SupabaseClient,
  discordUserId: string,
  today: Date = new Date()
): Promise<DailyRecapRow | null> {
  const creator = await findCreatorByDiscordUserId(client, discordUserId);
  if (!creator) return null;
  const creatorId = creator.id as string;

  const since = new Date(today.getTime() - POST_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const { data: postRows, error: postError } = await client
    .from("research_videos")
    .select("id, shortcode, url, posted_at, thumbnail_url, transcript_text, view_count, earnings_usd")
    .eq("research_creator_id", creatorId)
    .gte("posted_at", since.toISOString())
    .limit(2000);
  if (postError) throw new Error(`loading posts: ${postError.message}`);

  const posts = (postRows ?? []).map((p) => ({
    shortcode: p.shortcode as string | null,
    url: p.url as string,
    posted_at: p.posted_at as string | null,
    view_count: (p.view_count as number) ?? 0,
    earnings_usd: (p.earnings_usd as number) ?? 0,
    // The collapse needs the words; the card needs the image.
    transcript_text: (p.transcript_text as string) ?? null,
    thumbnail: (p.thumbnail_url as string) ?? null,
  }));

  // Movement can come from ANY live post, including ones older than the
  // lookback — an old reel catching fire is exactly what a daily should
  // surface — so the metrics read is keyed on the creator's whole video set.
  const { data: idRows } = await client
    .from("research_videos")
    .select("id, shortcode")
    .eq("research_creator_id", creatorId)
    .limit(5000);
  const shortcodeById = new Map(
    (idRows ?? []).map((r) => [r.id as string, r.shortcode as string | null])
  );

  const day = reportedDay(today).toISOString().slice(0, 10);
  const ids = [...shortcodeById.keys()];
  const metrics: { shortcode: string | null; views: number; viewsDelta: number }[] = [];
  // Chunked: an `in` list of a few thousand ids exceeds PostgREST's URL limit.
  for (let i = 0; i < ids.length; i += 200) {
    const { data, error } = await client
      .from("research_video_metrics_daily")
      .select("research_video_id, views, views_delta")
      .eq("date", day)
      .in("research_video_id", ids.slice(i, i + 200));
    if (error) throw new Error(`loading daily metrics: ${error.message}`);
    for (const m of data ?? []) {
      metrics.push({
        shortcode: shortcodeById.get(m.research_video_id as string) ?? null,
        views: (m.views as number) ?? 0,
        viewsDelta: (m.views_delta as number) ?? 0,
      });
    }
  }

  return {
    handle: creator.handle as string,
    name:
      ((creator.launchpoint_name as string) ||
        (creator.display_name as string) ||
        (creator.handle as string)) ?? "",
    avatarUrl: (creator.avatar_url as string) ?? null,
    recap: dailyRecap({ posts, metrics, today }),
  };
}
