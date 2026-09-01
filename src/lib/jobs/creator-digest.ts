/**
 * The scheduled recaps that go to creators, in their own coaching channels.
 *
 * Two sends share this file because they share every hard part: find the
 * creator's channel, build a card, warm it, post once and never twice.
 *
 *   weekly — Mondays, the same numbers /my-stats shows
 *   daily  — each morning, the same numbers /my-day shows
 *
 * Three rules hold this together.
 *
 * **The creator is pinged; nobody else is.** `allowed_mentions.users` names
 * exactly one id. These messages exist to be noticed by one person, and a
 * roster-wide send with an open mentions policy is one stray `@everyone` in a
 * creator's display name away from notifying the whole server.
 *
 * **A send is ledgered before it can repeat.** The key is computed from the
 * creator and the period, so a retried cron, a double deploy or a manual
 * re-run all collapse to one message.
 *
 * **It is off unless someone turned it on.** Both flags default false in the
 * database. A deploy cannot start notifying forty people by itself.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { listGuildMembers, postChannelMessage } from "@/lib/discord";
import { loadCreatorStats } from "@/lib/jobs/creator-stats";
import { loadDailyRecap } from "@/lib/jobs/daily-recap";
import { diagnose, cpmNote } from "@/lib/creator-coaching";
import { creatorCardUrl, myCardUrl, dailyCardUrl, warmRecapImage } from "@/lib/recap-image-url";
import { QUOTA_POSTS_PER_WEEK, lastCompleteWeek, weekKey, type Window } from "@/lib/performance";
import { formatCompact, formatUsd } from "@/lib/format";
import { isArchived, isParkedCategory } from "@/lib/roster-archive";

export interface CreatorSendResult {
  sent: { handle: string; channelId: string; kind: string; messageId: string }[];
  skipped: { handle: string; reason: string }[];
  failed: { handle: string; error: string }[];
  disabled?: true;
}

const empty = (): CreatorSendResult => ({ sent: [], skipped: [], failed: [] });

/** 13:00 UTC — 9am ET. Chosen so it lands before creators film, with
 *  yesterday's numbers fully settled. */
export const DAILY_HOUR_UTC = 13;
/** Monday 09:00 UTC, the same tick the coach digests already use. */
export const WEEKLY_HOUR_UTC = 9;

export function isCreatorDailyHour(now: Date = new Date()): boolean {
  return now.getUTCHours() === DAILY_HOUR_UTC;
}

export function isCreatorWeeklyHour(now: Date = new Date()): boolean {
  return now.getUTCDay() === 1 && now.getUTCHours() === WEEKLY_HOUR_UTC;
}

const weeklyKey = (creatorId: string, week: Window) =>
  `creator-weekly:${creatorId}:${weekKey(week)}`;
const dailyKey = (creatorId: string, day: string) => `creator-daily:${creatorId}:${day}`;

interface Target {
  creatorId: string;
  handle: string;
  discordUserId: string;
  channelId: string;
}

/** Discord ids currently in the guild, or null when the lookup failed.
 *
 *  A stored discord_user_id can outlive the account's membership — the person
 *  left, or was removed. Pinging that id renders as a literal `@unknown-user`
 *  in the channel (seen live), which looks broken to everyone reading, and the
 *  message is pointless anyway: someone who left cannot see the channel.
 *
 *  Null rather than an empty set on failure, so a Discord hiccup degrades to
 *  "send to everyone" instead of silently sending to nobody. */
async function guildMemberIds(): Promise<Set<string> | null> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;
  try {
    return new Set((await listGuildMembers(guildId)).map((m) => m.user.id));
  } catch {
    return null;
  }
}

export interface EligibilityInput {
  creators: {
    id: string;
    handle: string;
    discord_user_id: string | null;
    archived_at: string | null;
  }[];
  channels: { channel_id: string; research_creator_id: string | null; category: string | null }[];
  /** Discord ids currently in the guild, or null when the lookup failed. */
  memberIds: Set<string> | null;
}

/**
 * The send gate, pure so it can be tested without a database.
 *
 * Eligible means: on the roster, still working with us, with a linked
 * Discord account AND a live channel to post into. Any of those missing is
 * a skip with a reason, never a guess — posting someone's earnings into the
 * wrong channel is unrecoverable.
 *
 * Two independent things mean "we stopped working with this creator", and a
 * send has to honour both: `archived_at`, set in the app, and the
 * "Not Creating 🚫" Discord category, set by `/offboard` moving the channel.
 * Gating on the flag alone is what pinged six cut creators with a daily recap
 * on 2026-09-01 — their channels had moved months earlier and nothing had
 * written the flag.
 *
 * A creator holding BOTH a parked channel and a live team channel is not
 * parked: the team channel is the current one and the parked row is the old
 * channel left behind, exactly as `loadPerformanceReport` reads it.
 */
