/**
 * Roster lifecycle: who we have retired, and who looks like a candidate.
 *
 * Two separate ideas, deliberately not collapsed into one:
 *
 *   archived_at — a human decision, recorded. Hides the creator from the
 *                 default roster and takes them out of the scrape queue.
 *   quiet days  — derived from Launchpoint's last post date, any platform.
 *                 Surfaces candidates; never hides anything on its own.
 *
 * Deriving retirement from dormancy alone would be wrong twice over: a creator
 * on a two-week break is not retired, and a row that vanishes without anyone
 * choosing it is the exact failure the /creators "Unassigned" band exists to
 * prevent. So dormancy informs, and only the flag decides.
 *
 * Pure — `now` is injectable for tests.
 */

/** Quiet this long and the roster flags the creator as an archive candidate. */
export const QUIET_AFTER_DAYS = 30;
/** Quiet this long and the flag escalates. */
export const DORMANT_AFTER_DAYS = 60;

const DAY_MS = 24 * 60 * 60 * 1000;

export type QuietBand = "fresh" | "quiet" | "dormant" | "unknown";

/** Anything carrying the archive flag — the full creator row, or a probe of it. */
export interface Archivable {
  archived_at?: string | null;
}

/**
 * Whole days since the creator last posted anywhere Launchpoint tracks.
 *
 * Null when there is no date at all: absent data is not evidence of dormancy,
 * and rendering "0 days quiet" for an unknown would read as freshly active.
 */
export function quietDays(
  lastPostAt: string | null | undefined,
  now: Date = new Date()
): number | null {
  if (!lastPostAt) return null;
  const then = new Date(lastPostAt).getTime();
  if (!Number.isFinite(then)) return null;
  // Launchpoint's stamp can sit hours ahead of our clock; a negative count is
  // meaningless, so the floor is "posted today".
  return Math.max(0, Math.floor((now.getTime() - then) / DAY_MS));
}

export function quietBand(days: number | null): QuietBand {
  if (days == null) return "unknown";
  if (days >= DORMANT_AFTER_DAYS) return "dormant";
  if (days >= QUIET_AFTER_DAYS) return "quiet";
  return "fresh";
}

/** Archived is the timestamp's presence — never the scrape `status`. */
export function isArchived(creator: Archivable): boolean {
  return creator.archived_at != null;
}

/**
 * Split rows into what the roster shows and how many it is holding back.
 *
 * The count is returned even when showing archived rows, because the toggle
 * label needs it either way.
 */
export function splitArchived<T>(
  rows: T[],
  showArchived: boolean,
  creatorOf: (row: T) => Archivable
): { visible: T[]; archivedCount: number } {
  const archivedCount = rows.filter((r) => isArchived(creatorOf(r))).length;
  return {
    visible: showArchived ? rows : rows.filter((r) => !isArchived(creatorOf(r))),
    archivedCount,
  };
}

/**
 * The Discord category creators are moved into when they stop creating.
 *
 * This is the *other* retirement signal, and it is the one operators actually
 * use: `/offboard` drags the coaching channel into "Not Creating 🚫" and the
 * category is what everyone reads off the sidebar. Matched loosely because the
 * live category name carries an emoji ("Not Creating 🚫") that nobody types
 * consistently, and an exact-string test would fail open — the expensive
 * direction, since failing open here means pinging someone we cut.
 */
export const PARKED_CATEGORY = /not creating/i;

export function isParkedCategory(category: string | null | undefined): boolean {
  return !!category && PARKED_CATEGORY.test(category);
}

/**
 * Everything that means "we stopped working with this creator", in one test.
 *
 * The two signals are recorded in different places by different actors — the
 * archive flag by the web app, the parked category by the Discord bot — and
 * neither implies the other for rows that predate `/offboard` writing both.
 * Any send that pings a creator has to honour both or it will reach someone
 * who was cut, which is the one mistake here that cannot be taken back.
 */
export function isRetired(
  creator: Archivable,
  channelCategory: string | null | undefined
): boolean {
  return isArchived(creator) || isParkedCategory(channelCategory);
}
