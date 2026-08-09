"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  clearScrapeQueue,
  drainScrapeQueue,
  enqueueScrapeAll,
  readQueueState,
} from "@/app/(app)/scrape-actions";
import type { ResearchCreatorKind } from "@/lib/types";

type Phase = "idle" | "queuing" | "running" | "stopping";

function Spinner({ className = "" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/**
 * "Scrape all" button plus the loop that works through the queue.
 *
 * Each pull takes tens of seconds, so a full pass over 30+ creators can't
 * happen in one request. The server drains a single creator per call and this
 * component keeps calling until the queue empties, which also gives live
 * progress and a stop button. The page has to stay open for the run to
 * continue — that's the trade for having no background process.
 */
export function ScrapeAllButton({
  kinds,
  appId = null,
  label = "Scrape all",
  queued = 0,
}: {
  kinds: ResearchCreatorKind[];
  /** Roster scoping: only creators in this app. */
  appId?: string | null;
  label?: string;
  /** Queue depth at render time, so a reload shows work still pending. */
  queued?: number;
}) {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [remaining, setRemaining] = useState(queued);
  const [done, setDone] = useState(0);
  const [failed, setFailed] = useState(0);
  const [current, setCurrent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  // Read inside the loop without making it a dependency, so setting it to true
  // stops the run without restarting the effect.
  const stopRef = useRef(false);
  const runningRef = useRef(false);

  useEffect(() => setRemaining(queued), [queued]);

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, ms));

  const runLoop = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPhase("running");
    try {
      // Bounded so a bug in the drain logic can't spin forever.
      for (let guard = 0; guard < 500; guard++) {
        if (stopRef.current) break;
        const step = await drainScrapeQueue();
        if (step.handle == null) {
          setRemaining(0);
          break;
        }
        setCurrent(step.handle);
        setRemaining(step.remaining);
        if (step.ok) setDone((n) => n + 1);
        else {
          setFailed((n) => n + 1);
          setError(`@${step.handle}: ${step.error ?? "failed"}`);
        }
        if (step.remaining === 0) break;
        if (step.staggerSeconds > 0) await sleep(step.staggerSeconds * 1000);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      runningRef.current = false;
      stopRef.current = false;
      setCurrent(null);
      setPhase("idle");
      startTransition(() => router.refresh());
    }
  }, [router]);

  const start = async () => {
    setError(null);
    setDone(0);
    setFailed(0);
    setPhase("queuing");
    try {
      await enqueueScrapeAll({ kinds, appId });
      const { remaining: n } = await readQueueState();
      setRemaining(n);
      if (n === 0) {
        setPhase("idle");
        return;
      }
      await runLoop();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("idle");
    }
  };

  const stop = async () => {
    stopRef.current = true;
    setPhase("stopping");
    try {
      await clearScrapeQueue();
      setRemaining(0);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const busy = phase !== "idle";
  // Display-only progress. `remaining` is the live queue depth the server
  // reports each drain; processed + remaining tracks the initial batch size.
  const processed = done + failed;
  const total = processed + remaining;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

  return (
    <span className="flex flex-wrap items-center gap-2.5">
      {busy ? (
        <button
          type="button"
          onClick={stop}
          disabled={phase === "stopping"}
          className="inline-flex items-center gap-1.5 rounded-full bg-danger/[0.1] px-3 py-1.5 text-xs font-medium text-danger ring-1 ring-inset ring-danger/[0.22] transition hover:bg-danger/[0.16] active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-danger/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-60"
        >
          {phase === "stopping" ? (
            <>
              <Spinner />
              Stopping…
            </>
          ) : (
            <>
              <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop
            </>
          )}
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          className="inline-flex items-center gap-1.5 rounded-full bg-neutral-900 px-3.5 py-1.5 text-xs font-medium text-white shadow-ambient transition hover:bg-neutral-800 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          {label}
          {remaining > 0 && (
            <span className="rounded-full bg-white/15 px-1.5 py-px font-mono text-[10px] tabular-nums">
              {remaining}
            </span>
          )}
        </button>
      )}

      {busy && (
        <span className="inline-flex items-center gap-2">
          <Spinner className="text-neutral-400" />
          <span className="text-xs text-neutral-500">
            {phase === "queuing" ? (
              "Queuing…"
            ) : current ? (
              <>
                Scraping <span className="font-mono text-neutral-700">@{current}</span>
              </>
            ) : (
              "Working…"
            )}
          </span>
          {phase !== "queuing" && total > 0 && (
            <span className="inline-flex items-center gap-2">
              <span
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                className="block h-1.5 w-24 overflow-hidden rounded-full bg-surface-sunken ring-1 ring-hairline"
              >
                <span
                  className="block h-full rounded-full bg-neutral-900 transition-[width] duration-500"
                  style={{ width: `${pct}%` }}
                />
              </span>
              <span className="font-mono text-[11px] tabular-nums text-neutral-400">
                {processed}/{total}
              </span>
            </span>
          )}
        </span>
      )}

      {!busy && (done > 0 || failed > 0) && (
        <span className="inline-flex items-center gap-1.5 text-xs">
          <span className="inline-flex items-center gap-1 rounded-full bg-success/[0.1] px-2 py-0.5 font-medium text-success ring-1 ring-inset ring-success/[0.22]">
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
              <path d="m5 13 4 4L19 7" />
            </svg>
            {done} scraped
          </span>
          {failed > 0 && (
            <span className="rounded-full bg-danger/[0.1] px-2 py-0.5 font-medium text-danger ring-1 ring-inset ring-danger/[0.22]">
              {failed} failed
            </span>
          )}
        </span>
      )}

      {error && (
        <span
          className="max-w-md truncate rounded-full bg-danger/[0.1] px-2 py-0.5 text-xs text-danger ring-1 ring-inset ring-danger/[0.22]"
          title={error}
        >
          {error}
        </span>
      )}

      {busy && <span className="text-[11px] text-neutral-400">Keep this tab open</span>}
    </span>
  );
}
