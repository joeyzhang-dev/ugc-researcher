"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

/**
 * "Custom" window picker.
 *
 * Deliberately drives the URL itself rather than taking an `hrefForDays`
 * function like the preset links do: this is a client component, and functions
 * cannot cross the server/client boundary as props. Rewriting only the `days`
 * key of the current query preserves every other filter, which is exactly what
 * each page's own hrefForDays does.
 */
export function CustomRange({
  current,
  options,
  isCustom,
}: {
  current: number | null;
  /** Longer windows that would make the inline row unusably wide. */
  options: readonly number[];
  /** Whether `current` is a value the inline presets don't already show. */
  isCustom: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(current ? String(current) : "");
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    // Land keyboard users on the primary action (typing an exact window).
    inputRef.current?.focus();
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const go = (days: number | null) => {
    const sp = new URLSearchParams(params.toString());
    if (days == null) sp.delete("days");
    else sp.set("days", String(days));
    const qs = sp.toString();
    setOpen(false);
    router.push(`${pathname}${qs ? `?${qs}` : ""}`, { scroll: false });
  };

  const applyDraft = () => {
    const n = Math.round(Number(draft));
    if (!Number.isFinite(n) || n < 1) return;
    go(Math.min(n, 3650));
  };

  return (
    <span ref={wrapRef} className="relative inline-flex">
      <span className="inline-flex items-center rounded-xl bg-surface-sunken p-1 ring-1 ring-hairline">
        <button
          ref={triggerRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-haspopup="dialog"
          aria-expanded={open}
          className={`inline-flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas ${
            isCustom
              ? "bg-surface text-neutral-900 shadow-ambient ring-1 ring-hairline"
              : "text-neutral-500 hover:text-neutral-900 active:scale-[0.97]"
          }`}
        >
          {isCustom ? `${current}d` : "Custom"}
          <svg
            width="11"
            height="11"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className={`shrink-0 text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
      </span>

      {open && (
        <span
          role="dialog"
          aria-label="Custom recency window"
          className="absolute right-0 top-[calc(100%+8px)] z-40 block w-64 animate-fade-up rounded-2xl bg-surface p-3 shadow-raised ring-1 ring-hairline inset-shadow-highlight"
        >
          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400">
            Longer windows
          </span>
          <span className="mb-3 flex flex-wrap gap-1">
            {options.map((d) => {
              const on = current === d;
              return (
                <button
                  key={d}
                  type="button"
                  onClick={() => go(d)}
                  aria-pressed={on}
                  className={`rounded-lg px-2 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 ${
                    on
                      ? "bg-neutral-900 text-white shadow-ambient"
                      : "text-neutral-600 ring-1 ring-hairline hover:bg-surface-muted hover:text-neutral-900 active:scale-[0.97]"
                  }`}
                >
                  {d >= 365 && d % 365 === 0 ? `${d / 365}y` : d % 30 === 0 ? `${d / 30}mo` : `${d}d`}
                </button>
              );
            })}
          </span>

          <span className="mb-1.5 block text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400">
            Exact number of days
          </span>
          <span className="flex items-center gap-1.5">
            <input
              ref={inputRef}
              type="number"
              min={1}
              max={3650}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  applyDraft();
                }
              }}
              placeholder="e.g. 45"
              className="w-full min-w-0 rounded-lg bg-surface px-2 py-1 text-xs text-neutral-900 shadow-[inset_0_1px_2px_rgb(9_9_11/0.04)] ring-1 ring-hairline transition placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/45"
            />
            <button
              type="button"
              onClick={applyDraft}
              className="shrink-0 rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white shadow-ambient transition hover:bg-neutral-800 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Apply
            </button>
          </span>

          {current != null && (
            <button
              type="button"
              onClick={() => go(null)}
              className="mt-2 block text-[11px] text-neutral-400 transition-colors hover:text-neutral-900"
            >
              Clear — show all time
            </button>
          )}
        </span>
      )}
    </span>
  );
}
