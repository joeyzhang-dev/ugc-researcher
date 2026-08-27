"use client";

import { useMemo } from "react";
import { SEND_BLOCKER_LABEL, type SendTarget } from "@/lib/send-targets";

const CHIP =
  "rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset transition";

/**
 * The niche-grouped creator chips shared by the script send bar and the
 * announcement bar: a niche chip (with its sendable count) toggles the whole
 * group, creator chips toggle one, and anyone who cannot receive the batch
 * stays visible but un-pickable with the reason on the chip.
 *
 * Nobody reachable is ever hidden. A creator onboarded in Discord but not yet
 * linked to a handle used to be absent entirely — which is how a whole week's
 * send missed the newest people with nothing on screen to notice.
 */
export function CreatorPicker({
  targets,
  picked,
  onToggleCreator,
  onToggleNiche,
}: {
  targets: SendTarget[];
  picked: Set<string>;
  onToggleCreator: (id: string) => void;
  onToggleNiche: (members: SendTarget[]) => void;
}) {
  const byNiche = useMemo(() => {
    const groups = new Map<string, SendTarget[]>();
    for (const t of targets) {
      const key = t.niche ?? "No niche";
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(t);
    }
    return [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [targets]);

  // Onboarded but unlinked is the actionable one — it means a real person in a
  // real channel is about to be skipped, and one /link fixes it. Called out
  // under the chips so it is read before Send, not discovered after.
  const unlinked = useMemo(
    () => targets.filter((t) => t.blocker === "unlinked-channel"),
    [targets]
  );

  return (
    <div className="space-y-2">
      {byNiche.map(([niche, members]) => {
        const sendable = members.filter((m) => !m.blocker);
        const allIn = sendable.length > 0 && sendable.every((m) => picked.has(m.creatorId));
        return (
          <div key={niche} className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              disabled={sendable.length === 0}
              onClick={() => onToggleNiche(members)}
              className={`${CHIP} font-semibold ${
                allIn
                  ? "bg-neutral-900 text-white ring-white/10"
                  : "bg-neutral-500/[0.06] text-neutral-700 ring-hairline hover:bg-neutral-500/[0.12]"
              } ${sendable.length === 0 ? "cursor-default opacity-40" : ""}`}
            >
              {niche}
              <span className={`ml-1.5 tabular-nums ${allIn ? "text-white/60" : "text-neutral-400"}`}>
                {sendable.length}
              </span>
            </button>
            {members.map((t) =>
              !t.blocker ? (
                <button
                  key={t.creatorId}
                  type="button"
                  onClick={() => onToggleCreator(t.creatorId)}
                  className={`${CHIP} ${
                    picked.has(t.creatorId)
                      ? "bg-accent/[0.14] text-accent ring-accent/[0.3]"
                      : "bg-transparent text-neutral-500 ring-hairline hover:text-neutral-900"
                  }`}
                >
                  @{t.handle}
                </button>
              ) : (
                <span
                  key={t.creatorId}
                  title={SEND_BLOCKER_LABEL[t.blocker]}
                  // Dashed for "onboarded, one step from sendable"; flat grey
                  // for the chronic cases, so the fixable one stands out.
                  className={`${CHIP} cursor-default ${
                    t.blocker === "unlinked-channel"
                      ? "border border-dashed border-neutral-300 text-neutral-400 ring-transparent"
                      : "text-neutral-300 ring-hairline"
                  }`}
                >
                  {t.blocker === "unlinked-channel" ? t.handle : `@${t.handle}`}
                </span>
              )
            )}
          </div>
        );
      })}

      {unlinked.length > 0 && (
        <p className="pt-0.5 text-[11px] leading-relaxed text-neutral-400">
          {unlinked.length} newly onboarded{" "}
          {unlinked.length === 1 ? "channel is" : "channels are"} not linked to a creator yet and
          cannot be sent to: {unlinked.map((t) => t.handle).join(", ")}. Run{" "}
          <code className="rounded bg-neutral-500/[0.08] px-1 py-px">/link</code> in their channel,
          then reload.
        </p>
      )}
    </div>
  );
}
