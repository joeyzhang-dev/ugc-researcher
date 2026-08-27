"use client";

import { useState, useTransition } from "react";
import { sendAnnouncement, sendAnnouncementTest } from "./announce-actions";
import { CreatorPicker } from "./creator-picker";
import type { SendReport } from "./send-actions";
import type { SendTarget } from "./send-bar";

/**
 * The announcer: same floating panel + creator picker as the script send bar,
 * but carries a free-text message that lands in each picked creator's channel
 * with the creator tagged. Nothing is recorded in the database.
 */
export function AnnounceBar({
  targets,
  onClose,
}: {
  targets: SendTarget[];
  onClose: () => void;
}) {
  const [message, setMessage] = useState("");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [report, setReport] = useState<SendReport | null>(null);
  const [pending, startTransition] = useTransition();

  const toggleCreator = (id: string) =>
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
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
      setReport(await sendAnnouncement({ message, creatorIds: [...picked] }));
    });
  const sendTest = () =>
    startTransition(async () => {
      setReport(await sendAnnouncementTest(message));
    });

  return (
    // pointer-events split: the fixed wrapper is for centering only.
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-40 px-4">
      <div className="pointer-events-auto mx-auto max-w-3xl rounded-2xl bg-surface p-4 shadow-raised ring-1 ring-hairline">
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-neutral-900">
            📣 Announcement
            <span className="ml-2 font-normal text-neutral-400">
              to {picked.size} creator{picked.size === 1 ? "" : "s"}
            </span>
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-medium text-neutral-400 transition hover:text-neutral-900"
            >
              Close
            </button>
            <button
              type="button"
              disabled={pending || !message.trim()}
              onClick={sendTest}
              title="Posts the announcement to the private #script-send-test channel."
              className="rounded-lg px-3 py-1.5 text-[13px] font-medium text-neutral-700 ring-1 ring-inset ring-hairline transition hover:bg-neutral-500/[0.06] hover:text-neutral-900 disabled:text-neutral-300"
            >
              🧪 Test
            </button>
            <button
              type="button"
              disabled={pending || picked.size === 0 || !message.trim()}
              onClick={send}
              className="rounded-lg bg-neutral-900 px-3.5 py-1.5 text-[13px] font-semibold text-white shadow-ambient transition hover:bg-neutral-700 disabled:bg-neutral-200 disabled:text-neutral-400"
            >
              {pending ? "Sending…" : "Send announcement"}
            </button>
          </div>
        </div>

        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={3}
          maxLength={1800}
          autoFocus
          placeholder="What should the creators know? Lands in each picked channel with the creator tagged."
          className="mt-3 w-full resize-y rounded-lg bg-surface-sunken px-3 py-2 text-[13px] leading-relaxed text-neutral-900 outline-none ring-1 ring-inset ring-hairline placeholder:text-neutral-400 focus:ring-2 focus:ring-accent/45"
        />

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
                {r.ok ? " — announced" : ` — ${r.error}`}
              </p>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
