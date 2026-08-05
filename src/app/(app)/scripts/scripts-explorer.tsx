"use client";

import { useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { KPI_ICONS } from "@/components/ui";
import { ResearchScoreChip } from "@/components/research-panel";
import { formatCompact, formatDate, formatDateUTC } from "@/lib/format";
import {
  NICHE_PALETTE,
  card,
  cardTitle,
  pillActive,
  pillBase,
  pillIdle,
  rowPill,
  td,
  th,
} from "./cal";

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
] as const;
type ViewMode = (typeof VIEWS)[number][0];

const STATUS_TABS = [
  ["", "All"],
  ["Active", "Active"],
  ["Draft", "Draft"],
  ["Archived", "Archived"],
] as const;

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
}

function Kpi({
  label,
  value,
  sub,
  icon,
}: {
  label: string;
  value: string;
  sub?: string;
  icon: string;
}) {
  return (
    <div className={`flex items-start gap-3 p-4 ${card}`}>
      <span className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-neutral-100 text-neutral-900">
        {KPI_ICONS[icon]}
      </span>
      <span className="block min-w-0">
        <span className="block truncate text-[13px] font-medium text-neutral-500">{label}</span>
        <span className="mt-0.5 block text-2xl font-semibold tracking-tight tabular-nums text-neutral-900">
          {value}
        </span>
        {sub && <span className="mt-0.5 block truncate text-xs text-neutral-400">{sub}</span>}
      </span>
    </div>
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
        .filter((r) => !sents.length || sents.includes(r.sentDay)),
    [rows, status, niches, sents]
  );

  // Each filter row is scoped by the OTHER active filter, so picking a niche
  // leaves only that niche's send-out dates (and vice versa) — no dead combos.
  const nichesInView = useMemo(
    () =>
      [
        ...new Set(
          rows
            .filter((r) => !sents.length || sents.includes(r.sentDay))
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
            .map((r) => r.sentDay)
        ),
      ]
        .sort()
        .reverse(),
    [rows, niches]
  );

  const totalPosts = filtered.reduce((s, r) => s + r.posts, 0);
  const totalPending = filtered.reduce((s, r) => s + r.pending, 0);
  const best = filtered.find((r) => r.medianScore != null) ?? null;

  const hasFilterRow = nichesInView.length > 0 || sentDatesInView.length > 1;

  return (
    <>
      <div className="mb-8 grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Kpi label="Scripts" value={String(totalScripts)} icon="badge" />
        <Kpi label="Posts measured" value={String(totalPosts)} icon="play" />
        <Kpi label="Awaiting a post" value={String(totalPending)} icon="clock" />
        <Kpi
          label="Best median score"
          value={best?.medianScore?.toFixed(1) ?? "—"}
          sub={best?.label}
          icon="trend"
        />
      </div>

      {formSlot}

      <section className={`mt-8 ${card}`}>
        <header className="flex flex-wrap items-center justify-between gap-3 px-6 pt-5">
          <h2 className={cardTitle}>
            All scripts
            <span className="ml-2 font-normal tabular-nums text-neutral-400">
              {filtered.length}
            </span>
          </h2>
          {/* cal.com's signature pill-in-pill segmented control. */}
          <span className="flex items-center gap-2">
            <span className="inline-flex items-center gap-0.5 rounded-full bg-neutral-100 p-1">
              {VIEWS.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setView(value)}
                  className={`rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
                    view === value
                      ? "bg-white text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                      : "text-neutral-500 hover:text-neutral-900"
                  }`}
                >
                  {label}
                </button>
              ))}
            </span>
            <span className="inline-flex items-center gap-0.5 rounded-full bg-neutral-100 p-1">
            {STATUS_TABS.map(([value, label]) => (
              <button
                key={label}
                type="button"
                onClick={() => apply(value, niches, sents)}
                className={`rounded-full px-3.5 py-1 text-[13px] font-medium transition-colors ${
                  status === value
                    ? "bg-white text-neutral-900 shadow-[0_1px_2px_rgba(0,0,0,0.08)]"
                    : "text-neutral-500 hover:text-neutral-900"
                }`}
              >
                {label}
              </button>
            ))}
            </span>
          </span>
        </header>

        {hasFilterRow && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-neutral-100 px-6 py-3.5">
            {nichesInView.map((n) => {
              const c = colorOf(n);
              return (
                <button
                  key={n}
                  type="button"
                  onClick={() => apply(status, toggled(niches, n), sents)}
                  className={`${pillBase} border ${niches.includes(n) ? c.active : c.pill}`}
                >
                  {n}
                </button>
              );
            })}
            {nichesInView.length > 0 && sentDatesInView.length > 1 && (
              <span className="mx-1.5 h-4 w-px bg-neutral-200" />
            )}
            {sentDatesInView.length > 1 &&
              sentDatesInView.map((d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => apply(status, niches, toggled(sents, d))}
                  className={`tabular-nums ${sents.includes(d) ? pillActive : pillIdle}`}
                >
                  {formatDateUTC(d)}
                </button>
              ))}
            {(niches.length > 0 || sents.length > 0) && (
              <button
                type="button"
                onClick={() => apply(status, [], [])}
                className="ml-1.5 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[13px] font-medium text-neutral-400 transition-colors hover:bg-neutral-100 hover:text-neutral-900"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M6 6l12 12M18 6L6 18" />
                </svg>
                Reset
              </button>
            )}
          </div>
        )}

        <div className={`px-6 pb-5 ${hasFilterRow ? "" : "pt-3"}`}>
          {filtered.length === 0 ? (
            <p className="py-10 text-center text-sm text-neutral-400">
              {!hasAnyScripts
                ? "No scripts yet — write one above, hand it to a creator, then link the video they post."
                : "No scripts match these filters in the current workspace."}
            </p>
          ) : view === "grid" ? (
            /* Gallery: the hook plus the face of its best post. Scanning 102
               scripts as rows of numbers tells you nothing about what they
               are; the thumbnail and the opening line do. */
            <div className="grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(230px,1fr))]">
              {filtered.map((r) => (
                <Link
                  key={r.id}
                  href={`/scripts/${r.id}`}
                  className="group flex flex-col overflow-hidden rounded-xl border border-neutral-200 bg-white transition hover:border-neutral-300 hover:shadow-sm"
                >
                  <span className="relative block aspect-[4/3] w-full overflow-hidden bg-neutral-100">
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
                        className={`absolute left-2 top-2 max-w-[70%] truncate rounded-full px-2 py-0.5 text-[11px] font-medium ${colorOf(r.niche).row}`}
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
                          <span className="ml-1 text-amber-600">+{r.pending}</span>
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
            <div className="-mx-6 overflow-x-auto px-6">
              <table className="min-w-full divide-y divide-neutral-200">
                <thead>
                  <tr>
                    <th className={th}>Script</th>
                    <th className={th}>Score</th>
                    <th className={th}>Lift</th>
                    <th className={th}>Views</th>
                    <th className={th}>Ran by</th>
                    <th className={th}>Best post</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {filtered.map((r) => (
                    <tr key={r.id} className="transition-colors hover:bg-[#f8f9fa]">
                      <td className={`${td} max-w-96`}>
                        <Link href={`/scripts/${r.id}`} className="group block">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-neutral-900 group-hover:underline">
                              {r.label}
                            </span>
                            {r.niche && (
                              <span
                                className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${colorOf(r.niche).row}`}
                              >
                                {r.niche}
                              </span>
                            )}
                            {/* Which send-out the script came from, so same-niche
                                batches from different days stay tellable apart. */}
                            <span className={`${rowPill} tabular-nums text-neutral-500`}>
                              {formatDateUTC(r.createdAt)}
                            </span>
                            {r.status !== "Active" && (
                              <span className={`${rowPill} text-neutral-500`}>{r.status}</span>
                            )}
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
                          <span className={`ml-1.5 ${rowPill} text-neutral-500`}>
                            {r.pending} waiting
                          </span>
                        )}
                      </td>
                      <td className={`${td} max-w-56`}>
                        {r.best ? (
                          <span className="flex items-center gap-2">
                            <ResearchScoreChip score={r.best.score} />
                            <span className="min-w-0 truncate text-xs text-neutral-500">
                              @{r.best.handle}
                              {" · "}
                              {formatDate(r.best.postedAt)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-400">no posts yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {footnote}
        </div>
      </section>
    </>
  );
}
