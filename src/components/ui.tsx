import React from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatDate } from "@/lib/format";
import { PLATFORM_LABELS, type Platform } from "@/lib/types";

/* Minimal badge palette matching the reference: light tint + colored text, no dots. */
const STATUS_COLORS: Record<string, string> = {
  Prospect: "bg-neutral-100 text-neutral-600",
  Contacted: "bg-sky-50 text-sky-700",
  Negotiating: "bg-amber-50 text-amber-700",
  Active: "bg-emerald-50 text-emerald-700",
  Posted: "bg-blue-50 text-blue-700",
  "Ready to Pay": "bg-amber-50 text-amber-700",
  Paid: "bg-emerald-50 text-emerald-700",
  Dropped: "bg-neutral-100 text-neutral-400",
  Draft: "bg-neutral-100 text-neutral-600",
  Paused: "bg-amber-50 text-amber-700",
  Completed: "bg-neutral-100 text-neutral-500",
  Detected: "bg-sky-50 text-sky-700",
  Tracking: "bg-blue-50 text-blue-700",
  "Awaiting review": "bg-amber-50 text-amber-700",
  Reviewed: "bg-emerald-50 text-emerald-700",
  Ignored: "bg-neutral-100 text-neutral-400",
  Disputed: "bg-red-50 text-red-700",
  Suspicious: "bg-red-100 text-red-800",
  Pending: "bg-amber-50 text-amber-700",
  running: "bg-sky-50 text-sky-700",
  succeeded: "bg-emerald-50 text-emerald-700",
  partial: "bg-amber-50 text-amber-700",
  failed: "bg-red-50 text-red-700",
  // tags
  "Warm-up": "bg-violet-50 text-violet-700",
  Trial: "bg-violet-50 text-violet-700",
  Standard: "bg-neutral-100 text-neutral-600",
  // assignment states
  Assigned: "bg-sky-50 text-sky-700",
  Submitted: "bg-amber-50 text-amber-700",
  Skipped: "bg-neutral-100 text-neutral-400",
  Rejected: "bg-red-50 text-red-700",
  // derived payout states
  "Ready to pay": "bg-emerald-50 text-emerald-700",
  Due: "bg-orange-50 text-orange-700",
  Upcoming: "bg-amber-50 text-amber-700",
  "Needs review": "bg-violet-50 text-violet-700",
};

export function StatusBadge({ status }: { status: string }) {
  const color = STATUS_COLORS[status] ?? "bg-neutral-100 text-neutral-600";
  return (
    <span
      className={`inline-block whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ${color}`}
    >
      {status}
    </span>
  );
}

export function Card({
  title,
  children,
  action,
  id,
}: {
  title?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  /** Anchor target, so links like /creators#apps can scroll to a card. */
  id?: string;
}) {
  return (
    <section id={id} className="scroll-mt-6 rounded-xl border border-neutral-200 bg-white">
      {(title || action) && (
        <header className="flex items-center justify-between px-5 pb-1 pt-4">
          {title && <h2 className="text-sm font-semibold tracking-tight text-neutral-900">{title}</h2>}
          {action}
        </header>
      )}
      <div className="p-5 pt-3">{children}</div>
    </section>
  );
}

export function ViewAllLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="inline-flex items-center gap-1 text-xs font-medium text-neutral-500 underline-offset-2 transition-colors hover:text-neutral-900 hover:underline"
    >
      {children}
      <span aria-hidden>→</span>
    </Link>
  );
}

export type KpiTone = "neutral" | "emerald" | "amber" | "sky" | "violet" | "red" | "indigo" | "pink";

const KPI_TONES: Record<KpiTone, string> = {
  neutral: "bg-neutral-100 text-neutral-500",
  emerald: "bg-emerald-50 text-emerald-600",
  amber: "bg-amber-50 text-amber-600",
  sky: "bg-sky-50 text-sky-600",
  violet: "bg-violet-50 text-violet-600",
  red: "bg-red-50 text-red-500",
  indigo: "bg-indigo-50 text-indigo-600",
  pink: "bg-pink-50 text-pink-500",
};

/* Active (filter-engaged) ring follows the card's tone. */
const KPI_ACTIVE_RINGS: Record<KpiTone, string> = {
  neutral: "border-neutral-400 ring-2 ring-neutral-100",
  emerald: "border-emerald-300 ring-2 ring-emerald-100",
  amber: "border-amber-300 ring-2 ring-amber-100",
  sky: "border-sky-300 ring-2 ring-sky-100",
  violet: "border-violet-300 ring-2 ring-violet-100",
  red: "border-red-300 ring-2 ring-red-100",
  indigo: "border-indigo-300 ring-2 ring-indigo-100",
  pink: "border-pink-300 ring-2 ring-pink-100",
};

