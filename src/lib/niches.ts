/**
 * The niche track vocabulary, shared by the pages that render niche pills and
 * by /settings, which manages it.
 *
 * Mirrors worker/niches.py. The table is the TRACK vocabulary — niches that
 * own an emoji — not a registry of every niche string ever written, so
 * `nicheLabel` has to render an unknown niche unchanged rather than hiding it.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export interface Niche {
  name: string;
  emoji: string | null;
  /** Snowflake as text — a bigint through JSON.parse loses its low digits. */
  discordRoleId: string | null;
  isActive: boolean;
}

interface NicheRow {
  name: string;
  emoji: string | null;
  discord_role_id: string | null;
  is_active: boolean;
}

export async function loadNiches(client: SupabaseClient): Promise<Niche[]> {
  const { data, error } = await client
    .from("research_niches")
    .select("name, emoji, discord_role_id::text, is_active")
    .order("name");
  // A missing table must not take a page down — same reasoning as
  // videoSelect()'s probe: the code can reach Vercel before the migration
  // lands, and a select naming a missing relation is a hard PostgREST 400.
  if (error) return [];
  return ((data ?? []) as NicheRow[]).map((r) => ({
    name: r.name,
    emoji: r.emoji,
    discordRoleId: r.discord_role_id,
    isActive: r.is_active,
  }));
}

/**
 * `name -> emoji`, for the pages that render niche pills.
 *
 * A plain record rather than a Map because half the pills live in client
 * components (`scripts-explorer`, `creator-picker`), and a server component
 * hands this across the boundary as a prop.
 */
export function nicheEmojis(niches: Niche[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const n of niches) if (n.emoji) out[n.name] = n.emoji;
  return out;
}

export function nicheLabel(name: string, emojis: Record<string, string>): string {
  const emoji = emojis[name];
  return emoji ? `${emoji} ${name}` : name;
}
