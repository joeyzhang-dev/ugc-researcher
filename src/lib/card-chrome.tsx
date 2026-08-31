/**
 * Shared furniture for the rendered cards: the palette, the platform mark, and
 * the CPM colour bands.
 *
 * The recap card, the coach's `/stats` card and the creator's `/my-stats` card
 * are three views of one dataset, so they share a surface and a colour
 * vocabulary — a reader who learns "green is good" on one must not have to
 * relearn it on the next.
 */

/** Satori renders a deliberately small CSS subset: flexbox only, explicit
 *  `display: flex` on every element, no grid. Keep these styles boring. */
export const CARD = {
  bg: "#1a1b1e",
  panel: "#232529",
  line: "#2f3237",
  text: "#f2f3f5",
  dim: "#9aa0a6",
  faint: "#6b7178",
  accent: "#5865f2",
  good: "#3ba55d",
  warn: "#e8b339",
  bad: "#ed4245",
} as const;

/**
 * The Instagram glyph, inlined as a data URI.
 *
 * A data URI rather than a remote asset because Satori fetches images at
 * render time: a network hop for a 1KB logo would add latency to every card
 * and, worse, could fail — leaving a hole where the platform label should be.
 * Every number on these cards is Instagram-only (no TikTok post is ever
 * ingested), so the mark is a statement of scope, not decoration.
 */
const INSTAGRAM_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none">
<defs><linearGradient id="g" x1="2" y1="22" x2="22" y2="2">
<stop offset="0" stop-color="#FEDA75"/><stop offset="0.25" stop-color="#FA7E1E"/>
<stop offset="0.5" stop-color="#D62976"/><stop offset="0.75" stop-color="#962FBF"/>
<stop offset="1" stop-color="#4F5BD5"/></linearGradient></defs>
<rect x="2" y="2" width="20" height="20" rx="6" stroke="url(#g)" stroke-width="2"/>
<circle cx="12" cy="12" r="4.6" stroke="url(#g)" stroke-width="2"/>
<circle cx="17.6" cy="6.4" r="1.4" fill="url(#g)"/></svg>`;

export const INSTAGRAM_MARK = `data:image/svg+xml;base64,${Buffer.from(INSTAGRAM_SVG).toString("base64")}`;

/** The platform badge that sits in every card's top-right corner. */
export function PlatformMark({ label = "Instagram only" }: { label?: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", marginLeft: "auto" }}>
      <div style={{ display: "flex", fontSize: 14, color: CARD.faint, marginRight: 9 }}>{label}</div>
      <img src={INSTAGRAM_MARK} width={26} height={26} />
    </div>
  );
}

/* --- CPM bands ------------------------------------------------------------ */

/**
 * CPM is what a thousand views costs the program, so LOWER is better — the
 * opposite direction to every other number on these cards. That inversion is
 * exactly why it needs colour: a coach scanning "$1.32" and "$27.40" should
 * not have to remember which way is good.
 *
 * $3 is Joey's line for "well below" (2026-08-31); $25 is the existing
 * CPM_BAD_MIN_USD the buckets already use, so the red here means the same
 * thing red means everywhere else.
 */
export const CPM_GREAT_USD = 3;
export const CPM_POOR_USD = 25;

export type CpmBand = "great" | "ok" | "poor";

export function cpmBand(cpm: number | null | undefined): CpmBand | null {
  if (cpm == null || !Number.isFinite(cpm)) return null;
  if (cpm < CPM_GREAT_USD) return "great";
  if (cpm >= CPM_POOR_USD) return "poor";
  return "ok";
}

export const CPM_BAND_COLOR: Record<CpmBand, string> = {
  great: CARD.good,
  ok: CARD.warn,
  poor: CARD.bad,
};

/** Plain-language gloss, so the colour is never the only carrier of meaning —
 *  it would be invisible to a colour-blind reader otherwise. */
export const CPM_BAND_LABEL: Record<CpmBand, string> = {
  great: "great",
  ok: "ok",
  poor: "needs work",
};

/* --- date ranges ---------------------------------------------------------- */

const MD = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** "Jul 17 – Aug 16", inclusive of the last day. Windows are half-open
 *  `[start, end)`, so the label subtracts a millisecond — otherwise every
 *  range reads a day longer than it is. */
export function rangeLabel(start: Date, endExclusive: Date): string {
  return `${MD(start)} – ${MD(new Date(endExclusive.getTime() - 1))}`;
}

/**
 * What the CPM number actually covers, in words.
 *
 * The single most confusable figure on these cards: the true CPM window ends
 * at the creator's newest PAYOUT, not at today, so two creators looking at the
 * same card are reading different date ranges — Jas Jul 17–Aug 16, Roman
 * Jul 5–Aug 4. Without this caption "$1.32" looks like it means "this month"
 * to everyone, and a creator asking "why is my CPM from three weeks ago" has
 * nothing on the card to answer them.
 */
export function cpmRangeLabel(
  settledWindow: { start: Date; end: Date } | null,
  hasProjection: boolean
): string {
  if (settledWindow) return `paid posts · ${rangeLabel(settledWindow.start, settledWindow.end)}`;
  if (hasProjection) return "projected · last 30 days";
  return "no payouts yet";
}
