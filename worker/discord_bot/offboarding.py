"""Pure core for the ``/offboard`` slash command.

Offboarding is intentionally a small orchestration layer around injected
Discord/CRM side effects: find the creator channel, move it to the paused
category with synced permissions, re-grant the creator their own access to it,
remove the creator role, optionally kick the member, and mark the CRM row
paused. Keeping the side effects injected makes the logic unit-testable without
importing discord.py or touching the gateway.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Optional

from discord_bot.config import PAUSED_CATEGORY_LABEL, is_paused_category
from discord_bot.onboarding import (
    OverwriteSpec,
    _bot_top_role_name,
    _bot_top_role_position,
    _find_role,
    _member_has_role,
    build_channel_name,
    can_assign_role,
    find_existing_channel,
    slugify_creator_name,
)


@dataclass(frozen=True)
class OffboardOutcome:
    """Structured result of an offboarding attempt, rendered for the operator."""

    ok: bool
    channel_id: Optional[int] = None
    channel_name: Optional[str] = None
    category_name: Optional[str] = None
    channel_moved: bool = False
    permissions_synced: bool = False
    access_retained: bool = False
    access_error: Optional[str] = None
    role_removed: bool = False
    role_already_absent: bool = False
    role_error: Optional[str] = None
    niche_roles_removed: tuple[str, ...] = field(default_factory=tuple)
    niche_roles_already_absent: bool = False
    niche_role_error: Optional[str] = None
    kicked: bool = False
    kick_error: Optional[str] = None
    crm_synced: bool = False
    coach_name: Optional[str] = None
    offboard_message: Optional[str] = None
    error: Optional[str] = None
    warnings: tuple[str, ...] = field(default_factory=tuple)


def find_member_channel(text_channels: Any, member: Any) -> list[Any]:
    """Channels where this MEMBER holds an explicit view_channel=True
    overwrite — how every onboarded creator channel grants its creator access,
    regardless of what the channel is currently named. Role overwrites are
    filtered out (roles have no ``display_name``); a denied overwrite is not
    access."""
    member_id = getattr(member, "id", None)
    matches = []
    for ch in text_channels or []:
        overwrites = getattr(ch, "overwrites", {}) or {}
        if not isinstance(overwrites, dict):
            continue
        for target, ow in overwrites.items():
            if getattr(target, "id", None) != member_id:
                continue
            if not hasattr(target, "display_name"):
                continue  # a role that happens to share the id shape
            if getattr(ow, "view_channel", None) is True:
                matches.append(ch)
                break
    return matches


def category_denies_everyone(category: Any, default_role: Any) -> bool:
    """Whether the category explicitly denies ``view_channel`` to @everyone."""
    overwrite = None
    overwrites_for = getattr(category, "overwrites_for", None)
    if callable(overwrites_for):
        overwrite = overwrites_for(default_role)

    if overwrite is None:
        overwrites = getattr(category, "overwrites", {}) or {}
        if isinstance(overwrites, dict):
            overwrite = overwrites.get(default_role)
            if overwrite is None:
                default_id = getattr(default_role, "id", None)
                default_name = getattr(default_role, "name", None)
                for target, candidate in overwrites.items():
                    if (
                        default_id is not None
                        and getattr(target, "id", None) == default_id
                    ) or (
                        default_name is not None
                        and getattr(target, "name", None) == default_name
                    ):
                        overwrite = candidate
                        break

    return getattr(overwrite, "view_channel", None) is False


def build_retained_access_spec() -> OverwriteSpec:
    """The overwrite that keeps an offboarded creator in their own channel.

    Syncing permissions to the paused category is what hides the channel from
    everyone else, but it also wipes the creator's own overwrite — so the person
    the channel is about loses the thread the moment they are offboarded. This
    puts exactly one overwrite back, for that member alone: read the history,
    see new messages, and reply. Nobody else's access changes.
    """
    return OverwriteSpec(
        "creator_member",
        view_channel=True,
        send_messages=True,
        read_message_history=True,
    )


# The two program leads named in every offboarding message. Written the way
# Discord renders a username so the operator can paste the text straight in —
# a pasted "@name" is inert text either way, so nothing is auto-pinged.
PROGRAM_LEAD_HANDLES: tuple[str, ...] = ("@_willwilson.", "@lukeugc")

# "🏀 Will's Team" -> "Will". Categories record the coach team (see the pull
# worker's NON_NICHE_CATEGORIES note), so the category the channel sat in
# BEFORE the move is the only record of who coached this creator.
_TEAM_CATEGORY = re.compile(r"\bteam\b", re.IGNORECASE)
_CATEGORY_JUNK = re.compile(r"[^\w\s&'/-]", re.UNICODE)


def coach_from_category(category_name: Optional[str]) -> Optional[str]:
    """The coach's name from their team category, or ``None`` if it isn't one.

    Only "<something> Team" categories name a coach. A generic bucket
    (``FOLK TEAM``, ``Not Creating 🚫``) names nobody, and guessing there would
    put the wrong person's name in a message about cutting someone.
    """
    if not category_name or not _TEAM_CATEGORY.search(category_name):
        return None
    name = category_name.split(":", 1)[-1]
    name = _CATEGORY_JUNK.sub("", name).strip()
    name = _TEAM_CATEGORY.sub("", name).strip()
    name = re.sub(r"[\u2019']s$", "", name).strip()
    if not name or name.upper() == "FOLK":
        return None
    return name


def build_offboard_message(*, username: Optional[str], coach_name: Optional[str]) -> str:
    """The operator's copy-paste offboarding note.

    Deliberately verbatim boilerplate: this is a message a human sends in the
    creator's channel, so the only variables are who it is addressed to and
    which coach signs it. A missing username or coach leaves a visible
    placeholder rather than a silently malformed sentence.
    """
    who = f"@{username}" if username else "@[creator]"
    leads = " and ".join(PROGRAM_LEAD_HANDLES)
    coach = coach_name or "[coach]"
    return (
        f"hey {who} , after some long thought with {leads} , we decided that we have to "
        "cut you from this program for the time being. This decision was made purely "
        "based off performance of **this** specific campaign\n"
        "\n"
        "so from today, no more new posts, but you're remaining posts will be paid out "
        "within the next ~30 days and feel free to message me in this channel if you "
        "have any issues.\n"
        "\n"
        f"{coach} and I appreciate the time that we had working with you! :heart:  Will "
        "definitely reach out in the future if something comes along either us think you "
        "will be a good fit for!"
    )


def _resolve_paused_category(guild: Any) -> Optional[Any]:
    """The category offboarded channels are moved into, found by ID.

    Matched on `category.id`, never on its name: the name was renamed under us
    on 2026-09-04 (the emoji moved from the end to the front) and every
    /offboard failed until someone noticed. `is_paused_category` falls back to
    a loose name match only for a guild whose id we do not know.
    """
    for category in getattr(guild, "categories", []) or []:
        if is_paused_category(
            getattr(category, "id", None), getattr(category, "name", None)
        ):
            return category
    return None


def _role_removal_hierarchy_error(bot_role_name: str, role_name: str) -> str:
    return (
        f"i can't remove **{role_name}** — my **{bot_role_name}** role sits below it. "
        f"fix: Server Settings → Roles → drag **{bot_role_name}** above **{role_name}**, "
        "then run this again."
    )


def _can_kick_members(me: Any) -> bool:
    return bool(getattr(getattr(me, "guild_permissions", None), "kick_members", False))


def _is_guild_owner(guild: Any, member: Any) -> bool:
    member_id = getattr(member, "id", None)
    if member_id is None:
        return False
    owner_id = getattr(guild, "owner_id", None)
    if owner_id is not None:
        return int(owner_id) == int(member_id)
    owner = getattr(guild, "owner", None)
    return getattr(owner, "id", None) == member_id


def _kick_hierarchy_error(bot_role_name: str, target_role_name: str) -> str:
    return (
        f"i can't kick this member — their **{target_role_name}** role is not below "
        f"my **{bot_role_name}** role. fix: Server Settings → Roles → drag "
        f"**{bot_role_name}** above **{target_role_name}**, then run this again."
    )


async def _remove_member_role(
    *,
    guild: Any,
    member: Any,
    role: Any,
    role_name: str,
    remove_role: Optional[Callable[..., Awaitable[None]]],
    reason: str,
) -> tuple[bool, bool, Optional[str]]:
    if not hasattr(member, "roles"):
        return False, True, None
    if not _member_has_role(member, role):
        return False, True, None

    me = getattr(guild, "me", None)
    if me is not None and not can_assign_role(
        _bot_top_role_position(me), getattr(role, "position", 0)
    ):
        return False, False, _role_removal_hierarchy_error(
            _bot_top_role_name(me), getattr(role, "name", role_name)
        )
    if remove_role is None:
        return False, False, f"couldn't remove **{role_name}**: no role removal callback configured"

    try:
        await remove_role(member=member, role=role, reason=reason)
        return True, False, None
    except Exception as exc:  # noqa: BLE001 - surfaced to the operator
        return False, False, f"couldn't remove **{role_name}**: {exc}"


async def execute_offboarding(
    *,
    guild: Any,
    member: Any,
    kick: bool,
    creator_role_name: str,
    creator_role_id: Optional[int] = None,
    niche_role_ids: Optional[Iterable[int]] = None,
    move_channel: Callable[..., Awaitable[None]],
    grant_channel_access: Optional[Callable[..., Awaitable[None]]] = None,
    remove_role: Optional[Callable[..., Awaitable[None]]] = None,
    kick_member: Optional[Callable[..., Awaitable[None]]] = None,
    sync_crm: Optional[Callable[..., bool]] = None,
    get_channel_owner: Optional[Callable[[int], Optional[int]]] = None,
    get_creator_channel_id: Optional[Callable[[int], Optional[int]]] = None,
    reason: str = "creator offboarding via /offboard",
) -> OffboardOutcome:
    """Move the channel, remove the role, optionally kick, and sync the CRM.

    Like onboarding, this deliberately degrades rather than rolling back:
    hierarchy, kick, or CRM failures are reported to the operator but do not
    undo a successfully moved channel.
    """
    warnings: list[str] = []
    member_id = int(getattr(member, "id", 0))
    display_name = getattr(member, "display_name", None) or getattr(member, "name", "")
    text_channels = getattr(guild, "text_channels", []) or []
    channel = None
    channel_name = None

    linked_channel_id = get_creator_channel_id(member_id) if get_creator_channel_id is not None else None
    if linked_channel_id is not None:
        for candidate in text_channels:
            if int(getattr(candidate, "id", 0)) == int(linked_channel_id):
                channel = candidate
                channel_name = getattr(candidate, "name", None)
                break
        if channel is None:
            return OffboardOutcome(
                ok=False,
                channel_id=int(linked_channel_id),
                error=f"couldn't find the CRM-linked creator channel <#{int(linked_channel_id)}>",
            )
    else:
        # Channel names have changed conventions twice, so a reconstructed
        # legacy name is only the FIRST guess. The reliable signal is the
        # member's own permission overwrite — every onboarded channel grants
        # its creator explicit access, whatever it is currently called.
        try:
            channel_name = build_channel_name(display_name, fallback=str(member_id))
        except ValueError as exc:
            return OffboardOutcome(ok=False, error=str(exc))

        channel = find_existing_channel(text_channels, channel_name)
        if channel is None:
            by_access = find_member_channel(text_channels, member)
            if len(by_access) == 1:
                channel = by_access[0]
                channel_name = getattr(channel, "name", channel_name)
            elif len(by_access) > 1:
                shown = ", ".join(f"<#{getattr(c, 'id', '?')}>" for c in by_access[:5])
                return OffboardOutcome(
                    ok=False,
                    error=(
                        f"<@{member_id}> has access to several channels ({shown}) and none is "
                        "CRM-linked — link the right one in the app, then run this again."
                    ),
                )
            else:
                return OffboardOutcome(
                    ok=False,
                    error=(
                        f"couldn't find a creator channel for <@{member_id}> — no CRM link, "
                        f"no `#{channel_name}` legacy match, and no channel grants them access."
                    ),
                )

        if get_channel_owner is not None:
            owner_id = get_channel_owner(int(getattr(channel, "id", 0)))
            if owner_id is not None and int(owner_id) != member_id:
                return OffboardOutcome(
                    ok=False,
                    channel_id=int(getattr(channel, "id", 0)) or None,
                    channel_name=channel_name,
                    error=(
                        f"`#{channel_name}` belongs to <@{owner_id}>, not <@{member_id}>. "
                        "refusing to offboard the wrong creator."
                    ),
                )

    if channel_name is None:
        channel_name = getattr(channel, "name", "")

    # Read the coach off the channel's CURRENT category, before the move
    # overwrites it with the paused one — afterwards there is no record of who
    # this creator was coached by.
    coach_name = coach_from_category(
        getattr(getattr(channel, "category", None), "name", None)
    )
    offboard_message = build_offboard_message(
        username=getattr(member, "name", None) or None,
        coach_name=coach_name,
    )

    category = _resolve_paused_category(guild)
    expected = PAUSED_CATEGORY_LABEL
    if category is None:
        return OffboardOutcome(
            ok=False,
            channel_id=int(getattr(channel, "id", 0)) or None,
            channel_name=channel_name,
            error=f"couldn't find the paused category: {expected}",
        )
    category_name = getattr(category, "name", expected)

    if not category_denies_everyone(category, getattr(guild, "default_role", None)):
        warnings.append(
            f"**{category_name}** does not deny @everyone view access; "
            "this channel is still publicly visible. lock down the category."
        )

    try:
        await move_channel(
            channel=channel,
            category=category,
            sync_permissions=True,
            reason=reason,
        )
    except Exception as exc:  # noqa: BLE001 - surfaced to the operator
        return OffboardOutcome(
            ok=False,
            channel_id=int(getattr(channel, "id", 0)) or None,
            channel_name=channel_name,
            category_name=category_name,
            error=f"couldn't move the channel: {exc}",
            warnings=tuple(warnings),
        )

    # The sync above dropped the creator's own overwrite along with everyone
    # else's. Put theirs back — and only theirs — so an offboarded creator can
    # still read and reply in their channel. Skipped when they are being kicked:
    # an overwrite for someone who is no longer in the guild grants nothing.
    access_retained = False
    access_error: Optional[str] = None
    if not kick and hasattr(member, "roles"):
        if grant_channel_access is None:
            access_error = "no channel-access callback configured; the creator lost access to their channel"
        else:
            try:
                await grant_channel_access(
                    channel=channel,
                    member=member,
                    permissions=build_retained_access_spec().as_permission_kwargs(),
                    reason=reason,
                )
                access_retained = True
            except Exception as exc:  # noqa: BLE001 - surfaced to the operator
                access_error = f"couldn't keep the creator in their channel: {exc}"

    creator_role = _find_role(guild, creator_role_name, creator_role_id)
    role_removed = False
    role_already_absent = False
    role_error: Optional[str] = None
    if not hasattr(member, "roles"):
        role_already_absent = True
    elif creator_role is None:
        role_already_absent = True
        warnings.append(f"role `{creator_role_name}` not found in this server")
    else:
        role_removed, role_already_absent, role_error = await _remove_member_role(
            guild=guild,
            member=member,
            role=creator_role,
            role_name=creator_role_name,
            remove_role=remove_role,
            reason=reason,
        )

    niche_roles_removed: list[str] = []
    niche_roles_already_absent = False
    niche_role_error: Optional[str] = None
    configured_niche_role_ids = {
        int(role_id) for role_id in (niche_role_ids or ()) if role_id is not None
    }
    if configured_niche_role_ids:
        if not hasattr(member, "roles"):
            niche_roles_already_absent = True
        else:
            held_niche_roles = [
                role for role in list(getattr(member, "roles", []) or [])
                if getattr(role, "id", None) is not None
                and int(getattr(role, "id")) in configured_niche_role_ids
            ]
            if not held_niche_roles:
                niche_roles_already_absent = True
            else:
                niche_errors: list[str] = []
                for held_role in held_niche_roles:
                    role_id = int(getattr(held_role, "id"))
                    role_name = getattr(held_role, "name", f"role {role_id}")
                    niche_role = _find_role(guild, role_name, role_id) or held_role
                    removed, _already_absent, error = await _remove_member_role(
                        guild=guild,
                        member=member,
                        role=niche_role,
                        role_name=role_name,
                        remove_role=remove_role,
                        reason=reason,
                    )
                    if removed:
                        niche_roles_removed.append(getattr(niche_role, "name", role_name))
                    if error:
                        niche_errors.append(error)
                if niche_errors:
                    niche_role_error = "; ".join(niche_errors)

    kicked = False
    kick_error: Optional[str] = None
    if kick:
        if not hasattr(member, "top_role"):
            warnings.append("creator is already out of the server; skipped the kick")
        elif _is_guild_owner(guild, member):
            kick_error = "i can't kick the server owner."
        elif not _can_kick_members(getattr(guild, "me", None)):
            kick_error = (
                "i can't kick members — my role is missing **Kick Members**. "
                "fix: Server Settings → Roles → enable **Kick Members** for the bot role, "
                "then run this again."
            )
        elif getattr(member.top_role, "position", 0) >= _bot_top_role_position(getattr(guild, "me", None)):
            kick_error = _kick_hierarchy_error(
                _bot_top_role_name(getattr(guild, "me", None)),
                getattr(member.top_role, "name", "top"),
            )
        elif kick_member is None:
            kick_error = "couldn't kick this member: no kick callback configured"
        else:
            try:
                await kick_member(member=member, reason=reason)
                kicked = True
            except Exception as exc:  # noqa: BLE001 - surfaced to the operator
                kick_error = f"couldn't kick this member: {exc}"

    crm_synced = False
    if sync_crm is not None:
        try:
            crm_synced = bool(sync_crm(
                int(getattr(channel, "id", 0)),
                channel_name,
                slugify_creator_name(display_name),
                category_name,
                member_id,
            ))
            if not crm_synced:
                warnings.append("couldn't find this creator in the CRM; nothing was marked paused")
        except Exception as exc:  # noqa: BLE001 - CRM sync must not fail offboarding
            warnings.append(f"couldn't mark the creator paused in the CRM: {exc}")

    return OffboardOutcome(
        ok=True,
        channel_id=int(getattr(channel, "id", 0)) or None,
        channel_name=channel_name,
        category_name=category_name,
        channel_moved=True,
        permissions_synced=True,
        access_retained=access_retained,
        access_error=access_error,
        role_removed=role_removed,
        role_already_absent=role_already_absent,
        role_error=role_error,
        niche_roles_removed=tuple(niche_roles_removed),
        niche_roles_already_absent=niche_roles_already_absent,
        niche_role_error=niche_role_error,
        kicked=kicked,
        kick_error=kick_error,
        crm_synced=crm_synced,
        coach_name=coach_name,
        offboard_message=offboard_message,
        warnings=tuple(warnings),
    )


def render_offboard_outcome(outcome: OffboardOutcome, creator_role_name: str) -> str:
    """Format an :class:`OffboardOutcome` as the operator-facing reply."""
    if not outcome.ok:
        return f"❌ {outcome.error}"

    lines: list[str] = []
    if outcome.channel_moved:
        lines.append(f"✅ moved <#{outcome.channel_id}> to **{outcome.category_name}**")
    if outcome.permissions_synced:
        lines.append(f"✅ synced permissions to **{outcome.category_name}**")

    if outcome.access_error:
        lines.append(f"⚠️ {outcome.access_error}")
    elif outcome.access_retained:
        lines.append(f"✅ kept the creator's own access to <#{outcome.channel_id}> (read + post)")

    if outcome.role_error:
        lines.append(f"⚠️ {outcome.role_error}")
    elif outcome.role_already_absent:
        lines.append(f"ℹ️ already missing **{creator_role_name}**")
    elif outcome.role_removed:
        lines.append(f"✅ removed **{creator_role_name}**")

    if outcome.niche_role_error:
        lines.append(f"⚠️ {outcome.niche_role_error}")
    if outcome.niche_roles_removed:
        if len(outcome.niche_roles_removed) == 1:
            lines.append(f"✅ removed **{outcome.niche_roles_removed[0]}**")
        else:
            role_names = ", ".join(f"**{name}**" for name in outcome.niche_roles_removed)
            lines.append(f"✅ removed niche roles: {role_names}")
    elif outcome.niche_roles_already_absent:
        lines.append("ℹ️ already missing niche roles")

    if outcome.kick_error:
        lines.append(f"⚠️ {outcome.kick_error}")
    elif outcome.kicked:
        lines.append("✅ kicked the member")

    if outcome.crm_synced:
        lines.append("✅ marked paused in the CRM and archived on the roster (no more recaps)")

    lines.extend(f"⚠️ {w}" for w in outcome.warnings)
    return "\n".join(lines)