/** Reference-style KPI icons, keyed by name. */
export const KPI_ICONS: Record<string, ReactNode> = {
  users: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
      <circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.6c2.6.3 4.9 1.9 5.8 4.4" />
    </svg>
  ),
  play: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3V9Z" />
    </svg>
  ),
  eye: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" />
    </svg>
  ),
  dollar: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20M17 6.5c-.8-1.5-2.6-2.2-5-2.2-2.9 0-4.6 1.3-4.6 3.3 0 4.6 10 2.3 10 7 0 2.2-2 3.5-5.4 3.5-2.6 0-4.5-.9-5.3-2.5" />
    </svg>
  ),
  wallet: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M2.5 10h19" /><path d="M6.5 14.5H10" />
    </svg>
  ),
  alert: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8v5M12 16.5v.01M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  ),
  clock: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
    </svg>
  ),
  heart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20.5S3 14.7 3 8.9C3 6.2 5.1 4 7.8 4c1.7 0 3.3.9 4.2 2.3C12.9 4.9 14.5 4 16.2 4 18.9 4 21 6.2 21 8.9c0 5.8-9 11.6-9 11.6Z" />
    </svg>
  ),
  badge: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="9" r="5.5" /><path d="m8.5 13.5-1.5 7 5-2.5 5 2.5-1.5-7" />
    </svg>
  ),
  check: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 5-5.5" />
    </svg>
  ),
  trend: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m3 17 6-6 4 4 8-8" /><path d="M15 7h6v6" />
    </svg>
  ),
};

export function KpiCard({
  label,
  value,
  sub,
  icon,
  tone = "neutral",
  onClick,
  active = false,
}: {
  label: string;
  value: string;
  /** Text, or a node when the detail is worth more than a caption (an avatar
   *  stack under a headcount says who, not just how many). */
  sub?: ReactNode;
  /** Key into KPI_ICONS, or a custom node. */
  icon?: string | ReactNode;
  tone?: KpiTone;
  /** Makes the card a button (e.g. KPI doubles as a filter toggle). */
  onClick?: () => void;
  /** Highlight ring when the card's filter is engaged. */
  active?: boolean;
}) {
  const iconNode = typeof icon === "string" ? KPI_ICONS[icon] : icon;
  const base = `flex items-start gap-3 rounded-xl border bg-white p-4 ${
    active ? KPI_ACTIVE_RINGS[tone] : "border-neutral-200"
  }`;
  const inner = (
    <>
      {iconNode && (
        <span
          className={`mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${KPI_TONES[tone]}`}
        >
          {iconNode}
        </span>
      )}
      <span className="min-w-0 block">
        <span className="block truncate text-xs font-medium text-neutral-500">{label}</span>
        <span className="mt-0.5 block text-2xl font-semibold tracking-tight tabular-nums text-neutral-900">{value}</span>
        {sub && <span className="mt-0.5 block truncate text-xs text-neutral-400">{sub}</span>}
      </span>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={`${base} w-full text-left transition-colors hover:border-neutral-300`}>
        {inner}
      </button>
    );
  }
  return <div className={base}>{inner}</div>;
}

/** Creator avatar: profile picture when captured, initials otherwise. */
/**
 * Overlapping avatars for a headcount — who, not just how many.
 *
 * Capped, because a script handed to a dozen creators would otherwise push the
 * card wider than its neighbours and break the KPI row's alignment.
 */
export function AvatarStack({
  people,
  size = 22,
  max = 6,
}: {
  people: { handle: string; avatarUrl?: string | null }[];
  size?: number;
  max?: number;
}) {
  if (people.length === 0) return null;
  const shown = people.slice(0, max);
  const rest = people.length - shown.length;
  return (
    <span className="flex items-center">
      {shown.map((p, i) => (
        <span
          key={`${p.handle}-${i}`}
          title={`@${p.handle}`}
          className="rounded-full ring-2 ring-white"
          style={{ marginLeft: i === 0 ? 0 : -size / 3 }}
        >
          <Avatar name={p.handle} src={p.avatarUrl} size={size} />
        </span>
      ))}
      {rest > 0 && (
        <span
          className="flex items-center justify-center rounded-full bg-neutral-100 font-medium text-neutral-500 ring-2 ring-white"
          style={{ width: size, height: size, marginLeft: -size / 3, fontSize: size * 0.4 }}
        >
          +{rest}
        </span>
      )}
    </span>
  );
}

export function Avatar({ name, src, size = 24 }: { name: string; src?: string | null; size?: number }) {
  if (src) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="shrink-0 rounded-full object-cover"
        style={{ width: size, height: size }}
      />
    );
  }
  const initials = name
    .replace(/^@/, "")
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join("");
  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-full bg-neutral-900 font-semibold text-white"
      style={{ width: size, height: size, fontSize: Math.max(9, size * 0.38) }}
    >
      {initials || "?"}
    </span>
  );
}

