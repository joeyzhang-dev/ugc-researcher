"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  runLaunchpointMetadataSync,
  runLaunchpointSyncStep,
  type LaunchpointStatus,
} from "@/app/(app)/launchpoint-actions";
import { formatDateTime, formatNumber } from "@/lib/format";

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

const PHASE_LABELS: Record<string, string> = {
  creators: "Creators",
  posts: "Posts",
  insights: "Retention",
  history: "Daily curves",
};

const STATUS_TONE: Record<string, string> = {
  succeeded: "bg-success/[0.1] text-success ring-success/[0.22]",
  partial: "bg-warning/[0.12] text-warning ring-warning/[0.24]",
  failed: "bg-danger/[0.1] text-danger ring-danger/[0.2]",
};

/**
 * Launchpoint sync status and runner.
 *
 * Same browser-driven-loop shape as ScrapeAllButton, and for the same reason:
 * the first backfill is one API call per post against a 100/minute key, which
 * is about half an hour of wall clock. No single request should own that, so
 * the server does a 45-second slice, reports what is left, and this keeps
 * calling. The hourly cron does exactly the same thing unattended — this
 * button just makes it finish today instead of overnight.
 */
export function LaunchpointSync({ status }: { status: LaunchpointStatus }) {
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const [done, setDone] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const stopRef = useRef(false);
  const [, startTransition] = useTransition();

  const run = useCallback(async () => {
    setRunning(true);
    setError(null);
    setNote(null);
    setDone(0);
    stopRef.current = false;
    try {
      // Bounded so a bug in the drain logic cannot spin forever. 200 slices at
      // 45s is comfortably more than a full backfill needs.
      for (let guard = 0; guard < 200; guard++) {
        if (stopRef.current) break;
        const step = await runLaunchpointSyncStep();
        if (step.skipped) {
          setNote(step.skipped);
          break;
        }
        setDone((n) => n + (step.insights?.processed ?? 0) + (step.history?.processed ?? 0));
        setRemaining(step.remaining);
        // Failures are self-healing (the row stays stale and is retried), but
        // they must not be invisible while that happens.
        const reasons = [...(step.insights?.errors ?? []), ...(step.history?.errors ?? [])];
        setNote(reasons.length ? `Retrying past: ${reasons[0]}` : null);
        if (step.remaining === 0) break;
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      stopRef.current = false;
      startTransition(() => router.refresh());
    }
  }, [router]);

  const runMetadata = async () => {
    setRunning(true);
    setError(null);
    setNote(null);
    try {
      const res = await runLaunchpointMetadataSync();
      const parts = [
        `${res.creators?.linked ?? 0} creators linked`,
        `${res.creators?.created ?? 0} added`,
        `${res.posts?.matched ?? 0} posts matched`,
        `${res.posts?.inserted ?? 0} ingested for transcription`,
      ];
      // Never let a coverage gap pass silently — the TikTok accounts and any
      // unusable handle are deliberately not created, and that decision should
      // be visible to whoever ran the sync.
      const skippedPlatform =
        res.creators?.notCreated.filter((n) => n.reason === "platform").length ?? 0;
      const skippedHandle = res.creators?.notCreated.filter((n) => n.reason === "handle") ?? [];
      if (skippedPlatform > 0) parts.push(`${skippedPlatform} TikTok accounts left alone`);
      if (skippedHandle.length > 0) {
        parts.push(`${skippedHandle.length} unusable handle(s): ${skippedHandle.map((n) => n.handle).join(", ")}`);
      }
      if (res.creators?.possibleRenames.length) {
        parts.push(
          "possible renames, not merged: " +
            res.creators.possibleRenames.map((r) => `${r.launchpointHandle} ↔ ${r.existingHandle}`).join(", ")
        );
      }
      setNote(res.skipped ?? parts.join(" · "));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
      startTransition(() => router.refresh());
    }
  };

  const coverage =
    status.trackedVideos > 0 ? Math.round((status.withInsights / status.trackedVideos) * 100) : 0;

  if (!status.configured) {
    return (
      <p className="rounded-xl bg-warning/[0.08] p-3 text-xs text-warning ring-1 ring-inset ring-warning/[0.2]">
        <span className="font-medium">LAUNCHPOINT_API_KEY is not set.</span> Add it to
        <span className="font-mono"> .env.local</span> locally and to the Vercel project for the
        hourly cron. Without it every phase self-skips — nothing breaks, nothing syncs.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Coverage — the number that answers "is this working yet". */}
      <div className="rounded-xl bg-surface-muted p-3 ring-1 ring-hairline">
        <p className="flex items-baseline justify-between text-xs">
          <span className="font-semibold text-neutral-700">Retention coverage</span>
          <span className="font-mono tabular-nums text-neutral-500">
            {formatNumber(status.withInsights)} / {formatNumber(status.trackedVideos)} posts
          </span>
        </p>
        <span
          role="progressbar"
          aria-valuenow={coverage}
          aria-valuemin={0}
          aria-valuemax={100}
          className="mt-2 block h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken ring-1 ring-hairline"
        >
          <span
            className="block h-full rounded-full bg-accent transition-[width] duration-500"
            style={{ width: `${coverage}%` }}
          />
        </span>
        <p className="mt-1.5 font-mono text-[10px] text-neutral-400">
          {formatNumber(status.curvePoints)} daily snapshots stored
        </p>
      </div>

      {/* Per-phase state. Four rows because the phases fail and finish
          independently — one line saying "partial" would hide which half. */}
      <dl className="divide-y divide-hairline rounded-xl bg-surface-muted ring-1 ring-hairline">
        {(["creators", "posts", "insights", "history"] as const).map((phase) => {
          const row = status.phases.find((p) => p.phase === phase);
          return (
            <div key={phase} className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
              <dt className="font-medium text-neutral-700">{PHASE_LABELS[phase]}</dt>
              <dd className="flex min-w-0 items-center gap-2">
                <span className="truncate text-neutral-400" title={row?.last_detail ?? undefined}>
                  {row?.last_detail ?? "never run"}
                </span>
                {row?.last_status && (
                  <span
                    className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1 ring-inset ${
                      STATUS_TONE[row.last_status] ?? STATUS_TONE.failed
                    }`}
                    title={row.last_run_at ? formatDateTime(row.last_run_at) : undefined}
                  >
                    {row.last_status}
                  </span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="flex flex-wrap items-center gap-2.5">
        {running ? (
          <button
            type="button"
            onClick={() => {
              stopRef.current = true;
            }}
            className="inline-flex items-center gap-1.5 rounded-full bg-danger/[0.1] px-3 py-1.5 text-xs font-medium text-danger ring-1 ring-inset ring-danger/[0.22] transition hover:bg-danger/[0.16] active:scale-[0.98]"
          >
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
            Stop after this slice
          </button>
        ) : (
          <>
            <button
              type="button"
              onClick={run}
              className="inline-flex items-center gap-1.5 rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white shadow-ambient transition hover:bg-neutral-800 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Sync everything
              {remaining != null && remaining > 0 && (
                <span className="rounded-full bg-white/15 px-1.5 py-px font-mono text-[10px] tabular-nums">
                  {remaining}
                </span>
              )}
            </button>
            <button
              type="button"
              onClick={runMetadata}
              title="Creators and posts only — a handful of API calls, no retention backfill"
              className="rounded-full px-3 py-1.5 text-xs font-medium text-neutral-600 ring-1 ring-inset ring-hairline transition hover:bg-neutral-900/[0.03] hover:text-neutral-900 active:scale-[0.98]"
            >
              Creators &amp; posts only
            </button>
          </>
        )}

        {running && (
          <span className="inline-flex items-center gap-2 text-xs text-neutral-500">
            <Spinner className="text-neutral-400" />
            {done > 0 ? `${formatNumber(done)} posts synced` : "Working…"}
            {remaining != null && remaining > 0 && (
              <span className="font-mono text-[11px] tabular-nums text-neutral-400">
                {formatNumber(remaining)} left
              </span>
            )}
          </span>
        )}
      </div>

      {note && (
        <p className="rounded-lg bg-neutral-900/[0.03] px-2.5 py-1.5 text-xs text-neutral-600 ring-1 ring-inset ring-hairline">
          {note}
        </p>
      )}
      {error && (
        <p className="rounded-lg bg-danger/[0.1] px-2.5 py-1.5 text-xs text-danger ring-1 ring-inset ring-danger/[0.22]">
          {error}
        </p>
      )}
      {running && <p className="text-[11px] text-neutral-400">Keep this tab open</p>}
    </div>
  );
}
