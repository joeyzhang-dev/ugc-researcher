"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import type { VideoLift } from "@/lib/research";
import { formatCompact, formatDate } from "@/lib/format";

/**
 * Detail-panel selection for the Research page — same tiny external-store
 * pattern as video-selection.tsx (no context, no URL navigation, no scroll
 * jumps), but typed to a lift row so the panel can show scores.
 */
let selected: VideoLift | null = null;
const listeners = new Set<() => void>();

function selectRow(row: VideoLift | null) {
  selected = row;
  for (const l of listeners) l();
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function useSelectedRow() {
  return useSyncExternalStore(
    subscribe,
    () => selected,
    () => null,
  );
}

/** Clickable wrapper (table row cell / grid card) toggling the panel. */
export function ResearchSelectTrigger({
  row,
  className,
  selectedClassName,
  children,
}: {
  row: VideoLift;
  className?: string;
  selectedClassName?: string;
  children: ReactNode;
}) {
  const current = useSelectedRow();
  const isSelected = current?.video.id === row.video.id;
  const toggle = () => selectRow(isSelected ? null : row);

  // After a revalidation the row prop is fresh — keep the open panel in sync.
  useEffect(() => {
    if (current && current.video.id === row.video.id && current !== row) {
      selectRow(row);
    }
  }, [row, current]);

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={isSelected}
      onClick={toggle}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggle();
        }
      }}
      className={`cursor-pointer${className ? ` ${className}` : ""}${isSelected && selectedClassName ? ` ${selectedClassName}` : ""}`}
    >
      {children}
    </div>
  );
}

function scoreStyle(score: number): string {
  if (score >= 8) return "bg-amber-100 text-amber-800";
  if (score >= 6.5) return "bg-emerald-50 text-emerald-700";
  if (score >= 4) return "bg-neutral-100 text-neutral-600";
  return "bg-red-50 text-red-600";
}

