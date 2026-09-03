/**
 * Which live Discord channels a niche's emoji change would rename.
 *
 * Pure and previewable on purpose. Renaming is visible to every creator in
 * the channel, and Discord rate-limits channel updates to 2 per 10 minutes
 * per channel — so this is never automatic on an emoji edit. It produces a
 * plan someone confirms.
 */

// Variation selector and ZWJ as escapes — invisible in a source file, and
// this has to agree with niche_emoji_base() in SQL and strip_emoji_base() in
// Python or the three disagree about when two emojis are one track.
const DECORATIONS = /[\uFE0F\u200D]/g;

/** Mirrors niche_emoji_base() in SQL and strip_emoji_base() in Python. */
export const emojiBase = (emoji: string): string => emoji.replace(DECORATIONS, "").trim();

/** Text channels only (0 = text, 5 = announcement) — never categories. */
const TEXT_TYPES = new Set([0, 5]);

/** How many live channels currently carry this emoji. Same matching as the
 *  rename plan, so the count on the button and the work it does agree. */
export function countNicheChannels(
  channels: { id: string; name: string; type: number }[],
  emoji: string
): number {
  const base = emojiBase(emoji);
  if (!base) return 0;
  return channels.filter(
    (c) => TEXT_TYPES.has(c.type) && c.name.replace(DECORATIONS, "").startsWith(base)
  ).length;
}

export function planNicheChannelRenames(
  channels: { id: string; name: string; type: number }[],
  fromEmoji: string,
  toEmoji: string
): { channelId: string; from: string; to: string }[] {
  const from = emojiBase(fromEmoji);
  const to = toEmoji.trim();
  if (!from || !to || from === emojiBase(to)) return [];

  const plan: { channelId: string; from: string; to: string }[] = [];
  for (const c of channels) {
    if (!TEXT_TYPES.has(c.type)) continue;
    const bare = c.name.replace(DECORATIONS, "");
    if (!bare.startsWith(from)) continue;
    plan.push({ channelId: c.id, from: c.name, to: `${to}${bare.slice(from.length)}` });
  }
  return plan;
}
