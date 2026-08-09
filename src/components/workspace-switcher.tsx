"use client";

import Link from "next/link";
import { useTransition } from "react";
import type { ResearchApp } from "@/lib/types";
import { switchWorkspace } from "@/app/(app)/workspace-actions";
import { ALL_APPS, appInitials } from "@/lib/workspace";
import { RAIL_GLYPH, RAIL_LABEL, RAIL_ROW } from "./app-nav";

/** Square workspace mark — the app's logo when it has one, initials otherwise.
 *  Shared with the compact app picker (`app-select.tsx`); keep the signature. */
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
        className="shrink-0 rounded-lg object-cover ring-1 ring-hairline"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <span
      className={`flex shrink-0 items-center justify-center rounded-lg font-bold leading-none ${
        muted
          ? "bg-surface-sunken text-neutral-500 ring-1 ring-hairline"
          : "bg-neutral-950 text-white inset-shadow-highlight"
      }`}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.36) }}
    >
      {name === ALL_APPS ? "◆" : appInitials(name)}
    </span>
  );
}

/**
 * The *workspace* axis, rendered as a list inside the rail — one row per app
 * plus "All apps", so any workspace is a single click (no dropdown, no second
 * switcher in a header). Selecting one runs the cookie-backed `switchWorkspace`
 * server action. The current workspace takes a neutral tint + neutral edge bar,
 * deliberately unlike the section nav's accent, so the two axes never blur.
 *
 * Scoping is a roster view preference; the research pool stays global (creators
 * we study aren't owned by one product), which RLS — not this control — decides.
 */
export function WorkspaceSwitch({ apps, current }: { apps: ResearchApp[]; current: string }) {
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
        aria-current={active ? "true" : undefined}
        onClick={() => choose(id)}
        className={`${RAIL_ROW} ${
          active
            ? "bg-neutral-900/[0.05] text-neutral-900"
            : "text-neutral-500 hover:bg-neutral-900/[0.04] hover:text-neutral-900"
        }`}
      >
        <span
          aria-hidden
          className={`absolute left-0 top-1/2 h-6 w-[3px] -translate-y-1/2 rounded-r-full bg-neutral-900 transition-opacity ${
            active ? "opacity-100" : "opacity-0"
          }`}
        />
        <span className={`${RAIL_GLYPH} transition-transform group-hover/row:scale-105`}>
          <WorkspaceMark name={name} logoUrl={logoUrl} size={30} muted={!active} />
        </span>
        <span className={`${RAIL_LABEL} ${active ? "font-semibold" : ""}`}>{label}</span>
      </button>
    );
  };

  return (
    <div aria-label="Workspace" className={`flex flex-col gap-0.5 ${pending ? "opacity-70" : ""}`}>
      {apps.map((a) => tile(a.id, a.name, a.name, a.logo_url))}
      {tile(ALL_APPS, ALL_APPS, "All apps")}

      <Link
        href="/creators#apps"
        title="Add an app"
        className={`${RAIL_ROW} text-neutral-400 hover:bg-neutral-900/[0.04] hover:text-neutral-700`}
      >
        <span className={RAIL_GLYPH}>
          <span className="flex h-[30px] w-[30px] items-center justify-center rounded-lg border border-dashed border-hairline-strong">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </span>
        </span>
        <span className={RAIL_LABEL}>Add an app</span>
      </Link>
    </div>
  );
}
