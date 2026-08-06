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

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
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
    <span ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`rounded-md px-2.5 py-1 text-xs transition-colors ${
          isCustom ? "bg-neutral-900 font-medium text-white" : "text-neutral-500 hover:text-neutral-900"
        }`}
      >
        {isCustom ? `${current}d` : "Custom"}
      </button>

      {open && (
        <span className="absolute right-0 top-[calc(100%+6px)] z-40 block w-64 rounded-xl border border-neutral-200 bg-white p-3 shadow-lg">
          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Longer windows
          </span>
          <span className="mb-3 flex flex-wrap gap-1">
            {options.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => go(d)}
                className={`rounded-md border px-2 py-1 text-xs transition-colors ${
                  current === d
                    ? "border-neutral-900 bg-neutral-900 text-white"
                    : "border-neutral-200 text-neutral-600 hover:border-neutral-300 hover:text-neutral-900"
                }`}
              >
                {d >= 365 && d % 365 === 0 ? `${d / 365}y` : d % 30 === 0 ? `${d / 30}mo` : `${d}d`}
              </button>
            ))}
          </span>

          <span className="mb-1.5 block text-[11px] font-semibold uppercase tracking-wide text-neutral-400">
            Exact number of days
          </span>
          <span className="flex items-center gap-1.5">
            <input
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
              className="w-full min-w-0 rounded-lg border border-neutral-200 px-2 py-1 text-xs outline-none focus:border-neutral-400"
            />
            <button
              type="button"
              onClick={applyDraft}
              className="shrink-0 rounded-lg bg-neutral-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-neutral-700"
            >
              Apply
            </button>
          </span>

          {current != null && (
            <button
              type="button"
              onClick={() => go(null)}
              className="mt-2 block text-[11px] text-neutral-400 hover:text-neutral-900"
            >
              Clear — show all time
            </button>
          )}
        </span>
      )}
    </span>
  );
}
