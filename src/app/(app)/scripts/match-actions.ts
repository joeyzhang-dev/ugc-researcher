"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { applyMatches, resolveOpenAssignments } from "@/lib/jobs/match-scripts";

const fail = (m: string): never => redirect(`/scripts/review?error=${encodeURIComponent(m)}`);

/**
 * Link every open assignment whose match is unambiguous, and send the rest to
 * /scripts/review. Safe to re-run — anything already linked is skipped.
 */
export async function runAutoMatch() {
  await requireAdmin();
  const db = createAdminClient();

  const ctx = await resolveOpenAssignments(db);
  const { linked, conflicts } = await applyMatches(db, ctx.confirm, ctx.videoById);

  revalidatePath("/scripts");
  revalidatePath("/scripts/review");
  redirect(
    `/scripts/review?status=${encodeURIComponent(
      `Linked ${linked} post${linked === 1 ? "" : "s"}` +
        (conflicts ? `, ${conflicts} skipped as already claimed` : "") +
        (ctx.review.length ? ` · ${ctx.review.length} need a look` : "")
    )}`
  );
}
