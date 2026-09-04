/**
 * blud primitives, ported from folk-web's /admin console.
 *
 * Deliberately smaller than folk's original. Two things were left behind:
 *
 *   The motion library. folk's `Rise`, `Ticker`, `Sparkline` and `Delta` are
 *   built on `motion/react`. Adding a client animation dependency to a repo
 *   that also ships two Python workers is not worth one fade, so `Rise` here
 *   is the same gesture in CSS (see `.ag-rise`) and the data-viz components
 *   are simply absent until something needs them.
 *
 *   Anything settings does not use. Chips, tickers and the creative gallery
 *   come across when a page that needs them does.
 *
 * Everything here is server-component safe: no hooks, no "use client". That is
 * what lets the settings page stay a server component while looking like this.
 */

import type { ReactNode } from "react";

import "./glass.css";

/** The house easing, heavy, decelerating, never linear. */
export const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

/** Semantic ink, kept in one place so chips and text can't drift apart. */
export const INK = {
  blue: "#0a6cff",
  green: "#16a34a",
  amber: "#e08700",
  red: "#e5484d",
  quiet: "rgba(29,29,31,0.28)",
} as const;

// ── Panels ────────────────────────────────────────────────────────────────

/**
 * A floating pane of glass. `radius` is in px, large by default, because a
 * generous corner is what separates a consumer surface from a control panel.
 *
 * `tone="thick"` is for the hero: bigger surfaces should read as heavier
 * material, not just as larger rectangles. Use ONE per screen — twelve panes
 * all casting the same shadow is the same information as no shadow.
 */
export function GlassPanel({
  children,
  className = "",
  innerClassName = "",
  radius = 26,
  tone = "regular",
}: {
  children?: ReactNode;
  className?: string;
  innerClassName?: string;
  radius?: number;
  tone?: "regular" | "thick";
}) {
  return (
    <div
      className={`relative overflow-hidden ${
        tone === "thick" ? "ag-glass ag-glass--thick" : "ag-glass"
      } ${className}`}
      style={{ borderRadius: radius }}
    >
      <div className={`relative h-full ${innerClassName}`}>{children}</div>
    </div>
  );
}

/**
 * The flat surface everything that isn't the hero sits on.
 *
 * Separate component rather than a `tone` on GlassPanel because the two are
 * not the same material with a dial between them: this one never blurs, never
 * casts, and is safe to render a hundred of.
 */
export function Card({
  children,
  className = "",
  innerClassName = "",
  radius = 22,
  id,
}: {
  children?: ReactNode;
  className?: string;
  innerClassName?: string;
  radius?: number;
  /** For deep links — /settings#niches scrolls the rename preview into view. */
  id?: string;
}) {
  return (
    <div
      id={id}
      className={`relative overflow-hidden ag-card ${className}`}
      style={{ borderRadius: radius }}
    >
      <div className={`relative h-full ${innerClassName}`}>{children}</div>
    </div>
  );
}

/**
 * A grid of cells that share their edges rather than floating apart.
 *
 * Reach for this instead of `grid gap-4` whenever the cells are the same KIND
 * of thing — four totals, a set of stats. The shared rule groups them into one
 * object; a gap leaves them as N objects the reader has to relate.
 *
 * The grid template is a Tailwind class on `className` rather than a prop, so
 * a caller can set different counts per breakpoint without this knowing about
 * any of them.
 */
export function Lattice({
  children,
  className = "",
  radius = 22,
  tone = "card",
  role,
  ariaLabel,
}: {
  children: ReactNode;
  className?: string;
  radius?: number;
  tone?: "card" | "inset";
  role?: "list" | "group";
  ariaLabel?: string;
}) {
  return (
    <div
      role={role}
      aria-label={ariaLabel}
      className={`ag-lattice ${tone === "inset" ? "ag-lattice--inset" : ""} ${className}`}
      style={{ borderRadius: tone === "inset" ? undefined : radius }}
    >
      {children}
    </div>
  );
}

/**
 * Section header used at the top of every card — icon, label, and whatever
 * controls belong to that section, on one baseline. Written once because
 * twelve hand-rolled copies is how a page ends up with four label sizes.
 */
export function CardHead({
  icon,
  title,
  aside,
  tone = "neutral",
}: {
  icon?: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
  tone?: "neutral" | "critical";
}) {
  const color = tone === "critical" ? "text-[#c2333c]" : "text-[var(--ag-ink-3)]";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className={`flex items-center gap-2 ${color}`}>
        {icon}
        <span className="text-[11px] font-semibold uppercase tracking-[0.14em]">
          {title}
        </span>
      </div>
      {aside}
    </div>
  );
}

/**
 * Label-over-figure pair. Tabular by default because these stack into columns
 * and a proportional 1 next to a proportional 8 makes the column wobble.
 */
