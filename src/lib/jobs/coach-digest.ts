/**
 * Sends the weekly performance digest to each coach's private channel.
 *
 * Lives in the web app rather than the Fly bot on purpose: the math is here
 * (`src/lib/performance.ts`, tested), `src/lib/discord.ts` already posts with
 * the bot token over REST (no gateway, so it cannot double-connect the
 * token), and a change ships with a Vercel deploy instead of a bot restart.
 *
 * Idempotent by construction: every message is recorded in
 * `research_coach_digests` under a dedupe key computed *before* posting, and
 * a key that already exists is skipped. A retried cron tick, or the same week
 * run by hand twice, cannot post twice.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  PERM,
  createTextChannel,
  currentBotUser,
  discordConfigured,
  listGuildChannels,
  listGuildRoles,
  postChannelMessage,
  type PermissionOverwrite,
} from "@/lib/discord";
import { buildCoachRecapV2, buildOnboardingPing } from "@/lib/digest-render";
import { recapImageUrl, warmRecapImage } from "@/lib/recap-image-url";
import { lastCompleteWeek, type Window } from "@/lib/performance";
import { loadPerformanceReport, type PerformanceRow } from "@/lib/jobs/performance";

/** The channel created inside every "Coach: … Team" category. */
export const WEEKLY_REPORT_CHANNEL = "📊weekly-report";

/** Who can see it. Resolved by name from the live guild; overridable. */
export const DEFAULT_VIEWER_ROLES = ["Coach", "Folk Team", "dev"];

/** Same test the pull worker and the report use for a coach category. */
const TEAM_CATEGORY = /\bteam\b/i;

export interface DigestOptions {
  week?: Window;
  /** Render and report, post nothing, write nothing. */
  dryRun?: boolean;
  /** Post every digest to this one channel instead of the coach channels —
   *  for eyeballing in #script-send-test before the first real send. Nothing
   *  is recorded in the ledger, so the real send still goes out later. */
  toChannelId?: string | null;
  /** Skip the onboarding pings (weekly only). */
  weeklyOnly?: boolean;
}

export interface DigestResult {
  week: string;
  dryRun: boolean;
  sent: { coach: string; channelId: string; messages: number; kind: "weekly" | "onboarding"; creator?: string }[];
  skipped: { coach: string; reason: string }[];
  /** Coach groups the report produced that have no matching Discord category. */
  unrouted: string[];
  /** Channels created on this run. */
  createdChannels: { category: string; channelId: string }[];
}

/**
 * Find or create the report channel in every coach category. Remembered in
 * `research_coach_channels`; a channel still present in the guild under a
 * category is trusted over the table, so a manual re-create is picked up.
 */
export async function ensureCoachChannels(
  admin: SupabaseClient,
  guildId: string,
  viewerRoleNames: string[] = DEFAULT_VIEWER_ROLES
): Promise<{ byCategoryName: Map<string, { categoryId: string; channelId: string }>; created: DigestResult["createdChannels"] }> {
  const [channels, roles, me] = await Promise.all([listGuildChannels(guildId), listGuildRoles(guildId), currentBotUser()]);
  const categories = channels.filter((c) => c.type === 4 && TEAM_CATEGORY.test(c.name));
  const viewerRoles = roles.filter((r) => viewerRoleNames.includes(r.name));
  const missing = viewerRoleNames.filter((n) => !viewerRoles.some((r) => r.name === n));
  if (missing.length) throw new Error(`viewer roles not found in guild: ${missing.join(", ")}`);
  const everyone = roles.find((r) => r.name === "@everyone");
  if (!everyone) throw new Error("guild has no @everyone role?");

  const byCategoryName = new Map<string, { categoryId: string; channelId: string }>();
  const created: DigestResult["createdChannels"] = [];

  for (const category of categories) {
    let channel = channels.find((c) => c.type === 0 && c.parent_id === category.id && c.name === WEEKLY_REPORT_CHANNEL);
    if (!channel) {
      const view = (PERM.VIEW_CHANNEL | PERM.SEND_MESSAGES | PERM.READ_MESSAGE_HISTORY).toString();
      const overwrites: PermissionOverwrite[] = [
        { id: everyone.id, type: 0, allow: "0", deny: PERM.VIEW_CHANNEL.toString() },
        ...viewerRoles.map((r): PermissionOverwrite => ({ id: r.id, type: 0, allow: view, deny: "0" })),
        // The bot itself — it just denied @everyone, itself included.
        { id: me.id, type: 1, allow: view, deny: "0" },
      ];
      channel = await createTextChannel(guildId, {
        name: WEEKLY_REPORT_CHANNEL,
        parentId: category.id,
        topic: "Weekly creator performance for this team — posts vs quota, views, 30-day CPM. Coaches, Folk team and dev only.",
        overwrites,
      });
      created.push({ category: category.name, channelId: channel.id });
    }
    byCategoryName.set(category.name, { categoryId: category.id, channelId: channel.id });
    const { error } = await admin.from("research_coach_channels").upsert(
      {
        category_id: category.id,
        category_name: category.name,
        channel_id: channel.id,
        updated_at: new Date().toISOString(),
      },
      { onConflict: "category_id" }
    );
    if (error) throw new Error(`recording coach channel: ${error.message}`);
  }
  return { byCategoryName, created };
}

