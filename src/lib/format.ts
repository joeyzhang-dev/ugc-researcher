export function formatNumber(n: number | null | undefined): string {
  if (n == null) return "—";
  return n.toLocaleString("en-US");
}

export function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/**
 * Like formatDate, but pinned to UTC. For calendar-day identities (e.g. which
 * send-out batch a script belongs to): the day must match the UTC date used to
 * group/filter, or a batch sent at 02:00 UTC renders as the previous day.
 */
export function formatDateUTC(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Compact counts like the reference UI: 24.6K, 2.2M. */
export function formatCompact(n: number | null | undefined): string {
  if (n == null) return "—";
  if (n < 10_000) return n.toLocaleString("en-US");
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 }).format(n);
}

/** Relative day label for due dates: "in 3 days", "Today", "2 days ago". */
export function relativeDays(iso: string | null | undefined): string {
  if (!iso) return "";
  const days = Math.round(
    (new Date(iso).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 86_400_000
  );
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  return days > 0 ? `in ${days} days` : `${-days} days ago`;
}

/** For <input type="date"> values. */
export function toDateInputValue(iso: string | null | undefined): string {
  if (!iso) return "";
  return new Date(iso).toISOString().slice(0, 10);
}

/** 0.556 → "56%". Deliberately not clamped: a hold rate above 100% is a real,
 *  good outcome (viewers replayed), and hiding it would erase the signal. */
export function formatPercent(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

/** Money. Sub-cent values (a $40 flat fee spread over a million views) keep
 *  three decimals so a working CPM never rounds away to "$0.00". */
export function formatUsd(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const digits = n !== 0 && Math.abs(n) < 0.01 ? 3 : 2;
  return n.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** 16682 → "16.7s". Watch times are always seconds-scale on a reel. */
export function formatWatchTime(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return "—";
  const secs = ms / 1000;
  return secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs.toFixed(1)}s`;
}
