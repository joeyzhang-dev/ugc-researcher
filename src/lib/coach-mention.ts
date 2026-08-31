/**
 * Which coach owns a team category.
 *
 * The digest pings the coach whose team it is, and there is no upstream field
 * saying who that is — the only link between "Coach: Will's Team" and Will
 * Wilson is his name inside the category. So this matches on the name, with
 * one rule that matters more than the matching: **an ambiguous or missing
 * match pings nobody**.
 *
 * Pinging the wrong coach is worse than pinging none. A silent miss is a
 * message someone still reads; a wrong ping tells one coach that another
 * coach's roster is theirs, and does it every Monday until someone notices.
 * Same call `resolveScriptMatches` makes on a too-close pair.
 */

/** Strip the decoration: "Coach: Will's Team" → "will". */
export function coachNameFromCategory(category: string | null | undefined): string | null {
  if (!category) return null;
  const withoutPrefix = category.replace(/^\s*coach\s*:\s*/i, "");
  const withoutTeam = withoutPrefix.replace(/\bteam\b/i, "");
  const name = withoutTeam
    .replace(/[’']s\b/g, "")
    .replace(/[^\p{L}\s-]/gu, "")
    .trim()
    .toLowerCase();
  return name || null;
}

export interface CoachCandidate {
  discordUserId: string;
  /** Every name Discord knows them by: nickname, global name, username. */
  names: (string | null | undefined)[];
}

const norm = (s: string | null | undefined): string =>
  (s ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s-]/g, "")
    .trim();

/**
 * The coach for a category, or null when it cannot be settled confidently.
 *
 * A candidate matches when the category's name is one of the whole words in
 * any name they go by — "will" matches "Will Wilson", and does NOT match
 * "Willow", because a substring match would quietly bind the wrong person.
 */
export function coachForCategory(
  category: string | null | undefined,
  coaches: CoachCandidate[]
): string | null {
  const needle = coachNameFromCategory(category);
  if (!needle) return null;

  const matches = coaches.filter((c) =>
    c.names.some((n) => {
      const words = norm(n).split(/[\s-]+/).filter(Boolean);
      return words.includes(needle);
    })
  );
  // Exactly one, or nobody. Two coaches called Will means we do not guess.
  return matches.length === 1 ? matches[0].discordUserId : null;
}
