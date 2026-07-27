"use client";

import Link from "next/link";
import { useTransition } from "react";
import type { ResearchApp } from "@/lib/types";
import { switchWorkspace } from "@/app/(app)/workspace-actions";
import { ALL_APPS } from "@/lib/workspace";
import { WorkspaceMark } from "./workspace-switcher";

// 38px mark centred in the 64px collapsed rail -> 13px of padding each side.
// Keeping the same padding when expanded is what makes the marks stay put
// while only the labels slide in.
const ROW = "flex w-full items-center gap-3 rounded-lg px-[13px] py-1";
const LABEL =
  "min-w-0 flex-1 truncate whitespace-nowrap text-left text-[13px] opacity-0 transition-opacity duration-150 group-hover/rail:opacity-100 group-focus-within/rail:opacity-100";

/** Slack-style vertical rail: one tile per app, always one click from any
 *  workspace. Collapsed to icons, it widens on hover (or keyboard focus) to
 *  show the app names, so the marks never move — only the labels slide in. */
export function WorkspaceRail({ apps, current }: { apps: ResearchApp[]; current: string }) {
  const [pending, startTransition] = useTransition();

  const choose = (id: string) => {
    if (id === current) return;
    startTransition(() => {
      void switchWorkspace(id);
    });
  };

  const tile = (id: string, name: string, label: string, logoUrl?: string | null) => {
    const active = current === id;
    return (
      <button
        key={id}
        type="button"
        title={label}
        aria-current={active}
        onClick={() => choose(id)}
        className={`${ROW} group/tile relative transition-colors hover:bg-neutral-50`}
      >
        {/* Active indicator, flush to the rail edge. */}
        <span
          className={`absolute left-0 top-1/2 h-7 w-[3px] -translate-y-1/2 rounded-r-full bg-neutral-900 transition-opacity ${
            active ? "opacity-100" : "opacity-0"
          }`}
        />
        <span
          className={`shrink-0 transition-transform group-hover/tile:scale-105 ${
            active ? "" : "opacity-55 group-hover/tile:opacity-100"
          }`}
        >
          <WorkspaceMark name={name} logoUrl={logoUrl} size={38} muted={!active} />
        </span>
        <span className={`${LABEL} ${active ? "font-semibold text-neutral-900" : "text-neutral-600"}`}>
          {label}
        </span>
      </button>
    );
  };

  return (
    <>
      {/* Fixed rail + in-flow spacer: expanding overlays the page instead of
          reflowing it, so the video grid doesn't re-lay-out on every hover. */}
      <div className="w-16 shrink-0" aria-hidden />
      <aside
        className={`group/rail fixed left-0 top-0 z-40 flex h-screen w-16 flex-col gap-1 overflow-hidden border-r border-neutral-200 bg-white py-3 transition-[width] duration-200 ease-out hover:w-60 hover:shadow-xl focus-within:w-60 ${
          pending ? "opacity-70" : ""
        }`}
      >
        <Link href="/research" title="Trace Research" className={`${ROW} mb-1`}>
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg bg-neutral-950 text-sm font-bold text-white">
            T
          </span>
          <span className={`${LABEL} leading-tight`}>
            <span className="block font-semibold text-neutral-900">Trace Research</span>
            <span className="block text-[11px] text-neutral-500">Creator &amp; format study</span>
          </span>
        </Link>

        <span className="mx-[13px] mb-1 block h-px shrink-0 bg-neutral-200" />

        <div className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
          {apps.map((a) => tile(a.id, a.name, a.name, a.logo_url))}
          {tile(ALL_APPS, ALL_APPS, "All apps")}
        </div>

        <Link
          href="/creators#apps"
          title="Add an app"
          className={`${ROW} mt-1 text-neutral-400 transition-colors hover:text-neutral-700`}
        >
          <span className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded-lg border border-dashed border-neutral-300">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
          <span className={LABEL}>Add an app</span>
        </Link>
      </aside>
    </>
  );
}
