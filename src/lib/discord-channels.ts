/* Creator-channel display names, mirroring derive_creator_name in
   worker/discord_pull_worker.py. The live convention is emoji-only
   (``✝️jas`` — the track emoji carries the niche, the rest is the creator);
   the 2026-08-19 interim form put a niche word in between
   (``✝️christian-jas``) and legacy channels used ``coaching-<name>``. All
   three reduce to the bare creator name; anything else passes through. */

const LEGACY_PREFIXES = ["coaching-", "coachking-", "influencer-"];
const LEGACY_TRACK_WORDS = new Set(["christian", "improvement"]);

export function creatorNameFromChannel(channelName: string): string {
  const name = channelName.trim().toLowerCase();
  const trimTail = (s: string) => s.replace(/[^0-9a-z]+$/, "");
  for (const prefix of LEGACY_PREFIXES) {
    if (name.startsWith(prefix)) return trimTail(name.slice(prefix.length));
  }
  let core = name.replace(/^[^0-9a-z]+/, "");
  if (core !== name) {
    // Emoji-prefixed creator channel: drop the interim niche word when one
    // is there ("christian-jas" → "jas"), but never a real name ("austin-
    // gavin" stays whole, and a creator literally named "christian" too).
    const [first, ...rest] = core.split("-");
    const tail = rest.join("-");
    if (LEGACY_TRACK_WORDS.has(first) && tail) core = tail;
  }
  return trimTail(core);
}
