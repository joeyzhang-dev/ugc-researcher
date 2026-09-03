"use client";

import { useState } from "react";
import Link from "next/link";
import { ResearchScoreChip } from "@/components/research-panel";
import { SubmitButton } from "@/components/submit-button";
import { NicheCombobox } from "@/components/niche-combobox";
import { nicheLabel } from "@/lib/niches";
import { createScript } from "./actions";
import { buildDocGrid } from "./doc";
import { currentWeekKeyUTC, weekKeyUTC, weekLabel } from "./cal";
import type { ScriptRow } from "./scripts-explorer";

/* The weekly Google-Doc layout, verbatim: niches down the side, Script 1..N
   across, the full text of every script in its cell. This is the shape the
   batch is written in, so the current week's grid is also where new scripts
   get typed — each niche row ends in a composer cell. */

const CELL_LABEL = "font-bold text-neutral-500";
const CELL_INPUT =
  "w-full rounded-lg bg-surface px-2.5 py-1.5 text-[12px] text-neutral-900 outline-none ring-1 ring-inset ring-hairline placeholder:text-neutral-400 focus:ring-2 focus:ring-accent/45";

type NichePalette = { tag: string };

function DocCell({
  r,
  index,
  selected,
  onToggleSelect,
}: {
  r: ScriptRow;
  index: number;
  selected: boolean;
  onToggleSelect: (id: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 p-3 text-[12px] leading-relaxed text-neutral-800">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-2">
          <input
            type="checkbox"
            aria-label={`Select script ${index + 1}`}
            checked={selected}
            onChange={() => onToggleSelect(r.id)}
            className="size-3.5 accent-neutral-900"
          />
          <Link
            href={`/scripts/${r.id}`}
            className="text-[11px] font-semibold uppercase tracking-wide text-neutral-400 hover:text-neutral-900 hover:underline"
          >
            Script {index + 1}
          </Link>
        </span>
        {r.posts > 0 && <ResearchScoreChip score={r.medianScore} />}
      </div>
      {r.inspoUrl && (
        <p className="truncate">
          <span className={CELL_LABEL}>INSPO VIDEO: </span>
          <a
            href={r.inspoUrl}
            target="_blank"
            rel="noreferrer"
            className="text-accent underline decoration-accent/40 hover:decoration-accent"
          >
            {r.inspoUrl}
          </a>
        </p>
      )}
      {r.demo && (
        <p>
          <span className={CELL_LABEL}>DEMO TO USE: </span>
          {r.demo}
        </p>
      )}
      {r.songs && (
        <p className="break-words">
          <span className={CELL_LABEL}>SONG(S) TO USE: </span>
          {/^https?:\/\/\S+$/.test(r.songs.trim()) ? (
            <a
              href={r.songs.trim()}
              target="_blank"
              rel="noreferrer"
              className="text-accent underline decoration-accent/40 hover:decoration-accent"
            >
              {r.songs.trim()}
            </a>
          ) : (
            r.songs
          )}
        </p>
      )}
      {r.hook && (
        <p>
          <span className={CELL_LABEL}>TEXT HOOK: </span>
          <span className="font-semibold text-neutral-900">{r.hook}</span>
        </p>
      )}
      {r.body && <div className="whitespace-pre-wrap">{r.body}</div>}
    </div>
  );
}

/** The trailing cell of a current-week niche row: a "+" that unfolds into the
 *  same fields a doc cell displays. Niche and app ride along hidden; the
 *  title is derived server-side from the hook. */
function ComposerCell({ niche, appId }: { niche: string | null; appId: string | null }) {
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="m-3 flex min-h-24 w-[calc(100%-1.5rem)] items-center justify-center gap-1.5 rounded-xl text-[13px] font-medium text-neutral-400 ring-1 ring-inset ring-hairline transition hover:bg-neutral-500/[0.04] hover:text-neutral-900"
      >
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
          <path d="M12 5v14M5 12h14" />
        </svg>
        Script
      </button>
    );
  }

  return (
    <form
      action={async (fd) => {
        await createScript(fd);
        setOpen(false);
      }}
      className="flex flex-col gap-1.5 p-3"
    >
      <input type="hidden" name="stay" value="1" />
      {niche && <input type="hidden" name="niche" value={niche} />}
      {appId && <input type="hidden" name="appId" value={appId} />}
      <input name="inspoUrl" placeholder="INSPO VIDEO: link" className={CELL_INPUT} />
      <input name="demo" placeholder="DEMO TO USE" className={CELL_INPUT} />
      <input name="songs" placeholder="SONG(S) TO USE" className={CELL_INPUT} />
      <input
        name="hook"
        required
        placeholder="TEXT HOOK — the opening line"
        className={`${CELL_INPUT} font-semibold`}
      />
      <textarea
        name="body"
        rows={8}
        placeholder="The script"
        className={`${CELL_INPUT} resize-y leading-relaxed`}
      />
      <div className="flex items-center justify-end gap-2 pt-0.5">
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-neutral-400 transition hover:text-neutral-900"
        >
          Cancel
        </button>
        <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
      </div>
    </form>
  );
}

