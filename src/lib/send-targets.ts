/* Who this week's batch can actually be sent to.
 *
 * The send bar used to build its list purely from `research_creators`, which
 * quietly dropped anyone who wasn't a row yet. That is exactly what a freshly
 * onboarded creator is: their Discord channel is created days before they have
 * an Instagram handle to link (see the onboarding order), so they existed only
 * as a tracked channel — absent from the picker, with nothing on screen saying
 * a name was missing. A whole week's scripts went out without them.
 *
 * So the rule here is the one the picker already applied to creators without a
 * channel, extended to every reason a name can be unsendable: a target is
 * never omitted, it is listed with the reason it cannot be picked. "Why isn't X
 * in this send" is answerable by looking, and the answer is the fix.
 */
import { creatorNameFromChannel } from "@/lib/discord-channels";

/** Why a target is listed but cannot receive the batch. */
export type SendBlocker = "no-channel" | "unlinked-channel" | "outside-workspace";

export interface SendTarget {
  /** A creator id, or `channel:<snowflake>` for a channel with no creator yet. */
  creatorId: string;
  handle: string;
  niche: string | null;
  /** null means sendable; otherwise the reason it is not. */
  blocker: SendBlocker | null;
}

/** Marks a target that is a bare channel, so no send path mistakes it for a
 *  creator id and tries to write an assignment against it. */
export const CHANNEL_TARGET_PREFIX = "channel:";

export const SEND_BLOCKER_LABEL: Record<SendBlocker, string> = {
  "no-channel": "No linked Discord channel — link it on the Discord page",
  "unlinked-channel":
    "Onboarded in Discord, not linked to a creator yet — run /link in their channel, then send",
  "outside-workspace": "Not on this workspace's roster — add them on Our creators",
};

export interface SendTargetInput {
  /** Current workspace, or null for All apps. */
  appId: string | null;
  /** Roster creators (kind = 'roster'). */
  creators: { id: string; handle: string }[];
  memberships: { app_id: string; research_creator_id: string; niche: string | null }[];
  /** EVERY tracked channel — linked and unlinked. The unlinked ones are the point. */
  channels: {
    channel_id: string;
    channel_name: string;
    research_creator_id: string | null;
    niche: string | null;
  }[];
}

export function buildSendTargets({
  appId,
  creators,
  memberships,
  channels,
}: SendTargetInput): SendTarget[] {
  const channelByCreator = new Map(
    channels.filter((c) => c.research_creator_id).map((c) => [c.research_creator_id!, c])
  );
  const targets: SendTarget[] = [];

  for (const creator of creators) {
    const channel = channelByCreator.get(creator.id);
    const inWorkspace =
      !appId || memberships.some((m) => m.app_id === appId && m.research_creator_id === creator.id);
    // Outside the workspace AND unreachable — no channel to send to and no
    // roster claim on them. This is the only case worth omitting entirely.
    if (!inWorkspace && !channel) continue;

    targets.push({
      creatorId: creator.id,
      handle: creator.handle,
      // Workspace niche wins, then any niche they hold, then the channel's —
      // a creator whose membership predates niches still lands in a group.
      niche:
        memberships.find(
          (m) => m.research_creator_id === creator.id && m.niche && (!appId || m.app_id === appId)
        )?.niche ??
        memberships.find((m) => m.research_creator_id === creator.id && m.niche)?.niche ??
        channel?.niche ??
        null,
      blocker: !channel ? "no-channel" : !inWorkspace ? "outside-workspace" : null,
    });
  }

  // Onboarded in Discord, no creator row yet. The track emoji is what puts a
  // niche on a channel, so a niche is precisely what separates a creator
  // channel from a coach or dormant one — those carry none and stay out.
  for (const channel of channels) {
    if (channel.research_creator_id || !channel.niche) continue;
    targets.push({
      creatorId: `${CHANNEL_TARGET_PREFIX}${channel.channel_id}`,
      handle: creatorNameFromChannel(channel.channel_name),
      niche: channel.niche,
      blocker: "unlinked-channel",
    });
  }

  return targets.sort((a, b) => a.handle.localeCompare(b.handle));
}

/** Guard for the send paths: a `channel:` target can never carry an assignment. */
export const isChannelTarget = (id: string) => id.startsWith(CHANNEL_TARGET_PREFIX);
