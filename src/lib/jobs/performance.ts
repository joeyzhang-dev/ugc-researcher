/**
 * Builds the weekly performance report: every roster creator, grouped by
 * coach, with the numbers from `src/lib/performance.ts`.
 *
 * One loader for two consumers — the /performance page and the Discord
 * digest route — so the coach never sees a figure the page cannot show.
 * Takes whichever Supabase client the caller has: the page's session client
 * (RLS, staff) or the job route's admin client.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  comparePerformance,
  creatorPerformance,
  lastCompleteWeek,
  weekKey,
  type CreatorPerformance,
  type PerformanceVideo,
  type Window,
} from "@/lib/performance";

/** Discord categories that are coach teams look like "Coach: Will's Team".
 *  The pull worker uses the same "team" test (`_TEAM_CATEGORY`) to tell a
 *  coach category from a niche one. */
const TEAM_CATEGORY = /\bteam\b/i;

/** Creators parked here are skipped for now (decided 2026-08-29). */
const PARKED_CATEGORY = /not creating/i;

export interface PerformanceRow {
  creatorId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  profileUrl: string | null;
  /** Snowflake as text — needed verbatim for a `<@id>` mention. */
  discordUserId: string | null;
  /** The coach category name, or null when the creator has no coaching
   *  channel in a team category. */
  coach: string | null;
  /** The creator's coaching channel, for a jump link in the digest. */
  discordChannelId: string | null;
  performance: CreatorPerformance;
}

export interface CoachGroup {
  /** Category name; `null` groups creators with no coach. */
  coach: string | null;
  rows: PerformanceRow[];
}

export interface PerformanceReport {
  week: Window;
  weekKey: string;
  /** Coach groups in name order, the coachless group last. Rows inside each
   *  are in digest order (bad → decent → good, worst rise first). */
  groups: CoachGroup[];
  /** Creators parked in "Not Creating" — listed so the skip is visible. */
  parked: { creatorId: string; handle: string }[];
  totals: { creators: number; belowQuota: number; flagged: number };
}

/** PostgREST caps a select at 1,000 rows; page through or lose videos. The
 *  caller builds the query and this adds the `range`. */
async function readAllRows<T>(
  label: string,
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>
): Promise<T[]> {
  const PAGE = 1000;
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1);
    if (error) throw new Error(`reading ${label}: ${error.message}`);
    const batch = (data ?? []) as T[];
    rows.push(...batch);
    if (batch.length < PAGE) return rows;
  }
}

export async function loadPerformanceReport(
  client: SupabaseClient,
  week: Window = lastCompleteWeek()
): Promise<PerformanceReport> {
  type CreatorRow = {
    id: string;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    profile_url: string | null;
    discord_user_id: string | null;
    launchpoint_creator_id: string | null;
  };
  type AccountRow = { contractor_id: string; first_post_at: string | null };
  type ChannelRow = {
    channel_id: string;
    research_creator_id: string | null;
    category: string | null;
  };
  type VideoRow = PerformanceVideo & { research_creator_id: string };

  // Instagram only — TikTok is out of scope (decided 2026-08-29), and the
  // roster's TikTok rows (a handful, pre-dating CREATE_PLATFORMS) have no
  // videos behind them anyway.
  const [igCreators, accounts, channels] = await Promise.all([
    readAllRows<CreatorRow>("research_creators", (from, to) =>
      client
        .from("research_creators")
        .select(
          "id, handle, display_name, avatar_url, profile_url, discord_user_id::text, launchpoint_creator_id"
        )
        .eq("kind", "roster")
        .eq("platform", "instagram")
        .range(from, to)
    ),
    readAllRows<AccountRow>("research_launchpoint_accounts", (from, to) =>
      client.from("research_launchpoint_accounts").select("contractor_id, first_post_at").range(from, to)
    ),
    readAllRows<ChannelRow>("research_discord_channels", (from, to) =>
      client
        .from("research_discord_channels")
        .select("channel_id::text, research_creator_id, category")
        .range(from, to)
    ),
  ]);

  const creatorIds = igCreators.map((c) => c.id);
  const videos = creatorIds.length
    ? await readAllRows<VideoRow>("research_videos", (from, to) =>
        client
          .from("research_videos")
          .select("research_creator_id, shortcode, url, posted_at, view_count, earnings_usd")
          .in("research_creator_id", creatorIds)
          .range(from, to)
      )
    : [];

  // joined_at = the creator's first Launchpoint post, earliest across every
  // account the contractor holds (decided 2026-08-29).
  const joinedByContractor = new Map<string, Date>();
  for (const a of accounts) {
    if (!a.first_post_at) continue;
    const at = new Date(a.first_post_at);
    const prev = joinedByContractor.get(a.contractor_id);
    if (!prev || at < prev) joinedByContractor.set(a.contractor_id, at);
  }

  // creator → coach comes from the category of their coaching channel.
  const coachByCreator = new Map<string, { coach: string; channelId: string }>();
  const parkedCreators = new Set<string>();
  for (const ch of channels) {
    if (!ch.research_creator_id || !ch.category) continue;
    if (PARKED_CATEGORY.test(ch.category)) {
      parkedCreators.add(ch.research_creator_id);
      continue;
    }
    if (TEAM_CATEGORY.test(ch.category) && !coachByCreator.has(ch.research_creator_id)) {
      coachByCreator.set(ch.research_creator_id, { coach: ch.category, channelId: ch.channel_id });
    }
  }

  const videosByCreator = new Map<string, PerformanceVideo[]>();
  for (const v of videos) {
    (videosByCreator.get(v.research_creator_id) ??
      videosByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  const rows: PerformanceRow[] = [];
  const parked: PerformanceReport["parked"] = [];
  for (const c of igCreators) {
    // A creator both parked and in a team keeps the team — the team channel
    // is the live one; "Not Creating" is where old channels go.
    const team = coachByCreator.get(c.id) ?? null;
    if (!team && parkedCreators.has(c.id)) {
      parked.push({ creatorId: c.id, handle: c.handle });
      continue;
    }
    rows.push({
      creatorId: c.id,
      handle: c.handle,
      displayName: c.display_name,
      avatarUrl: c.avatar_url,
      profileUrl: c.profile_url,
      discordUserId: c.discord_user_id,
      coach: team?.coach ?? null,
      discordChannelId: team?.channelId ?? null,
      performance: creatorPerformance({
        videos: videosByCreator.get(c.id) ?? [],
        joinedAt: c.launchpoint_creator_id
          ? (joinedByContractor.get(c.launchpoint_creator_id) ?? null)
          : null,
        week,
      }),
    });
  }

  const byCoach = new Map<string | null, PerformanceRow[]>();
  for (const r of rows) {
    (byCoach.get(r.coach) ?? byCoach.set(r.coach, []).get(r.coach)!).push(r);
  }
  const groups: CoachGroup[] = [...byCoach.entries()]
    .sort(([a], [b]) => (a == null ? 1 : b == null ? -1 : a.localeCompare(b)))
    .map(([coach, groupRows]) => ({
      coach,
      rows: groupRows.sort(
        (a, b) =>
          comparePerformance(a.performance, b.performance) || a.handle.localeCompare(b.handle)
      ),
    }));

  return {
    week,
    weekKey: weekKey(week),
    groups,
    parked: parked.sort((a, b) => a.handle.localeCompare(b.handle)),
    totals: {
      creators: rows.length,
      belowQuota: rows.filter((r) => r.performance.weekly.belowQuota).length,
      flagged: rows.filter((r) => r.performance.flagged).length,
    },
  };
}
