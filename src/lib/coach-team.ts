import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { TEAM_CATEGORY } from "@/lib/jobs/performance";
import type { CoachTeam } from "@/lib/types";

/**
 * Coach ↔ team bindings (`research_coach_teams`).
 *
 * A team is a Discord category name ("Coach: Will's Team"), the same key the
 * coach digest and /performance group creators by. There is no other identity
 * a team has in this schema, so binding a coach account to the category name
 * is binding it to exactly the creators the digest would call theirs.
 */

const COLUMNS = "profile_id, category, discord_user_id::text, created_at, updated_at";

/** The signed-in coach's own team, through RLS — the row is readable by its
 *  owner and by staff, nobody else. Null when none is assigned yet. */
export async function getOwnCoachTeam(profileId: string): Promise<CoachTeam | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("research_coach_teams")
    .select(COLUMNS)
    .eq("profile_id", profileId)
    .maybeSingle();
  return (data as CoachTeam | null) ?? null;
}

export interface CoachTeamRow extends CoachTeam {
  email: string | null;
  name: string | null;
  role: string;
}

/** Every binding with the account behind it, for the admin card. */
export async function listCoachTeams(admin: SupabaseClient): Promise<CoachTeamRow[]> {
  const { data, error } = await admin
    .from("research_coach_teams")
    .select(`${COLUMNS}, profiles!inner(email, name, role)`)
    .order("category");
  if (error) throw new Error(`listing coach teams: ${error.message}`);
  return ((data ?? []) as unknown as (CoachTeam & { profiles: { email: string | null; name: string | null; role: string } })[]).map(
    ({ profiles, ...team }) => ({ ...team, email: profiles.email, name: profiles.name, role: profiles.role })
  );
}

/** The team categories that exist in Discord right now, from the coaching
 *  channels' categories — so the admin picks a real team, not a typo. */
export async function listTeamCategories(admin: SupabaseClient): Promise<string[]> {
  const { data, error } = await admin
    .from("research_discord_channels")
    .select("category")
    .not("category", "is", null)
    .limit(5000);
  if (error) throw new Error(`listing team categories: ${error.message}`);
  const seen = new Set<string>();
  for (const row of (data ?? []) as { category: string | null }[]) {
    if (row.category && TEAM_CATEGORY.test(row.category)) seen.add(row.category);
  }
  return [...seen].sort((a, b) => a.localeCompare(b));
}