export function Stat({
  label,
  value,
  sub,
  tone = "lead",
}: {
  label: ReactNode;
  value: ReactNode;
  /** One quiet line under the figure — "run in progress", "3 failed". */
  sub?: ReactNode;
  tone?: "lead" | "quiet";
}) {
  return (
    <div>
      <dt className="text-[9.5px] font-semibold uppercase tracking-[0.1em] text-[var(--ag-ink-4)]">
        {label}
      </dt>
      <dd
        className={`mt-1 tabular-nums ${
          tone === "lead"
            ? "text-[26px] font-semibold leading-none tracking-[-0.02em] text-[var(--ag-ink)]"
            : "text-[13px] font-medium text-[var(--ag-ink-2)]"
        }`}
      >
        {value}
      </dd>
      {sub ? (
        <p className="mt-1.5 text-[11px] leading-tight text-[var(--ag-ink-4)]">{sub}</p>
      ) : null}
    </div>
  );
}

/** Microscopic uppercase label that precedes a heading or sits on a card. */
export function Eyebrow({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "positive" | "warn" | "critical";
}) {
  const tones = {
    neutral: "bg-[rgba(118,128,152,0.10)] text-[var(--ag-ink-2)]",
    positive: "bg-[rgba(22,163,74,0.11)] text-[#137a3a]",
    warn: "bg-[rgba(224,135,0,0.13)] text-[#a86200]",
    critical: "bg-[rgba(229,72,77,0.11)] text-[#c2333c]",
  } as const;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

/**
 * Staggered fade-up, in CSS. `index` drives the stagger; the delay is capped
 * so the twelfth card does not arrive half a second after the first.
 *
 * Transform and opacity only — no blur. folk animates a blur through
 * `motion/react`, but a CSS `filter` transition is not compositor-friendly and
 * this file's own rule is transform + opacity.
 */
export function Rise({
  children,
  index = 0,
  className = "",
}: {
  children: ReactNode;
  index?: number;
  className?: string;
}) {
  return (
    <div
      className={`ag-rise ${className}`}
      style={{ "--ag-rise-delay": `${Math.min(index, 10) * 45}ms` } as React.CSSProperties}
    >
      {children}
    </div>
  );
}

// ── Icons ─────────────────────────────────────────────────────────────────
//
// Ultra-light 1.5px strokes, round caps. Ported from folk so a glyph means the
// same thing in both consoles.

const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  "aria-hidden": true,
};

export function SlidersIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M3 6h11M18 6h3M3 12h4M11 12h10M3 18h8M15 18h6" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="9" cy="12" r="2" />
      <circle cx="13" cy="18" r="2" />
    </svg>
  );
}

export function UsersIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20" />
      <circle cx="9" cy="7" r="3.5" />
      <path d="M22 20v-1.5a4 4 0 0 0-3-3.87" />
      <path d="M16.5 3.63a4 4 0 0 1 0 6.74" />
    </svg>
  );
}

export function AlertIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7.5v5.5M12 16.5h.01" />
    </svg>
  );
}

export function RefreshIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M20 11a8 8 0 1 0-.6 4" />
      <path d="M20 5v6h-6" />
    </svg>
  );
}

export function ClockIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5.2l3.2 1.9" />
    </svg>
  );
}

export function TagIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M3.5 11.2V4.8a1.3 1.3 0 0 1 1.3-1.3h6.4a1.3 1.3 0 0 1 .92.38l8 8a1.3 1.3 0 0 1 0 1.84l-6.4 6.4a1.3 1.3 0 0 1-1.84 0l-8-8a1.3 1.3 0 0 1-.38-.92Z" />
      <path d="M7.75 7.75h.01" />
    </svg>
  );
}

export function PlusIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M5 12h14M12 5v14" />
    </svg>
  );
}

export function CheckIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}

export function ArrowIcon({ className = "" }: { className?: string }) {
  return (
    <svg {...iconProps} className={className}>
      <path d="M7 17 17 7M9 7h8v8" />
    </svg>
  );
}

