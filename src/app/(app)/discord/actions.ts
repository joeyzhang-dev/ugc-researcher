"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { parseCreatorInput } from "@/lib/creator-input";

const fail = (m: string): never => redirect(`/discord?error=${encodeURIComponent(m)}`);

/** Manually link a coaching channel to a roster creator — for the channels
 *  the worker's discover step can't match by name (new creators, emoji
 *  variants). Accepts an existing roster handle OR a brand-new Instagram
 *  handle / profile URL: a new one gets a roster row + Folk membership and
 *  joins the scrape queue. Discover preserves manual links, so this sticks. */
export async function linkChannelToCreator(formData: FormData) {
  await requireAdmin();
  const channelId = String(formData.get("channelId") ?? "");
  const input = String(formData.get("creator") ?? "").trim();
  if (!/^\d+$/.test(channelId)) fail("Bad channel id.");
  if (!input) fail("Type an Instagram handle (or pick a suggestion) to link.");
  const admin = createAdminClient();

  const { data: channel } = await admin
    .from("research_discord_channels")
    .select("channel_id::text, channel_name, niche")
    .eq("channel_id", channelId)
    .maybeSingle();
  if (!channel) fail("Channel not found.");

  const parsed = parseCreatorInput(input);
  if (!parsed) fail("That doesn't look like an Instagram/TikTok handle or URL.");

  // Existing roster creator wins; otherwise create one (pending, queued for
  // the next scrape run) — same shape addRosterCreator produces.
  const { data: existing } = await admin
    .from("research_creators")
    .select("id, kind")
    .eq("platform", parsed!.platform)
    .eq("handle", parsed!.handle)
    .maybeSingle();

  let creatorId: string;
  if (existing) {
    creatorId = existing.id;
    if (existing.kind !== "roster") {
      // A studied outside profile being claimed as ours — promote it.
      await admin.from("research_creators").update({ kind: "roster" }).eq("id", creatorId);
    }
  } else {
    const { data: created, error: createError } = await admin
      .from("research_creators")
      .insert({
        platform: parsed!.platform,
        handle: parsed!.handle,
        kind: "roster",
        status: "pending",
        scrape_queued_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (createError) fail(createError.message);
    creatorId = created!.id;
  }

  // Folk membership so the creator shows up in the workspace; niche comes
  // from the channel's category when the membership doesn't carry one yet.
  const { data: folk } = await admin
    .from("research_apps")
    .select("id")
    .eq("name", "Folk")
    .maybeSingle();
  if (folk) {
    await admin
      .from("research_app_creators")
      .upsert(
        { app_id: folk.id, research_creator_id: creatorId, niche: channel!.niche },
        { onConflict: "app_id,research_creator_id", ignoreDuplicates: true }
      );
    if (channel!.niche) {
      await admin
        .from("research_app_creators")
        .update({ niche: channel!.niche })
        .eq("app_id", folk.id)
        .eq("research_creator_id", creatorId)
        .is("niche", null);
    }
  }

  const { error: linkError } = await admin
    .from("research_discord_channels")
    .update({ research_creator_id: creatorId })
    .eq("channel_id", channelId);
  if (linkError) fail(linkError.message);

  revalidatePath("/discord");
  revalidatePath("/creators");
}