const weeklyKey = (categoryId: string, week: Window) => `weekly:${categoryId}:${week.start.toISOString().slice(0, 10)}`;
const onboardingKey = (creatorId: string) => `onboarding:${creatorId}`;

/** A creator whose first week closed inside the week being read. */
export function isFreshlyOnboarded(row: PerformanceRow): boolean {
  const o = row.performance.onboarding;
  return o.final && row.performance.weeksSinceJoined === 1 && o.posts > 0;
}

export async function sendCoachDigests(admin: SupabaseClient, options: DigestOptions = {}): Promise<DigestResult> {
  const week = options.week ?? lastCompleteWeek();
  const dryRun = Boolean(options.dryRun);
  const result: DigestResult = {
    week: week.start.toISOString().slice(0, 10),
    dryRun,
    sent: [],
    skipped: [],
    unrouted: [],
    createdChannels: [],
  };
  if (!discordConfigured()) throw new Error("DISCORD_BOT_TOKEN is not set");
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) throw new Error("DISCORD_GUILD_ID is not set");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://bludgc.vercel.app").replace(/\/$/, "");
  const sendNonce = Date.now().toString(36);

  const report = await loadPerformanceReport(admin, week);

  // Where each coach's digest goes. With a test-channel override we neither
  // touch the guild structure nor the ledger.
  let route = new Map<string, { categoryId: string; channelId: string }>();
  if (!options.toChannelId && !dryRun) {
    const ensured = await ensureCoachChannels(admin, guildId);
    route = ensured.byCategoryName;
    result.createdChannels = ensured.created;
  } else if (!options.toChannelId) {
    const channels = await listGuildChannels(guildId);
    for (const c of channels) if (c.type === 4 && TEAM_CATEGORY.test(c.name)) route.set(c.name, { categoryId: c.id, channelId: "(dry)" });
  }

  const { data: ledgerRows, error: ledgerError } = await admin
    .from("research_coach_digests")
    .select("dedupe_key")
    .gte("week_start", new Date(week.start.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10));
  if (ledgerError) throw new Error(`reading digest ledger: ${ledgerError.message}`);
  const sentKeys = new Set((ledgerRows ?? []).map((r: { dedupe_key: string }) => r.dedupe_key));

  const record = async (row: Record<string, unknown>) => {
    const { error } = await admin.from("research_coach_digests").insert(row);
    if (error) throw new Error(`recording digest: ${error.message}`);
  };

  for (const group of report.groups) {
    if (group.coach == null) {
      if (group.rows.length) result.unrouted.push(`(no coach) ${group.rows.length} creators`);
      continue;
    }
    const target = options.toChannelId
      ? { categoryId: `test:${group.coach}`, channelId: options.toChannelId }
      : route.get(group.coach);
    if (!target) {
      result.unrouted.push(group.coach);
      continue;
    }

    // Weekly digest.
    const key = weeklyKey(target.categoryId, week);
    if (!options.toChannelId && sentKeys.has(key)) {
      result.skipped.push({ coach: group.coach, reason: "already sent this week" });
    } else {
      // One message now, not a chunked series: the per-creator detail is a
      // rendered card, so there is nothing left to overflow into extra embeds.
      // Fresh per send, so a retry gets a URL Discord has not already cached a
      // failure against.
      const imageUrl = recapImageUrl(appUrl, group.coach, week.start, sendNonce);
      // Render it before Discord asks for it — see warmRecapImage. A cold
      // render loses the race with Discord's proxy and the card comes out as a
      // broken-image box.
      const warmed = imageUrl && !dryRun ? await warmRecapImage(imageUrl) : false;
      const payload = buildCoachRecapV2({
        coach: group.coach,
        week,
        rows: group.rows,
        appUrl,
        // Link it only once it is known to render: a URL that 404s or times
        // out would be cached as a failure by Discord against that exact URL.
        imageUrl: warmed ? imageUrl : null,
      });
      const payloads = [payload];
      if (!dryRun) {
        const ids: string[] = [];
        for (const p of payloads) ids.push(await postChannelMessage(target.channelId, p));
        if (!options.toChannelId) {
          await record({
            dedupe_key: key,
            kind: "weekly",
            category_id: target.categoryId,
            channel_id: target.channelId,
            week_start: result.week,
            message_ids: ids,
          });
        }
      }
      result.sent.push({ coach: group.coach, channelId: target.channelId, messages: payloads.length, kind: "weekly" });
    }

    // Onboarding pings — one per creator, ever.
    if (options.weeklyOnly) continue;
    for (const row of group.rows.filter(isFreshlyOnboarded)) {
      const oKey = onboardingKey(row.creatorId);
      if (!options.toChannelId && sentKeys.has(oKey)) continue;
      const payload = buildOnboardingPing(row);
      if (!dryRun) {
        const id = await postChannelMessage(target.channelId, payload);
        if (!options.toChannelId) {
          await record({
            dedupe_key: oKey,
            kind: "onboarding",
            category_id: target.categoryId,
            channel_id: target.channelId,
            week_start: result.week,
            research_creator_id: row.creatorId,
            message_ids: [id],
          });
        }
      }
      result.sent.push({ coach: group.coach, channelId: target.channelId, messages: 1, kind: "onboarding", creator: row.handle });
    }
  }
  return result;
}

/** Monday 09:00 UTC — the hourly cron checks this to send once a week. */
export function isDigestHour(now: Date = new Date()): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === 9;
}
