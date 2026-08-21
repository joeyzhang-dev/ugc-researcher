"use client";

import { Fragment, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { ResearchScoreChip } from "@/components/research-panel";
import { Segmented, StatusBadge, table, tableWrap, td, th, trHover } from "@/components/ui";
import { formatCompact, formatDateUTC } from "@/lib/format";
import { weekKeyUTC, weekLabel } from "./cal";
import { assignScriptNumbers } from "./doc";
import { ScriptsDocView } from "./scripts-doc-view";
import { AnnounceBar } from "./announce-bar";
import { SendBar, type SendTarget } from "./send-bar";

/* Categorical niche colors, restyled from cal.ts's flat pastels into the app's
   hairline-ring + tint language. The server deals a stable index per niche
   (nicheColorIndex); this maps that index onto four ready-made class strings —
   `tag` (static label on a surface), `overlay` (the same label frosted over a
   thumbnail), and `idle`/`on` for the multi-select filter pill. Full literal
   strings so Tailwind's scanner catches every one. */
const NICHE_PALETTE = [
  {
    tag: "bg-violet-500/[0.1] text-violet-700 ring-1 ring-inset ring-violet-500/[0.2]",
    overlay: "bg-white/85 text-violet-700 ring-1 ring-inset ring-violet-500/25 shadow-sm backdrop-blur-sm",
    idle: "bg-violet-500/[0.08] text-violet-700 ring-1 ring-inset ring-violet-500/[0.2] hover:bg-violet-500/[0.16]",
    on: "bg-violet-600 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
  {
    tag: "bg-sky-500/[0.1] text-sky-700 ring-1 ring-inset ring-sky-500/[0.2]",
    overlay: "bg-white/85 text-sky-700 ring-1 ring-inset ring-sky-500/25 shadow-sm backdrop-blur-sm",
    idle: "bg-sky-500/[0.08] text-sky-700 ring-1 ring-inset ring-sky-500/[0.2] hover:bg-sky-500/[0.16]",
    on: "bg-sky-600 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
  {
    tag: "bg-pink-500/[0.1] text-pink-700 ring-1 ring-inset ring-pink-500/[0.2]",
    overlay: "bg-white/85 text-pink-700 ring-1 ring-inset ring-pink-500/25 shadow-sm backdrop-blur-sm",
    idle: "bg-pink-500/[0.08] text-pink-700 ring-1 ring-inset ring-pink-500/[0.2] hover:bg-pink-500/[0.16]",
    on: "bg-pink-600 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
  {
    tag: "bg-emerald-500/[0.1] text-emerald-700 ring-1 ring-inset ring-emerald-500/[0.2]",
    overlay: "bg-white/85 text-emerald-700 ring-1 ring-inset ring-emerald-500/25 shadow-sm backdrop-blur-sm",
    idle: "bg-emerald-500/[0.08] text-emerald-700 ring-1 ring-inset ring-emerald-500/[0.2] hover:bg-emerald-500/[0.16]",
    on: "bg-emerald-600 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
  {
    tag: "bg-amber-500/[0.12] text-amber-700 ring-1 ring-inset ring-amber-500/[0.22]",
    overlay: "bg-white/85 text-amber-700 ring-1 ring-inset ring-amber-500/30 shadow-sm backdrop-blur-sm",
    idle: "bg-amber-500/[0.1] text-amber-700 ring-1 ring-inset ring-amber-500/[0.22] hover:bg-amber-500/[0.18]",
    on: "bg-amber-500 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
  {
    tag: "bg-orange-500/[0.1] text-orange-700 ring-1 ring-inset ring-orange-500/[0.2]",
    overlay: "bg-white/85 text-orange-700 ring-1 ring-inset ring-orange-500/25 shadow-sm backdrop-blur-sm",
    idle: "bg-orange-500/[0.08] text-orange-700 ring-1 ring-inset ring-orange-500/[0.2] hover:bg-orange-500/[0.16]",
    on: "bg-orange-600 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
  {
    tag: "bg-teal-500/[0.1] text-teal-700 ring-1 ring-inset ring-teal-500/[0.2]",
    overlay: "bg-white/85 text-teal-700 ring-1 ring-inset ring-teal-500/25 shadow-sm backdrop-blur-sm",
    idle: "bg-teal-500/[0.08] text-teal-700 ring-1 ring-inset ring-teal-500/[0.2] hover:bg-teal-500/[0.16]",
    on: "bg-teal-600 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
  {
    tag: "bg-indigo-500/[0.1] text-indigo-700 ring-1 ring-inset ring-indigo-500/[0.2]",
    overlay: "bg-white/85 text-indigo-700 ring-1 ring-inset ring-indigo-500/25 shadow-sm backdrop-blur-sm",
    idle: "bg-indigo-500/[0.08] text-indigo-700 ring-1 ring-inset ring-indigo-500/[0.2] hover:bg-indigo-500/[0.16]",
    on: "bg-indigo-600 text-white shadow-ambient ring-1 ring-inset ring-white/15",
  },
] as const;

/* Multi-select filter pills. Every pill is always rendered and merely dimmed
   (never removed) when a cross-filter would empty it, so toggling one never
   reflows the row — the deliberate no-layout-shift fix. */
const FILTER_PILL = "rounded-full px-3 py-1 text-[13px] font-medium transition";
const WEEK_ON = "bg-neutral-900 text-white shadow-ambient ring-1 ring-inset ring-white/10";
const WEEK_IDLE =
  "bg-neutral-500/[0.06] text-neutral-600 ring-1 ring-inset ring-hairline hover:bg-neutral-500/[0.1] hover:text-neutral-900";

/** Slim, serializable projection of ScriptPerf — the full thing drags every
 *  post's video (transcripts included) over the wire for no reason. */
export type ScriptRow = {
  id: string;
  label: string;
  niche: string | null;
  /** created_at, both the YYYY-MM-DD day (filter key) and the full ISO. */
  sentDay: string;
  createdAt: string;
  status: string;
  /** Full text for the Doc view — the other views only need the label. */
  hook: string | null;
  body: string | null;
  inspoUrl: string | null;
  demo: string | null;
  songs: string | null;
  medianScore: number | null;
  medianLift: number | null;
  medianViews: number | null;
  posts: number;
  creators: number;
  pending: number;
  best: { score: number | null; handle: string; postedAt: string | null; thumbnailUrl: string | null } | null;
};

const VIEWS = [
  ["table", "Table"],
  ["grid", "Gallery"],
  ["doc", "Doc"],
] as const;
type ViewMode = (typeof VIEWS)[number][0];

const STATUS_TABS = [
  ["", "All"],
  ["Active", "Active"],
  ["Draft", "Draft"],
  ["Archived", "Archived"],
] as const;

/** Sentinel niche key for scripts that have none, so they still group. */
const UNGROUPED = "\u0000none";

function Chevron({ open, small = false }: { open: boolean; small?: boolean }) {
  const n = small ? 11 : 13;
  return (
    <svg
      width={n}
      height={n}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.4"
      strokeLinecap="round"
      className={`shrink-0 text-neutral-400 transition-transform ${open ? "" : "-rotate-90"}`}
    >
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
}

/** One cell of the stat strip. Short numbers did not justify a card each,
 *  stretched across the page with its own icon disc. */
function Kpi({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex min-w-0 flex-col justify-center gap-0.5 px-4 py-2.5">
      <span className="truncate text-[11px] font-medium text-neutral-500">{label}</span>
      <span className="text-lg font-semibold tabular-nums text-neutral-900">{value}</span>
    </span>
  );
}

/**
 * KPIs, filters and the scripts table, filtering entirely client-side —
 * every toggle is instant, and the URL is kept shareable via replaceState
 * (no server round-trip, no scroll jump).
 */
export function ScriptsExplorer({
  rows,
  totalScripts,
  hasAnyScripts,
  nicheColorIndex,
  initialStatus,
  initialNiches,
  initialSents,
  currentAppId,
  sendTargets,
  formSlot,
  footnote,
}: {
  rows: ScriptRow[];
  totalScripts: number;
  hasAnyScripts: boolean;
  /** Palette index per niche, dealt server-side from the full known-niche list. */
  nicheColorIndex: Record<string, number>;
  initialStatus: string;
  initialNiches: string[];
  initialSents: string[];
  /** Workspace app the Doc view files new scripts under (null = All apps). */
  currentAppId: string | null;
  /** Roster creators the send bar can deliver to. */
  sendTargets: SendTarget[];
  /** The server-rendered "Write a script" card, slotted between KPIs and table. */
  formSlot: ReactNode;
  footnote?: ReactNode;
}) {
  const [status, setStatus] = useState(initialStatus);
  const [niches, setNiches] = useState(initialNiches);
  const [sents, setSents] = useState(initialSents);
  // View is a local preference, not a filter — keeping it out of the URL means
  // a shared link still lands on the recipient's own preferred layout.
  const [view, setView] = useState<ViewMode>("table");
  // Scripts ticked for sending — survives filter changes on purpose, so you
  // can gather a batch across weeks; the bar's Clear empties it.
  // Canonical #N per script (Doc position within week+niche) — computed over
  // ALL rows so filters never renumber anything.
  const scriptNumbers = useMemo(() => assignScriptNumbers(rows), [rows]);
  const [announceOpen, setAnnounceOpen] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const toggleSelected = (id: string) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  // Group checkbox semantics: all selected → clear them, else select all.
  const toggleMany = (ids: string[]) =>
    setSelectedIds((prev) => {
      const next = new Set(prev);
      const allIn = ids.length > 0 && ids.every((id) => next.has(id));
      for (const id of ids) (allIn ? next.delete(id) : next.add(id));
      return next;
    });

  const apply = (nextStatus: string, nextNiches: string[], nextSents: string[]) => {
    setStatus(nextStatus);
    setNiches(nextNiches);
    setSents(nextSents);
    const sp = new URLSearchParams();
    if (nextStatus) sp.set("status", nextStatus);
    for (const n of nextNiches) sp.append("niche", n);
    for (const d of nextSents) sp.append("sent", d);
    const qs = sp.toString();
    window.history.replaceState(null, "", `/scripts${qs ? `?${qs}` : ""}`);
  };

  const toggled = (list: string[], v: string) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];

  const colorOf = (niche: string) =>
    NICHE_PALETTE[(nicheColorIndex[niche] ?? 0) % NICHE_PALETTE.length];

  const filtered = useMemo(
    () =>
      rows
        .filter((r) => !status || r.status === status)
        .filter((r) => !niches.length || (!!r.niche && niches.includes(r.niche)))
        .filter((r) => !sents.length || sents.includes(weekKeyUTC(r.sentDay))),
    [rows, status, niches, sents]
  );

  // Every niche and every send-out date is always rendered, so the filter row
  // never changes height. It used to list only the combinations that still had
  // results, which meant clicking a date removed niche pills, the row reflowed,
  // and the entire page below it jumped — the amount depending on which pill
  // you happened to click. The cross-filtered sets below now only decide which
  // pills are dimmed, never how many exist.
  const nichesInView = useMemo(
    () =>
      [
        ...new Set(
          rows
            .filter((r) => !sents.length || sents.includes(weekKeyUTC(r.sentDay)))
            .map((r) => r.niche)
            .filter((n): n is string => !!n)
        ),
      ].sort(),
    [rows, sents]
  );

  const sentDatesInView = useMemo(
    () =>
      [
        ...new Set(
          rows
            .filter((r) => !niches.length || (!!r.niche && niches.includes(r.niche)))
            .map((r) => weekKeyUTC(r.sentDay))
        ),
      ]
        .sort()
        .reverse(),
    [rows, niches]
  );

  const allNiches = useMemo(
    () => [...new Set(rows.map((r) => r.niche).filter((n): n is string => !!n))].sort(),
    [rows]
  );
  const allWeeks = useMemo(() => {
    // Latest actual send-out in each week, so an older week's pill shows a date
    // that really happened rather than the Monday that starts it.
    const latest = new Map<string, string>();
    for (const r of rows) {
      const k = weekKeyUTC(r.sentDay);
      if (!latest.has(k) || r.sentDay > latest.get(k)!) latest.set(k, r.sentDay);
    }
    return [...latest.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, latestDay]) => ({ key, label: weekLabel(key, latestDay) }));
  }, [rows]);

  // Rows arrive flat but are read in batches: everything sent in one week,
  // split by niche. Grouping in the table means you can fold a week away
  // instead of scrolling past it.
  const grouped = useMemo(() => {
    const weeks = new Map<string, { latestDay: string; rows: ScriptRow[] }>();
    for (const r of filtered) {
      const k = weekKeyUTC(r.sentDay);
      const w = weeks.get(k) ?? { latestDay: r.sentDay, rows: [] };
      if (r.sentDay > w.latestDay) w.latestDay = r.sentDay;
      w.rows.push(r);
      weeks.set(k, w);
    }
    return [...weeks.entries()]
      .sort((a, b) => (a[0] < b[0] ? 1 : -1))
      .map(([key, w]) => {
        const byNiche = new Map<string, ScriptRow[]>();
        for (const r of w.rows) {
          const n = r.niche ?? UNGROUPED;
          (byNiche.get(n) ?? byNiche.set(n, []).get(n)!).push(r);
        }
        return {
          key,
          label: weekLabel(key, w.latestDay),
          count: w.rows.length,
          niches: [...byNiche.entries()]
            .sort((a, b) =>
              // Unniched last, otherwise alphabetical.
              a[0] === UNGROUPED ? 1 : b[0] === UNGROUPED ? -1 : a[0].localeCompare(b[0])
            )
            .map(([niche, rs]) => ({ niche, rows: rs })),
        };
      });
  }, [filtered]);

  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<string>>(new Set());
  const [collapsedNiches, setCollapsedNiches] = useState<Set<string>>(new Set());
  const toggleWeek = (k: string) =>
    setCollapsedWeeks((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });
  const toggleNiche = (k: string) =>
    setCollapsedNiches((prev) => {
      const next = new Set(prev);
      if (!next.delete(k)) next.add(k);
      return next;
    });

  const totalPosts = filtered.reduce((s, r) => s + r.posts, 0);
  const totalPending = filtered.reduce((s, r) => s + r.pending, 0);

  // Based on the full sets, not the cross-filtered ones: if this flipped false
  // mid-filtering the whole row would vanish and take the page with it.
  const hasFilterRow = allNiches.length > 0 || allWeeks.length > 1;

  return (
    <div className="stagger-children">
      {/* Composer shares the row with the stats — closed it is just a button,
          and it only claims a line of its own once opened. */}
      <div className="mb-4 flex flex-wrap items-start gap-3">
        <div className="inline-flex max-w-full flex-wrap items-stretch divide-x divide-hairline overflow-hidden rounded-2xl bg-surface shadow-ambient ring-1 ring-hairline inset-shadow-highlight">
          <Kpi label="Scripts" value={String(totalScripts)} />
          <Kpi label="Posts measured" value={String(totalPosts)} />
          <Kpi label="Awaiting a post" value={String(totalPending)} />
        </div>
        {formSlot}
      </div>

      <section className="mt-5 rounded-[18px] bg-surface-muted p-1.5 shadow-ambient ring-1 ring-hairline">
        <div className="rounded-xl bg-surface inset-shadow-highlight ring-1 ring-hairline">
        <header className="flex flex-wrap items-center justify-between gap-3 px-5 pb-3 pt-4">
          <h2 className="text-sm font-semibold tracking-[-0.01em] text-neutral-900">
            All scripts
            <span className="ml-1.5 font-normal tabular-nums text-neutral-400">
              {filtered.length}
            </span>
          </h2>
          {/* View is a local layout preference; status a single-select filter —
              both genuine single-value pickers, so both ride the shared
              Segmented. The week/niche pills below stay multi-select. */}
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setAnnounceOpen((v) => !v)}
              title="Post an announcement into picked creators' channels, tagging each creator"
              className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium ring-1 ring-inset transition ${
                announceOpen
                  ? "bg-neutral-900 text-white ring-white/10"
                  : "text-neutral-600 ring-hairline hover:bg-neutral-500/[0.06] hover:text-neutral-900"
              }`}
            >
              📣 Announce
            </button>
            <Segmented
              size="sm"
              aria-label="View mode"
              value={view}
              items={VIEWS.map(([value, label]) => ({
                value,
                label,
                onClick: () => setView(value),
              }))}
            />
            <Segmented
              size="sm"
              aria-label="Status filter"
              value={status}
              items={STATUS_TABS.map(([value, label]) => ({
                value,
                label,
                onClick: () => apply(value, niches, sents),
              }))}
            />
          </div>
        </header>

        {hasFilterRow && (
          <div className="flex flex-wrap items-center gap-1.5 border-t border-hairline px-5 py-3">
            {allNiches.map((n) => {
              const c = colorOf(n);
              const on = niches.includes(n);
              // Dimmed rather than removed: it would return nothing under the
              // dates currently selected, but it keeps its place in the row.
              const dead = !on && !nichesInView.includes(n);
              return (
                <button
                  key={n}
                  type="button"
                  disabled={dead}
                  title={dead ? "No scripts in this niche for the selected dates" : undefined}
                  onClick={() => apply(status, toggled(niches, n), sents)}
                  className={`${FILTER_PILL} ${on ? c.on : c.idle} ${
                    dead ? "cursor-default opacity-40" : ""
                  }`}
                >
                  {n}
                </button>
              );
            })}
            {allNiches.length > 0 && allWeeks.length > 1 && (
              <span className="mx-1.5 h-4 w-px bg-hairline-strong" />
            )}
            {allWeeks.length > 1 &&
              allWeeks.map(({ key, label }) => {
                const on = sents.includes(key);
                const dead = !on && !sentDatesInView.includes(key);
                return (
                  <button
                    key={key}
                    type="button"
                    disabled={dead}
                    title={dead ? "No scripts sent this week in the selected niches" : undefined}
                    onClick={() => apply(status, niches, toggled(sents, key))}
                    className={`${FILTER_PILL} tabular-nums ${on ? WEEK_ON : WEEK_IDLE} ${
                      dead ? "cursor-default opacity-40" : ""
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            {(niches.length > 0 || sents.length > 0) && (
              <button
                type="button"
                onClick={() => apply(status, [], [])}
                className="ml-1.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-medium text-neutral-400 transition hover:bg-neutral-500/[0.08] hover:text-neutral-900"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
                Reset
              </button>
            )}
          </div>
        )}

        <div className={`px-5 pb-5 ${hasFilterRow ? "pt-3" : "pt-1"}`}>
          {/* Doc view renders even with nothing to show — its current-week
              grid is where a fresh batch gets written. */}
          {filtered.length === 0 && view !== "doc" ? (
            <p className="py-10 text-center text-sm text-neutral-400">
              {!hasAnyScripts
                ? "No scripts yet — write one above, hand it to a creator, then link the video they post."
                : "No scripts match these filters in the current workspace."}
            </p>
          ) : view === "doc" ? (
            <ScriptsDocView
              rows={filtered}
              colorOf={colorOf}
              knownNiches={Object.keys(nicheColorIndex).sort()}
              currentAppId={currentAppId}
              selectedIds={selectedIds}
              onToggleSelect={toggleSelected}
            />
          ) : view === "grid" ? (
            /* Gallery: the hook plus the face of its best post. Scanning 102
               scripts as rows of numbers tells you nothing about what they
               are; the thumbnail and the opening line do. */
            <div className="grid gap-3 stagger-children [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
              {filtered.map((r) => (
                <Link
                  key={r.id}
                  href={`/scripts/${r.id}`}
                  className="group flex flex-col overflow-hidden rounded-2xl bg-surface shadow-ambient ring-1 ring-hairline transition hover:shadow-raised active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  <span className="relative block aspect-[4/3] w-full overflow-hidden bg-surface-sunken">
                    {r.best?.thumbnailUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={r.best.thumbnailUrl}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        referrerPolicy="no-referrer"
                        className="h-full w-full object-cover"
                      />
                    ) : (
                      <span className="flex h-full w-full items-center justify-center text-[11px] text-neutral-400">
                        no posts yet
                      </span>
                    )}
                    <span className="absolute right-2 top-2">
                      <ResearchScoreChip score={r.medianScore} />
                    </span>
                    {r.niche && (
                      <span
                        className={`absolute left-2 top-2 max-w-[70%] truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${colorOf(r.niche).overlay}`}
                      >
                        {r.niche}
                      </span>
                    )}
                  </span>

                  <span className="flex min-w-0 flex-1 flex-col gap-1.5 p-3">
                    <span className="line-clamp-2 text-[13px] font-medium leading-snug text-neutral-900 group-hover:underline">
                      {r.label}
                    </span>
                    <span className="mt-auto flex items-center justify-between gap-2 text-[11px] tabular-nums text-neutral-500">
                      <span>
                        {fmtLift(r.medianLift)} · {formatCompact(r.medianViews)} views
                      </span>
                      <span className="shrink-0">
                        {r.posts}/{r.creators}
                        {r.pending > 0 && (
                          <span className="ml-1 text-warning">+{r.pending}</span>
                        )}
                      </span>
                    </span>
                    <span className="text-[11px] tabular-nums text-neutral-400">
                      {formatDateUTC(r.createdAt)}
                      {r.status !== "Active" && ` · ${r.status}`}
                    </span>
                  </span>
                </Link>
              ))}
            </div>
          ) : (
            <div className={tableWrap}>
              <table className={table}>
                <thead>
                  <tr>
                    {/* Selection column: header intentionally unlabeled. */}
                    <th className={`${th} w-8`} aria-label="Select" />
                    <th className={th}>Sent</th>
                    <th className={th}>Niche</th>
                    <th className={th}>Script</th>
                    <th className={th}>Score</th>
                    <th className={th}>Lift</th>
                    <th className={th}>Views</th>
                    <th className={th}>Ran by</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-black/[0.05]">
                  {grouped.map((week) => {
                    const weekOpen = !collapsedWeeks.has(week.key);
                    return (
                      <Fragment key={week.key}>
                        <tr className="bg-neutral-900/[0.03]">
                          <td colSpan={8} className="px-3 py-2">
                            <div className="flex items-center gap-2">
                              <input
                                type="checkbox"
                                aria-label={`Select every ${week.label} script`}
                                checked={
                                  week.niches.length > 0 &&
                                  week.niches.every((g) => g.rows.every((r) => selectedIds.has(r.id)))
                                }
                                onChange={() =>
                                  toggleMany(week.niches.flatMap((g) => g.rows.map((r) => r.id)))
                                }
                                className="size-3.5 accent-neutral-900"
                              />
                              <button
                                type="button"
                                onClick={() => toggleWeek(week.key)}
                                className="flex w-full items-center gap-2 text-left text-[13px] font-semibold text-neutral-900"
                              >
                                <Chevron open={weekOpen} />
                                {week.label}
                                <span className="font-normal tabular-nums text-neutral-400">
                                  {week.count}
                                </span>
                              </button>
                            </div>
                          </td>
                        </tr>
                        {weekOpen &&
                          week.niches.map((group) => {
                            const groupKey = `${week.key}|${group.niche}`;
                            const groupOpen = !collapsedNiches.has(groupKey);
                            return (
                              <Fragment key={groupKey}>
                                {/* Only worth a sub-header when the week
                                    actually spans more than one niche. */}
                                {week.niches.length > 1 && (
                                  <tr>
                                    <td colSpan={8} className="px-3 py-1.5 pl-8">
                                      <div className="flex items-center gap-2">
                                        <input
                                          type="checkbox"
                                          aria-label={`Select all ${group.niche === UNGROUPED ? "un-niched" : group.niche} scripts this week`}
                                          checked={group.rows.every((r) => selectedIds.has(r.id))}
                                          onChange={() => toggleMany(group.rows.map((r) => r.id))}
                                          className="size-3.5 accent-neutral-900"
                                        />
                                        <button
                                          type="button"
                                          onClick={() => toggleNiche(groupKey)}
                                          className="flex items-center gap-2 text-left text-[12px] font-medium text-neutral-500"
                                        >
                                          <Chevron open={groupOpen} small />
                                          {group.niche === UNGROUPED ? "No niche" : group.niche}
                                          <span className="tabular-nums text-neutral-400">
                                            {group.rows.length}
                                          </span>
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                )}
                                {(groupOpen || week.niches.length === 1) &&
                                  group.rows.map((r) => (
                            <tr key={r.id} className={trHover}>
                              <td className={`${td} w-8`}>
                                <input
                                  type="checkbox"
                                  aria-label={`Select ${r.label}`}
                                  checked={selectedIds.has(r.id)}
                                  onChange={() => toggleSelected(r.id)}
                                  className="size-3.5 accent-neutral-900"
                                />
                              </td>
                              <td className={`${td} whitespace-nowrap tabular-nums text-neutral-500`}>
                                {formatDateUTC(r.createdAt)}
                              </td>
                              <td className={td}>
                                {r.niche ? (
                                  <span
                                    className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${colorOf(r.niche).tag}`}
                                  >
                                    {r.niche}
                                  </span>
                                ) : (
                                  <span className="text-neutral-300">—</span>
                                )}
                              </td>
                              <td className={`${td} max-w-[32rem]`}>
                                <Link href={`/scripts/${r.id}`} className="group block">
                                  <span className="flex items-center gap-1.5">
                                    {scriptNumbers.get(r.id) != null && (
                                      <span className="shrink-0 tabular-nums text-[12px] font-semibold text-neutral-400">
                                        #{scriptNumbers.get(r.id)}
                                      </span>
                                    )}
                                    <span className="truncate font-medium text-neutral-900 group-hover:underline">
                                      {r.label}
                                    </span>
                                    {r.status !== "Active" && <StatusBadge status={r.status} />}
                                  </span>
                                </Link>
                              </td>
                              <td className={td}>
                                <ResearchScoreChip score={r.medianScore} />
                              </td>
                              <td className={`${td} tabular-nums`}>{fmtLift(r.medianLift)}</td>
                              <td className={`${td} tabular-nums`}>{formatCompact(r.medianViews)}</td>
                              <td className={`${td} whitespace-nowrap tabular-nums`}>
                                <span className="font-medium">{r.posts}</span>
                                <span className="text-neutral-400">
                                  /{r.creators} creator{r.creators === 1 ? "" : "s"}
                                </span>
                                {r.pending > 0 && (
                                  <span className="ml-1.5 shrink-0 rounded-full bg-warning/[0.12] px-2 py-0.5 text-[11px] font-medium text-warning ring-1 ring-inset ring-warning/[0.24]">
                                    {r.pending} waiting
                                  </span>
                                )}
                              </td>
                            </tr>
                                  ))}
                              </Fragment>
                            );
                          })}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
          {footnote}
        </div>
        </div>
      </section>

      {selectedIds.size > 0 && (
        <SendBar
          scriptIds={[...selectedIds]}
          targets={sendTargets}
          onClear={() => setSelectedIds(new Set())}
        />
      )}
      {/* The script send bar wins the bottom slot — an active selection means
          a send is in progress, so the announcer waits its turn. */}
      {announceOpen && selectedIds.size === 0 && (
        <AnnounceBar targets={sendTargets} onClose={() => setAnnounceOpen(false)} />
      )}
    </div>
  );
}
