"use client";

import { useState, useTransition } from "react";
import { CreatorPicker } from "./creator-picker";
import {
  sendScripts,
  sendScriptsTest,
  sendScriptsToChannel,
  type ChannelSendReport,
  type SendReport,
} from "./send-actions";
import type { SendTarget } from "@/lib/send-targets";
import type { FormatChannel } from "@/lib/format-channels";
import { Segmented } from "@/components/ui";

// Re-exported for the pages that already import the type from here.
export type { SendTarget };

type Mode = "channel" | "creators";

/**
 * The sender: appears once scripts are selected, floats over the bottom of
 * the page. Two ways to deliver a batch: publish once to a shared format
 * channel — the library, posted with no ping, anyone can pull from it — or
 * send to each picked creator's own channel individually. Channel is the
 * default mode: it is the new workflow, with the older per-creator path one
 * click away rather than removed.
 */
export function SendBar({
  scriptIds,
  targets,
  nicheEmojis,
  formatChannels,
  onClear,
}: {
  scriptIds: string[];
  targets: SendTarget[];
  nicheEmojis: Record<string, string>;
  formatChannels: FormatChannel[];
  onClear: () => void;
}) {
  const [mode, setMode] = useState<Mode>("channel");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<SendReport | null>(null);
  const [channelId, setChannelId] = useState<string>("");
  const [channelReport, setChannelReport] = useState<ChannelSendReport | null>(null);
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
      const sendable = members.filter((m) => !m.blocker).map((m) => m.creatorId);
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

  const publish = () =>
    startTransition(async () => {
      setChannelReport(await sendScriptsToChannel({ scriptIds, channelId }));
    });

  const pickedChannelName = formatChannels.find((c) => c.id === channelId)?.name;

  return (
    // pointer-events-none: the fixed wrapper spans the viewport for centering
    // only — clicks in the empty margins must reach the table behind it.
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 px-4">
      <div className="pointer-events-auto mx-auto max-w-3xl rounded-2xl bg-surface p-4 shadow-raised ring-1 ring-hairline">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-neutral-900">
            Send {scriptIds.length} script{scriptIds.length === 1 ? "" : "s"}
            {mode === "creators" ? (
              <span className="ml-2 font-normal text-neutral-400">
                to {picked.size} creator{picked.size === 1 ? "" : "s"}
              </span>
            ) : pickedChannelName ? (
              <span className="ml-2 font-normal text-neutral-400">to #{pickedChannelName}</span>
            ) : null}
          </p>
          <div className="flex items-center gap-2">
            <Segmented
              size="sm"
              aria-label="Send target"
              value={mode}
              items={[
                {
                  value: "channel",
                  label: "Channel",
                  onClick: () => {
                    setMode("channel");
                    // A report from the other mode (or a prior excursion back
                    // into this one) must not linger under a picker it no
                    // longer describes — most of all the unrecorded warning,
                    // which someone must act on and must not re-see stale.
                    setReport(null);
                    setChannelReport(null);
                  },
                },
                {
                  value: "creators",
                  label: "Creators",
                  onClick: () => {
                    setMode("creators");
                    setReport(null);
                    setChannelReport(null);
                  },
                },
              ]}
            />
            <button
              type="button"
              onClick={onClear}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-400 transition hover:text-neutral-900"
            >
              Clear
            </button>
            {mode === "creators" && (
              <button
                type="button"
                disabled={pending}
                onClick={sendTest}
                title="Posts the exact message to the private #script-send-test channel. Nothing is tracked."
                className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-neutral-700 ring-1 ring-inset ring-hairline transition hover:bg-neutral-500/[0.06] hover:text-neutral-900 disabled:text-neutral-300"
              >
                🧪 Test send
              </button>
            )}
            {mode === "creators" ? (
              <button
                type="button"
                disabled={pending || picked.size === 0}
                onClick={send}
                className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-ambient transition hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400"
              >
                {pending ? "Sending…" : "Send to Discord"}
              </button>
            ) : (
              <button
                type="button"
                disabled={pending || !channelId}
                onClick={publish}
                className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-ambient transition hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400"
              >
                {pending ? "Publishing…" : "Publish"}
              </button>
            )}
          </div>
        </div>

        <div className="mt-3">
          {mode === "creators" ? (
            <CreatorPicker
              targets={targets}
              picked={picked}
              nicheEmojis={nicheEmojis}
              onToggleCreator={toggleCreator}
              onToggleNiche={toggleNiche}
            />
          ) : (
            <select
              aria-label="Format channel"
              value={channelId}
              onChange={(e) => {
                setChannelId(e.target.value);
                // Reselecting mid-picker means the prior Publish result no
                // longer describes the channel now showing in the control.
                setChannelReport(null);
              }}
              className="w-full rounded-lg bg-surface px-3 py-2 text-[13px] text-neutral-900 shadow-[inset_0_1px_2px_rgb(9_9_11/0.04)] ring-1 ring-hairline transition focus:outline-none focus:ring-2 focus:ring-inset focus:ring-accent/45"
            >
              <option value="" disabled>
                {formatChannels.length === 0 ? "No format channels found" : "Pick a channel…"}
              </option>
              {formatChannels.map((c) => (
                <option key={c.id} value={c.id}>
                  #{c.name}
                </option>
              ))}
            </select>
          )}
        </div>

        {mode === "creators" && report && (
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

        {mode === "channel" &&
          channelReport &&
          (() => {
            const r = channelReport;
            // On an error path posted + alreadyPosted can fall short of the
            // batch size — the gap is scripts nothing was attempted on, and
            // rendering only posted/alreadyPosted would leave the operator to
            // infer that gap rather than see it.
            const attempted = r.posted + r.alreadyPosted;
            const notAttempted = scriptIds.length - attempted;
            return (
              <div className="mt-3 space-y-1 border-t border-hairline pt-2.5 text-[12px]">
                {r.error && <p className="text-danger">{r.error}</p>}
                {(attempted > 0 || !r.error) && (
                  <p className={r.error ? "text-danger" : "text-neutral-600"}>
                    Posted {r.posted} to #{r.channel}
                    {r.alreadyPosted > 0 ? `, ${r.alreadyPosted} already there` : ""}
                  </p>
                )}
                {notAttempted > 0 && (
                  <p className="text-danger">
                    {notAttempted} of {scriptIds.length} script{scriptIds.length === 1 ? "" : "s"} not
                    attempted.
                  </p>
                )}
                {r.unrecorded.length > 0 && (
                  <p className="text-danger">
                    {r.unrecorded.length} card{r.unrecorded.length === 1 ? "" : "s"} posted live to
                    Discord with no database row to match — the dedupe can&apos;t see{" "}
                    {r.unrecorded.length === 1 ? "it" : "them"}, so re-running this batch WOULD post a
                    duplicate. Reconcile by hand before retrying.
                  </p>
                )}
              </div>
            );
          })()}
      </div>
    </div>
  );
}