export function ResearchScoreChip({ score, size = "sm" }: { score: number | null; size?: "sm" | "lg" }) {
  if (score == null) return <span className="text-xs text-neutral-400">—</span>;
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md font-bold tabular-nums ${
        size === "lg" ? "px-2 py-1 text-sm" : "min-w-9 px-1.5 py-0.5 text-xs"
      } ${scoreStyle(score)}`}
    >
      {score.toFixed(1)}
    </span>
  );
}

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <span className="block">
      <span className="block text-[11px] text-neutral-400">{label}</span>
      <span className="block text-sm font-semibold tabular-nums">{value}</span>
    </span>
  );
}

/** One timestamped transcript line (WhisperX segment). */
export interface PanelSegment {
  position: number;
  start_time: number | null;
  text: string;
}

/** 83.4s → "1:23" */
function fmtTimestamp(secs: number | null): string {
  if (secs == null) return "–:––";
  const s = Math.max(0, Math.floor(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Right-hand panel for the selected research video: playable video, score,
 *  lift breakdown, counts, hashtags, transcript. Nothing until selection. */
export function ResearchVideoPanel({
  segmentsByVideo,
}: {
  segmentsByVideo: Record<string, PanelSegment[]>;
}) {
  const row = useSelectedRow();
  if (!row) return null;
  const v = row.video;
  const segments = segmentsByVideo[v.id] ?? [];

  return (
    <aside className="sticky top-6 w-[380px] shrink-0 rounded-xl border border-neutral-200 bg-white">
      <header className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold">
          Video details <ResearchScoreChip score={row.score} />
        </h2>
        <button
          type="button"
          onClick={() => selectRow(null)}
          className="rounded-md px-2 py-0.5 text-sm text-neutral-400 hover:bg-neutral-100 hover:text-neutral-900"
          aria-label="Close panel"
        >
          ✕
        </button>
      </header>

      <div className="max-h-[calc(100vh-8rem)] space-y-3 overflow-y-auto p-4">
        {/* Player — the scraped CDN file, watchable in place. */}
        <div className="overflow-hidden rounded-xl bg-neutral-950">
          {v.video_url ? (
            <video
              key={v.id}
              src={v.video_url}
              poster={v.thumbnail_url ?? undefined}
              controls
              playsInline
              preload="metadata"
              className="mx-auto aspect-[9/16] max-h-[420px] w-auto"
            />
          ) : v.thumbnail_url ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={v.thumbnail_url} alt="" className="mx-auto aspect-[9/16] max-h-[420px] w-auto object-cover" />
          ) : (
            <span className="flex aspect-[9/16] max-h-[420px] items-center justify-center text-neutral-600">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m10 9 5 3-5 3V9Z" /></svg>
            </span>
          )}
        </div>

        <div>
          <p className="text-sm font-semibold leading-snug">
            {v.caption?.split("\n")[0] || v.shortcode || "Reel"}
          </p>
          <p className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-neutral-400">
            {v.posted_at && <span>{formatDate(v.posted_at)}</span>}
            {v.posted_at && <span>·</span>}
            <a href={v.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-neutral-700">
              Open original ↗
            </a>
            {v.format_category && (
              <>
                <span>·</span>
                <span className="rounded-md bg-violet-50 px-1.5 py-0.5 font-medium text-violet-700">
                  {v.format_category}
                </span>
              </>
            )}
          </p>
        </div>

        {/* Counts */}
        <dl className="grid grid-cols-4 divide-x divide-neutral-100 rounded-xl border border-neutral-200 py-2.5 text-center">
          <Stat label="Views" value={formatCompact(v.view_count)} />
          <Stat label="Likes" value={formatCompact(v.like_count)} />
          <Stat label="Comments" value={formatCompact(v.comment_count)} />
          <Stat label="Shares" value={formatCompact(v.share_count)} />
        </dl>

        {/* Lift breakdown */}
        <div className="rounded-xl border border-neutral-200 p-3">
          <p className="mb-2 text-xs font-semibold text-neutral-700">Lift vs creator baseline</p>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
            <span className="text-neutral-500">Score</span>
            <span className="text-right"><ResearchScoreChip score={row.score} /></span>
            <span className="text-neutral-500">
              Lift{row.liftBasis === "overall" ? " (overall)" : " (trailing 10)"}
            </span>
            <span className="text-right font-semibold tabular-nums">{fmtLift(row.lift)}</span>
            <span className="text-neutral-500">±45-day window</span>
            <span className="text-right tabular-nums">{fmtLift(row.windowLift)}</span>
            <span className="text-neutral-500">Whole account</span>
            <span className="text-right tabular-nums">{fmtLift(row.overallLift)}</span>
            <span className="text-neutral-500">Engagement</span>
            <span className="text-right tabular-nums">
              {row.engagementPct != null ? `${row.engagementPct.toFixed(1)}%` : "—"}
            </span>
          </dl>
        </div>

        {v.caption && v.caption.split("\n").length > 1 && (
          <div className="rounded-xl border border-neutral-200 p-3">
            <p className="mb-1.5 text-xs font-semibold text-neutral-700">Caption</p>
            <p className="whitespace-pre-wrap text-xs leading-relaxed text-neutral-600">{v.caption}</p>
          </div>
        )}

        {v.hashtags.length > 0 && (
          <p className="flex flex-wrap gap-1">
            {v.hashtags.map((h) => (
              <span key={h} className="rounded-md bg-neutral-100 px-1.5 py-0.5 text-xs text-neutral-500">
                #{h}
              </span>
            ))}
          </p>
        )}

        {/* Script — timestamped lines, ugc-ops style. */}
        <div className="rounded-xl border border-neutral-200 p-3">
          <p className="mb-1.5 flex items-center justify-between text-xs font-semibold text-neutral-700">
            Script
            <span className="font-normal text-neutral-400">
              {v.transcript_status === "transcribed" ? v.transcript_method : v.transcript_status}
            </span>
          </p>
          {segments.length > 0 ? (
            <ol className="max-h-72 divide-y divide-neutral-50 overflow-y-auto">
              {segments.map((s) => (
                <li key={s.position} className="flex gap-2.5 py-1.5">
                  <span className="w-9 shrink-0 pt-px text-right font-mono text-[10px] tabular-nums text-neutral-400">
                    {fmtTimestamp(s.start_time)}
                  </span>
                  <span className="min-w-0 text-xs leading-relaxed text-neutral-700">{s.text}</span>
                </li>
              ))}
            </ol>
          ) : v.transcript_text ? (
            <p className="max-h-72 overflow-y-auto whitespace-pre-wrap text-xs leading-relaxed text-neutral-600">
              {v.transcript_text}
            </p>
          ) : (
            <p className="text-xs text-neutral-400">
              {v.transcript_status === "failed"
                ? `Failed: ${v.error_message ?? "unknown error"}`
                : "Not transcribed yet — the local worker is working through the queue."}
            </p>
          )}
        </div>
      </div>
    </aside>
  );
}
