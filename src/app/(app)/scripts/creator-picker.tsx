"use client";

import { useMemo } from "react";
import type { SendTarget } from "./send-bar";

const CHIP =
  "rounded-full px-2.5 py-1 text-[12px] font-medium ring-1 ring-inset transition";

/**
 * The niche-grouped creator chips shared by the script send bar and the
 * announcement bar: a niche chip (with its sendable count) toggles the whole
 * group, creator chips toggle one, creators without a linked channel stay
 * visible but un-pickable.
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

  return (
    <div className="space-y-2">
      {byNiche.map(([niche, members]) => {
        const sendable = members.filter((m) => m.hasChannel);
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
              t.hasChannel ? (
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
                  title="No linked Discord channel — link it on the Discord page"
                  className={`${CHIP} cursor-default text-neutral-300 ring-hairline`}
                >
                  @{t.handle}
                </span>
              )
            )}
          </div>
        );
      })}
    </div>
  );
}
