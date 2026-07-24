import { createClient } from "@/lib/supabase/server";
import type { Profile } from "@/lib/types";

/** Returns the signed-in user's profile, or null when signed out. */
export async function getProfile(): Promise<Profile | null> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return null;

  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("id", user.id)
    .single();
  // Default deny: a signed-in user with no profile row is treated as a non-staff
  // 'creator', never as a viewer — RLS + guards must never fall open.
  return (profile as Profile) ?? { id: user.id, email: user.email ?? null, name: null, role: "creator", created_at: "" };
}

/** Staff = internal team (admin or viewer). Creators are NOT staff. */
export function isStaff(profile: Pick<Profile, "role"> | null | undefined): boolean {
  return profile?.role === "admin" || profile?.role === "viewer";
}

/** Throws unless the caller is a signed-in admin. Use at the top of mutating server actions. */
export async function requireAdmin(): Promise<Profile> {
  const profile = await getProfile();
  if (!profile) throw new Error("Not signed in");
  if (profile.role !== "admin") throw new Error("Admin access required");
  return profile;
}
