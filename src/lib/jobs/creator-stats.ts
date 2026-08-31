/**
 * Load one creator's stats panel.
 *
 * Deliberately NOT `loadPerformanceReport`: that one reads every creator and
 * every video in the corpus (~40k rows) because the digest needs the whole
 * roster. `/stats` is an interactive command about one person, so it reads one
 * creator's videos and nothing else — the difference between a few hundred
 * rows and forty thousand, on a path where a human is watching a spinner.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { creatorStats, trendWindows, TREND_WEEKS, type CreatorStats } from "@/lib/creator-stats";
import { lastCompleteWeek, type PerformanceVideo } from "@/lib/performance";

export interface CreatorStatsRow {
  creatorId: string;
  handle: string;
  displayName: string | null;
  launchpointName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  discordUserId: string | null;
  discordChannelId: string | null;
  /** The coach team category, when their channel sits in one. */
  coach: string | null;
  /** Always "instagram" today: it is the only platform whose posts are
   *  ingested, so it is the only platform these numbers can describe. */
  platform: "instagram";
  niche: string | null;
  archivedAt: string | null;
  stats: CreatorStats;
}

const CREATOR_COLUMNS =
  "id, handle, display_name, launchpoint_name, avatar_url, profile_url, discord_user_id::text, archived_at";

/**
 * Resolve a creator by handle (with or without @), case-insensitively.
 *
 * Pinned to Instagram, because `research_creators` is keyed on
 * (platform, handle) and the same handle can exist on both. Only Instagram
 * posts are ingested — Launchpoint tracks TikTok accounts for these same
 * people, but no TikTok video ever lands in `research_videos` — so a TikTok
 * row has nothing behind it. Without this filter an unpinned `.limit(1)` would
 * take whichever row came back first and quietly render an empty panel for an
 * active creator. The digest pins the same way.
 */
export async function findCreatorByHandle(
  client: SupabaseClient,
  handle: string
): Promise<Record<string, unknown> | null> {
  const clean = handle.trim().replace(/^@/, "");
  if (!clean) return null;
  const { data, error } = await client
    .from("research_creators")
    .select(CREATOR_COLUMNS)
    .eq("platform", "instagram")
    .ilike("handle", clean)
    .limit(1);
  if (error) throw new Error(`looking up ${clean}: ${error.message}`);
  return (data?.[0] as Record<string, unknown>) ?? null;
}

/**
 * Resolve a creator by their Discord id.
 *
 * `/my-stats` resolves the caller this way and never by a name they typed:
 * the id comes from the interaction, which Discord signs, so it is the one
 * identifier a creator cannot put words into. Accepting a handle there would
 * let anyone read anyone's earnings.
 *
 * `discord_user_id` is a bigint snowflake, so it is compared as text — a JS
 * number loses the low bits and would silently match the wrong person.
 */
export async function findCreatorByDiscordUserId(
  client: SupabaseClient,
  discordUserId: string
): Promise<Record<string, unknown> | null> {
  const id = (discordUserId ?? "").trim();
  if (!/^\d{5,25}$/.test(id)) return null;
  const { data, error } = await client
    .from("research_creators")
    .select(CREATOR_COLUMNS)
    .eq("platform", "instagram")
    .eq("discord_user_id", id)
    .limit(1);
  if (error) throw new Error(`looking up discord ${id}: ${error.message}`);
  return (data?.[0] as Record<string, unknown>) ?? null;
}

export async function loadCreatorStats(
  client: SupabaseClient,
  handle: string,
  asOf: Date = lastCompleteWeek().start
): Promise<CreatorStatsRow | null> {
  const creator = await findCreatorByHandle(client, handle);
  if (!creator) return null;
  const creatorId = creator.id as string;

  // Every video, because money is lifetime and the settled CPM window reaches
  // back past the trend. One creator's corpus is a few hundred rows.
  const { data: videoRows, error: videoError } = await client
    .from("research_videos")
    .select("shortcode, url, posted_at, view_count, earnings_usd")
    .eq("research_creator_id", creatorId)
    .limit(5000);
  if (videoError) throw new Error(`loading videos: ${videoError.message}`);

  // Transcripts and thumbnails only across the trend window: the collapse
  // needs the words, the card needs the images, and neither question reaches
  // further back than the bars do.
  const windows = trendWindows(asOf, TREND_WEEKS);
  const from = windows[0].start.toISOString();
  const to = windows[windows.length - 1].end.toISOString();
  const { data: extraRows, error: extraError } = await client
    .from("research_videos")
    .select("shortcode, transcript_text, thumbnail_url")
    .eq("research_creator_id", creatorId)
    .gte("posted_at", from)
    .lt("posted_at", to)
    .limit(5000);
  if (extraError) throw new Error(`loading transcripts: ${extraError.message}`);

  const extras = new Map(
    (extraRows ?? []).filter((r) => !!r.shortcode).map((r) => [r.shortcode as string, r] as const)
  );
  const videos: PerformanceVideo[] = (videoRows ?? []).map((v) => {
    const extra = v.shortcode ? extras.get(v.shortcode) : undefined;
    return extra
      ? { ...v, transcript_text: extra.transcript_text, thumbnail_url: extra.thumbnail_url }
      : v;
  });

  // The coaching channel gives us both the coach team and the niche.
  const { data: channels } = await client
    .from("research_discord_channels")
    .select("channel_id::text, category, niche")
    .eq("research_creator_id", creatorId)
    .limit(1);
  const channel = channels?.[0] as
    | { channel_id: string | null; category: string | null; niche: string | null }
    | undefined;

  return {
    creatorId,
    handle: creator.handle as string,
    displayName: (creator.display_name as string) ?? null,
    launchpointName: (creator.launchpoint_name as string) ?? null,
    avatarUrl: (creator.avatar_url as string) ?? null,
    profileUrl: (creator.profile_url as string) ?? null,
    discordUserId: (creator.discord_user_id as string) ?? null,
    discordChannelId: channel?.channel_id ?? null,
    coach: channel?.category ?? null,
    platform: "instagram",
    niche: channel?.niche ?? null,
    archivedAt: (creator.archived_at as string) ?? null,
    stats: creatorStats({ videos, asOf }),
  };
}
