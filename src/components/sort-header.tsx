import Link from "next/link";
import { th } from "@/components/ui";

// URL-param table sorting (?sort=&dir=), matching how every other filter on
// these pages works — server-rendered, no client JS, survives a refresh and
// can be linked/shared.

export type SortDir = "asc" | "desc";

export function parseSort<K extends string>(
  rawKey: string | undefined,
  rawDir: string | undefined,
  allowed: readonly K[],
  fallback: { key: K; dir: SortDir }
): { key: K; dir: SortDir } {
  const key = (allowed as readonly string[]).includes(rawKey ?? "")
    ? (rawKey as K)
    : fallback.key;
  const dir: SortDir = rawDir === "asc" || rawDir === "desc" ? rawDir : fallback.dir;
  return { key, dir };
}

/** Comparator that always sinks nulls to the bottom, whichever way you sort. */
export function compareValues(
  a: string | number | null | undefined,
  b: string | number | null | undefined,
  dir: SortDir
): number {
  if (a == null && b == null) return 0;
  if (a == null) return 1;
  if (b == null) return -1;
  const cmp =
    typeof a === "string" && typeof b === "string"
      ? a.localeCompare(b)
      : Number(a) - Number(b);
  return dir === "asc" ? cmp : -cmp;
}

/**
 * A clickable column header. Clicking the active column flips direction;
 * clicking a new one starts at `firstDir` (descending for numbers, so the
 * biggest values come first — that's what you want from "sort by views").
 */
export function SortHeader<K extends string>({
  label,
  sortKey,
  active,
  dir,
  hrefFor,
  firstDir = "desc",
  className = "",
  as: Tag = "th",
}: {
  label: string;
  sortKey: K;
  active: boolean;
  dir: SortDir;
  hrefFor: (key: K, dir: SortDir) => string;
  firstDir?: SortDir;
  className?: string;
  /** "div" for grid-based tables (aria-sort is only valid on real th cells). */
  as?: "th" | "div";
}) {
  const nextDir: SortDir = active ? (dir === "asc" ? "desc" : "asc") : firstDir;
  return (
    <Tag
      className={`${th} ${className}`}
      aria-sort={
        Tag === "th" ? (active ? (dir === "asc" ? "ascending" : "descending") : "none") : undefined
      }
    >
      <Link
        href={hrefFor(sortKey, nextDir)}
        scroll={false}
        title={`Sort by ${label.toLowerCase()}`}
        className={`group inline-flex items-center gap-1 transition-colors ${
          active ? "font-semibold text-neutral-900" : "hover:text-neutral-700"
        }`}
      >
        {label}
        {active ? (
          <svg
            aria-hidden
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            className="shrink-0"
          >
            <path d={dir === "asc" ? "m18 15-6-6-6 6" : "m6 9 6 6 6-6"} />
          </svg>
        ) : (
          <svg
            aria-hidden
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            className="shrink-0 text-neutral-300 opacity-0 transition-opacity group-hover:opacity-100"
          >
            <path d="m8 9 4-4 4 4M8 15l4 4 4-4" />
          </svg>
        )}
      </Link>
    </Tag>
  );
}