export function sendEligibility(input: EligibilityInput): {
  targets: Target[];
  skipped: CreatorSendResult["skipped"];
} {
  const liveByCreator = new Map<string, string>();
  const parkedCreators = new Set<string>();
  for (const c of input.channels) {
    if (!c.research_creator_id) continue;
    if (isParkedCategory(c.category)) {
      parkedCreators.add(c.research_creator_id);
      continue;
    }
    if (!liveByCreator.has(c.research_creator_id)) {
      liveByCreator.set(c.research_creator_id, c.channel_id);
    }
  }

  const targets: Target[] = [];
  const skipped: CreatorSendResult["skipped"] = [];
  for (const c of input.creators) {
    const handle = c.handle;
    if (isArchived(c)) {
      skipped.push({ handle, reason: "archived" });
      continue;
    }
    if (!c.discord_user_id) {
      skipped.push({ handle, reason: "no linked Discord account" });
      continue;
    }
    const channelId = liveByCreator.get(c.id);
    if (!channelId) {
      skipped.push({
        handle,
        reason: parkedCreators.has(c.id) ? "parked in Not Creating" : "no tracked coaching channel",
      });
      continue;
    }
    if (input.memberIds && !input.memberIds.has(c.discord_user_id)) {
      skipped.push({ handle, reason: "no longer in the server" });
      continue;
    }
    targets.push({
      creatorId: c.id,
      handle,
      discordUserId: c.discord_user_id,
      channelId,
    });
  }
  return { targets, skipped };
}

async function targets(
  admin: SupabaseClient,
  memberIds: Set<string> | null
): Promise<{ targets: Target[]; skipped: CreatorSendResult["skipped"] }> {
  const { data: creators, error } = await admin
    .from("research_creators")
    .select("id, handle, discord_user_id::text, archived_at")
    .eq("platform", "instagram")
    .eq("kind", "roster")
    .limit(1000);
  if (error) throw new Error(`loading creators: ${error.message}`);

  // `category` is not decoration: it is the only place `/offboard` records
  // that we cut someone, so it has to come back with the channel.
  const { data: channels } = await admin
    .from("research_discord_channels")
    .select("channel_id::text, research_creator_id, category")
    .eq("is_tracked", true)
    .limit(1000);

  return sendEligibility({
    creators: (creators ?? []) as EligibilityInput["creators"],
    channels: (channels ?? []) as EligibilityInput["channels"],
    memberIds,
  });
}

async function ledgerKeys(admin: SupabaseClient, kind: string): Promise<Set<string>> {
  const { data } = await admin
    .from("research_coach_digests")
    .select("dedupe_key")
    .eq("kind", kind)
    .order("week_start", { ascending: false })
    .limit(5000);
  return new Set((data ?? []).map((r: { dedupe_key: string }) => r.dedupe_key));
}

/** One creator, one ping, nobody else. */
const payloadFor = (content: string, embed: object, discordUserId: string) => ({
  content,
  embeds: [embed],
  allowed_mentions: { parse: [], users: [discordUserId] },
});

async function enabled(admin: SupabaseClient, column: string): Promise<boolean> {
  const { data } = await admin.from("research_settings").select(column).eq("id", true).maybeSingle();
  return !!(data as Record<string, unknown> | null)?.[column];
}

