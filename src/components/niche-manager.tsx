import { SubmitButton } from "@/components/submit-button";
import { StatusBadge, inputClass, table, tableWrap, td, th, trHover } from "@/components/ui";
import {
  createNiche, renameNicheChannels, setNicheActive, updateNiche,
} from "@/app/(app)/settings/niche-actions";
import type { Niche } from "@/lib/niches";

export function NicheManager({
  niches,
  channelCounts,
  liveEmojiCounts,
}: {
  niches: (Niche & { id: string })[];
  /** Live Discord channels currently named with each niche's emoji. */
  channelCounts: Map<string, number>;
  /** Live Discord channel names starting with each emoji base, keyed by
   *  EMOJI (not niche name — a niche's stored emoji is the lookup key, and
   *  more than one niche can share it while it is still resolving). */
  liveEmojiCounts: Map<string, number>;
}) {
  return (
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
                {n.emoji && (liveEmojiCounts.get(n.emoji) ?? 0) > 0 && (
                  <form action={renameNicheChannels} className="mt-2 flex items-center gap-2">
                    <input type="hidden" name="fromEmoji" value={n.emoji} />
                    <input
                      name="toEmoji"
                      placeholder="new emoji"
                      required
                      className={`${inputClass} w-16 text-center`}
                      aria-label={`Rename ${n.name} channels to a new emoji`}
                    />
                    <span className="text-xs text-neutral-400">
                      renames {liveEmojiCounts.get(n.emoji)} live Discord channels
                    </span>
                    <SubmitButton>Rename in Discord</SubmitButton>
                  </form>
                )}
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
  );
}
