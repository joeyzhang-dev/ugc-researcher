import type { VideoLift } from "@/lib/research";
import { formatCompact, formatDate } from "@/lib/format";
import { HoverVideo } from "./hover-video";
import { ResearchScoreChip, ResearchSelectTrigger } from "./research-panel";

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
  return (
    <ResearchSelectTrigger
      row={row}
      className="group relative flex h-full w-full flex-col overflow-hidden bg-white text-left"
      selectedClassName="z-10 ring-2 ring-inset ring-neutral-900"
    >
      <div className="relative aspect-[3/4] w-full bg-neutral-100">
        <HoverVideo src={v.video_url} poster={v.thumbnail_url} />
        {/* Scrim + info fade out while the hover preview plays. */}
        <span className="pointer-events-none absolute inset-0 bg-black/35 transition-opacity duration-200 group-hover:opacity-0" />
        <span className="pointer-events-none absolute inset-x-0 bottom-0 flex flex-col gap-1 p-3 text-white transition-opacity duration-200 group-hover:opacity-0">
          <span className="flex items-center justify-between text-base font-semibold tabular-nums drop-shadow">
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
          {creatorHandle && (
            <span className="truncate text-[11px] font-semibold text-white drop-shadow">
              @{creatorHandle}
            </span>
          )}
          <span className="text-[11px] font-semibold text-sky-200 drop-shadow">
            {formatDate(v.posted_at)}
          </span>
          <span className="line-clamp-2 text-xs leading-snug text-white/95 drop-shadow">
            {v.caption?.split("\n")[0] || v.shortcode || "—"}
          </span>
        </span>
        <span className="absolute right-2 top-2 flex items-center gap-1">
          {showLift && row.lift != null && (
            <span className="rounded-md bg-neutral-900/85 px-1.5 py-0.5 text-[10px] font-bold tabular-nums text-white shadow-sm">
              {row.lift >= 10 ? Math.round(row.lift) : row.lift.toFixed(1)}×
            </span>
          )}
          <span className="shadow-sm">
            <ResearchScoreChip score={row.score} />
          </span>
        </span>
        {v.format_category && (
          <span className="absolute left-2 top-2 max-w-[70%] truncate rounded-md bg-white/95 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 shadow-sm">
            {v.format_category}
          </span>
        )}
      </div>
    </ResearchSelectTrigger>
  );
}
