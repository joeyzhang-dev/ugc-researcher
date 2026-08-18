import React from "react";
import Link from "next/link";
import type { ReactNode } from "react";
import { formatDate } from "@/lib/format";
import { PLATFORM_LABELS, type Platform } from "@/lib/types";

/* ---------------------------------------------------------------------------
   Tone system. One recipe per hue (low-alpha tint + legible text + hairline
   ring), so the ~40 status strings and the KPI cards reference a *named tone*
   instead of a wall of one-off `bg-x-50 text-x-700` literals. Meaning-carrying
   tones (success / warning / danger / info / accent / neutral) ride the
   semantic tokens from globals.css; purely categorical hues (violet / indigo /
   pink / orange) use Tailwind's numbered scale but stay centralized here.
   Everything is hairline-ring + tint — never a solid fill.

   Each recipe carries: `badge` (tint+text+ring for pills), `text`/`chip` (for
   the KPI icon), and `activeRing`/`activeSurface` (for the KPI filter-toggle
   engaged state). */
export type Hue =
  | "neutral"
  | "accent"
  | "success"
  | "warning"
  | "danger"
  | "info"
  | "violet"
  | "indigo"
  | "pink"
  | "orange"
  | "muted";

interface ToneRecipe {
  /** Pill: tint background, legible text, inset hairline ring. */
  badge: string;
  /** KPI number-card icon color. */
  text: string;
  /** KPI icon chip: tint background + hairline ring. */
  chip: string;
  /** KPI filter-toggle engaged ring. */
  activeRing: string;
  /** KPI filter-toggle engaged surface tint. */
  activeSurface: string;
}

const HUES: Record<Hue, ToneRecipe> = {
  neutral: {
    badge: "bg-neutral-500/[0.1] text-neutral-600 ring-neutral-500/[0.14]",
    text: "text-neutral-500",
    chip: "bg-neutral-500/[0.1] ring-neutral-500/[0.12]",
    activeRing: "ring-neutral-900/25",
    activeSurface: "bg-neutral-900/[0.03]",
  },
  // Faded neutral for "off" states (Dropped / Ignored / Inactive / Skipped).
  muted: {
    badge: "bg-neutral-500/[0.08] text-neutral-400 ring-neutral-500/[0.1]",
    text: "text-neutral-400",
    chip: "bg-neutral-500/[0.08] ring-neutral-500/[0.1]",
    activeRing: "ring-neutral-900/20",
    activeSurface: "bg-neutral-900/[0.02]",
  },
  accent: {
    badge: "bg-accent/[0.1] text-accent ring-accent/[0.22]",
    text: "text-accent",
    chip: "bg-accent/[0.1] ring-accent/[0.16]",
    activeRing: "ring-accent/40",
    activeSurface: "bg-accent/[0.05]",
  },
  success: {
    badge: "bg-success/[0.1] text-success ring-success/[0.22]",
    text: "text-success",
    chip: "bg-success/[0.1] ring-success/[0.16]",
    activeRing: "ring-success/40",
    activeSurface: "bg-success/[0.05]",
  },
  warning: {
    badge: "bg-warning/[0.12] text-warning ring-warning/[0.24]",
    text: "text-warning",
    chip: "bg-warning/[0.12] ring-warning/[0.18]",
    activeRing: "ring-warning/45",
    activeSurface: "bg-warning/[0.06]",
  },
  danger: {
    badge: "bg-danger/[0.1] text-danger ring-danger/[0.22]",
    text: "text-danger",
    chip: "bg-danger/[0.1] ring-danger/[0.16]",
    activeRing: "ring-danger/40",
    activeSurface: "bg-danger/[0.05]",
  },
  info: {
    badge: "bg-info/[0.1] text-info ring-info/[0.22]",
    text: "text-info",
    chip: "bg-info/[0.1] ring-info/[0.16]",
    activeRing: "ring-info/40",
    activeSurface: "bg-info/[0.05]",
  },
  violet: {
    badge: "bg-violet-500/[0.1] text-violet-700 ring-violet-500/[0.2]",
    text: "text-violet-600",
    chip: "bg-violet-500/[0.1] ring-violet-500/[0.16]",
    activeRing: "ring-violet-500/40",
    activeSurface: "bg-violet-500/[0.05]",
  },
  indigo: {
    badge: "bg-indigo-500/[0.1] text-indigo-700 ring-indigo-500/[0.2]",
    text: "text-indigo-600",
    chip: "bg-indigo-500/[0.1] ring-indigo-500/[0.16]",
    activeRing: "ring-indigo-500/40",
    activeSurface: "bg-indigo-500/[0.05]",
  },
  pink: {
    badge: "bg-pink-500/[0.1] text-pink-700 ring-pink-500/[0.2]",
    text: "text-pink-600",
    chip: "bg-pink-500/[0.1] ring-pink-500/[0.16]",
    activeRing: "ring-pink-500/40",
    activeSurface: "bg-pink-500/[0.05]",
  },
  orange: {
    badge: "bg-orange-500/[0.1] text-orange-700 ring-orange-500/[0.2]",
    text: "text-orange-600",
    chip: "bg-orange-500/[0.1] ring-orange-500/[0.16]",
    activeRing: "ring-orange-500/40",
    activeSurface: "bg-orange-500/[0.05]",
  },
};

