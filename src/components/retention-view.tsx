/**
 * Retention presentation — bands, chips, stat block and the daily view curve.
 *
 * Directive-free on purpose, same reason as research-score.tsx: the retention
 * panel is a client component but the scripts and creator pages are server
 * components, and a server component may not *call* a function exported from a
 * "use client" module. Keeping these hook-free and un-directived lets both
 * sides use them.
 *
 * ── Where the thresholds come from ────────────────────────────────────────
 * They are not invented. A 178-post sample of the live Folk corpus (every
 * Instagram post we hold a duration for, sampled 2026-08-26) gives:
 *
 *     hold rate   p10 0.21   p25 0.26   median 0.32   p75 0.41   p90 0.49
 *     skip rate   p10 30     p25 35     median 42     p75 49     p90 54
 *     save rate   p10 0.004  p25 0.007  median 0.013  p75 0.026  p90 0.042
 *
 * The bands are those quartiles, so "strong" means *strong against this
 * roster* rather than against a number someone liked the look of. Re-measure
 * before changing them.
 *
 * One finding worth keeping in view: posts above 50k views ran a median hold
 * of 0.36 against 0.32 for posts under 5k, and a median skip of 36 against 43.
 * Small sample on the winners' side (n=6), but it is the direction the whole
 * integration exists to test.
 */

import { formatCompact, formatPercent, formatUsd, formatWatchTime } from "@/lib/format";
import { dayOneShare, isStillClimbing, retentionMetrics, type RetentionInput } from "@/lib/retention";
import type { ScoreBand } from "./research-score";

/** Hold rate → band, from the measured quartiles above. */
export function holdRateBand(holdRate: number): ScoreBand {
  if (holdRate >= 0.49) return "elite";
  if (holdRate >= 0.41) return "strong";
  if (holdRate >= 0.26) return "base";
  return "weak";
}

/** Skip rate → band. Inverted: **lower is better**, which is the whole reason
 *  this is a separate function rather than a shared numeric ramp. */
export function skipRateBand(skipRate: number): ScoreBand {
  if (skipRate <= 30) return "elite";
  if (skipRate <= 35) return "strong";
  if (skipRate <= 49) return "base";
  return "weak";
}

const BAND_CHIP: Record<ScoreBand, string> = {
  elite: "bg-warning/[0.14] text-warning ring-warning/30",
  strong: "bg-success/[0.1] text-success ring-success/[0.22]",
  base: "bg-neutral-500/[0.1] text-neutral-600 ring-neutral-500/[0.16]",
  weak: "bg-danger/[0.08] text-danger ring-danger/[0.2]",
};

/** A banded metric pill. `band` null renders a plain value — used where the
 *  number is informative but has no good/bad direction (reach, saves). */
export function RetentionChip({
  value,
  band,
  title,
}: {
  value: string;
  band?: ScoreBand | null;
  title?: string;
}) {
  if (value === "—") return <span className="text-xs text-neutral-400">—</span>;
  return (
    <span
      title={title}
      className={`inline-flex items-center justify-center rounded-md px-1.5 py-0.5 font-mono text-xs font-bold tabular-nums ring-1 ring-inset ${
        band ? BAND_CHIP[band] : "bg-neutral-500/[0.06] text-neutral-600 ring-neutral-500/[0.12]"
      }`}
    >
      {value}
    </span>
  );
}

/** Hold-rate chip: the headline retention number. */
export function HoldRateChip({ holdRate }: { holdRate: number | null }) {
  if (holdRate == null) return <span className="text-xs text-neutral-400">—</span>;
  return (
    <RetentionChip
      value={formatPercent(holdRate)}
      band={holdRateBand(holdRate)}
      title={`Average viewer watched ${formatPercent(holdRate)} of the video${
        holdRate > 1 ? " — over 100% means they replayed it" : ""
      }`}
    />
  );
}

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <>
      <span className="text-neutral-500" title={hint}>
        {label}
      </span>
      <span className="text-right">{children}</span>
    </>
  );
}

/**
 * The retention block for the video detail panel.
 *
 * Renders nothing at all when Launchpoint has no insights for the post —
 * an empty grid of em-dashes reads as "broken", while absence reads correctly
 * as "this is an outside creator, or it hasn't synced yet".
 */
