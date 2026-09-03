import Link from "next/link";
import { SubmitButton } from "@/components/submit-button";
import {
  StatusBadge, inputClass, secondaryButtonClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
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
        <div className="rounded-xl bg-amber-500/[0.08] px-3.5 py-2.5 text-sm text-amber-800 ring-1 ring-inset ring-amber-500/[0.22]">
          <p className="font-medium">
            {stranded.reduce((n, b) => n + b.channels.length, 0)} live channels carry an emoji no
            niche claims.
          </p>
          <p className="mt-1 text-[13px] text-amber-800/80">
            Those channels no longer classify: <code className="font-mono">track_bases()</code>{" "}
            does not map the emoji, so <code className="font-mono">discover</code> silently skips
            them and new ones on it are never picked up. Either give a niche that emoji above, or
            rename the channels below.
          </p>
        </div>
      )}

      <div className={tableWrap}>
        <table className={table}>
          <thead>
            <tr>
              <th className={th}>Emoji</th>
              <th className={th}>Niche</th>
              <th className={th}>Discord role id</th>
              <th className={th}>Channels</th>
              <th className={th} />
            </tr>
          </thead>
          <tbody>
            {niches.map((n) => (
              <tr key={n.id} className={trHover}>
                <td className={td} colSpan={4}>
                  <form action={updateNiche} className="flex flex-wrap items-center gap-2">
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="originalName" value={n.name} />
                    <input
                      name="emoji"
                      defaultValue={n.emoji ?? ""}
                      className={`${inputClass} w-16 text-center`}
                      aria-label={`Emoji for ${n.name}`}
                    />
                    <input
                      name="name"
                      defaultValue={n.name}
                      required
                      className={`${inputClass} w-64`}
                      aria-label={`Name for ${n.name}`}
                    />
                    <input
                      name="discordRoleId"
                      defaultValue={n.discordRoleId ?? ""}
                      placeholder="role id (optional)"
                      className={`${inputClass} w-48 font-mono text-xs`}
                      aria-label={`Discord role for ${n.name}`}
                    />
                    <span className="text-xs text-neutral-400">
                      {channelCounts.get(n.name) ?? 0} channels
                    </span>
                    {!n.isActive && <StatusBadge status="Archived" />}
                    <SubmitButton>Save</SubmitButton>
                  </form>
                </td>
                <td className={td}>
                  <form action={setNicheActive}>
                    <input type="hidden" name="id" value={n.id} />
                    <input type="hidden" name="active" value={n.isActive ? "false" : "true"} />
                    <SubmitButton>{n.isActive ? "Archive" : "Restore"}</SubmitButton>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <form action={createNiche} className="mt-4 flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          <input name="emoji" placeholder="🌱" className={`${inputClass} w-16 text-center`} aria-label="New niche emoji" />
          <input name="name" required placeholder="New niche name" className={`${inputClass} w-64`} aria-label="New niche name" />
          <input
            name="discordRoleId"
            placeholder="role id (optional)"
            className={`${inputClass} w-48 font-mono text-xs`}
            aria-label="New niche Discord role id"
          />
          <SubmitButton>Add niche</SubmitButton>
        </form>

        <p className="mt-3 text-xs text-neutral-400">
          Archiving keeps a niche classifying its existing channels — it only leaves
          /onboard&rsquo;s picker. The workers pick up a change within a minute; no restart.
        </p>
      </div>

      <div className="border-t border-hairline pt-5">
        <h3 className="text-sm font-semibold text-neutral-900">Emoji on live Discord channels</h3>
        <p className="mt-1 text-xs text-neutral-500">
          Read from Discord, not from the table above, so an emoji nothing claims still shows up.
          Changing a niche&rsquo;s emoji never renames anything — the channels stay where they are
          until a rename is previewed and confirmed here.
        </p>

        {preview ? (
          <RenameConfirm preview={preview} />
        ) : !discordReachable ? (
          <p className="mt-3 text-xs text-neutral-400">
            Discord is not reachable from here (no bot token, no guild id, or the API call failed),
            so live channel names and renames are unavailable.
          </p>
        ) : liveBases.length === 0 ? (
          <p className="mt-3 text-xs text-neutral-400">No live channel carries an emoji prefix.</p>
        ) : (
          <div className={`${tableWrap} mt-3`}>
            <table className={table}>
              <thead>
                <tr>
                  <th className={th}>Emoji</th>
                  <th className={th}>Claimed by</th>
                  <th className={th}>Channels</th>
                  <th className={th}>Rename to</th>
                </tr>
              </thead>
              <tbody>
                {liveBases.map((b) => (
                  <tr key={b.base} className={trHover}>
                    <td className={`${td} text-lg`}>{b.display}</td>
                    <td className={td}>
                      {b.niche ?? <StatusBadge status="No niche claims this" tone="warning" />}
                    </td>
                    <td className={td}>
                      <span className="text-xs text-neutral-500">
                        {b.channels.length}
                        {b.channels.length > 0 && (
                          <span className="ml-1.5 text-neutral-400">
                            e.g. {b.channels.slice(0, 3).join(", ")}
                            {b.channels.length > 3 ? "…" : ""}
                          </span>
                        )}
                      </span>
                    </td>
                    <td className={td}>
                      <form action={previewNicheChannelRenames} className="flex items-center gap-2">
                        <input type="hidden" name="fromEmoji" value={b.base} />
                        <input
                          name="toEmoji"
                          placeholder="new emoji"
                          required
                          className={`${inputClass} w-16 text-center`}
                          aria-label={`Rename channels on ${b.display} to a new emoji`}
                        />
                        <SubmitButton pendingLabel="Loading…">Preview rename</SubmitButton>
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
    <div className="mt-3 rounded-xl bg-neutral-500/[0.04] p-3.5 ring-1 ring-inset ring-hairline">
      <p className="text-sm font-medium text-neutral-900">
        Rename {preview.steps.length} channel{preview.steps.length === 1 ? "" : "s"}:{" "}
        {preview.fromEmoji} → {preview.toEmoji}
      </p>
      {preview.steps.length === 0 ? (
        <p className="mt-1 text-xs text-neutral-500">
          Nothing to rename — no live channel starts with {preview.fromEmoji}, or the emoji did not
          change.
        </p>
      ) : (
        <ul className="mt-2 max-h-72 space-y-0.5 overflow-y-auto font-mono text-xs text-neutral-600">
          {preview.steps.map((s) => (
            <li key={s.channelId}>
              {s.from} <span className="text-neutral-400">→</span>{" "}
              <span className="text-neutral-900">{s.to}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-neutral-500">
        Discord allows 2 updates per channel per 10 minutes, so this runs once and reports each
        failure rather than retrying.
      </p>
      <div className="mt-3 flex items-center gap-2">
        {preview.steps.length > 0 && (
          <form action={renameNicheChannels}>
            <input type="hidden" name="fromEmoji" value={preview.fromEmoji} />
            <input type="hidden" name="toEmoji" value={preview.toEmoji} />
            <SubmitButton pendingLabel="Renaming…">Confirm rename in Discord</SubmitButton>
          </form>
        )}
        <Link href="/settings#niches" className={secondaryButtonClass}>
          {preview.steps.length > 0 ? "Cancel" : "Back"}
        </Link>
      </div>
    </div>
  );
}
