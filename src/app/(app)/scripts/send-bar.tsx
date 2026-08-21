"use client";

import { useState, useTransition } from "react";
import { CreatorPicker } from "./creator-picker";
import { sendScripts, sendScriptsTest, type SendReport } from "./send-actions";

/** One roster creator the bar can target. Creators without a linked Discord
 *  channel stay visible but un-pickable, so "why isn't X listed" never
 *  needs investigating — the answer is on screen. */
export type SendTarget = {
  creatorId: string;
  handle: string;
  niche: string | null;
  hasChannel: boolean;
};

/**
 * The sender: appears once scripts are selected, floats over the bottom of
 * the page. Pick creators one by one or toggle a whole niche; Send posts the
 * batch to each creator's channel and reports per-creator results inline.
 */
export function SendBar({
  scriptIds,
  targets,
  onClear,
}: {
  scriptIds: string[];
  targets: SendTarget[];
  onClear: () => void;
}) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<SendReport | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleCreator = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  // A niche chip selects its sendable creators; clicking again clears them.
  const toggleNiche = (members: SendTarget[]) =>
    setPicked((prev) => {
      const sendable = members.filter((m) => m.hasChannel).map((m) => m.creatorId);
      const allIn = sendable.length > 0 && sendable.every((id) => prev.has(id));
      const next = new Set(prev);
      for (const id of sendable) (allIn ? next.delete(id) : next.add(id));
      return next;
    });

  const send = () =>
    startTransition(async () => {
      setReport(await sendScripts({ scriptIds, creatorIds: [...picked] }));
    });

  // Same message, private #script-send-test channel, zero DB writes — for
  // checking the batch before it reaches any creator. Needs no recipients.
  const sendTest = () =>
    startTransition(async () => {
      setReport(await sendScriptsTest(scriptIds));
    });

  return (
    // pointer-events-none: the fixed wrapper spans the viewport for centering
    // only — clicks in the empty margins must reach the table behind it.
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 px-4">
      <div className="pointer-events-auto mx-auto max-w-3xl rounded-2xl bg-surface p-4 shadow-raised ring-1 ring-hairline">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-neutral-900">
            Send {scriptIds.length} script{scriptIds.length === 1 ? "" : "s"}
            <span className="ml-2 font-normal text-neutral-400">
              to {picked.size} creator{picked.size === 1 ? "" : "s"}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClear}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-400 transition hover:text-neutral-900"
            >
              Clear
            </button>
            <button
              type="button"
              disabled={pending}
              onClick={sendTest}
              title="Posts the exact message to the private #script-send-test channel. Nothing is tracked."
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-neutral-700 ring-1 ring-inset ring-hairline transition hover:bg-neutral-500/[0.06] hover:text-neutral-900 disabled:text-neutral-300"
            >
              🧪 Test send
            </button>
            <button
              type="button"
              disabled={pending || picked.size === 0}
              onClick={send}
              className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-ambient transition hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400"
            >
              {pending ? "Sending…" : "Send to Discord"}
            </button>
          </div>
        </div>

        <div className="mt-3">
          <CreatorPicker
            targets={targets}
            picked={picked}
            onToggleCreator={toggleCreator}
            onToggleNiche={toggleNiche}
          />
        </div>

        {report && (
          <div className="mt-3 space-y-1 border-t border-hairline pt-2.5 text-[12px]">
            {report.error && <p className="text-danger">{report.error}</p>}
            {report.results.map((r) => (
              <p key={r.creatorId} className={r.ok ? "text-neutral-600" : "text-danger"}>
                {r.ok ? "✓" : "✗"} @{r.handle}
                {r.ok
                  ? ` — sent ${r.sent}${r.alreadySent ? `, ${r.alreadySent} already sent earlier` : ""}`
                  : ` — ${r.error}`}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