export function RetentionStats({ input }: { input: RetentionInput }) {
  const m = retentionMetrics(input);
  const hasAny = m.holdRate != null || m.skipRate != null || input.reach != null;
  if (!hasAny) return null;

  return (
    <div className="rounded-xl bg-surface-muted p-3 ring-1 ring-hairline">
      <p className="mb-2 flex items-center justify-between text-xs font-semibold text-neutral-700">
        Retention
        <span className="font-normal text-neutral-400" title="First-party Instagram metrics, via Launchpoint — not available from a public scrape">
          Launchpoint
        </span>
      </p>
      <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5 text-sm">
        <Row label="Held" hint="Average watch time as a share of the video's length. Over 100% means viewers replayed.">
          <HoldRateChip holdRate={m.holdRate} />
        </Row>
        <Row label="Skipped" hint="Share of viewers who swiped away. Lower is better.">
          {m.skipRate != null ? (
            <RetentionChip value={`${m.skipRate.toFixed(0)}%`} band={skipRateBand(m.skipRate)} />
          ) : (
            <span className="text-xs text-neutral-400">—</span>
          )}
        </Row>
        <Row label="Avg watch" hint="Mean milliseconds watched, as seconds">
          <span className="font-semibold tabular-nums">{formatWatchTime(input.avgWatchTimeMs)}</span>
        </Row>
        <Row label="Reach" hint="Unique accounts reached. Views counts replays; reach counts people.">
          <span className="tabular-nums">{formatCompact(input.reach)}</span>
        </Row>
        <Row label="Replays" hint="Views per person beyond the first watch">
          <span className="tabular-nums">{formatPercent(m.replayRate)}</span>
        </Row>
        <Row label="Saves" hint="Saves per person reached — the highest-intent public signal Instagram exposes">
          <span className="tabular-nums">
            {formatCompact(input.saves)}
            {m.saveRate != null && (
              <span className="ml-1 text-xs text-neutral-400">({formatPercent(m.saveRate, 1)})</span>
            )}
          </span>
        </Row>
        {input.earningsUsd != null && input.earningsUsd > 0 && (
          <>
            <Row label="Paid" hint="What this post cost">
              <span className="tabular-nums">{formatUsd(input.earningsUsd)}</span>
            </Row>
            <Row label="Cost / 1k views">
              <span className="tabular-nums">{formatUsd(m.cpmUsd)}</span>
            </Row>
          </>
        )}
      </dl>
    </div>
  );
}

export interface CurvePoint {
  date: string;
  views: number | null;
  views_delta: number | null;
}

/**
 * The daily view curve.
 *
 * This is the thing a single overwritten `view_count` could never show. The
 * area is cumulative views; the endpoint is emphasised because "where is it
 * now" is the question being asked. Instagram front-loads distribution hard —
 * a typical post takes half its lifetime views on day one — so the shape of
 * the shoulder is the interesting part, not the peak.
 *
 * Hand-rolled SVG rather than a chart library: it is one polyline, and the
 * bundle cost of a charting dependency for this is not worth paying.
 */
export function ViewCurve({ points, className = "" }: { points: CurvePoint[]; className?: string }) {
  const series = [...points]
    .filter((p) => p.views != null)
    .sort((a, b) => a.date.localeCompare(b.date));
  // One point is a dot, not a curve, and would render as a flat line implying
  // a history we do not have.
  if (series.length < 2) return null;

  const W = 320;
  const H = 64;
  const PAD = 3;
  const max = Math.max(...series.map((p) => p.views ?? 0), 1);
  const x = (i: number) => PAD + (i * (W - PAD * 2)) / (series.length - 1);
  const y = (v: number) => H - PAD - (v / max) * (H - PAD * 2);

  const line = series.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.views ?? 0).toFixed(1)}`).join(" ");
  const area = `${line} L${x(series.length - 1).toFixed(1)},${H - PAD} L${x(0).toFixed(1)},${H - PAD} Z`;

  const share = dayOneShare(series);
  const climbing = isStillClimbing(
    series.map((p) => ({ date: p.date, views: p.views, viewsDelta: p.views_delta }))
  );
  const last = series[series.length - 1];

  return (
    <div className={`rounded-xl bg-surface-muted p-3 ring-1 ring-hairline ${className}`}>
      <p className="mb-1.5 flex items-center justify-between text-xs font-semibold text-neutral-700">
        Daily views
        {climbing && (
          <span
            className="rounded-md bg-success/[0.1] px-1.5 py-0.5 text-[10px] font-medium text-success ring-1 ring-inset ring-success/[0.22]"
            title="The most recent day still added at least 1% of the post's total — it hasn't finished running"
          >
            Still climbing
          </span>
        )}
      </p>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Cumulative daily views">
        <defs>
          <linearGradient id="curve-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.16" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g className="text-accent">
          <path d={area} fill="url(#curve-fill)" />
          <path d={line} fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinejoin="round" strokeLinecap="round" />
          <circle cx={x(series.length - 1)} cy={y(last.views ?? 0)} r="2.75" fill="currentColor" />
        </g>
      </svg>
      <p className="mt-1 flex items-center justify-between font-mono text-[10px] text-neutral-400">
        <span>{series[0].date.slice(5)}</span>
        <span className="text-neutral-500">
          {share != null && `${formatPercent(share)} on day one · `}
          {series.length} days
        </span>
        <span>{last.date.slice(5)}</span>
      </p>
    </div>
  );
}
