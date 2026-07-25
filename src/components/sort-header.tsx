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
}: {
  label: string;
  sortKey: K;
  active: boolean;
  dir: SortDir;
  hrefFor: (key: K, dir: SortDir) => string;
  firstDir?: SortDir;
  className?: string;
}) {
  const nextDir: SortDir = active ? (dir === "asc" ? "desc" : "asc") : firstDir;
  return (
    <th className={`${th} ${className}`}>
      <Link
        href={hrefFor(sortKey, nextDir)}
        scroll={false}
        title={`Sort by ${label.toLowerCase()}`}
        className={`inline-flex items-center gap-1 transition-colors hover:text-neutral-900 ${
          active ? "text-neutral-900" : ""
        }`}
      >
        {label}
        <span className={active ? "text-neutral-900" : "text-neutral-300"}>
          {active ? (dir === "asc" ? "↑" : "↓") : "↕"}
        </span>
      </Link>
    </th>
  );
}
