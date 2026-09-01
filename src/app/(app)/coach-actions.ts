"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireAdmin } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { TEAM_CATEGORY } from "@/lib/jobs/performance";

/**
 * Give an account the coach role and bind it to a team.
 *
 * If no account exists for the email yet, one is invited through Supabase
 * auth (the invite email carries the sign-in link); the profile row appears
 * via the `on_auth_user_created` trigger and is promoted here. An existing
 * creator-role account is promoted; an admin or viewer is refused — turning
 * staff into a coach silently would remove their access to everything else,
 * and that should be a deliberate, separate step.
 */
export async function assignCoach(formData: FormData) {
  await requireAdmin();
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const category = String(formData.get("category") ?? "").trim();
  const discordRaw = String(formData.get("discord_user_id") ?? "").trim();

  // A declared function, not a const arrow: TypeScript only narrows on a
  // `never` call when the callee has an explicit annotation it can see.
  function fail(message: string): never {
    redirect(`/settings?coach=${encodeURIComponent(message)}#coaches`);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fail("Enter the coach's email.");
  if (!category || !TEAM_CATEGORY.test(category)) fail("Pick a team category.");
  if (discordRaw && !/^\d{5,25}$/.test(discordRaw)) fail("Discord user id must be the numeric snowflake.");

  const admin = createAdminClient();
  const { data: existing } = await admin
    .from("profiles")
    .select("id, role")
    .ilike("email", email)
    .maybeSingle();

  let profileId = existing?.id as string | undefined;
  if (existing && existing.role !== "creator" && existing.role !== "coach") {
    fail(`${email} is ${existing.role} — staff accounts are not turned into coaches from here.`);
  }
  if (!profileId) {
    const { data: invited, error } = await admin.auth.admin.inviteUserByEmail(email);
    const user = invited?.user ?? null;
    if (error || !user) fail(error?.message ?? `Could not invite ${email}`);
    profileId = user.id;
  }

  const { error: roleError } = await admin.from("profiles").update({ role: "coach" }).eq("id", profileId);
  if (roleError) fail(roleError.message);
  // The snowflake goes in as a string; PostgREST casts it to bigint server-side,
  // so it never passes through a JS number.
  const { error: teamError } = await admin.from("research_coach_teams").upsert(
    { profile_id: profileId, category, discord_user_id: discordRaw || null },
    { onConflict: "profile_id" }
  );
  if (teamError) fail(teamError.message);

  revalidatePath("/settings");
  revalidatePath("/coach");
  redirect("/settings#coaches");
}

/** Drop the binding and the role. The account stays (as a creator-role
 *  account with no access), so removing a coach never deletes a login. */
export async function removeCoach(formData: FormData) {
  await requireAdmin();
  const profileId = String(formData.get("profile_id") ?? "");
  if (!/^[0-9a-f-]{36}$/.test(profileId)) return;
  const admin = createAdminClient();
  await admin.from("research_coach_teams").delete().eq("profile_id", profileId);
  await admin.from("profiles").update({ role: "creator" }).eq("id", profileId).eq("role", "coach");
  revalidatePath("/settings");
  revalidatePath("/coach");
}
