"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { discordConfigured, listGuildChannels, renameChannel } from "@/lib/discord";
import { normalizeNicheEmoji, planNicheChannelRenames } from "@/lib/niche-channel-rename";

/** Pages that render a niche pill or the manager itself. */
const NICHE_PATHS = ["/settings", "/discord", "/scripts"];
const revalidateNichePaths = () => NICHE_PATHS.forEach((p) => revalidatePath(p));

const clean = (v: FormDataEntryValue | null) => String(v ?? "").trim();

/** An emoji with every space removed, not merely trimmed — see
 *  normalizeNicheEmoji: interior whitespace is what lets a row evade the
 *  emoji-base unique index while colliding in track_bases(). */
const cleanEmoji = (v: FormDataEntryValue | null) => normalizeNicheEmoji(clean(v));

export async function createNiche(formData: FormData) {
  await requireAdmin();
  const name = clean(formData.get("name"));
  if (!name) return;
  const emoji = cleanEmoji(formData.get("emoji")) || null;
  const roleId = clean(formData.get("discordRoleId")) || null;

  const { error } = await createAdminClient().from("research_niches").insert({
    name,
    emoji,
    discord_role_id: roleId,
  });
  if (error) throw new Error(`adding niche: ${error.message}`);
  revalidateNichePaths();
}

export async function updateNiche(formData: FormData) {
  await requireAdmin();
  const id = clean(formData.get("id"));
  const originalName = clean(formData.get("originalName"));
  const name = clean(formData.get("name"));
  if (!id || !name) return;
  const admin = createAdminClient();

  // A rename has to move the rows carrying the old string too, or it
  // manufactures the orphan that stranded Finance General. rename_niche does
  // all four updates in one transaction and renames the niche row itself, so
  // it is the whole write when the name changed.
  if (name !== originalName) {
    const { error } = await admin.rpc("rename_niche", {
      old_name: originalName,
      new_name: name,
    });
    if (error) throw new Error(`renaming niche: ${error.message}`);
  }

  const { error } = await admin
    .from("research_niches")
    .update({
      emoji: cleanEmoji(formData.get("emoji")) || null,
      discord_role_id: clean(formData.get("discordRoleId")) || null,
    })
    .eq("id", id);
  if (error) throw new Error(`updating niche: ${error.message}`);
  revalidateNichePaths();
}

export async function setNicheActive(formData: FormData) {
  await requireAdmin();
  const id = clean(formData.get("id"));
  if (!id) return;
  // Archive, never delete: the name is still written across three tables, and
  // an archived niche keeps classifying its existing channels.
  const { error } = await createAdminClient()
    .from("research_niches")
    .update({ is_active: clean(formData.get("active")) === "true" })
    .eq("id", id);
  if (error) throw new Error(`archiving niche: ${error.message}`);
  revalidateNichePaths();
}

/**
 * Step one of a rename: put the old and new emoji in the URL so /settings can
 * render the full old→new list.
 *
 * Two steps rather than one because the spec's gate is a *preview*, not a
 * count. A count says how many creators will see their channel renamed; it
 * does not say which channels, and Discord's 2-updates-per-10-minutes-per-
 * channel limit makes an undo slow enough that "which" has to be answered
 * before the write, not after.
 */
export async function previewNicheChannelRenames(formData: FormData) {
  await requireAdmin();
  const fromEmoji = clean(formData.get("fromEmoji"));
  const toEmoji = cleanEmoji(formData.get("toEmoji"));
  // redirect() throws to unwind, so it must never sit inside a try block.
  if (!fromEmoji || !toEmoji) redirect("/settings#niches");
  redirect(
    `/settings?renameFrom=${encodeURIComponent(fromEmoji)}` +
      `&renameTo=${encodeURIComponent(toEmoji)}#niches`
  );
}

/**
 * Rename every live channel on one emoji to another.
 *
 * Explicit and confirmed, never a side effect of editing a niche's emoji: it
 * is visible to every creator in those channels, and Discord's 2-updates-per-
 * 10-minutes-per-channel limit makes a bulk rename slow and a repeat rename a
 * stall. Failures are reported per channel and never retried in a loop.
 *
 * The source emoji comes from the live channel list rather than from a niche
 * row, which is what makes this reachable after the niche's emoji has already
 * been changed — the case where the channels are stranded and the rename is
 * the only way back.
 */
export async function renameNicheChannels(formData: FormData) {
  await requireAdmin();
  const fromEmoji = clean(formData.get("fromEmoji"));
  const toEmoji = cleanEmoji(formData.get("toEmoji"));
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!fromEmoji || !toEmoji || !guildId || !discordConfigured()) return;

  const plan = planNicheChannelRenames(await listGuildChannels(guildId), fromEmoji, toEmoji);
  const failed: string[] = [];
  for (const step of plan) {
    try {
      await renameChannel(step.channelId, step.to);
    } catch (err) {
      failed.push(`${step.from}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (failed.length) throw new Error(`renamed ${plan.length - failed.length}/${plan.length}; failed: ${failed.join("; ")}`);
  revalidateNichePaths();
  // Drop the preview params, or the confirmed plan stays on screen offering
  // to redo a rename Discord will now rate-limit.
  redirect("/settings#niches");
}
