/* The format category — where published scripts land — resolved by ID.
 *
 * The CHANNELS under it are still read live from Discord rather than stored,
 * for the same reason the niche rename controls are: a channel that was
 * renamed or recreated must not silently stop resolving, leaving a picker
 * that looks fine and posts nowhere.
 *
 * The CATEGORY, though, is matched on its id. This module originally matched
 * `name === "scripts / formats"`, and that category was renamed three times in
 * a single day: to add emoji and format suffixes to its channels, and then to
 * "SCRIPT / FORMATS" — singular, which is what it is called now. Each rename
 * silently emptied the picker, producing exactly the failure the paragraph
 * above says this file exists to prevent. Reading live only protects against a
 * rename if the thing you match on is the thing that does not change.
 */
import { listGuildChannels, type GuildChannel } from "@/lib/discord";

/** The live category id. A name belongs to whoever holds Manage Channels;
 *  this does not change when they use it. */
export const FORMAT_CATEGORY_ID = "1544088923926560899";

/** Last-resort name match, for a guild whose id we do not know — a fresh
 *  server, or a test fixture built from names. Deliberately loose: optional
 *  plural on both words and any spacing around the slash, so the singular /
 *  plural flip that broke this cannot break it again. Never the primary test.
 */
const FORMAT_CATEGORY_FALLBACK = /^\s*scripts?\s*\/\s*formats?\s*$/i;

export interface FormatChannel {
  id: string;
  name: string;
}

/** True when this guild category is the one published scripts go to. */
export function isFormatCategory(channel: Pick<GuildChannel, "id" | "type" | "name">): boolean {
  if (channel.type !== 4) return false;
  if (channel.id === FORMAT_CATEGORY_ID) return true;
  return FORMAT_CATEGORY_FALLBACK.test(channel.name ?? "");
}

/** Text channels under the format category, in Discord's own display order. */
export async function listFormatChannels(): Promise<FormatChannel[]> {
  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return [];
  const all = await listGuildChannels(guildId);
  const category = all.find(isFormatCategory);
  if (!category) return [];
  return all
    .filter((c) => c.type === 0 && c.parent_id === category.id)
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0) || a.name.localeCompare(b.name))
    .map((c) => ({ id: c.id, name: c.name }));
}