/* Every status string in the app → a tone. Adding a status is one line here,
   not a new color literal. Unknown strings fall back to neutral. */
const STATUS_TONE: Record<string, Hue> = {
  Prospect: "neutral",
  Contacted: "info",
  Negotiating: "warning",
  Active: "success",
  Posted: "accent",
  "Ready to Pay": "warning",
  Paid: "success",
  Dropped: "muted",
  Draft: "neutral",
  Paused: "warning",
  Completed: "muted",
  Detected: "info",
  Tracking: "accent",
  "Awaiting review": "warning",
  Reviewed: "success",
  Ignored: "muted",
  Disputed: "danger",
  Suspicious: "danger",
  Pending: "warning",
  running: "info",
  succeeded: "success",
  partial: "warning",
  failed: "danger",
  // tags
  "Warm-up": "violet",
  Trial: "violet",
  Standard: "neutral",
  // discord channel states (category-driven)
  Creating: "success",
  "Not creating": "warning",
  // discord summary workflow states (claude-generated)
  Onboarding: "info",
  "Awaiting videos": "warning",
  "Needs video review": "violet",
  "Revision requested": "orange",
  "Ready to post": "success",
  "In discussion": "neutral",
  Inactive: "muted",
  // assignment states
  Assigned: "info",
  Submitted: "warning",
  Skipped: "muted",
  Rejected: "danger",
  // derived payout states
  "Ready to pay": "success",
  Due: "orange",
  Upcoming: "warning",
  "Needs review": "violet",
};

