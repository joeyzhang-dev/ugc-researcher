import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import {
  Badge, agButton, agButtonQuiet, agInput, agTh,
} from "@/components/glass";
import {
  createNiche, previewNicheChannelRenames, renameNicheChannels, setNicheActive, updateNiche,
} from "@/app/(app)/settings/niche-actions";
import type { LiveEmojiBase } from "@/lib/niche-channel-rename";
import type { Niche } from "@/lib/niches";

/** One template for the header, every row and the add form — three places that
 *  must agree, so they read from one constant rather than three copies. */
const NICHE_COLS =
  "grid grid-cols-[48px_minmax(160px,1fr)_150px_72px_auto_auto] items-center gap-x-2";

/** Same discipline for the live-Discord table below it. */
const LIVE_COLS =
  "grid grid-cols-[40px_minmax(120px,0.9fr)_44px_minmax(140px,1.4fr)_auto] items-center gap-x-2";

export interface RenamePreview {
  fromEmoji: string;
  toEmoji: string;
  steps: { channelId: string; from: string; to: string }[];
}

export function NicheManager({
  niches,
  channelCounts,
  liveBases,
  discordReachable,
  preview,
}: {
  niches: (Niche & { id: string })[];
  /** Tracked channels per niche NAME, from research_discord_channels. */
  channelCounts: Map<string, number>;
  /** Emoji actually prefixing live Discord channels right now, each with the
   *  niche that claims it — or null. Derived from Discord, never from the
   *  niche rows: an edited emoji strands its old channels, and a control
   *  keyed on the niche's stored emoji disappears at exactly that moment. */
  liveBases: LiveEmojiBase[];
  discordReachable: boolean;
  /** A rename waiting to be confirmed, shaped by ?renameFrom/?renameTo. */
  preview: RenamePreview | null;
}) {
  const stranded = liveBases.filter((b) => b.niche === null);

  return (
    <div className="space-y-4">
      {stranded.length > 0 && (
        <div className="rounded-[14px] bg-[rgba(224,135,0,0.09)] px-4 py-3 text-[13px] text-[#a86200]">
          <p className="font-medium">
            {stranded.reduce((n, b) => n + b.channels.length, 0)} live channels carry an emoji no
            niche claims.
          </p>
          <p className="mt-1.5 text-[12px] leading-relaxed text-[#a86200]/85">
            Those channels no longer classify: <code className="font-mono">track_bases()</code>{" "}
            does not map the emoji, so <code className="font-mono">discover</code> silently skips
            them and new ones on it are never picked up. Either give a niche that emoji above, or
            rename the channels below.
          </p>
        </div>
      )}

      {/* A grid, not a <table>: each row is its own <form>, and a <form> cannot
          wrap a <tr>. The old markup worked around that with a colSpan={4} cell
          holding a flex form, which meant the fields never lined up with the
          headers above them. `display: contents` on the form drops it out of
          the box tree so its inputs become grid items directly — real column
          alignment, one line per niche, and the form still posts normally.
          Hidden inputs are display:none, so they never take a cell. */}
      <div className="overflow-x-auto">
        <div className="min-w-[780px]">
          <div className={`${NICHE_COLS} px-2 pb-1.5`}>
            <span className={agTh}>Emoji</span>
            <span className={agTh}>Niche</span>
            <span className={agTh}>Discord role</span>
            <span className={`${agTh} text-right`}>Channels</span>
            <span className={agTh} />
            <span className={agTh} />
          </div>

          {niches.map((n) => (
            <div
              key={n.id}
              className={`ag-lattice-cell ${NICHE_COLS} items-center rounded-[10px] border-t border-[var(--ag-hairline)] px-2 py-1.5 ${
                n.isActive ? "" : "opacity-55"
              }`}
            >
              <form action={updateNiche} className="contents">
                <input type="hidden" name="id" value={n.id} />
                <input type="hidden" name="originalName" value={n.name} />
                <input
                  name="emoji"
                  defaultValue={n.emoji ?? ""}
                  className={`${agInput} w-full text-center text-[15px]`}
                  aria-label={`Emoji for ${n.name}`}
                />
                <input
                  name="name"
                  defaultValue={n.name}
                  required
                  className={`${agInput} w-full`}
                  aria-label={`Name for ${n.name}`}
                />
                <input
                  name="discordRoleId"
                  defaultValue={n.discordRoleId ?? ""}
                  placeholder="—"
                  className={`${agInput} w-full font-mono text-[11px]`}
                  aria-label={`Discord role for ${n.name}`}
                />
                <span className="pr-1 text-right text-[12px] tabular-nums text-[var(--ag-ink-3)]">
                  {channelCounts.get(n.name) ?? 0}
                </span>
                <SubmitButton className={agButtonQuiet}>Save</SubmitButton>
              </form>
              <form action={setNicheActive}>
                <input type="hidden" name="id" value={n.id} />
                <input type="hidden" name="active" value={n.isActive ? "false" : "true"} />
                <SubmitButton className={agButtonQuiet}>
                  {n.isActive ? "Archive" : "Restore"}
                </SubmitButton>
              </form>
            </div>
          ))}

          {/* Same grid, so the new-niche fields sit under the columns they fill. */}
          <form
            action={createNiche}
            className={`${NICHE_COLS} mt-2 items-center border-t border-[var(--ag-hairline)] px-2 pt-3`}
          >
            <input
              name="emoji"
              placeholder="🌱"
              className={`${agInput} w-full text-center text-[15px]`}
              aria-label="New niche emoji"
            />
            <input
              name="name"
              required
              placeholder="New niche"
              className={`${agInput} w-full`}
              aria-label="New niche name"
            />
            <input
              name="discordRoleId"
              placeholder="role id"
              className={`${agInput} w-full font-mono text-[11px]`}
              aria-label="New niche Discord role id"
            />
            <span />
            <SubmitButton className={agButton}>Add</SubmitButton>
            <span />
          </form>
        </div>
      </div>

      <p className="text-[11.5px] leading-relaxed text-[var(--ag-ink-4)]">
        Archiving keeps a niche classifying its existing channels — it only leaves
        /onboard&rsquo;s picker. The workers pick up a change within a minute; no restart.
      </p>

      <div className="border-t border-[var(--ag-hairline)] pt-4">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ag-ink-3)]">Emoji on live Discord channels</h3>
        <p className="mt-1 max-w-[85ch] text-[12px] leading-relaxed text-[var(--ag-ink-3)]">
          Read from Discord, not from the table above, so an emoji nothing claims still shows up.
          Changing a niche&rsquo;s emoji never renames anything — the channels stay where they are
          until a rename is previewed and confirmed here.
        </p>

        {preview ? (
          <RenameConfirm preview={preview} />
        ) : !discordReachable ? (
          <p className="mt-3 text-[11.5px] text-[var(--ag-ink-4)]">
            Discord is not reachable from here (no bot token, no guild id, or the API call failed),
            so live channel names and renames are unavailable.
          </p>
        ) : liveBases.length === 0 ? (
          <p className="mt-3 text-[11.5px] text-[var(--ag-ink-4)]">No live channel carries an emoji prefix.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <div className="min-w-[720px]">
              <div className={`${LIVE_COLS} px-2 pb-1.5`}>
                <span className={agTh}>Emoji</span>
                <span className={agTh}>Claimed by</span>
                <span className={`${agTh} text-right`}>Ch.</span>
                <span className={agTh}>Example channels</span>
                <span className={agTh}>Rename to</span>
              </div>
              {liveBases.map((b) => (
                <div
                  key={b.base}
                  className={`ag-lattice-cell ${LIVE_COLS} items-center rounded-[10px] border-t border-[var(--ag-hairline)] px-2 py-1.5`}
                >
                  <span className="text-[16px] leading-none">{b.display}</span>
                  <span className="min-w-0 truncate text-[12.5px] text-[var(--ag-ink-2)]">
                    {b.niche ?? <Badge status="unclaimed" tone="warn" />}
                  </span>
                  <span className="pr-1 text-right text-[12px] tabular-nums text-[var(--ag-ink-3)]">
                    {b.channels.length}
                  </span>
                  <span className="min-w-0 truncate font-mono text-[11px] text-[var(--ag-ink-4)]">
                    {b.channels.slice(0, 3).join(", ")}
                    {b.channels.length > 3 ? "…" : ""}
                  </span>
                  <form action={previewNicheChannelRenames} className="flex items-center gap-1.5">
                    <input type="hidden" name="fromEmoji" value={b.base} />
                    <input
                      name="toEmoji"
                      placeholder="🆕"
                      required
                      className={`${agInput} w-12 text-center text-[15px]`}
                      aria-label={`Rename channels on ${b.display} to a new emoji`}
                    />
                    <SubmitButton pendingLabel="…" className={agButtonQuiet}>
                      Preview
                    </SubmitButton>
                  </form>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/** The confirm step: every old→new name, then one button. A count alone does
 *  not say WHICH creators see their channel renamed, and Discord's rate limit
 *  makes finding out afterwards expensive. */
function RenameConfirm({ preview }: { preview: RenamePreview }) {
  return (
    <div className="ag-glass-thin mt-3 rounded-[16px] p-4">
      <p className="text-[13.5px] font-semibold text-[var(--ag-ink)]">
        Rename {preview.steps.length} channel{preview.steps.length === 1 ? "" : "s"}:{" "}
        {preview.fromEmoji} → {preview.toEmoji}
      </p>
      {preview.steps.length === 0 ? (
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--ag-ink-2)]">
          Nothing to rename — no live channel starts with {preview.fromEmoji}, or the emoji did not
          change.
        </p>
      ) : (
        <ul className="mt-3 max-h-72 space-y-0.5 overflow-y-auto font-mono text-[11.5px] text-[var(--ag-ink-2)]">
          {preview.steps.map((s) => (
            <li key={s.channelId}>
              {s.from} <span className="text-[var(--ag-ink-4)]">→</span>{" "}
              <span className="text-[var(--ag-ink)]">{s.to}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-[11.5px] leading-relaxed text-[var(--ag-ink-3)]">
        Discord allows 2 updates per channel per 10 minutes, so this runs once and reports each
        failure rather than retrying.
      </p>
      <div className="mt-3 flex items-center gap-2">
        {preview.steps.length > 0 && (
          <form action={renameNicheChannels}>
            <input type="hidden" name="fromEmoji" value={preview.fromEmoji} />
            <input type="hidden" name="toEmoji" value={preview.toEmoji} />
            <SubmitButton pendingLabel="Renaming…" className={agButton}>Confirm rename in Discord</SubmitButton>
          </form>
        )}
        <Link href="/settings#niches" className={agButtonQuiet}>
          {preview.steps.length > 0 ? "Cancel" : "Back"}
        </Link>
      </div>
    </div>
  );
}
