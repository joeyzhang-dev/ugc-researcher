"use server";

import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordConfigured, postChannelMessage } from "@/lib/discord";
import type { SendReport } from "./send-actions";
import { isChannelTarget } from "@/lib/send-targets";

/** Discord's message cap is 2000; leave headroom for the 📣 and the mention. */
const MAX_ANNOUNCEMENT_CHARS = 1800;

function announcementPayload(message: string, discordUserId: string | null) {
  return {
    content: `📣 ${message}${discordUserId ? `\n\n<@${discordUserId}>` : ""}`,
    allowed_mentions: discordUserId ? { users: [discordUserId] } : { parse: [] as string[] },
  };
}

/**
 * Post an announcement into each picked creator's channel, tagging the
 * creator. Same targeting as script sends (creator → linked channel), but a
 * plain message: nothing is recorded in the database.
 */
export async function sendAnnouncement(input: {
  message: string;
  creatorIds: string[];
}): Promise<SendReport> {
  await requireAdmin();
  if (!discordConfigured()) {
    return { results: [], error: "DISCORD_BOT_TOKEN is not set — add it and retry." };
  }
  const message = input.message.trim();
  if (!message) return { results: [], error: "Write the announcement first." };
  if (message.length > MAX_ANNOUNCEMENT_CHARS) {
    return { results: [], error: `Announcements cap at ${MAX_ANNOUNCEMENT_CHARS} characters (this one is ${message.length}).` };
  }
  const picked = [...new Set(input.creatorIds)].filter(Boolean);
  // Same guard as the script send: a bare channel is not a creator.
  const creatorIds = picked.filter((id) => !isChannelTarget(id));
  if (creatorIds.length !== picked.length) {
    return {
      results: [],
      error: "Some picked channels aren't linked to a creator yet — run /link in their channel first.",
    };
  }
  if (!creatorIds.length) return { results: [], error: "Pick at least one creator." };

  const db = createAdminClient();
  const [{ data: creatorsData }, { data: channelsData }] = await Promise.all([
    // ::text keeps the snowflake exact — as a JS number it rounds past 2^53.
    db.from("research_creators").select("id, handle, discord_user_id::text").in("id", creatorIds),
    db
      .from("research_discord_channels")
      .select("channel_id::text, research_creator_id")
      .in("research_creator_id", creatorIds)
      .eq("is_tracked", true),
  ]);
  const creators = (creatorsData ?? []) as {
    id: string;
    handle: string;
    discord_user_id: string | null;
  }[];
  const channelByCreator = new Map(
    ((channelsData ?? []) as { channel_id: string; research_creator_id: string | null }[])
      .filter((c) => c.research_creator_id)
      .map((c) => [c.research_creator_id!, String(c.channel_id)])
  );

  const results: SendReport["results"] = [];
  for (const creator of creators) {
    const channelId = channelByCreator.get(creator.id);
    if (!channelId) {
      results.push({ creatorId: creator.id, handle: creator.handle, ok: false, sent: 0, alreadySent: 0, error: "No linked Discord channel" });
      continue;
    }
    try {
      await postChannelMessage(channelId, announcementPayload(message, creator.discord_user_id));
      results.push({ creatorId: creator.id, handle: creator.handle, ok: true, sent: 1, alreadySent: 0 });
    } catch (e) {
      results.push({
        creatorId: creator.id,
        handle: creator.handle,
        ok: false,
        sent: 0,
        alreadySent: 0,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return { results };
}

/** Preview in the private test channel — no creators, no pings. */
export async function sendAnnouncementTest(message: string): Promise<SendReport> {
  await requireAdmin();
  if (!discordConfigured()) {
    return { results: [], error: "DISCORD_BOT_TOKEN is not set — add it and retry." };
  }
  const channelId = process.env.DISCORD_TEST_CHANNEL_ID;
  if (!channelId) {
    return { results: [], error: "DISCORD_TEST_CHANNEL_ID is not set — point it at #script-send-test." };
  }
  const trimmed = message.trim();
  if (!trimmed) return { results: [], error: "Write the announcement first." };
  try {
    await postChannelMessage(channelId, {
      content: `-# 🧪 Test announcement — not sent to creators\n📣 ${trimmed}`,
      allowed_mentions: { parse: [] },
    });
    return { results: [{ creatorId: "test", handle: "script-send-test", ok: true, sent: 1, alreadySent: 0 }] };
  } catch (e) {
    return {
      results: [{
        creatorId: "test",
        handle: "script-send-test",
        ok: false,
        sent: 0,
        alreadySent: 0,
        error: e instanceof Error ? e.message : String(e),
      }],
    };
  }
}
