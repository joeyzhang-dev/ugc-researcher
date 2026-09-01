"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { runResearchScrape } from "@/lib/jobs/research";
import { parseCreatorInput } from "@/lib/creator-input";

const fail = (m: string): never => redirect(`/creators?error=${encodeURIComponent(m)}`);

/** Add an app (a product we promote — Folk, future apps). */
export async function createApp(formData: FormData) {
  await requireAdmin();
  const name = String(formData.get("name") ?? "").trim();
  if (!name) fail("App name is required.");
  const { error } = await createAdminClient()
    .from("research_apps")
    .upsert({ name }, { onConflict: "name", ignoreDuplicates: true });
  if (error) fail(error.message);
  revalidatePath("/creators");
}

/** Add a campaign under an app. */
export async function createCampaign(formData: FormData) {
  await requireAdmin();
  const appId = String(formData.get("appId") ?? "");
  const name = String(formData.get("name") ?? "").trim();
  if (!appId) fail("Pick an app for the campaign.");
  if (!name) fail("Campaign name is required.");
  const { error } = await createAdminClient()
    .from("research_campaigns")
    .upsert({ app_id: appId, name }, { onConflict: "app_id,name", ignoreDuplicates: true });
  if (error) fail(error.message);
  revalidatePath("/creators");
}

/**
 * Add one of OUR creators: create the roster row + app membership (with the
 * per-app niche) FIRST so the creator is visible even if the scrape fails,
 * then run the same deep profile scrape the research pool uses.
 */
export async function addRosterCreator(formData: FormData) {
  await requireAdmin();
  const admin = createAdminClient();

  const parsed = parseCreatorInput(String(formData.get("handle") ?? ""));
  if (!parsed) fail("Paste an Instagram/TikTok profile URL or a handle.");
  const appId = String(formData.get("appId") ?? "");
  if (!appId) fail("Pick which app this creator promotes.");
  const niche = String(formData.get("niche") ?? "").trim() || null;
  const campaignId = String(formData.get("campaignId") ?? "");

  // Roster row first (kind='roster'); the scrape below re-upserts status.
  const { data: creator, error: upsertError } = await admin
    .from("research_creators")
    .upsert(
      { platform: parsed!.platform, handle: parsed!.handle, kind: "roster", status: "pending" },
      { onConflict: "platform,handle" }
    )
    .select("id")
    .single();
  if (upsertError || !creator) fail(upsertError?.message ?? "Could not create creator");

  const { error: memberError } = await admin
    .from("research_app_creators")
    .upsert(
      { app_id: appId, research_creator_id: creator!.id, ...(niche ? { niche } : {}) },
      { onConflict: "app_id,research_creator_id" }
    );
  if (memberError) fail(memberError!.message);

  if (campaignId) {
    // The campaign must belong to the chosen app (the select lists all apps' campaigns).
    const { data: campaign } = await admin
      .from("research_campaigns")
      .select("id, app_id")
      .eq("id", campaignId)
      .maybeSingle();
    if (!campaign || campaign.app_id !== appId) {
      fail("That campaign belongs to a different app — pick a matching one.");
    }
    const { error } = await admin
      .from("research_campaign_creators")
      .upsert(
        { campaign_id: campaignId, research_creator_id: creator!.id },
        { onConflict: "campaign_id,research_creator_id", ignoreDuplicates: true }
      );
    if (error) fail(error.message);
  }

  try {
    await runResearchScrape(admin, { ...parsed!, kind: "roster" });
  } catch (error) {
    // Membership exists; the row shows status=failed with the error inline.
    fail(error instanceof Error ? error.message : String(error));
  }
  revalidatePath("/creators");
  redirect("/creators");
}

/** Update the per-app niche tag on a roster membership row. */
export async function setNiche(formData: FormData) {
  await requireAdmin();
  const membershipId = String(formData.get("membershipId") ?? "");
  if (!membershipId) fail("Missing membership id.");
  const niche = String(formData.get("niche") ?? "").trim() || null;
  const { error } = await createAdminClient()
    .from("research_app_creators")
    .update({ niche })
    .eq("id", membershipId);
  if (error) fail(error.message);
  revalidatePath("/creators");
}

/** Put a creator into a campaign (validated against the membership's app). */
export async function assignToCampaign(formData: FormData) {
  await requireAdmin();
  const creatorId = String(formData.get("creatorId") ?? "");
  const appId = String(formData.get("appId") ?? "");
  const campaignId = String(formData.get("campaignId") ?? "");
  if (!creatorId || !campaignId) fail("Pick a campaign.");
  const admin = createAdminClient();
  const { data: campaign } = await admin
    .from("research_campaigns")
    .select("id, app_id")
    .eq("id", campaignId)
    .maybeSingle();
  if (!campaign || (appId && campaign.app_id !== appId)) {
    fail("That campaign belongs to a different app.");
  }
  const { error } = await admin
    .from("research_campaign_creators")
    .upsert(
      { campaign_id: campaignId, research_creator_id: creatorId },
      { onConflict: "campaign_id,research_creator_id", ignoreDuplicates: true }
    );
  if (error) fail(error.message);
  revalidatePath("/creators");
}

/** Remove a creator from one campaign (membership row id). */
export async function removeFromCampaign(membershipId: string) {
  await requireAdmin();
  const { error } = await createAdminClient()
    .from("research_campaign_creators")
    .delete()
    .eq("id", membershipId);
  if (error) throw new Error(error.message);
  revalidatePath("/creators");
}

/**
 * Retire a creator: hide them from the default roster and stop scraping them.
 *
 * Deliberately not a delete. Their videos, transcripts, script assignments and
 * Launchpoint history stay exactly where they are — the roster is a working
 * list, and everything this pool exists to study is still worth keeping after
 * someone leaves the program. Unarchive puts the row straight back.
 */
export async function archiveCreator(formData: FormData) {
  await requireAdmin();
  const creatorId = String(formData.get("creatorId") ?? "");
  if (!creatorId) fail("Missing creator id.");
  const reason = String(formData.get("reason") ?? "").trim() || null;
  const { error } = await createAdminClient()
    .from("research_creators")
    .update({ archived_at: new Date().toISOString(), archived_reason: reason })
    .eq("id", creatorId);
  if (error) fail(error.message);
  revalidatePath("/creators");
}

/** Put an archived creator back on the roster (and back in the scrape queue). */
export async function unarchiveCreator(formData: FormData) {
  await requireAdmin();
  const creatorId = String(formData.get("creatorId") ?? "");
  if (!creatorId) fail("Missing creator id.");
  const { error } = await createAdminClient()
    .from("research_creators")
    .update({ archived_at: null, archived_reason: null })
    .eq("id", creatorId);
  if (error) fail(error.message);
  revalidatePath("/creators");
}
