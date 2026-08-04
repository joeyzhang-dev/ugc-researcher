"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ResearchAssignmentStatus, ResearchScriptStatus } from "@/lib/types";

const fail = (m: string): never => redirect(`/scripts?error=${encodeURIComponent(m)}`);

const str = (fd: FormData, key: string): string | null => {
  const v = String(fd.get(key) ?? "").trim();
  return v === "" ? null : v;
};

/** Write a new script. */
export async function createScript(formData: FormData) {
  await requireAdmin();
  const title = str(formData, "title");
  if (!title) fail("Give the script a title.");

  const { data, error } = await createAdminClient()
    .from("research_scripts")
    .insert({
      title,
      app_id: str(formData, "appId"),
      hook: str(formData, "hook"),
      body: str(formData, "body"),
      niche: str(formData, "niche"),
      notes: str(formData, "notes"),
      status: (str(formData, "status") as ResearchScriptStatus) ?? "Active",
    })
    .select("id")
    .single();
  if (error) fail(error.message);

  revalidatePath("/scripts");
  redirect(`/scripts/${data!.id}`);
}

/** Edit an existing script. */
export async function updateScript(scriptId: string, formData: FormData) {
  await requireAdmin();
  const title = str(formData, "title");
  if (!title) fail("Give the script a title.");

  const { error } = await createAdminClient()
    .from("research_scripts")
    .update({
      title,
      app_id: str(formData, "appId"),
      hook: str(formData, "hook"),
      body: str(formData, "body"),
      niche: str(formData, "niche"),
      notes: str(formData, "notes"),
      status: (str(formData, "status") as ResearchScriptStatus) ?? "Active",
    })
    .eq("id", scriptId);
  if (error) fail(error.message);

  revalidatePath("/scripts");
  revalidatePath(`/scripts/${scriptId}`);
}

/** Hand a script to one of our creators. */
export async function assignScript(scriptId: string, formData: FormData) {
  await requireAdmin();
  const creatorId = str(formData, "creatorId");
  if (!creatorId) fail("Pick a creator.");

  const { error } = await createAdminClient()
    .from("research_script_assignments")
    // A creator can only hold a given script once; re-assigning is a no-op
    // rather than an error, so double-clicking the button is harmless.
    .upsert(
      { script_id: scriptId, research_creator_id: creatorId },
      { onConflict: "script_id,research_creator_id", ignoreDuplicates: true }
    );
  if (error) fail(error.message);

  revalidatePath(`/scripts/${scriptId}`);
}

/**
 * Link the video a creator posted from this script.
 *
 * This is the link every per-script number is derived from, which is why it is
 * always a deliberate confirmation and never inferred automatically — a
 * creator running two similar scripts would otherwise get them silently
 * swapped, and the stats would be quietly wrong with no way to notice.
 */
export async function linkAssignmentVideo(assignmentId: string, formData: FormData) {
  await requireAdmin();
  const videoId = str(formData, "videoId");
  const scriptId = str(formData, "scriptId");

  const { error } = await createAdminClient()
    .from("research_script_assignments")
    .update({
      research_video_id: videoId,
      status: videoId ? "Posted" : "Assigned",
      posted_at: videoId ? new Date().toISOString() : null,
    })
    .eq("id", assignmentId);
  if (error) {
    // The partial unique index means one video can only back a single script.
    fail(
      error.code === "23505"
        ? "That video is already linked to another script."
        : error.message
    );
  }

  revalidatePath(`/scripts/${scriptId}`);
  revalidatePath("/scripts");
}

/** Mark an assignment Assigned / Posted / Skipped. */
export async function setAssignmentStatus(
  assignmentId: string,
  scriptId: string,
  status: ResearchAssignmentStatus
) {
  await requireAdmin();
  const { error } = await createAdminClient()
    .from("research_script_assignments")
    .update({ status })
    .eq("id", assignmentId);
  if (error) fail(error.message);

  revalidatePath(`/scripts/${scriptId}`);
  revalidatePath("/scripts");
}

/** Remove an assignment entirely. */
export async function removeAssignment(assignmentId: string, scriptId: string) {
  await requireAdmin();
  const { error } = await createAdminClient()
    .from("research_script_assignments")
    .delete()
    .eq("id", assignmentId);
  if (error) fail(error.message);

  revalidatePath(`/scripts/${scriptId}`);
  revalidatePath("/scripts");
}
