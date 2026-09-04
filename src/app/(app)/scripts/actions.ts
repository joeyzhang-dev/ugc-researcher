"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { parseVirtualAssignmentId } from "@/lib/scripts";
import { createAdminClient } from "@/lib/supabase/admin";
import type { ResearchAssignmentStatus, ResearchScriptStatus } from "@/lib/types";
import { titleFromHook } from "./doc";

const fail = (m: string): never => redirect(`/scripts?error=${encodeURIComponent(m)}`);

const str = (fd: FormData, key: string): string | null => {
  const v = String(fd.get(key) ?? "").trim();
  return v === "" ? null : v;
};

/** Write a new script. */
export async function createScript(formData: FormData) {
  await requireAdmin();
  const hook = str(formData, "hook");
  // The doc-grid composer has no title field — the hook is the identity there,
  // so its first line stands in as the stored title.
  const title = str(formData, "title") ?? titleFromHook(hook);
  if (!title) fail("Give the script a title or a hook.");

  const { data, error } = await createAdminClient()
    .from("research_scripts")
    .insert({
      title,
      app_id: str(formData, "appId"),
      hook,
      body: str(formData, "body"),
      niche: str(formData, "niche"),
      inspo_url: str(formData, "inspoUrl"),
      demo: str(formData, "demo"),
      songs: str(formData, "songs"),
      notes: str(formData, "notes"),
      status: (str(formData, "status") as ResearchScriptStatus) ?? "Active",
    })
    .select("id")
    .single();
  if (error) fail(error.message);

  revalidatePath("/scripts");
  // The grid composer stays on the page it was writing into (the refresh
  // drops the new script into its cell); the standalone form keeps jumping
  // to the new script's detail page.
  if (formData.get("stay") != null) return;
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
      // Same only-when-sent rule as notes below: a form that never rendered
      // these fields must not blank them on save.
      ...(formData.get("inspoUrl") != null ? { inspo_url: str(formData, "inspoUrl") } : {}),
      ...(formData.get("demo") != null ? { demo: str(formData, "demo") } : {}),
      ...(formData.get("songs") != null ? { songs: str(formData, "songs") } : {}),
      // Notes render on the detail form, but the doc-grid composer still
      // omits them — only write the field when a form actually sends it,
      // otherwise a composer save would silently wipe the stored notes
      // (including lines appended from the Discord card's 📝 Note modal).
      ...(formData.get("notes") != null ? { notes: str(formData, "notes") } : {}),
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

  const db = createAdminClient();

  // Stamp the day the creator posted, not the day we noticed. The bulk matcher
  // links hundreds of months-old posts at once, and "now" would date every one
  // of them today.
  let postedAt: string | null = null;
  if (videoId) {
    const { data: video } = await db
      .from("research_videos")
      .select("posted_at")
      .eq("id", videoId)
      .maybeSingle();
    postedAt = (video?.posted_at as string | null) ?? new Date().toISOString();
  }

  // A published script has no assignment row until someone is shown to have
  // made it. An UPDATE by id would match nothing here and report success —
  // the queue this button drains is exactly the contested pairs the
  // auto-matcher refused, so it cannot be left silently broken.
  const virtual = parseVirtualAssignmentId(assignmentId);
  if (virtual) {
    if (!videoId) redirect("/scripts/review"); // nothing to unlink yet
    const { error: insertError } = await db.from("research_script_assignments").insert({
      script_id: virtual.scriptId,
      research_creator_id: virtual.creatorId,
      research_video_id: videoId,
      status: "Posted",
      assigned_at: postedAt,
      posted_at: postedAt,
    });
    if (insertError) {
      fail(
        insertError.code === "23505"
          ? "That post is already linked to another script."
          : insertError.message
      );
    }
    revalidatePath("/scripts");
    revalidatePath("/scripts/review");
    redirect("/scripts/review?status=Linked");
  }

  const { error } = await db
    .from("research_script_assignments")
    .update({
      research_video_id: videoId,
      status: videoId ? "Posted" : "Assigned",
      posted_at: postedAt,
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
