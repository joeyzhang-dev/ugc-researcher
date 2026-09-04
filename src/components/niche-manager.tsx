import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import {
  Badge, agButton, agButtonQuiet, agInput, agRow, agTable, agTableWrap, agTd, agTh,
} from "@/components/glass";
import {
  createNiche, previewNicheChannelRenames, renameNicheChannels, setNicheActive, updateNiche,
} from "@/app/(app)/settings/niche-actions";
import type { LiveEmojiBase } from "@/lib/niche-channel-rename";
import type { Niche } from "@/lib/niches";

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
    <div className="space-y-6">
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

      <div className={agTableWrap}>
        <table className={agTable}>
          <thead>
            <tr>
              <th className={agTh}>Emoji</th>
              <th className={agTh}>Niche</th>
              <th className={agTh}>Discord role id</th>
              <th className={agTh}>Channels</th>
              <th className={agTh} />
            </tr>
          </thead>
          <tbody>
            {niches.map((n) => (
              <tr key={n.id} className={agRow}>
                <td className={agTd} colSpan={4}>
                  <form action={updateNiche} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="originalName" value={n.name} />
                    <input
                      name="emoji"
                      defaultValue={n.emoji ?? ""}
                      className={`${agInput} w-16 text-center`}
                      aria-label={`Emoji for ${n.name}`}
                    />
                    <input
                      name="name"
                      defaultValue={n.name}
                      required
                      className={`${agInput} w-60`}
                      aria-label={`Name for ${n.name}`}
                    />
                    <input
                      name="discordRoleId"
                      defaultValue={n.discordRoleId ?? ""}
                      placeholder="role id (optional)"
                      className={`${agInput} w-44 font-mono text-[11.5px]`}
                      aria-label={`Discord role for ${n.name}`}
                    />
                    <span className="text-[11.5px] text-[var(--ag-ink-4)]">
                      {channelCounts.get(n.name) ?? 0} channels
                    </span>
                    {!n.isActive && <Badge status="Archived" />}
                    <SubmitButton className={agButtonQuiet}>Save</SubmitButton>
                  </form>
                </td>
                <td className={agTd}>
                  <form action={setNicheActive}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="active" value={n.isActive ? "false" : "true"} />
                    <SubmitButton className={agButtonQuiet}>{n.isActive ? "Archive" : "Restore"}</SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <form action={createNiche} className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--ag-hairline)] pt-4">
          <input name="emoji" placeholder="🌱" className={`${agInput} w-16 text-center`} aria-label="New niche emoji" />
          <input name="name" required placeholder="New niche name" className={`${agInput} w-60`} aria-label="New niche name" />
          <input
            name="discordRoleId"
            placeholder="role id (optional)"
            className={`${agInput} w-44 font-mono text-[11.5px]`}
            aria-label="New niche Discord role id"
          />
          <SubmitButton className={agButton}>Add niche</SubmitButton>
        </form>

        <p className="mt-3 text-[11.5px] text-[var(--ag-ink-4)]">
          Archiving keeps a niche classifying its existing channels — it only leaves
          /onboard&rsquo;s picker. The workers pick up a change within a minute; no restart.
        </p>
      </div>

      <div className="border-t border-[var(--ag-hairline)] pt-5">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--ag-ink-3)]">Emoji on live Discord channels</h3>
        <p className="mt-1.5 text-[12px] leading-relaxed text-[var(--ag-ink-2)]">
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
          <div className={`${agTableWrap} mt-3`}>
            <table className={agTable}>
              <thead>
                <tr>
                  <th className={agTh}>Emoji</th>
                  <th className={agTh}>Claimed by</th>
                  <th className={agTh}>Channels</th>
                  <th className={agTh}>Rename to</th>
                </tr>
              </thead>
              <tbody>
                {liveBases.map((b) => (
                  <tr key={b.base} className={agRow}>
                    <td className={`${agTd} text-[17px]`}>{b.display}</td>
                    <td className={agTd}>
                      {b.niche ?? <Badge status="No niche claims this" tone="warn" />}
                    </td>
                    <td className={agTd}>
                      <span className="text-[11.5px] text-[var(--ag-ink-3)]">
                        {b.channels.length}
                        {b.channels.length > 0 && (
                          <span className="ml-1.5 text-[var(--ag-ink-4)]">
                            e.g. {b.channels.slice(0, 3).join(", ")}
                            {b.channels.length > 3 ? "…" : ""}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={agTd}>
                      <form action={previewNicheChannelRenames} className="flex items-center gap-2">
                        <input type="hidden" name="fromEmoji" value={b.base} />
                        <input
                          name="toEmoji"
                          placeholder="new emoji"
                          required
                          className={`${agInput} w-16 text-center`}
                          aria-label={`Rename channels on ${b.display} to a new emoji`}
                        />
                        <SubmitButton pendingLabel="Loading…" className={agButtonQuiet}>Preview rename</SubmitButton>
                      </form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
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
