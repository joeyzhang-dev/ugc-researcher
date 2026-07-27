"use client";

import Link from "next/link";
import { useEffect, useRef, useState, useTransition } from "react";
import type { ResearchApp } from "@/lib/types";
import { switchWorkspace } from "@/app/(app)/workspace-actions";
import { ALL_APPS, appInitials } from "@/lib/workspace";

/** Square workspace mark — the app's logo when it has one, initials otherwise. */
export function WorkspaceMark({
  name,
  logoUrl,
  size = 32,
  muted = false,
}: {
  name: string;
  logoUrl?: string | null;
  size?: number;
  muted?: boolean;
}) {
  if (logoUrl) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={logoUrl}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="shrink-0 rounded-lg object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg font-bold leading-none ${
        muted ? "bg-neutral-200 text-neutral-600" : "bg-neutral-950 text-white"
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {name === ALL_APPS ? "◆" : appInitials(name)}
    </span>
  );
}

/** Header workspace switcher: current app + dropdown of the rest. Scopes the
 *  roster; the research pool is deliberately global (creators we study aren't
 *  owned by one product), which the subtitle spells out. */
export function WorkspaceSwitcher({
  apps,
  current,
}: {
  apps: ResearchApp[];
  current: string;
}) {
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const active = apps.find((a) => a.id === current);
  const label = active?.name ?? "All apps";

  const choose = (id: string) => {
    setOpen(false);
    if (id === current) return;
    startTransition(() => {
      void switchWorkspace(id);
    });
  };

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className={`flex items-center gap-2.5 rounded-lg py-1 pl-1 pr-2 text-left transition-colors hover:bg-neutral-100 ${
          pending ? "opacity-60" : ""
        }`}
      >
        <WorkspaceMark name={active?.name ?? ALL_APPS} logoUrl={active?.logo_url} />
        <span className="leading-tight">
          <span className="block text-[13px] font-semibold">{label}</span>
          <span className="block text-[11px] text-neutral-500">
            {active ? "Roster workspace" : "Every app"}
          </span>
        </span>
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="ml-0.5 shrink-0 text-neutral-400"
        >
          <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
        </svg>
      </button>

      {open && (
        <div
          role="menu"
          className="absolute left-0 top-[calc(100%+6px)] z-50 w-60 overflow-hidden rounded-xl border border-neutral-200 bg-white py-1 shadow-lg"
        >
          {apps.map((a) => (
            <button
              key={a.id}
              role="menuitem"
              type="button"
              onClick={() => choose(a.id)}
              className="flex w-full items-center gap-2.5 px-2 py-1.5 text-left transition-colors hover:bg-neutral-50"
            >
              <WorkspaceMark name={a.name} logoUrl={a.logo_url} size={26} />
              <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{a.name}</span>
              {a.id === current && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-neutral-900">
                  <path d="m5 13 4 4L19 7" />
                </svg>
              )}
            </button>
          ))}

          <button
            role="menuitem"
            type="button"
            onClick={() => choose(ALL_APPS)}
            className="flex w-full items-center gap-2.5 px-2 py-1.5 text-left transition-colors hover:bg-neutral-50"
          >
            <WorkspaceMark name={ALL_APPS} size={26} muted />
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium">All apps</span>
            {current === ALL_APPS && (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0 text-neutral-900">
                <path d="m5 13 4 4L19 7" />
              </svg>
            )}
          </button>

          <span className="my-1 block border-t border-neutral-100" />
          <Link
            href="/creators#apps"
            onClick={() => setOpen(false)}
            className="flex items-center gap-2 px-3 py-1.5 text-[13px] text-neutral-600 transition-colors hover:bg-neutral-50 hover:text-neutral-900"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H2a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.4-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V2a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H22a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" />
            </svg>
            Manage apps
          </Link>
        </div>
      )}
    </div>
  );
}