export function ScriptsDocView({
  rows,
  colorOf,
  nicheEmojis,
  knownNiches,
  currentAppId,
  selectedIds,
  onToggleSelect,
}: {
  rows: ScriptRow[];
  colorOf: (niche: string) => NichePalette;
  /** name -> emoji from research_niches, dealt server-side. */
  nicheEmojis: Record<string, string>;
  /** Full known-niche list, for starting a fresh row in the current week. */
  knownNiches: string[];
  /** Workspace app new scripts are filed under (null = no app). */
  currentAppId: string | null;
  /** Scripts ticked for the send bar. */
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
}) {
  // Niche rows opened by hand this week, before any script exists in them.
  const [extraNiches, setExtraNiches] = useState<string[]>([]);

  const currentWeek = currentWeekKeyUTC();
  const weeks = new Map<string, { latestDay: string; rows: ScriptRow[] }>();
  for (const r of rows) {
    const k = weekKeyUTC(r.sentDay);
    const w = weeks.get(k) ?? { latestDay: r.sentDay, rows: [] };
    if (r.sentDay > w.latestDay) w.latestDay = r.sentDay;
    w.rows.push(r);
    weeks.set(k, w);
  }
  // The current week always renders, even empty — it is where the new batch
  // gets written.
  if (!weeks.has(currentWeek)) weeks.set(currentWeek, { latestDay: currentWeek, rows: [] });

  const sections = [...weeks.entries()]
    .sort((a, b) => (a[0] < b[0] ? 1 : -1))
    .map(([key, w]) => {
      const grid = buildDocGrid(w.rows);
      if (key === currentWeek) {
        const present = new Set(grid.rows.map((g) => g.niche));
        for (const n of extraNiches) {
          if (!present.has(n)) grid.rows.push({ niche: n, scripts: [] });
        }
      }
      return { key, label: weekLabel(key, w.latestDay), grid, editable: key === currentWeek };
    });

  return (
    <div className="space-y-6">
      {sections.map(({ key, label, grid, editable }) => (
        <section key={key}>
          <h3 className="mb-2 flex items-baseline gap-1.5 text-[13px] font-semibold text-neutral-900">
            {label}
            <span className="font-normal tabular-nums text-neutral-400">
              {grid.rows.reduce((s, r) => s + r.scripts.length, 0)}
            </span>
          </h3>

          {grid.rows.length === 0 ? (
            <p className="rounded-xl px-4 py-6 text-center text-sm text-neutral-400 ring-1 ring-inset ring-hairline">
              Nothing written this week yet — add a niche below to start the batch.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl ring-1 ring-hairline">
              <table className="w-full border-separate border-spacing-0">
                <thead>
                  <tr>
                    <th className="sticky left-0 z-10 min-w-24 border-b border-hairline bg-surface px-3 py-2 text-left text-[12px] font-semibold text-neutral-500">
                      Niche
                    </th>
                    {Array.from({ length: grid.columns }, (_, i) => (
                      <th
                        key={i}
                        className="min-w-[300px] max-w-[360px] border-b border-l border-hairline px-3 py-2 text-left text-[12px] font-semibold text-neutral-500"
                      >
                        Script {i + 1}
                      </th>
                    ))}
                    {editable && (
                      <th className="min-w-[240px] border-b border-l border-hairline px-3 py-2 text-left text-[12px] font-semibold text-neutral-400">
                        New
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {grid.rows.map((row, ri) => {
                    const last = ri === grid.rows.length - 1;
                    const cellBorder = `border-l border-hairline align-top ${last ? "" : "border-b"}`;
                    return (
                      <tr key={row.niche ?? " none"}>
                        <td
                          className={`sticky left-0 z-10 bg-surface px-3 py-3 align-top ${last ? "" : "border-b border-hairline"}`}
                        >
                          {row.niche ? (
                            <span
                              className={`inline-block whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-medium ${colorOf(row.niche).tag}`}
                            >
                              {nicheLabel(row.niche, nicheEmojis)}
                            </span>
                          ) : (
                            <span className="text-[11px] text-neutral-400">No niche</span>
                          )}
                        </td>
                        {Array.from({ length: grid.columns }, (_, i) => (
                          <td key={i} className={cellBorder}>
                            {row.scripts[i] && (
                              <DocCell
                                r={row.scripts[i]}
                                index={i}
                                selected={selectedIds.has(row.scripts[i].id)}
                                onToggleSelect={onToggleSelect}
                              />
                            )}
                          </td>
                        ))}
                        {editable && (
                          <td className={cellBorder}>
                            <ComposerCell niche={row.niche} appId={currentAppId} />
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {editable && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                const v = String(new FormData(e.currentTarget).get("niche") ?? "").trim();
                if (v) setExtraNiches((prev) => (prev.includes(v) ? prev : [...prev, v]));
              }}
              className="mt-2 flex max-w-sm items-center gap-2"
            >
              <NicheCombobox options={knownNiches} placeholder="Add a niche row…" />
              <button
                type="submit"
                className="shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-500 ring-1 ring-inset ring-hairline transition hover:bg-neutral-500/[0.04] hover:text-neutral-900"
              >
                Add row
              </button>
            </form>
          )}
        </section>
      ))}
    </div>
  );
}