/* --- Platform logos --------------------------------------------------------
   Inline brand glyphs so a creator/video's platform reads at a glance. Instagram
   uses its rounded-square camera mark; TikTok its music-note mark. */
const PLATFORM_GLYPHS: Record<Platform, ReactNode> = {
  instagram: (
    <>
      <rect x="2" y="2" width="20" height="20" rx="5.5" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="12" cy="12" r="4.3" fill="none" stroke="currentColor" strokeWidth="2" />
      <circle cx="17.6" cy="6.4" r="1.3" fill="currentColor" />
    </>
  ),
  tiktok: (
    <>
      <path
        d="M9.4 3h2.6c.2 1.9 1.3 3.6 3.4 4.1v2.6c-1.3.05-2.5-.3-3.4-.95V14a4.6 4.6 0 1 1-4.6-4.6c.24 0 .47.02.7.06v2.7a1.95 1.95 0 1 0 1.3 1.84V3Z"
        fill="currentColor"
      />
    </>
  ),
};

const PLATFORM_ICON_COLOR: Record<Platform, string> = {
  instagram: "text-pink-600",
  tiktok: "text-neutral-900",
};

/** A single platform's brand glyph. */
export function PlatformIcon({ platform, size = 15 }: { platform: Platform; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className={`inline-block shrink-0 ${PLATFORM_ICON_COLOR[platform]}`}
      role="img"
      aria-label={PLATFORM_LABELS[platform]}
    >
      <title>{PLATFORM_LABELS[platform]}</title>
      {PLATFORM_GLYPHS[platform]}
    </svg>
  );
}

/** Row of platform glyphs for a creator/video. Renders nothing when empty. */
export function PlatformBadges({
  platforms,
  size = 15,
  className,
}: {
  platforms: Platform[];
  size?: number;
  className?: string;
}) {
  if (platforms.length === 0) return null;
  return (
    <span className={`inline-flex items-center gap-1 ${className ?? ""}`}>
      {platforms.map((p) => (
        <PlatformIcon key={p} platform={p} size={size} />
      ))}
    </span>
  );
}

/** Thin horizontal bar for relative comparisons (campaign performance, pipeline). */
export function MiniBar({ ratio, className }: { ratio: number; className?: string }) {
  const width = `${Math.min(100, Math.max(0, ratio * 100))}%`;
  return (
    <div className={`h-1 w-full overflow-hidden rounded-full bg-neutral-100 ${className ?? ""}`}>
      <div className="h-full rounded-full bg-neutral-900" style={{ width }} />
    </div>
  );
}

export function PageHeader({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex items-center justify-between">
      <h1 className="text-[26px] font-bold tracking-tight">{title}</h1>
      {action}
    </div>
  );
}

export function EmptyState({ message }: { message: string }) {
  return <p className="py-8 text-center text-sm text-neutral-400">{message}</p>;
}

/** Posted-style date: same-day renders as a blue "Today · 3h ago" so fresh
 *  posts jump out; anything older falls back to the plain date. */
export function DateOrToday({ iso }: { iso: string | null | undefined }) {
  if (!iso) return <>—</>;
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() !== now.toDateString()) return <>{formatDate(iso)}</>;
  const h = Math.floor(Math.max(0, now.getTime() - d.getTime()) / 3_600_000);
  return (
    <span className="whitespace-nowrap font-medium text-blue-600">
      Today · {h < 1 ? "just now" : `${h}h ago`}
    </span>
  );
}

export function LinkButton({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass}>
      {children}
    </Link>
  );
}

export const th =
  "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-wider text-neutral-400";
export const td = "px-3 py-2.5 text-sm text-neutral-700";
export const tableWrap = "-mx-5 overflow-x-auto px-5";
export const table = "min-w-full divide-y divide-neutral-100";
export const trHover = "transition-colors hover:bg-neutral-50";

export const inputClass =
  "mt-1 w-full rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm placeholder:text-neutral-300 focus:border-neutral-400 focus:outline-none focus:ring-2 focus:ring-neutral-100";
export const labelClass = "block text-sm font-medium text-neutral-700";
export const buttonClass =
  "inline-flex items-center gap-1.5 rounded-lg bg-neutral-900 px-3.5 py-2 text-sm font-medium text-white transition-colors hover:bg-neutral-700 disabled:opacity-50";
export const secondaryButtonClass =
  "inline-flex items-center gap-1.5 rounded-lg border border-neutral-200 bg-white px-3.5 py-2 text-sm font-medium text-neutral-700 transition-colors hover:bg-neutral-50";
