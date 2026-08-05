"use client";

import { useEffect, useRef, useState } from "react";
import { WorkspaceMark } from "@/components/workspace-switcher";

export type AppOption = { id: string; name: string; logoUrl?: string | null };

/**
 * App picker that shows each app's logo beside its name.
 *
 * A native <select> cannot render an image in its options, and the apps are
 * already identified by their marks everywhere else in the UI (the workspace
 * rail, the switcher) — a bare text list was the odd one out.
 *
 * Submits through a hidden input so it drops into the existing server actions
 * unchanged.
 */
export function AppSelect({
  name = "appId",
  apps,
  defaultValue = "",
  allowNone = true,
  noneLabel = "No app",
  className = "",
}: {
  name?: string;
  apps: AppOption[];
  defaultValue?: string;
  allowNone?: boolean;
  noneLabel?: string;
  className?: string;
}) {
  const [value, setValue] = useState(defaultValue);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

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

  const selected = apps.find((a) => a.id === value) ?? null;

  return (
    <div ref={wrapRef} className={`relative ${className}`}>
      <input type="hidden" name={name} value={value} />
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="flex h-10 w-full items-center gap-2 rounded-lg border border-neutral-200 bg-white px-3 text-sm text-neutral-900 transition-colors hover:border-neutral-300"
      >
        {selected ? (
          <>
            <WorkspaceMark name={selected.name} logoUrl={selected.logoUrl} size={20} />
            <span className="min-w-0 flex-1 truncate text-left">{selected.name}</span>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-left text-neutral-400">{noneLabel}</span>
        )}
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={`shrink-0 text-neutral-400 transition-transform ${open ? "rotate-180" : ""}`}
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>

      {open && (
        <ul
          role="listbox"
          className="absolute left-0 right-0 top-[calc(100%+4px)] z-40 max-h-60 overflow-y-auto rounded-xl border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {allowNone && (
            <li>
              <button
                type="button"
                onClick={() => {
                  setValue("");
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-neutral-500 hover:bg-neutral-50 ${
                  value === "" ? "bg-neutral-50" : ""
                }`}
              >
                <span className="h-5 w-5 shrink-0 rounded-md border border-dashed border-neutral-300" />
                {noneLabel}
              </button>
            </li>
          )}
          {apps.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                onClick={() => {
                  setValue(a.id);
                  setOpen(false);
                }}
                className={`flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm hover:bg-neutral-50 ${
                  value === a.id ? "bg-neutral-50" : ""
                }`}
              >
                <WorkspaceMark name={a.name} logoUrl={a.logoUrl} size={20} />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                {value === a.id && (
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
                    <path d="m5 13 4 4L19 7" />
                  </svg>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