export function ChevronIcon({
  direction = "right",
  className = "",
}: {
  direction?: "left" | "right";
  className?: string;
}) {
  return (
    <svg
      {...iconProps}
      className={`${direction === "left" ? "-scale-x-100" : ""} ${className}`}
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

/* Brand glyph. Filled, deliberately breaking the 1.5px-stroke house rule: a
 * brand mark is not our iconography, and a "stroked Discord face" is a wrong
 * logo, not a consistent one. */
export function DiscordGlyph({ className = "" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d="M20.32 4.37a19.8 19.8 0 0 0-4.93-1.51 13.8 13.8 0 0 0-.64 1.28 18.27 18.27 0 0 0-5.5 0 12.64 12.64 0 0 0-.64-1.28c-1.71.29-3.35.8-4.93 1.51C.56 9.05-.32 13.6.12 18.09a19.9 19.9 0 0 0 6.04 3.03c.49-.66.92-1.37 1.29-2.11-.71-.27-1.39-.6-2.03-.99.17-.12.34-.25.5-.38 3.9 1.79 8.12 1.79 11.98 0 .17.13.33.26.5.38-.64.39-1.33.72-2.04.99.37.74.8 1.45 1.29 2.11a19.84 19.84 0 0 0 6.05-3.03c.52-5.2-.89-9.71-3.38-13.72ZM8.02 15.33c-1.18 0-2.15-1.08-2.15-2.4 0-1.32.95-2.4 2.15-2.4 1.21 0 2.17 1.09 2.15 2.4 0 1.32-.95 2.4-2.15 2.4Zm7.96 0c-1.18 0-2.15-1.08-2.15-2.4 0-1.32.95-2.4 2.15-2.4 1.21 0 2.17 1.09 2.15 2.4 0 1.32-.94 2.4-2.15 2.4Z" />
    </svg>
  );
}

// ── Controls ──────────────────────────────────────────────────────────────

/** The house field. One hairline, no double edge, focus handled by `.ag`. */
export const agInput =
  "w-full rounded-[10px] bg-[rgba(118,128,152,0.06)] px-3 py-2 text-[13px] text-[var(--ag-ink)] " +
  "shadow-[inset_0_0_0_0.5px_rgba(16,24,40,0.10)] outline-none " +
  "placeholder:text-[var(--ag-ink-4)] transition-[background-color,box-shadow] duration-200";

export const agLabel =
  "block text-[11px] font-semibold uppercase tracking-[0.1em] text-[var(--ag-ink-3)]";

/** Quiet explanatory line under a field. */
export const agHint = "mt-1.5 block text-[11.5px] leading-snug text-[var(--ag-ink-4)]";

/**
 * The primary control: an ink-filled pill. `ag-press` gives it the physical
 * push; the trailing glyph rides in its own circle so it never sits naked
 * against the label.
 */
export const agButton =
  "ag-press inline-flex items-center gap-2 rounded-full bg-[var(--ag-ink)] py-2 pl-4 pr-2 " +
  "text-[13px] font-medium text-[var(--ag-on-ink)] disabled:opacity-40";

export const agButtonQuiet =
  "ag-press ag-glass-thin inline-flex items-center gap-2 rounded-full px-4 py-2 " +
  "text-[13px] font-medium text-[var(--ag-ink-2)] hover:text-[var(--ag-ink)] disabled:opacity-40";

/** The nested circle a trailing icon sits in. Never a naked arrow. */
export const agButtonIcon =
  "grid h-6 w-6 place-items-center rounded-full bg-[rgba(255,255,255,0.16)] " +
  "transition-transform duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)] " +
  "group-hover:translate-x-[2px] group-hover:scale-105";

// ── Tables ────────────────────────────────────────────────────────────────
//
// Tables are the main event on this console and they run past a screen, so the
// header sticks (`.ag-thead`) rather than scrolling away and leaving column
// four an unlabelled number.

export const agTableWrap = "-mx-5 overflow-x-auto px-5";
export const agTable = "min-w-full tabular-nums";
export const agTh =
  "whitespace-nowrap px-3 py-2.5 text-left text-[10px] font-semibold uppercase " +
  "tracking-[0.12em] text-[var(--ag-ink-4)]";
export const agTd = "px-3 py-2.5 align-middle text-[13px] text-[var(--ag-ink-2)]";
export const agRow =
  "border-t border-[var(--ag-hairline)] transition-colors duration-200 hover:bg-[rgba(118,128,152,0.045)]";

/**
 * Status pill. Tone is derived from the word rather than passed, so the same
 * status can't render green on one page and amber on another.
 */
export function Badge({
  status,
  tone,
}: {
  status: string;
  tone?: "neutral" | "positive" | "warn" | "critical";
}) {
  const derived =
    tone ??
    (/^(ready|active|succeeded|done|linked)$/i.test(status)
      ? "positive"
      : /^(failed|error)$/i.test(status)
        ? "critical"
        : /^(pending|queued|paused|archived|running)$/i.test(status)
          ? "warn"
          : "neutral");
  return <Eyebrow tone={derived}>{status}</Eyebrow>;
}

/** The quiet line a section shows instead of a table when it has nothing. */
export function Empty({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-[14px] bg-[rgba(118,128,152,0.05)] px-4 py-6 text-center text-[13px] text-[var(--ag-ink-4)]">
      {children}
    </p>
  );
}

/** Label / value line, for a definition list inside a card. */
export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-[12px] text-[var(--ag-ink-3)]">{label}</dt>
      <dd className="min-w-0 truncate text-right text-[13px] font-medium text-[var(--ag-ink)]">
        {children}
      </dd>
    </div>
  );
}
