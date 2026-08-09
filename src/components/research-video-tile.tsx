import type { VideoLift } from "@/lib/research";
import { formatCompact, formatDate } from "@/lib/format";
import { HoverVideo } from "./hover-video";
import { ResearchSelectTrigger } from "./research-panel";
import { FormatTag, scoreBand, type ScoreBand } from "./research-score";

const EyeIcon = () => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);
const HeartIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M12 21C7 16.5 3 13.3 3 9.3 3 6.4 5.2 4 8 4c1.6 0 3.1.8 4 2 1-1.2 2.4-2 4-2 2.8 0 5 2.4 5 5.3 0 4-4 7.2-9 11.7Z" />
  </svg>
);
const CommentIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    <path d="M21 12a8 8 0 0 1-8 8H4l2.5-2.5A8 8 0 1 1 21 12Z" />
  </svg>
);

// On-media score badge. Only the elite tier gets a loud solid-gold fill so the
// real breakouts pop off a wall of tiles; every other band stays a calm
// near-white chip with the number in its band colour. One hot colour — the page
// never turns into a rainbow.
const SCORE_MEDALLION: Record<ScoreBand, string> = {
  elite: "bg-warning text-white ring-white/25",
  strong: "bg-surface/95 text-success ring-black/[0.06] backdrop-blur",
  base: "bg-surface/95 text-neutral-700 ring-black/[0.06] backdrop-blur",
  weak: "bg-surface/90 text-danger ring-black/[0.06] backdrop-blur",
};

/**
 * One video in a research grid. Clicking selects it into the side panel.
 * Shared by the creator detail page and the cross-creator overview so the two
 * grids can't drift apart; `creatorHandle` is what distinguishes the overview
 * (where a tile could belong to any creator).
 */
export function ResearchVideoTile({
  row,
  creatorHandle,
  showLift = false,
}: {
  row: VideoLift;
  creatorHandle?: string;
  /** Show the raw multiplier next to the score. The 0–10 score saturates at
   *  ~5.7× lift, so on a leaderboard of breakouts every tile would otherwise
   *  read "10.0" and rank order would be invisible. */
  showLift?: boolean;
}) {
  const v = row.video;
  const band = row.score != null ? scoreBand(row.score) : null;
  return (
    <ResearchSelectTrigger
      row={row}
      className="group relative flex h-full w-full flex-col overflow-hidden bg-surface text-left transition duration-200 hover:z-10"
      selectedClassName="z-10 ring-2 ring-inset ring-neutral-900"
    >
      <div className="relative aspect-[3/4] w-full bg-surface-sunken">
        <HoverVideo src={v.video_url} poster={v.thumbnail_url} />
        {/* Bottom-anchored gradient carries the caption/stats; only the lower
            half darkens (the corner chips bring their own surface). Fades out to
            reveal the hover preview. */}
        <span className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/80 via-black/20 to-transparent transition-opacity duration-200 group-hover:opacity-0" />
        {/* Hover frame — a crisp inset ring reads as "lifted" on the gapless,
            un-rounded grid without re-introducing gaps or a scale that would
            overlap neighbours. */}
        <span className="pointer-events-none absolute inset-0 ring-1 ring-inset ring-white/0 transition duration-200 group-hover:ring-white/25" />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 text-white transition-opacity duration-200 group-hover:opacity-0">
          <span className="flex items-center justify-between text-sm font-semibold tabular-nums drop-shadow">
            <span className="inline-flex items-center gap-1">
              <EyeIcon />
              {formatCompact(v.view_count)}
            </span>
            <span className="inline-flex items-center gap-1">
              <HeartIcon />
              {formatCompact(v.like_count)}
            </span>
            <span className="inline-flex items-center gap-1">
              <CommentIcon />
              {formatCompact(v.comment_count)}
            </span>
          </span>
          <span className="flex items-center justify-between gap-2 font-mono text-[11px] font-medium text-white/75 drop-shadow">
            {creatorHandle ? <span className="truncate">@{creatorHandle}</span> : <span />}
            <span className="shrink-0">{formatDate(v.posted_at)}</span>
          </span>
          <span className="line-clamp-2 text-xs leading-snug text-white/90 drop-shadow">
            {v.caption?.split("\n")[0] || v.shortcode || "—"}
          </span>
        </span>
        {/* Score is the hero — a bold medallion pinned outside the fading
            overlay so it stays legible over the still, the hover preview and the
            selected state alike. Raw lift rides alongside only where the 0–10
            score saturates a leaderboard of breakouts (see `showLift`). */}
        <span className="absolute right-2 top-2 flex items-center gap-1">
          {showLift && row.lift != null && (
            <span className="rounded-lg bg-neutral-950/80 px-1.5 py-1 font-mono text-[10px] font-bold tabular-nums text-white shadow-sm ring-1 ring-inset ring-white/10 backdrop-blur">
              {row.lift >= 10 ? Math.round(row.lift) : row.lift.toFixed(1)}×
            </span>
          )}
          {band && (
            <span
              className={`inline-flex min-w-[2.1rem] items-center justify-center rounded-lg px-1.5 py-1 font-mono text-[15px] font-bold leading-none tabular-nums shadow-sm ring-1 ring-inset ${SCORE_MEDALLION[band]}`}
            >
              {row.score!.toFixed(1)}
            </span>
          )}
        </span>
        {v.format_category && (
          <FormatTag name={v.format_category} onMedia className="absolute left-2 top-2 max-w-[70%]" />
        )}
      </div>
    </ResearchSelectTrigger>
  );
}
