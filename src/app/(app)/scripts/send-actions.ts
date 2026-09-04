"use server";

import { revalidatePath } from "next/cache";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordConfigured, postChannelMessage } from "@/lib/discord";
import { buildScriptPage, testSendContent, type SendableScript } from "@/lib/discord-send";
import { resolveInspoVideoUrl } from "@/lib/inspo-media";
import { isChannelTarget } from "@/lib/send-targets";
import { listFormatChannels } from "@/lib/format-channels";
import { assignScriptNumbers } from "./doc";
import type { ResearchScript, ResearchScriptPost } from "@/lib/types";

/** Canonical #N for every script (Doc position within week+niche) — computed
 *  over the WHOLE table so a subset send still carries the real numbers. */
async function scriptNumbering(db: ReturnType<typeof createAdminClient>) {
  const { data } = await db.from("research_scripts").select("id, niche, created_at");
  return assignScriptNumbers(
    ((data ?? []) as { id: string; niche: string | null; created_at: string }[]).map((s) => ({
      id: s.id,
      niche: s.niche,
      createdAt: s.created_at,
    }))
  );
}

/** Resolve each first-page inspo video once per batch, not once per creator.
 *  The result is a permanent public storage URL the card references — no
 *  Discord uploads anywhere in the send path. */
function inspoCache() {
  const cache = new Map<string, Promise<string | null>>();
  return (script: SendableScript): Promise<string | null> => {
    if (!script.inspoUrl) return Promise.resolve(null);
    if (!cache.has(script.id)) {
      cache.set(script.id, resolveInspoVideoUrl(script.inspoUrl));
    }
    return cache.get(script.id)!;
  };
}

/** Post one page (V2 card) — pure JSON; the gallery references the video by
 *  public URL, or the card carries a plain link line when none resolved. */
function postPage(
  channelId: string,
  scripts: SendableScript[],
  index: number,
  opts: {
    videoUrl: string | null;
    testMarker?: string;
    viewAllUrl?: string | null;
    header?: string | null;
    paged?: boolean;
    /** Whitelists exactly this user for the header's ping. */
    mentionUserId?: string | null;
  }
): Promise<string> {
  return postChannelMessage(channelId, {
    ...buildScriptPage(scripts, index, opts),
    allowed_mentions: opts.mentionUserId ? { users: [opts.mentionUserId] } : { parse: [] },
  });
}

const toSendable = (s: ResearchScript): SendableScript => ({
  id: s.id,
  hook: s.hook,
  body: s.body,
  inspoUrl: s.inspo_url,
  demo: s.demo,
  songs: s.songs,
  niche: s.niche,
});

export interface CreatorSendResult {
  creatorId: string;
  handle: string;
  ok: boolean;
  /** Scripts actually delivered in this send (batch minus already-sent). */
  sent: number;
  /** Scripts skipped because this creator already received them. */
  alreadySent: number;
  error?: string;
}

export interface SendReport {
  results: CreatorSendResult[];
  /** Setup-level failure (bad input, missing token) — nothing was sent. */
  error?: string;
}

/**
 * Deliver a batch of scripts to each selected creator's Discord channel.
 *
 * One paged message per creator (page 0 posted here; the gateway bot answers
 * the nav buttons). The assignment row is the send record: existing rows keep
 * their status and merely learn the message id, new ones start Assigned.
 * A creator is never sent the same script twice — re-sends are skipped
 * per script, and a creator whose whole batch was already sent is a no-op.
 */
