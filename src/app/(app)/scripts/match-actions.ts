"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { matchScriptPosts } from "@/lib/jobs/match-scripts";

const fail = (m: string): never => redirect(`/scripts/review?error=${encodeURIComponent(m)}`);

/**
 * Link every open assignment whose match is unambiguous, and send the rest to
 * /scripts/review. Safe to re-run — anything already linked is skipped.
 *
 * This is `matchScriptPosts`, the whole call the hourly cron makes — requeue,
 * resolve, apply — rather than resolve-and-apply on its own, so the button and
 * the cron see the same state. The requeue is not decoration: it flips the
 * untranscribed posts that stand between an assignment and a match back to
 * pending, and the resolver reads their status in the same pass to decide
 * whether a burst is still landing. Skipping it made the button judge that
 * question from rows the cron had already re-armed.
 */
export async function runAutoMatch() {
  await requireAdmin();
  const db = createAdminClient();

  const { linked, conflicts, review, awaitingSiblings } = await matchScriptPosts(db);

  revalidatePath("/scripts");
  revalidatePath("/scripts/review");
  redirect(
    `/scripts/review?status=${encodeURIComponent(
      `Linked ${linked} post${linked === 1 ? "" : "s"}` +
        (conflicts ? `, ${conflicts} skipped as already claimed` : "") +
        (awaitingSiblings
          ? `, ${awaitingSiblings} held while same-day uploads transcribe`
          : "") +
        (review ? ` · ${review} need a look` : "")
    )}`
  );
}
