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

  return (
    <span className="flex flex-wrap items-center gap-2">
      {busy ? (
        <button
          type="button"
          onClick={stop}
          disabled={phase === "stopping"}
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-1.5 text-xs font-medium text-red-700 transition-colors hover:bg-red-100 disabled:opacity-60"
        >
          {phase === "stopping" ? "Stopping…" : "Stop"}
        </button>
      ) : (
        <button
          type="button"
          onClick={start}
          className="rounded-lg bg-neutral-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-neutral-700"
        >
          {label}
          {remaining > 0 ? ` (${remaining} queued)` : ""}
        </button>
      )}

      {busy && (
        <span className="text-xs text-neutral-500">
          {phase === "queuing"
            ? "Queuing…"
            : current
              ? `Scraping @${current} · ${remaining} left`
              : `${remaining} left`}
        </span>
      )}

      {!busy && (done > 0 || failed > 0) && (
        <span className="text-xs text-neutral-500">
          Done: {done} scraped{failed > 0 ? `, ${failed} failed` : ""}
        </span>
      )}

      {error && (
        <span className="max-w-md truncate text-xs text-red-600" title={error}>
          {error}
        </span>
      )}

      {busy && (
        <span className="text-[11px] text-neutral-400">Keep this tab open</span>
      )}
    </span>
  );
}
