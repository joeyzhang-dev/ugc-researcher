"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { runFormatCategorization, runResearchScrape } from "@/lib/jobs/research";
import { parseCreatorInput } from "@/lib/creator-input";
import type { Platform } from "@/lib/types";

/** Add (or re-scrape) a research creator. Runs the Apify scrape inline —
 *  expect it to take a minute or two for a deep profile pull. */
export async function addResearchCreator(formData: FormData) {
  await requireAdmin();
  const fail = (m: string): never => redirect(`/research?error=${encodeURIComponent(m)}`);

  const parsed = parseCreatorInput(String(formData.get("handle") ?? ""));
  if (!parsed) fail("Paste an Instagram/TikTok profile URL or a handle.");

  let creatorId: string;
  try {
    const result = await runResearchScrape(createAdminClient(), parsed!);
    creatorId = result.creatorId;
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    return;
  }
  revalidatePath("/research");
  redirect(`/research/${creatorId}`);
}

/** Refresh a creator: re-pull recent posts + metrics (idempotent upsert). */
export async function rescrapeResearchCreator(id: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { data: creator } = await admin
    .from("research_creators")
    .select("handle, platform")
    .eq("id", id)
    .single();
  if (!creator) throw new Error("Research creator not found");
  await runResearchScrape(admin, {
    handle: creator.handle,
    platform: creator.platform as Platform,
  });
  revalidatePath(`/research/${id}`);
  revalidatePath("/research");
}

/** Re-run the fast regex format detection over this creator's videos. */
export async function autoCategorizeFormats(creatorId: string) {
  await requireAdmin();
  await runFormatCategorization(createAdminClient(), creatorId);
  revalidatePath(`/research/${creatorId}`);
}

/**
 * Queue this creator's videos for AI format categorization. Just flips a flag —
 * the actual LLM work is done by the Copilot agent when the drainer runs
 * (`npm run categorize:formats`), mirroring the transcription worker. See
 * docs/format-categorization.md.
 */
export async function queueAiCategorization(creatorId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_videos")
    .update({ format_llm_status: "pending", updated_at: new Date().toISOString() })
    .eq("research_creator_id", creatorId);
  if (error) throw new Error(error.message);
  revalidatePath(`/research/${creatorId}`);
}

/** Requeue this creator's failed transcripts for the local worker. */
export async function retryFailedTranscripts(creatorId: string) {
  await requireAdmin();
  const admin = createAdminClient();
  const { error } = await admin
    .from("research_videos")
    .update({ transcript_status: "pending", error_message: null })
    .eq("research_creator_id", creatorId)
    .eq("transcript_status", "failed");
  if (error) throw new Error(error.message);
  revalidatePath(`/research/${creatorId}`);
}
