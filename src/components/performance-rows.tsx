import Link from "next/link";
import type { PerformanceRow as PerformanceRowData } from "@/lib/jobs/performance";
import { DEFAULT_PAYSCALE, type Bucket, type Delta } from "@/lib/performance";
import { Avatar, DiscordIcon } from "@/components/ui";
import { formatCompact, formatDateUTC, formatUsd } from "@/lib/format";

/** Header and rows share one column recipe. */
export const PERFORMANCE_GRID =
  "grid grid-cols-[minmax(220px,1.4fr)_minmax(90px,0.6fr)_minmax(110px,0.8fr)_minmax(120px,0.9fr)_minmax(120px,0.9fr)_minmax(90px,0.6fr)_minmax(120px,0.9fr)] items-center gap-x-3";

/**
 * One creator's line of the weekly read. Shared by /performance (staff) and
 * /coach (the coach's own team), so both surfaces are one recipe.
 *
 * `creatorHref` decides where the name goes: staff get the research detail
 * page; a coach, who cannot open /research, gets a plain name (null).
 */
export function PerformanceRow({
  row,
  showCoach,
  creatorHref,
}: {
  row: PerformanceRowData;
  showCoach: boolean;
  creatorHref: (row: PerformanceRowData) => string | null;
}) {
  const href = creatorHref(row);
  const p = row.performance;
  const cpm = p.cpm30.cpm ?? p.cpm30.projected;
  const projected = p.cpm30.cpm == null && p.cpm30.projected != null;
  return (
    <div className={`${PERFORMANCE_GRID} py-3 pr-1 transition-colors hover:bg-neutral-900/[0.03]`}>
      <div className="flex min-w-0 items-center gap-2.5">
        <Avatar name={row.handle} src={row.avatarUrl} size={34} />
        <span className="min-w-0">
          <span className="flex items-center gap-1.5">
            {href ? (
              <Link href={href} className="truncate text-sm font-semibold tracking-[-0.01em] text-neutral-900 hover:underline">
                {row.launchpointName || row.displayName || `@${row.handle}`}
              </Link>
            ) : (
              <span className="truncate text-sm font-semibold tracking-[-0.01em] text-neutral-900">
                {row.launchpointName || row.displayName || `@${row.handle}`}
              </span>
            )}
            {p.flagged && (
              <span
                title={`${p.badStreak} consecutive bad weeks — coach call or offboard`}
                className="rounded-full bg-danger/[0.1] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.06em] text-danger ring-1 ring-inset ring-danger/[0.22]"
              >
                {p.badStreak}w bad
              </span>
            )}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {row.discordUserId && <DiscordIcon size={12} />}
            <a
              href={row.profileUrl ?? `https://www.instagram.com/${row.handle}/`}
              target="_blank"
              rel="noreferrer"
              className="truncate font-mono text-[11px] text-neutral-400 hover:text-neutral-700"
            >
              @{row.handle}
            </a>
            {showCoach && (
              <span className="truncate text-[11px] text-neutral-400">
                · {row.coach?.replace(/^Coach:\s*/i, "") ?? "no coach"}
              </span>
            )}
          </span>
        </span>
      </div>

      <Cell
        value={`${p.weekly.posts}/${p.weekly.quota}`}
        sub={p.weekly.belowQuota ? "below quota" : "on quota"}
        tone={p.weekly.belowQuota ? "warn" : "ok"}
      />
      <Cell
        value={formatCompact(p.weekly.avgViews == null ? null : Math.round(p.weekly.avgViews))}
        sub={
          p.weekly.posts === 0
            ? "no posts"
            : (p.weekly.avgViews ?? 0) < DEFAULT_PAYSCALE.flatFeeMinViews
              ? `under ${formatCompact(DEFAULT_PAYSCALE.flatFeeMinViews)} · no flat fee`
              : `≈ ${formatUsd(p.weekly.projectedCpm)} CPM${
                  p.weekly.spikes.length > 0
                    ? ` · ${p.weekly.spikes.length} spike${p.weekly.spikes.length === 1 ? "" : "s"}`
                    : ""
                }`
        }
        href={p.weekly.bestPost?.url}
      />
      <Cell
        value={cpm == null ? "—" : formatUsd(cpm)}
        sub={
          cpm == null
            ? "no posts in 30d"
            : projected
              ? "≈ what Launchpoint will pay · nothing settled yet"
              : `${p.cpm30.paidPosts} paid · to ${formatDateUTC(p.cpm30.settledWindow?.end.toISOString())}${
                  p.cpm30.lowSample ? " · low sample" : ""
                }`
        }
        tone={projected || p.cpm30.lowSample ? "muted" : undefined}
      />
      {p.delta != null ? (
        <DeltaCell
          delta={p.delta}
          label={`vs prior 30d${p.cpm30.lowSample || p.cpm30.priorLowSample ? " · low sample" : ""}`}
          muted={p.cpm30.lowSample || p.cpm30.priorLowSample}
        />
      ) : p.projectedDelta != null ? (
        <DeltaCell delta={p.projectedDelta} label="this week vs last · projected" muted={false} />
      ) : (
        <Cell
          value="—"
          sub={p.cpm30.cpm != null ? "no settled month before" : p.weekly.posts > 0 ? "no posts last week" : "no posts either week"}
        />
      )}
      <Cell
        value={p.weeksSinceJoined == null ? "—" : `${p.weeksSinceJoined}w`}
        sub={
          p.onboarding.bucket
            ? `start: ${p.onboarding.bucket}${p.onboarding.final ? "" : " (pending)"}`
            : p.onboarding.joinedAt
              ? "no first-week posts"
              : "not on Launchpoint"
        }
      />
      <div className="text-right">
        <BucketChip bucket={p.bucket} projected={p.bucketSource === "projected"} />
      </div>
    </div>
  );
}