export function StatusBadge({ status, tone }: { status: string; tone?: Hue }) {
  const hue = tone ?? STATUS_TONE[status] ?? "neutral";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-md px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${HUES[hue].badge}`}
    >
      {status}
    </span>
  );
}

export function Card({
  title,
  subtitle,
  children,
  action,
  id,
  padded = true,
}: {
  title?: ReactNode;
  /** Quiet second line under the title (e.g. a count or scope). */
  subtitle?: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  /** Anchor target, so links like /creators#apps can scroll to a card. */
  id?: string;
  /** Table cards set this false and manage their own edges (see `tableWrap`). */
  padded?: boolean;
}) {
  const hasHeader = Boolean(title || action || subtitle);
  return (
    // Double-bezel: an off-white outer shell (hairline ring + soft ambient
    // shadow + small padding) wrapping a white inner core with its own hairline
    // ring and an inset top catch-light. The 6px shell gap + concentric radii
    // (18px outer → 12px inner) give the machined, nested look.
    <section
      id={id}
      className="group/card scroll-mt-6 rounded-[18px] bg-surface-muted p-1.5 shadow-ambient ring-1 ring-hairline"
    >
      <div className="rounded-xl bg-surface inset-shadow-highlight ring-1 ring-hairline">
        {hasHeader && (
          <header className="flex items-start justify-between gap-3 px-5 pb-3 pt-4">
            <div className="min-w-0">
              {title && (
                <h2 className="truncate text-sm font-semibold tracking-[-0.01em] text-neutral-900">
                  {title}
                </h2>
              )}
              {subtitle && (
                <p className="mt-0.5 truncate text-xs text-neutral-500">{subtitle}</p>
              )}
            </div>
            {action && <div className="shrink-0">{action}</div>}
          </header>
        )}
        {/* Keep horizontal padding at 20px (px-5) whenever padded — `tableWrap`'s
            -mx-5/px-5 is coupled to it. Change one, change both. */}
        <div className={padded ? (hasHeader ? "px-5 pb-5 pt-1" : "p-5") : ""}>
          {children}
        </div>
      </div>
    </section>
  );
}

export function ViewAllLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="group inline-flex items-center gap-1 text-xs font-medium text-neutral-500 transition-colors hover:text-neutral-900"
    >
      {children}
      {/* Magnetic nudge on hover — transform only, house-eased. */}
      <span aria-hidden className="transition-transform duration-200 ease-fluid group-hover:translate-x-0.5">
        →
      </span>
    </Link>
  );
}

export type KpiTone = "neutral" | "emerald" | "amber" | "sky" | "violet" | "red" | "indigo" | "pink";

/* KpiTone kept for back-compat; each maps onto a semantic hue recipe so KPI
   cards and status pills share one source of truth. */
const KPI_TONE_HUE: Record<KpiTone, Hue> = {
  neutral: "neutral",
  emerald: "success",
  amber: "warning",
  sky: "info",
  violet: "violet",
  red: "danger",
  indigo: "indigo",
  pink: "pink",
};

/** Reference-style KPI icons, keyed by name. */
export const KPI_ICONS: Record<string, ReactNode> = {
  users: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.2 3.4-5 6.5-5s5.7 1.8 6.5 5" />
      <circle cx="17" cy="9" r="2.5" /><path d="M15.5 14.6c2.6.3 4.9 1.9 5.8 4.4" />
    </svg>
  ),
  play: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="3" /><path d="m10 9 5 3-5 3V9Z" />
    </svg>
  ),
  eye: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Z" /><circle cx="12" cy="12" r="2.5" />
    </svg>
  ),
  dollar: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2v20M17 6.5c-.8-1.5-2.6-2.2-5-2.2-2.9 0-4.6 1.3-4.6 3.3 0 4.6 10 2.3 10 7 0 2.2-2 3.5-5.4 3.5-2.6 0-4.5-.9-5.3-2.5" />
    </svg>
  ),
  wallet: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2.5" y="6" width="19" height="12" rx="2.5" /><path d="M2.5 10h19" /><path d="M6.5 14.5H10" />
    </svg>
  ),
  alert: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 8v5M12 16.5v.01M10.3 3.9 1.9 18a2 2 0 0 0 1.7 3h16.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
    </svg>
  ),
  clock: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3.5 2" />
    </svg>
  ),
  heart: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20.5S3 14.7 3 8.9C3 6.2 5.1 4 7.8 4c1.7 0 3.3.9 4.2 2.3C12.9 4.9 14.5 4 16.2 4 18.9 4 21 6.2 21 8.9c0 5.8-9 11.6-9 11.6Z" />
    </svg>
  ),
  badge: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="9" r="5.5" /><path d="m8.5 13.5-1.5 7 5-2.5 5 2.5-1.5-7" />
    </svg>
  ),
  check: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" /><path d="m8.5 12.5 2.5 2.5 5-5.5" />
    </svg>
  ),
  trend: (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round" strokeLinejoin="round">
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
  const hue = HUES[KPI_TONE_HUE[tone]];
  // Quiet machined surface at rest; the number carries the card. Engaged state
  // swaps to a tone-matched 2px ring + faint tinted surface — clearly "on"
  // without a loud fill. Resting cards keep a hairline ring only.
  const base = `flex items-start gap-3 rounded-2xl bg-surface p-4 shadow-ambient ring-1 ${
    active ? `ring-2 ${hue.activeRing} ${hue.activeSurface}` : "ring-hairline"
  }`;
  const inner = (
    <>
      {iconNode && (
        <span
          className={`mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] ring-1 ${hue.chip} ${hue.text}`}
        >
          {iconNode}
        </span>
      )}
      <span className="block min-w-0">
        <span className="block truncate text-xs font-medium text-neutral-500">{label}</span>
        <span className="mt-1 block text-[26px] font-semibold leading-none tracking-[-0.02em] tabular-nums text-neutral-900">
          {value}
        </span>
        {sub && <span className="mt-1.5 block truncate text-xs text-neutral-400">{sub}</span>}
      </span>
    </>
  );
  if (onClick) {
    return (
      <button
        type="button"
        onClick={onClick}
        aria-pressed={active}
        className={`${base} w-full text-left transition hover:shadow-raised active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40`}
      >
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

/** Discord's mark, for roster creators with a linked Discord identity. */
export function DiscordIcon({ size = 15 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="inline-block shrink-0 text-indigo-500"
      role="img"
      aria-label="Discord"
    >
      <title>Discord</title>
      <path
        fill="currentColor"
        d="M20.32 4.37a19.8 19.8 0 0 0-4.89-1.52.07.07 0 0 0-.08.04c-.21.38-.44.87-.6 1.25a18.3 18.3 0 0 0-5.5 0 12.6 12.6 0 0 0-.6-1.25.08.08 0 0 0-.09-.04 19.7 19.7 0 0 0-4.88 1.52.07.07 0 0 0-.03.03A20.3 20.3 0 0 0 .1 18.06a.08.08 0 0 0 .03.05 19.9 19.9 0 0 0 6 3.03.08.08 0 0 0 .08-.03c.46-.63.87-1.3 1.22-2a.08.08 0 0 0-.04-.1 13.1 13.1 0 0 1-1.87-.9.08.08 0 0 1 0-.12l.37-.29a.07.07 0 0 1 .08 0 14.2 14.2 0 0 0 12.06 0 .07.07 0 0 1 .08 0l.37.3a.08.08 0 0 1 0 .12 12.3 12.3 0 0 1-1.87.89.08.08 0 0 0-.04.11c.36.7.77 1.36 1.22 1.99a.08.08 0 0 0 .08.03 19.8 19.8 0 0 0 6.02-3.03.08.08 0 0 0 .03-.05 20.2 20.2 0 0 0-3.56-13.66.06.06 0 0 0-.03-.03ZM8.02 15.33c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.96-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.96 2.42-2.16 2.42Zm7.97 0c-1.18 0-2.16-1.08-2.16-2.42 0-1.33.95-2.42 2.16-2.42 1.21 0 2.18 1.1 2.16 2.42 0 1.34-.95 2.42-2.16 2.42Z"
      />
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
    <div className={`h-1 w-full overflow-hidden rounded-full bg-neutral-500/[0.12] ${className ?? ""}`}>
      <div className="h-full rounded-full bg-neutral-900" style={{ width }} />
    </div>
  );
}

export function PageHeader({
  title,
  action,
  subtitle,
  eyebrow,
}: {
  title: string;
  action?: ReactNode;
  /** Replaces the `-mt-4 mb-5 … text-neutral-500` blurb every page used to
   *  repeat by hand — pass the description here instead. */
  subtitle?: ReactNode;
  /** Optional micro-label above the title (uppercase, tracked). */
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && (
          <div className="mb-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-neutral-400">
            {eyebrow}
          </div>
        )}
        <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] text-neutral-900">
          {title}
        </h1>
        {subtitle && (
          <p className="mt-1.5 max-w-3xl text-sm leading-relaxed text-neutral-500">{subtitle}</p>
        )}
      </div>
      {action && <div className="shrink-0">{action}</div>}
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
    <span className="whitespace-nowrap font-medium text-accent">
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

// Uppercase micro-tracked header; hairline row separators; comfortable-but-dense
// rows; tabular-nums on the whole table so figures line up column-to-column.
export const th =
  "px-3 py-2 text-left text-[11px] font-medium uppercase tracking-[0.08em] text-neutral-400";
export const td = "px-3 py-2.5 align-middle text-sm text-neutral-700";
// tableWrap bleeds a table to the card's inner-core edges then re-pads for
// horizontal scroll. The -mx-5/px-5 is COUPLED to Card's px-5 content padding —
// if Card's padding changes, change this in lockstep or every table breaks.
export const tableWrap = "-mx-5 overflow-x-auto px-5";
export const table = "min-w-full divide-y divide-black/[0.05] tabular-nums";
export const trHover = "transition-colors hover:bg-neutral-900/[0.03]";

// Sunken field: hairline ring + faint inset, accent focus ring (not browser blue).
export const inputClass =
  "mt-1 w-full rounded-xl bg-surface px-3 py-2 text-sm text-neutral-900 shadow-[inset_0_1px_2px_rgb(9_9_11/0.04)] ring-1 ring-hairline transition placeholder:text-neutral-400 focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/45";
export const labelClass = "block text-sm font-medium text-neutral-700";
// Pill buttons with haptic press (active:scale) and a designed focus ring.
export const buttonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-full bg-neutral-900 px-4 py-2 text-sm font-medium text-white shadow-ambient transition hover:bg-neutral-800 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50";
export const secondaryButtonClass =
  "inline-flex items-center justify-center gap-1.5 rounded-full bg-surface px-4 py-2 text-sm font-medium text-neutral-700 shadow-ambient ring-1 ring-hairline transition hover:bg-surface-muted hover:text-neutral-900 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas disabled:pointer-events-none disabled:opacity-50";

export interface SegmentedItem {
  value: string;
  label: ReactNode;
  /** Renders a <Link> — the app's server-rendered filter-pill pattern. */
  href?: string;
  /** Renders a <button> — for client-side toggles. */
  onClick?: () => void;
  title?: string;
}

/**
 * Pill-group toggle. Several pages hand-roll this (pool switchers, range
 * pickers); use this instead. Items are links by default (server-friendly, URL
 * as state) or buttons when given an onClick. The active item lifts to a raised
 * white core against the sunken track — the same machined language as the cards.
 */
export function Segmented({
  items,
  value,
  size = "md",
  className,
  "aria-label": ariaLabel,
}: {
  items: SegmentedItem[];
  value: string;
  size?: "sm" | "md";
  className?: string;
  "aria-label"?: string;
}) {
  const pad = size === "sm" ? "px-2.5 py-1 text-xs" : "px-3 py-1.5 text-sm";
  const itemBase = `rounded-lg font-medium transition ${pad}`;
  const activeCls = "bg-surface text-neutral-900 shadow-ambient ring-1 ring-hairline";
  const idleCls = "text-neutral-500 hover:text-neutral-900";
  return (
    <span
      role="group"
      aria-label={ariaLabel}
      className={`inline-flex shrink-0 items-center gap-0.5 rounded-xl bg-surface-sunken p-1 ring-1 ring-hairline ${className ?? ""}`}
    >
      {items.map((it) => {
        const on = it.value === value;
        const cls = `${itemBase} ${on ? activeCls : idleCls}`;
        return it.href ? (
          <Link
            key={it.value}
            href={it.href}
            scroll={false}
            title={it.title}
            aria-current={on ? "true" : undefined}
            className={cls}
          >
            {it.label}
          </Link>
        ) : (
          <button
            key={it.value}
            type="button"
            onClick={it.onClick}
            title={it.title}
            aria-pressed={on}
            className={`${cls} ${on ? "" : "active:scale-[0.97]"}`}
          >
            {it.label}
          </button>
        );
      })}
    </span>
  );
}
