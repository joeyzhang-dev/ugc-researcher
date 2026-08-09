/**
 * Score + format presentation, shared by BOTH server and client components.
 *
 * These are pure and hook-free, but they used to live in research-panel.tsx,
 * which is a "use client" module. A server component may *render* a client
 * component, but it may not *call* a function exported from one — the server
 * build replaces it with a client reference, so `scoreBand(x)` threw
 * "Attempted to call scoreBand() from the server" and 500'd /overview. Keeping
 * them in a directive-free module lets the server call them directly while
 * client importers still bundle them normally.
 */
/**
 * Lift score → visual band. The 0–10 score is the hero metric of the research
 * surface, so it rides a deliberate four-step ramp instead of a per-tenth
 * rainbow: gold marks the breakouts worth studying (8.0+ ≈ 2.8× lift), green
 * clears the baseline, neutral sits on it, danger falls below. Thresholds live
 * here only — every score chip in the app derives from this one function.
 */
export type ScoreBand = "elite" | "strong" | "base" | "weak";

export function scoreBand(score: number): ScoreBand {
  if (score >= 8) return "elite";
  if (score >= 6) return "strong";
  if (score >= 4) return "base";
  return "weak";
}

// On-light chip (tables, rollups, panel) — low-alpha tint + legible token text.
const SCORE_CHIP: Record<ScoreBand, string> = {
  elite: "bg-warning/[0.14] text-warning ring-warning/30",
  strong: "bg-success/[0.1] text-success ring-success/[0.22]",
  base: "bg-neutral-500/[0.1] text-neutral-600 ring-neutral-500/[0.16]",
  weak: "bg-danger/[0.08] text-danger ring-danger/[0.2]",
};

export function ResearchScoreChip({
  score,
  size = "sm",
}: {
  score: number | null;
  size?: "sm" | "lg";
}) {
  if (score == null) return <span className="text-xs text-neutral-400">—</span>;
  return (
    <span
      className={`inline-flex items-center justify-center rounded-md font-mono font-bold tabular-nums ring-1 ring-inset ${
        size === "lg" ? "min-w-10 px-2 py-1 text-sm" : "min-w-9 px-1.5 py-0.5 text-xs"
      } ${SCORE_CHIP[scoreBand(score)]}`}
    >
      {score.toFixed(1)}
    </span>
  );
}

/**
 * Format-category chip. Every detected format shares one violet identity so the
 * buckets read as a designed taxonomy rather than a wall of raw strings;
 * uncategorized recedes to a quiet neutral. Presentational — wrap in a Link at
 * the call sites that filter. `onMedia` swaps to a legible light surface for
 * dark grid-tile overlays.
 */
export function FormatTag({
  name,
  active = false,
  muted = false,
  onMedia = false,
  className = "",
}: {
  name: string;
  active?: boolean;
  muted?: boolean;
  onMedia?: boolean;
  className?: string;
}) {
  const tone = onMedia
    ? `bg-surface/90 shadow-sm backdrop-blur ring-black/[0.06] ${muted ? "text-neutral-500" : "text-violet-700"}`
    : muted
      ? "bg-neutral-500/[0.08] text-neutral-400 ring-neutral-500/[0.12]"
      : active
        ? "bg-violet-500/[0.16] text-violet-700 ring-violet-500/40"
        : "bg-violet-500/[0.1] text-violet-700 ring-violet-500/[0.2]";
  return (
    <span
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone} ${className}`}
    >
      <svg
        width="9"
        height="9"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.4"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="shrink-0 opacity-70"
        aria-hidden
      >
        <path d="M3 7.6V4a1 1 0 0 1 1-1h3.6a1 1 0 0 1 .7.3l11 11a1 1 0 0 1 0 1.4l-4.6 4.6a1 1 0 0 1-1.4 0l-11-11a1 1 0 0 1-.3-.7Z" />
        <circle cx="7" cy="7" r="1.1" fill="currentColor" stroke="none" />
      </svg>
      <span className="min-w-0 truncate">{name}</span>
    </span>
  );
}
