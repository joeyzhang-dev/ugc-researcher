/**
 * Which live Discord channels a niche's emoji change would rename.
 *
 * Pure and previewable on purpose. Renaming is visible to every creator in
 * the channel, and Discord rate-limits channel updates to 2 per 10 minutes
 * per channel — so this is never automatic on an emoji edit. It produces a
 * plan someone confirms.
 *
 * The other half of this module answers the question /settings has to ask
 * FIRST: which emoji are actually on live channels right now, and does a
 * niche still claim each one. That has to come from Discord rather than from
 * research_niches, because the dangerous state is exactly the one where the
 * two disagree — a niche whose emoji was edited leaves N channels on a base
 * `track_bases()` no longer maps, so `split_track_channel` returns None and
 * `cmd_discover` (upsert-only) quietly stops discovering them. Nothing
 * raises. Deriving the rename controls from the niche rows would hide the
 * stranded channels at the exact moment they appear.
 */

// Variation selector and ZWJ as escapes — invisible in a source file, and
// this has to agree with niche_emoji_base() in SQL and strip_emoji_base() in
// Python or the three disagree about when two emojis are one track.
const DECORATIONS = /[\uFE0F\u200D]/g;

/** Mirrors niche_emoji_base() in SQL and strip_emoji_base() in Python. */
export const emojiBase = (emoji: string): string => emoji.replace(DECORATIONS, "").trim();

/**
 * What actually gets stored in `research_niches.emoji`.
 *
 * All whitespace, not just the ends. `clean()` in niche-actions already trims
 * the outside, so a plain "cross + trailing space" was never the hole — the
 * hole is whitespace trimming cannot reach: U+271D, SPACE, U+FE0F. Python's
 * `strip_emoji_base` and this file's `emojiBase` both remove the decoration
 * and THEN strip, so both read that as U+271D; SQL's `niche_emoji_base()`
 * only removes the decoration, so it reads "U+271D SPACE" and the unique
 * index lets it sit beside a real U+271D. Two rows that classify
 * identically make discovery non-deterministic with nothing reporting it, so
 * the padded form must never be storable in the first place. An emoji never
 * legitimately contains whitespace.
 */
export const normalizeNicheEmoji = (emoji: string): string => emoji.replace(/\s+/gu, "");

/** Text channels only (0 = text, 5 = announcement) — never categories. */
const TEXT_TYPES = new Set([0, 5]);

interface Channel {
  id: string;
  name: string;
  type: number;
}

/** What ends the emoji run. U+30FB (KATAKANA MIDDLE DOT) is in here so the
 *  run stops before it, but it is deliberately absent from STRIPPABLE below:
 *  it is the mark server furniture uses (emoji, U+30FB, name), and leaving it
 *  in the remainder is exactly what disqualifies those channels -- the same
 *  call split_track_channel makes. */
const RUN_STOPS = new Set(["-", "_", " ", "\u30FB"]);
/** Separators a creator channel may put between the emoji and the name.
 *  Mirrors Python's `.lstrip("-_ ")`. */
const STRIPPABLE = /^[-_ ]+/u;
const isAlnum = (ch: string): boolean => /[\p{L}\p{N}]/u.test(ch);

/**
 * The leading emoji of a creator-shaped channel name (`🌱ethan-lau`), or null.
 *
 * Mirrors `split_track_channel` in discord_pull_worker.py: the emoji run stops
 * at the first alphanumeric or separator, and what follows — after the same
 * decoration/separator trim Python does — has to start alphanumeric. That last
 * test is what keeps server furniture (`🌱・getting-started`, `📃・creator-brief`)
 * out of the emoji list, so the only bases shown are ones the classifier would
 * treat as creator channels if a niche claimed them.
 */
export function leadingEmojiRun(name: string): { base: string; display: string } | null {
  const cps = [...name.trim()];
  let i = 0;
  while (i < cps.length && !isAlnum(cps[i]) && !RUN_STOPS.has(cps[i])) i += 1;
  if (i === 0) return null;

  const display = cps.slice(0, i).join("");
  const base = emojiBase(display);
  if (!base) return null;

  const rest = cps.slice(i).join("").replace(STRIPPABLE, "");
  if (!rest || !isAlnum([...rest][0])) return null;
  return { base, display };
}

export interface LiveEmojiBase {
  /** Decoration-stripped prefix — the key everything compares on. */
  base: string;
  /** The prefix as Discord actually renders it, decorations included. */
  display: string;
  /** The niche claiming this base, or null. Null is the stalled state. */
  niche: string | null;
  /** Names the rename would touch, same rule as planNicheChannelRenames, so
   *  the number on the button and the work it does can never disagree. */
  channels: string[];
}

/**
 * Every emoji currently prefixing a live creator channel, with the niche that
 * claims it — or null when none does.
 *
 * Archived niches count as claiming: `track_bases()` reads every row, so an
 * archived niche still classifies its channels and they are not stranded.
 */
export function liveEmojiBases(
  channels: Channel[],
  niches: { name: string; emoji: string | null }[]
): LiveEmojiBase[] {
  const text = channels.filter((c) => TEXT_TYPES.has(c.type));

  // Candidate bases come only from creator-shaped names, so a decorative
  // channel can never invent a row of its own.
  const seen = new Map<string, string>();
  for (const c of text) {
    const run = leadingEmojiRun(c.name);
    if (run && !seen.has(run.base)) seen.set(run.base, run.display);
  }

  const claimedBy = new Map<string, string>();
  for (const n of niches) {
    const base = n.emoji ? emojiBase(n.emoji) : "";
    if (base && !claimedBy.has(base)) claimedBy.set(base, n.name);
  }

  const rows: LiveEmojiBase[] = [...seen.entries()].map(([base, display]) => ({
    base,
    // Prefer the niche's own spelling once it claims the base, so the row and
    // the niche table above show the same glyph.
    display: claimedBy.has(base)
      ? (niches.find((n) => n.emoji && emojiBase(n.emoji) === base)?.emoji ?? display)
      : display,
    niche: claimedBy.get(base) ?? null,
    channels: channelsOnBase(text, base).map((c) => c.name),
  }));

  // Unclaimed first: that row IS the stall report, so it goes where it is read.
  return rows.sort((a, b) => {
    if ((a.niche === null) !== (b.niche === null)) return a.niche === null ? -1 : 1;
    return (a.niche ?? a.base).localeCompare(b.niche ?? b.base);
  });
}

/** Channels a rename from `base` would touch. Prefix match on the
 *  decoration-stripped name, so a channel written with the U+FE0F variation
 *  selector and one written without it move together. */
function channelsOnBase(channels: Channel[], base: string): Channel[] {
  if (!base) return [];
  return channels.filter((c) => c.name.replace(DECORATIONS, "").startsWith(base));
}

export function planNicheChannelRenames(
  channels: Channel[],
  fromEmoji: string,
  toEmoji: string
): { channelId: string; from: string; to: string }[] {
  const from = emojiBase(fromEmoji);
  const to = normalizeNicheEmoji(toEmoji);
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