export async function sendCreatorWeekly(
  admin: SupabaseClient,
  options: { dryRun?: boolean; toChannelId?: string | null; force?: boolean; limit?: number } = {}
): Promise<CreatorSendResult> {
  if (!options.force && !(await enabled(admin, "creator_weekly_enabled"))) {
    return { ...empty(), disabled: true };
  }
  const result = empty();
  const week = lastCompleteWeek();
  const { targets: all, skipped } = await targets(admin, await guildMemberIds());
  const list = options.limit ? all.slice(0, options.limit) : all;
  result.skipped.push(...skipped);
  const sentKeys = await ledgerKeys(admin, "creator-weekly");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://bludgc.vercel.app").replace(/\/$/, "");
  const nonce = Date.now().toString(36);

  for (const t of list) {
    const key = weeklyKey(t.creatorId, week);
    if (!options.toChannelId && sentKeys.has(key)) {
      result.skipped.push({ handle: t.handle, reason: "already sent this week" });
      continue;
    }
    try {
      const row = await loadCreatorStats(admin, t.handle, week.start);
      if (!row) {
        result.skipped.push({ handle: t.handle, reason: "no stats" });
        continue;
      }
      const coaching = diagnose(row.stats);
      const s = row.stats;
      const url = myCardUrl(appUrl, t.handle, week.start, nonce);
      const imageUrl = url && !options.dryRun && (await warmRecapImage(url)) ? url : null;
      const note = cpmNote(
        s.money.cpm30.cpm,
        s.money.cpm30.projected,
        s.money.cpm30.settledWindow,
        s.current.posts > 0
      );
      const embed: Record<string, unknown> = {
        title: `📊 Your week — ${weekKey(week)}`,
        description: [coaching.creator, note ? `-# ${note}` : ""].filter(Boolean).join("\n"),
        color: coaching.tone === "good" ? 0x3ba55d : coaching.tone === "neutral" ? 0x5865f2 : 0xe8b339,
        fields: [
          { name: "Posts", value: `**${s.current.posts}**/${QUOTA_POSTS_PER_WEEK}`, inline: true },
          {
            name: "Avg views",
            value: `**${s.current.posts ? formatCompact(Math.round(s.current.avgViews ?? 0)) : "—"}**`,
            inline: true,
          },
          { name: "Earned", value: `**${formatUsd(s.money.earnedUsd)}**`, inline: true },
        ],
        footer: { text: "your week in review · Instagram · run /my-stats any time" },
      };
      if (imageUrl) embed.image = { url: imageUrl };

      if (!options.dryRun) {
        const id = await postChannelMessage(
          options.toChannelId || t.channelId,
          payloadFor(`<@${t.discordUserId}> here's your week 👇`, embed, t.discordUserId)
        );
        if (!options.toChannelId) {
          await admin.from("research_coach_digests").insert({
            dedupe_key: key,
            kind: "creator-weekly",
            channel_id: t.channelId,
            week_start: weekKey(week),
            research_creator_id: t.creatorId,
            message_ids: [id],
          });
        }
        result.sent.push({ handle: t.handle, channelId: t.channelId, kind: "weekly", messageId: id });
      } else {
        result.sent.push({ handle: t.handle, channelId: t.channelId, kind: "weekly", messageId: "(dry)" });
      }
    } catch (error) {
      result.failed.push({ handle: t.handle, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}

export async function sendCreatorDaily(
  admin: SupabaseClient,
  options: { dryRun?: boolean; toChannelId?: string | null; force?: boolean; limit?: number } = {}
): Promise<CreatorSendResult> {
  if (!options.force && !(await enabled(admin, "creator_daily_enabled"))) {
    return { ...empty(), disabled: true };
  }
  const result = empty();
  const { targets: all, skipped } = await targets(admin, await guildMemberIds());
  const list = options.limit ? all.slice(0, options.limit) : all;
  result.skipped.push(...skipped);
  const sentKeys = await ledgerKeys(admin, "creator-daily");
  const appUrl = (process.env.NEXT_PUBLIC_APP_URL ?? "https://bludgc.vercel.app").replace(/\/$/, "");
  const nonce = Date.now().toString(36);

  for (const t of list) {
    try {
      const row = await loadDailyRecap(admin, t.discordUserId);
      if (!row) {
        result.skipped.push({ handle: t.handle, reason: "no stats" });
        continue;
      }
      const r = row.recap;
      const day = r.day.toISOString().slice(0, 10);
      const key = dailyKey(t.creatorId, day);
      if (!options.toChannelId && sentKeys.has(key)) {
        result.skipped.push({ handle: t.handle, reason: "already sent today" });
        continue;
      }

      // A day with nothing to report is not worth a notification. Silence
      // keeps the ones that DO fire meaningful.
      if (r.viewsAdded === 0 && r.postedThatDay.length === 0 && r.pace.postsThisWeek === 0) {
        result.skipped.push({ handle: t.handle, reason: "nothing happened" });
        continue;
      }

      const remaining = Math.max(QUOTA_POSTS_PER_WEEK - r.pace.postsThisWeek, 0);
      const message =
        remaining === 0
          ? "Target already hit this week — everything from here is upside."
          : `${remaining} to go with ${r.pace.daysLeft} day${r.pace.daysLeft === 1 ? "" : "s"} left — about ${r.pace.perDayNeeded} a day gets you there.`;
      const url = dailyCardUrl(appUrl, t.discordUserId, day, nonce);
      const imageUrl = url && !options.dryRun && (await warmRecapImage(url)) ? url : null;

      const embed: Record<string, unknown> = {
        title: `☀️ Your day — ${day}`,
        description: message,
        color: r.pace.onTrack ? 0x3ba55d : 0xe8b339,
        fields: [
          { name: "Views added", value: `**${formatCompact(r.viewsAdded)}**`, inline: true },
          { name: "Posted", value: `**${r.postedThatDay.length}**`, inline: true },
          {
            name: "Streak",
            value: r.streakDays ? `**${r.streakDays}d**` : "—",
            inline: true,
          },
          {
            name: "Week so far",
            value: `**${r.pace.postsThisWeek}**/${QUOTA_POSTS_PER_WEEK}`,
            inline: true,
          },
        ],
        footer: { text: "yesterday's numbers · Instagram · run /my-day any time" },
      };
      if (imageUrl) embed.image = { url: imageUrl };

      if (!options.dryRun) {
        const id = await postChannelMessage(
          options.toChannelId || t.channelId,
          payloadFor(`<@${t.discordUserId}> ☀️`, embed, t.discordUserId)
        );
        if (!options.toChannelId) {
          await admin.from("research_coach_digests").insert({
            dedupe_key: key,
            kind: "creator-daily",
            channel_id: t.channelId,
            week_start: day,
            research_creator_id: t.creatorId,
            message_ids: [id],
          });
        }
        result.sent.push({ handle: t.handle, channelId: t.channelId, kind: "daily", messageId: id });
      } else {
        result.sent.push({ handle: t.handle, channelId: t.channelId, kind: "daily", messageId: "(dry)" });
      }
    } catch (error) {
      result.failed.push({ handle: t.handle, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return result;
}
