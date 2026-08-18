"use client";

import { useMemo, useRef, useState } from "react";
import type { DayPoint } from "@/lib/overview-stats";
import { formatCompact } from "@/lib/format";

/**
 * The Overview time series: every metric as its own line on one shared axis,
 * with a legend up top and a combined tooltip on hover — date, then one row
 * per metric. Views dominates the scale (it always will), so it also gets a
 * soft area fill; the rest ride the baseline exactly like the source data.
 *
 * The palette is categorical, assigned in this fixed order, and validated with
 * the dataviz six-checks script (lightness band, chroma floor, adjacent-pair
 * CVD ≥8, normal-vision floor, ≥3:1 contrast on white) — don't reorder or
 * substitute hues without re-running it.
 */
const SERIES = [
  { key: "views", label: "Views", color: "#2a78d6" },
  { key: "engagement", label: "Engagement", color: "#c73a80" },
  { key: "likes", label: "Likes", color: "#6d28d9" },
  { key: "comments", label: "Comments", color: "#008300" },
  { key: "shares", label: "Shares", color: "#0891b2" },
  { key: "posts", label: "Posts", color: "#b45309" },
] as const;
type SeriesKey = (typeof SERIES)[number]["key"];

export function OverviewChart({ points }: { points: DayPoint[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);

  const W = 1000;
  const H = 300;
  const PAD = { top: 14, right: 12, bottom: 26, left: 46 };
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;

  const { xs, lines, ticks, xLabels, yFor } = useMemo(() => {
    const max =
      Math.max(1, ...points.flatMap((p) => SERIES.map((s) => p[s.key]))) * 1.08;
    const step = points.length > 1 ? iw / (points.length - 1) : 0;
    const xs = points.map((_, i) => PAD.left + (points.length > 1 ? i * step : iw / 2));
    const yFor = (v: number) => PAD.top + ih * (1 - v / max);
    const pathFor = (key: SeriesKey) =>
      xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${yFor(points[i][key]).toFixed(1)}`).join("");
    const lines = SERIES.map((s) => ({ ...s, d: pathFor(s.key) }));
    const ticks = [0.25, 0.5, 0.75, 1].map((f) => ({
      y: PAD.top + ih * (1 - f),
      label: formatCompact(Math.round(max * f)),
    }));
    const every = Math.max(1, Math.ceil(points.length / 7));
    const xLabels = points
      .map((p, i) => ({ x: xs[i], label: p.label, i }))
      .filter(({ i }) => i % every === 0 || i === points.length - 1);
    return { xs, lines, ticks, xLabels, yFor };
  }, [points, iw, ih, PAD.left, PAD.top]);

  const viewsArea =
    points.length > 0
      ? `${lines[0].d}L${xs[xs.length - 1].toFixed(1)},${PAD.top + ih}L${xs[0].toFixed(1)},${PAD.top + ih}Z`
      : "";

  const locate = (clientX: number): number | null => {
    const svg = svgRef.current;
    if (!svg || points.length === 0) return null;
    const rect = svg.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * W;
    let best = 0;
    for (let i = 1; i < xs.length; i++) if (Math.abs(xs[i] - x) < Math.abs(xs[best] - x)) best = i;
    return best;
  };

  const h = hover != null ? { x: xs[hover], p: points[hover] } : null;
  // Flip the tooltip to the other side of the crosshair near the right edge.
  const tooltipLeft = h != null && h.x > W * 0.62;

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-end gap-x-4 gap-y-1.5">
        {SERIES.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5 text-xs text-neutral-500">
            <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>

      <div className="relative">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H}`}
          className="block h-auto w-full"
          role="img"
          aria-label="Views, engagement, likes, comments, shares and posts per day"
          onMouseMove={(e) => setHover(locate(e.clientX))}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id="ov-views-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#2a78d6" stopOpacity="0.12" />
              <stop offset="100%" stopColor="#2a78d6" stopOpacity="0.01" />
            </linearGradient>
          </defs>

          {ticks.map((t) => (
            <g key={t.y}>
              <line x1={PAD.left} x2={W - PAD.right} y1={t.y} y2={t.y} stroke="var(--color-hairline)" />
              <text x={PAD.left - 8} y={t.y + 3.5} textAnchor="end" fontSize="11" className="fill-neutral-400 tabular-nums">
                {t.label}
              </text>
            </g>
          ))}
          <line
            x1={PAD.left} x2={W - PAD.right} y1={PAD.top + ih} y2={PAD.top + ih}
            stroke="var(--color-hairline-strong)"
          />
          {xLabels.map((t) => (
            <text key={t.i} x={t.x} y={H - 8} textAnchor="middle" fontSize="11" className="fill-neutral-400">
              {t.label}
            </text>
          ))}

          <path d={viewsArea} fill="url(#ov-views-fill)" />
          {/* Views last so the hero line sits above the baseline bunch. */}
          {[...lines].reverse().map((s) => (
            <path key={s.key} d={s.d} fill="none" stroke={s.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
          ))}

          {h && (
            <g>
              <line x1={h.x} x2={h.x} y1={PAD.top} y2={PAD.top + ih} stroke="var(--color-hairline-strong)" />
              {SERIES.map((s) => (
                <circle
                  key={s.key}
                  cx={h.x}
                  cy={yFor(h.p[s.key])}
                  r="4"
                  fill={s.color}
                  stroke="var(--color-surface)"
                  strokeWidth="2"
                />
              ))}
            </g>
          )}
        </svg>

        {h && (
          <div
            className="pointer-events-none absolute top-2 z-10 w-48 rounded-xl bg-surface p-3 shadow-raised ring-1 ring-hairline"
            style={
              tooltipLeft
                ? { right: `${100 - (h.x / W) * 100}%`, marginRight: "12px" }
                : { left: `${(h.x / W) * 100}%`, marginLeft: "12px" }
            }
          >
            <div className="text-xs font-semibold text-neutral-900">{h.p.label}</div>
            <dl className="mt-2 space-y-1.5">
              {SERIES.map((s) => (
                <div key={s.key} className="flex items-center gap-1.5">
                  <span aria-hidden className="h-2 w-2 shrink-0 rounded-full" style={{ background: s.color }} />
                  <dt className="flex-1 text-xs text-neutral-500">{s.label}</dt>
                  <dd className="text-xs font-medium tabular-nums text-neutral-900">
                    {formatCompact(h.p[s.key])}
                  </dd>
                </div>
              ))}
            </dl>
          </div>
        )}
      </div>
    </div>
  );
}
