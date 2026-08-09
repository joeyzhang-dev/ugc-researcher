"use client";

import Link from "next/link";
import type { ResearchApp } from "@/lib/types";
import { signOut } from "@/app/login/actions";
import { AppNav, RAIL_GLYPH, RAIL_LABEL, RAIL_ROW } from "./app-nav";
import { WorkspaceSwitch } from "./workspace-switcher";

/* One rail, one axis each. This is the single most visible surface in the app,
   and it used to carry three overlapping navigations (a workspace rail, a
   duplicate header workspace dropdown, and a header row of page pills). They're
   now merged into one column:

     • brand           — home
     • Workspace zone  — which app/brand you're scoped to (WorkspaceSwitch)
     • Sections zone   — which page you're on           (AppNav)
     • account         — who you are + sign out

   Collapsed to a 64px icon strip, it expands to reveal labels on hover or
   keyboard focus. It stays `fixed` behind an in-flow spacer so expanding
   *overlays* the page instead of reflowing it — the deliberate fix that stops
   the video grid re-laying-out on every hover. */

/** A zone heading that only occupies space once the rail is expanded, so the
 *  collapsed strip stays clean (no floating labels, no reserved gaps). */
const RAIL_EYEBROW =
  "flex h-0 items-center overflow-hidden px-4 text-[10px] font-semibold uppercase tracking-[0.12em] text-neutral-400 opacity-0 transition-all duration-150 ease-fluid group-hover/rail:h-6 group-hover/rail:opacity-100 group-focus-within/rail:h-6 group-focus-within/rail:opacity-100";

const RAIL_DIVIDER = "mx-4 my-1.5 h-px shrink-0 bg-black/[0.06]";

export function WorkspaceRail({
  apps,
  current,
  email,
}: {
  apps: ResearchApp[];
  current: string;
  email: string | null;
}) {
  const monogram = (email ?? "").replace(/@.*/, "").slice(0, 2).toUpperCase() || "?";

  return (
    <>
      {/* Spacer keeps the collapsed footprint in flow; the rail itself is fixed
          and overlays the page as it widens. */}
      <div className="w-16 shrink-0" aria-hidden />
      <aside
        aria-label="Primary"
        className="group/rail fixed left-0 top-0 z-40 flex h-screen w-16 flex-col overflow-hidden border-r border-hairline bg-surface py-3 transition-[width] duration-300 ease-fluid hover:w-64 hover:shadow-raised focus-within:w-64"
      >
        {/* Brand / home */}
        <Link
          href="/research"
          title="Trace Research"
          className="group/row relative flex w-full items-center gap-3 rounded-xl px-[14px] py-1 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          <span className={RAIL_GLYPH}>
            <span className="flex h-9 w-9 items-center justify-center rounded-[11px] bg-neutral-950 text-sm font-bold text-white shadow-ambient inset-shadow-highlight">
              T
            </span>
          </span>
          <span className={`${RAIL_LABEL} leading-tight`}>
            <span className="block font-semibold tracking-[-0.01em] text-neutral-900">Trace Research</span>
            <span className="block text-[11px] text-neutral-500">Creator &amp; format study</span>
          </span>
        </Link>

        <div className={RAIL_DIVIDER} />

        {/* Scrolling middle: workspace axis over section axis. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className={RAIL_EYEBROW}>Workspace</div>
          <WorkspaceSwitch apps={apps} current={current} />

          <div className={RAIL_DIVIDER} />

          <div className={RAIL_EYEBROW}>Sections</div>
          <AppNav />
        </div>

        <div className={RAIL_DIVIDER} />

        {/* Account */}
        <div className="shrink-0">
          <div className="relative flex w-full items-center gap-3 rounded-xl px-[14px] py-1">
            <span className={RAIL_GLYPH}>
              <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg bg-surface-sunken text-[11px] font-semibold text-neutral-600 ring-1 ring-hairline">
                {monogram}
              </span>
            </span>
            <span className={`${RAIL_LABEL} leading-tight`}>
              <span className="block truncate text-[12px] font-medium text-neutral-800">
                {email ?? "Signed in"}
              </span>
              <span className="block text-[11px] text-neutral-400">Trace team</span>
            </span>
          </div>

          <form action={signOut}>
            <button
              type="submit"
              title="Sign out"
              className={`${RAIL_ROW} text-neutral-500 hover:bg-danger/[0.08] hover:text-danger`}
            >
              <span className={`${RAIL_GLYPH} text-neutral-400 group-hover/row:text-current`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 21H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3" />
                  <path d="m16 17 5-5-5-5" />
                  <path d="M21 12H9" />
                </svg>
              </span>
              <span className={RAIL_LABEL}>Sign out</span>
            </button>
          </form>
        </div>
      </aside>
    </>
  );
}
