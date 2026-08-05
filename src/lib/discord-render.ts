/* Rendering helpers for Discord content — a 1:1 port of discord-crm's
   reporting.py cleanup so messages read like the old dashboard, not like raw
   markdown. Pure functions, no I/O. */

const MENTION_USER = /<@!?(\d+)>/g;
const MENTION_ROLE = /<@&\d+>/g;
const MENTION_CHAN = /<#(\d+)>/g;

/** Fallback sender label per role when the author has no known name. */
export const ROLE_SENDER: Record<string, string> = {
  creator: "creator",
  coach: "coach",
  launchpoint: "Launchpoint",
  unknown: "someone",
};

/** Sender chip tints, matching the old dashboard's role palette
 *  (creator blue, coach amber, launchpoint green, unknown gray). */
export const ROLE_CHIP: Record<string, string> = {
  creator: "bg-blue-50 text-blue-700",
  coach: "bg-amber-50 text-amber-800",
  launchpoint: "bg-emerald-50 text-emerald-700",
  unknown: "bg-neutral-100 text-neutral-500",
};

/** Tidy a raw Discord message: resolve @mentions / #channels to names, strip
 *  divider + markdown noise, collapse whitespace, truncate. */
export function cleanSnippet(
  content: string | null | undefined,
  names: Map<string, string>,
  channels: Map<string, string>,
  limit = 240
): string {
  let text = content ?? "";
  text = text.replace(/#{1,6}\s+/g, ""); // markdown headers, e.g. "## Script 9/9"
  text = text.replace(MENTION_USER, (_, id) => "@" + (names.get(id) ?? "someone"));
  text = text.replace(MENTION_CHAN, (_, id) => "#" + (channels.get(id) ?? "channel"));
  text = text.replace(MENTION_ROLE, "@coaches");
  text = text.replaceAll("━", " ").replaceAll("`", "");
  text = text.split(/\s+/).join(" ").trim();
  if (text.length > limit) text = text.slice(0, limit - 1).trimEnd() + "…";
  return text;
}

/** Web deep link to one Discord message (the client rewrites it to the app). */
export function messageUrl(guildId: string, channelId: string, messageId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;
}

/** Web link to a channel. */
export function channelUrl(guildId: string, channelId: string): string {
  return `https://discord.com/channels/${guildId}/${channelId}`;
}