export function Cell({
  value,
  sub,
  tone,
  href,
}: {
  value: string;
  sub: string;
  tone?: "ok" | "warn" | "muted";
  href?: string;
}) {
  const subClass =
    tone === "warn" ? "text-warning" : tone === "ok" ? "text-success" : "text-neutral-400";
  return (
    <span className="text-right">
      <span
        className={`block text-[15px] font-semibold tracking-[-0.01em] tabular-nums ${
          tone === "muted" ? "text-neutral-500" : "text-neutral-900"
        }`}
      >
        {value}
      </span>
      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className={`mt-0.5 block text-[11px] leading-tight hover:underline ${subClass}`}
        >
          {sub}
        </a>
      ) : (
        <span className={`mt-0.5 block text-[11px] leading-tight ${subClass}`}>{sub}</span>
      )}
    </span>
  );
}

/** For CPM, down is good: it costs less to reach a thousand people. A change
 *  read off fewer than three paid posts is shown but not coloured — one
 *  spike entering or leaving the sample is not a trend. `label` says what
 *  the change is against, because two different comparisons share this
 *  cell: settled month vs prior month, and this week vs last (projected). */
export function DeltaCell({
  delta,
  label,
  muted,
}: {
  delta: Delta | null;
  label: string;
  muted: boolean;
}) {
  if (!delta) return <Cell value="—" sub="no prior read" />;
  const flat = Math.abs(delta.usd) < 0.005;
  const tone =
    muted || flat ? "text-neutral-500" : delta.usd < 0 ? "text-success" : "text-danger";
  const arrow = flat ? "→" : delta.usd < 0 ? "▼" : "▲";
  return (
    <span className="text-right">
      <span className={`block text-[15px] font-semibold tracking-[-0.01em] tabular-nums ${tone}`}>
        {arrow} {formatUsd(Math.abs(delta.usd))}
      </span>
      <span className="mt-0.5 block text-[11px] leading-tight tabular-nums text-neutral-400">
        {delta.pct > 0 ? "+" : ""}
        {delta.pct.toFixed(1)}% · {label}
      </span>
    </span>
  );
}

export function BucketChip({ bucket, projected }: { bucket: Bucket | null; projected: boolean }) {
  if (!bucket) {
    return <span className="font-mono text-[11px] text-neutral-400">—</span>;
  }
  const tone =
    bucket === "good"
      ? "bg-success/[0.1] text-success ring-success/[0.22]"
      : bucket === "bad"
        ? "bg-danger/[0.1] text-danger ring-danger/[0.22]"
        : "bg-warning/[0.1] text-warning ring-warning/[0.22]";
  return (
    <span
      title={projected ? "From the projected CPM — nothing in the window is paid yet" : "From the true CPM"}
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.06em] ring-1 ring-inset ${tone}`}
    >
      {bucket}
      {projected && <span className="font-normal normal-case tracking-normal opacity-70">~</span>}
    </span>
  );
}