export async function sendScripts(input: {
  scriptIds: string[];
  creatorIds: string[];
}): Promise<SendReport> {
  await requireAdmin();
  if (!discordConfigured()) {
    return { results: [], error: "DISCORD_BOT_TOKEN is not set in .env.local — add it (same token the worker bot uses) and retry." };
  }
  const scriptIds = [...new Set(input.scriptIds)].filter(Boolean);
  const picked = [...new Set(input.creatorIds)].filter(Boolean);
  // A `channel:` target is a Discord channel with no creator row behind it —
  // the picker renders those un-pickable, and an assignment cannot reference
  // one, so refuse rather than let the pseudo-id reach a uuid column.
  const creatorIds = picked.filter((id) => !isChannelTarget(id));
  if (creatorIds.length !== picked.length) {
    return {
      results: [],
      error: "Some picked channels aren't linked to a creator yet — run /link in their channel first.",
    };
  }
  if (!scriptIds.length || !creatorIds.length) {
    return { results: [], error: "Pick at least one script and one creator." };
  }

  const db = createAdminClient();
  const [{ data: scriptsData }, { data: creatorsData }, { data: channelsData }, { data: assignmentsData }] =
    await Promise.all([
      db.from("research_scripts").select("*").in("id", scriptIds),
      // ::text keeps the snowflake exact — as a JS number it rounds past
      // 2^53 and the header pings a user id that doesn't exist.
      db.from("research_creators").select("id, handle, discord_user_id::text").in("id", creatorIds),
      db
        .from("research_discord_channels")
        .select("channel_id::text, research_creator_id")
        .in("research_creator_id", creatorIds)
        .eq("is_tracked", true),
      db
        .from("research_script_assignments")
        .select("id, script_id, research_creator_id, discord_message_id")
        .in("script_id", scriptIds)
        .in("research_creator_id", creatorIds),
    ]);

  // Doc order: Script 1 is the oldest, same numbering the Doc view shows.
  const scripts = ((scriptsData ?? []) as ResearchScript[])
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const creators = (creatorsData ?? []) as {
    id: string;
    handle: string;
    discord_user_id: string | null;
  }[];
  const handleById = new Map(creators.map((c) => [c.id, c.handle]));
  const discordIdById = new Map(creators.map((c) => [c.id, c.discord_user_id]));
  const channelByCreator = new Map(
    ((channelsData ?? []) as { channel_id: string; research_creator_id: string | null }[])
      .filter((c) => c.research_creator_id)
      .map((c) => [c.research_creator_id!, String(c.channel_id)])
  );
  const assignments = (assignmentsData ?? []) as {
    id: string;
    script_id: string;
    research_creator_id: string;
    discord_message_id: string | null;
  }[];
  const numbering = await scriptNumbering(db);
  const assignmentFor = (creatorId: string, scriptId: string) =>
    assignments.find((a) => a.research_creator_id === creatorId && a.script_id === scriptId);

  const results: CreatorSendResult[] = [];
  const inspoFor = inspoCache();
  for (const creatorId of creatorIds) {
    const handle = handleById.get(creatorId) ?? creatorId;
    const channelId = channelByCreator.get(creatorId);
    if (!channelId) {
      results.push({ creatorId, handle, ok: false, sent: 0, alreadySent: 0, error: "No linked Discord channel" });
      continue;
    }

    const alreadySent = scripts.filter((s) => assignmentFor(creatorId, s.id)?.discord_message_id);
    const batch = scripts.filter((s) => !assignmentFor(creatorId, s.id)?.discord_message_id);
    if (!batch.length) {
      results.push({ creatorId, handle, ok: true, sent: 0, alreadySent: alreadySent.length });
      continue;
    }

    const sendable: SendableScript[] = batch.map((s) => ({
      ...toSendable(s),
      number: numbering.get(s.id) ?? null,
    }));

    try {
      const discordUserId = discordIdById.get(creatorId);
      // First line doubles as the push-notification preview on their phone.
      const header = `📗 New scripts for Folk${discordUserId ? ` — <@${discordUserId}>` : ""}`;
      // The whole batch lands as consecutive cards — one message per script,
      // nothing to page through. Header + ping ride the first card only, and
      // each assignment is recorded right after its card posts so a mid-batch
      // failure leaves accurate records (the dedupe skips them on retry).
      for (let i = 0; i < sendable.length; i++) {
        const messageId = await postPage(channelId, sendable, i, {
          videoUrl: await inspoFor(sendable[i]),
          paged: false,
          header: i === 0 ? header : null,
          mentionUserId: i === 0 ? discordUserId : null,
        });
        const sentAt = new Date().toISOString();
        const s = batch[i];
        const existing = assignmentFor(creatorId, s.id);
        const sendCols = {
          discord_channel_id: channelId,
          discord_message_id: messageId,
          sent_at: sentAt,
        };
        const { error } = existing
          ? await db.from("research_script_assignments").update(sendCols).eq("id", existing.id)
          : await db.from("research_script_assignments").insert({
              script_id: s.id,
              research_creator_id: creatorId,
              status: "Assigned",
              assigned_at: sentAt,
              ...sendCols,
            });
        if (error) throw new Error(`sent, but recording the assignment failed: ${error.message}`);
      }
      results.push({ creatorId, handle, ok: true, sent: batch.length, alreadySent: alreadySent.length });
    } catch (e) {
      results.push({
        creatorId,
        handle,
        ok: false,
        sent: 0,
        alreadySent: alreadySent.length,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  revalidatePath("/scripts");
  return { results };
}

/**
 * Post the batch to the private #script-send-test channel, exactly as a
 * creator would receive it — except a subtext line labels it a test and
 * carries the script ids for the pager, because a test send writes NOTHING
 * to the database (no assignments, no dedupe, no stats).
 */
export async function sendScriptsTest(scriptIds: string[]): Promise<SendReport> {
  await requireAdmin();
  if (!discordConfigured()) {
    return { results: [], error: "DISCORD_BOT_TOKEN is not set in .env.local — add it and retry." };
  }
  const channelId = process.env.DISCORD_TEST_CHANNEL_ID;
  if (!channelId) {
    return { results: [], error: "DISCORD_TEST_CHANNEL_ID is not set in .env.local — point it at #script-send-test." };
  }
  const ids = [...new Set(scriptIds)].filter(Boolean);
  if (!ids.length) return { results: [], error: "Pick at least one script." };

  const { data } = await createAdminClient().from("research_scripts").select("*").in("id", ids);
  const scripts = ((data ?? []) as ResearchScript[])
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  if (!scripts.length) return { results: [], error: "Those scripts weren't found." };

  try {
    const numbering = await scriptNumbering(createAdminClient());
    const sendable = scripts.map((s) => ({
      ...toSendable(s),
      number: numbering.get(s.id) ?? null,
    }));
    // Same shape as a real send: consecutive cards, marker on the first.
    const inspoFor = inspoCache();
    for (let i = 0; i < sendable.length; i++) {
      await postPage(channelId, sendable, i, {
        videoUrl: await inspoFor(sendable[i]),
        paged: false,
        testMarker: i === 0 ? testSendContent(scripts.map((s) => s.id)) : undefined,
      });
    }
    return {
      results: [{ creatorId: "test", handle: "script-send-test", ok: true, sent: scripts.length, alreadySent: 0 }],
    };
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

export interface ChannelSendReport {
  channel: string;
  /** Cards actually posted in this run. */
  posted: number;
  /** Skipped because this script is already in this channel. */
  alreadyPosted: number;
  /**
   * Script ids whose card posted to Discord but whose research_script_posts
   * row failed to write for a reason other than "already published here"
   * (23505 — see below). Each one is a live card the dedupe `already` set
   * cannot see, so a retry of this batch will post it again as a genuine
   * second card. Reconciling an unrecorded id (find the card, insert the
   * missing row by hand) is a manual step; nothing here does it for you.
   */
  unrecorded: string[];
  error?: string;
}

/**
 * Publish a batch of scripts to one format channel.
 *
 * No creator loop, no assignments, no ping: the card is a library entry, and
 * whoever wants it takes it. The research_script_posts row is the record, and
 * its unique index is the dedupe — re-running is a no-op per script.
 */
export async function sendScriptsToChannel(input: {
  scriptIds: string[];
  channelId: string;
}): Promise<ChannelSendReport> {
  await requireAdmin();
  if (!discordConfigured()) {
    return { channel: input.channelId, posted: 0, alreadyPosted: 0, unrecorded: [],
      error: "DISCORD_BOT_TOKEN is not set in .env.local — add it and retry." };
  }
  const scriptIds = [...new Set(input.scriptIds)].filter(Boolean);
  if (!scriptIds.length || !input.channelId) {
    return { channel: input.channelId, posted: 0, alreadyPosted: 0, unrecorded: [],
      error: "Pick at least one script and a channel." };
  }

  const channels = await listFormatChannels();
  const channel = channels.find((c) => c.id === input.channelId);
  if (!channel) {
    return { channel: input.channelId, posted: 0, alreadyPosted: 0, unrecorded: [],
      error: "That channel isn't under the scripts / formats category any more." };
  }

  const db = createAdminClient();
  const [{ data: scriptsData }, { data: postedData }] = await Promise.all([
    db.from("research_scripts").select("*").in("id", scriptIds),
    // ::text — a snowflake read as a JS number rounds past 2^53 and would
    // compare unequal to the id we are about to post to.
    db
      .from("research_script_posts")
      .select("script_id, discord_channel_id::text")
      .in("script_id", scriptIds),
  ]);

  const already = new Set(
    ((postedData ?? []) as Pick<ResearchScriptPost, "script_id" | "discord_channel_id">[])
      .filter((p) => String(p.discord_channel_id) === input.channelId)
      .map((p) => p.script_id)
  );
  const scripts = ((scriptsData ?? []) as ResearchScript[])
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
  const batch = scripts.filter((s) => !already.has(s.id));
  if (!batch.length) {
    return { channel: channel.name, posted: 0, alreadyPosted: scripts.length, unrecorded: [] };
  }

  const numbering = await scriptNumbering(db);
  const sendable: SendableScript[] = batch.map((s) => ({
    ...toSendable(s),
    number: numbering.get(s.id) ?? null,
  }));

  const inspoFor = inspoCache();
  let posted = 0;
  const unrecorded: string[] = [];
  try {
    for (let i = 0; i < sendable.length; i++) {
      // No header and no mention: a library entry pings nobody.
      const messageId = await postPage(input.channelId, sendable, i, {
        videoUrl: await inspoFor(sendable[i]),
        paged: false,
        header: null,
        mentionUserId: null,
      });
      const { error } = await db.from("research_script_posts").insert({
        script_id: batch[i].id,
        discord_channel_id: input.channelId,
        channel_label: channel.name,
        discord_message_id: messageId,
        posted_at: new Date().toISOString(),
      });
      if (error && error.code !== "23505") {
        // Not "already published here" (that's 23505, handled below) — the
        // row genuinely failed to write, so the card that's live in Discord
        // right now has no record at all. Throwing here would abandon every
        // later script in the batch with nothing to show for it beyond one
        // error message, so instead note the id as unrecorded and keep
        // going; the rest of the batch is unrelated to why this one insert
        // failed.
        unrecorded.push(batch[i].id);
      }
      // 23505 means it was already published here — the card is a duplicate we
      // just posted, but the record stands; do not fail the batch over it.
      posted++;
    }
  } catch (e) {
    // Only postPage (the Discord call) throws past this point — nothing was
    // posted for this script, so the rest of the batch is genuinely unsafe
    // to continue and aborting here (unlike an insert failure, above) is
    // correct.
    return {
      channel: channel.name, posted, alreadyPosted: already.size, unrecorded,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  revalidatePath("/scripts");
  return { channel: channel.name, posted, alreadyPosted: already.size, unrecorded };
}
