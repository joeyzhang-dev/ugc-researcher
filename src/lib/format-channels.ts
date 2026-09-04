/* The `scripts / formats` category: where published scripts land.
 *
 * Read live from Discord rather than from a stored id, for the same reason the
 * niche rename controls do — a category that was renamed or recreated must not
 * silently stop resolving, leaving a picker that looks fine and posts nowhere.
 */
import { listGuildChannels } from "@/lib/discord";

export const FORMAT_CATEGORY = "scripts / formats";

export interface FormatChannel {
  id: string;
  name: string;
}

/** Text channels under the format category, in Discord's own display order. */
export async function listFormatChannels(): Promise<FormatChannel[]> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return [];
  const all = await listGuildChannels(guildId);
  const category = all.find(
    (c) => c.type === 4 && c.name.trim().toLowerCase() === FORMAT_CATEGORY
  );
  if (!category) return [];
  return all
    .filter((c) => c.type === 0 && c.parent_id === category.id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, name: c.name }));
}
