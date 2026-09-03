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

export function nicheEmojiMap(niches: Niche[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const n of niches) if (n.emoji) map.set(n.name, n.emoji);
  return map;
}

export function nicheLabel(name: string, emojis: Map<string, string>): string {
  const emoji = emojis.get(name);
  return emoji ? `${emoji} ${name}` : name;
}
