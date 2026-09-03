"""Pure core for the ``/onboard`` slash command.

Onboarding a creator is three side effects (create channel, assign role, post
welcome) wrapped around a lot of decisions: what to name the channel, which
category the niche maps to, which permission overwrites to copy from the
server's existing convention, and whether the bot is even allowed to hand out
the role. All of those decisions live here as pure functions so they can be
unit-tested without touching Discord.

``execute_onboarding`` is the orchestrator. It is ``async`` but duck-typed --
it only calls the handful of guild/member methods it needs -- so tests drive it
with simple fakes instead of a live gateway connection.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Iterable, Mapping, Optional, Sequence

import niches

# Live convention 2026-08-20: a creator channel is ``<track-emoji><name>``
# (``✝️jas``) and the CATEGORY records the coach team, not the niche. The
# emoji-per-niche vocabulary now lives in research_niches (see niches.py),
# not a module constant here. NICHE_CHANNEL_PREFIXES below is seeded from
# the fallback list rather than read live -- a stopgap kept just wide enough
# to keep this module importable; making /onboard's niche list (autocomplete
# included) track research_niches live is separate follow-up work, not done
# here. Unmapped tracks fall back to the legacy ``coaching-`` prefix, which
# every parser accepts.
CHANNEL_PREFIX = "coaching-"
NICHE_CHANNEL_PREFIXES: dict[str, str] = dict(niches.FALLBACK_NICHES)

# Discord hard limit for a channel name.
MAX_CHANNEL_NAME_LEN = 100

# Categories that exist for server plumbing rather than a creator niche. Used to
# keep the /onboard niche autocomplete to real niches only.
NON_NICHE_CATEGORIES: frozenset[str] = frozenset(
    {
        "🏠Home",
        "👤・Creators",
        "ℹ️・Info",
        "FOLK TEAM",
        "VERIFY",
        "Resources",
        "⭐CALLS ⭐",
        "Meta ads groups",
        "Archived",
    }
)

_NON_SLUG = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class WelcomeLinks:
    """Channel ids and custom-emoji ids referenced by the welcome message.

    Ids, not names: Discord only renders a channel as a clickable link from
    ``<#id>``. A literal ``#some-channel`` is inert text, and a custom emoji
    written ``:tt:`` renders as nothing at all outside the app's own composer —
    both have to carry the numeric id to survive.
    """

    post_tracking: int
    warmup: int
    folk_access: int
    setup_ig_dms: int
    demos: int
    demo_maker: int
    folk_domains: int
    trial_reel_tool: int
    folk_branding: int
    emoji_tiktok: int
    emoji_instagram: int


@dataclass(frozen=True)
class OverwriteSpec:
    """One permission overwrite, expressed as intent rather than a bitfield.

    ``target`` is a symbolic name resolved by the caller to a real Discord role
    or member. ``None`` means "inherit" (neither allow nor deny).
    """

    target: str
    view_channel: Optional[bool] = None
    send_messages: Optional[bool] = None
    embed_links: Optional[bool] = None
    attach_files: Optional[bool] = None
    read_message_history: Optional[bool] = None

    def as_permission_kwargs(self) -> dict[str, bool]:
        """Only the explicitly set permissions, ready for PermissionOverwrite."""
        pairs = {
            "view_channel": self.view_channel,
            "send_messages": self.send_messages,
            "embed_links": self.embed_links,
            "attach_files": self.attach_files,
            "read_message_history": self.read_message_history,
        }
        return {k: v for k, v in pairs.items() if v is not None}


@dataclass(frozen=True)
class OnboardOutcome:
    """Structured result of an onboarding attempt, rendered for the operator."""

    ok: bool
    channel_id: Optional[int] = None
    channel_name: Optional[str] = None
    category_name: Optional[str] = None
    channel_created: bool = False
    role_assigned: bool = False
    role_already_had: bool = False
    role_error: Optional[str] = None
    niche_role_assigned: bool = False
    niche_role_already_had: bool = False
    niche_role_name: Optional[str] = None
    niche_role_error: Optional[str] = None
    welcome_posted: bool = False
    checklist_posted: bool = False
    crm_synced: bool = False
    # [CREATOR-PROVISION] The folk tracking link this creator should put in
    # their posts. Absent when provisioning was skipped or failed; the reason
    # lands in ``warnings`` so onboarding still succeeds without it.
    folk_link: Optional[str] = None
    folk_link_status: Optional[str] = None
    error: Optional[str] = None
    warnings: tuple[str, ...] = field(default_factory=tuple)


def slugify_creator_name(raw: str) -> str:
    """Reduce a display name to the lowercase slug used in channel names.

    Emoji and punctuation are stripped so ``Malik 💪`` becomes ``malik``, which
    matches how the existing ``coaching-*`` channels are named.
    """
    slug = _NON_SLUG.sub("-", (raw or "").strip().lower())
    return slug.strip("-")


def build_channel_name(display_name: str, fallback: str = "", niche: Optional[str] = None) -> str:
    """Channel name for a creator: the niche track's emoji prefix when the
    track is known, else the legacy ``coaching-<slug>``."""
    slug = slugify_creator_name(display_name) or slugify_creator_name(fallback)
    if not slug:
        raise ValueError("cannot derive a channel name from an empty display name")
    prefix = NICHE_CHANNEL_PREFIXES.get(niche or "", CHANNEL_PREFIX)
    return f"{prefix}{slug}"[:MAX_CHANNEL_NAME_LEN]


def is_niche_category(name: str) -> bool:
    """Whether a category represents a creator niche (vs server plumbing).

    Name-based heuristic, kept as a secondary filter behind the authoritative
    id-based exclusion list so a renamed category can't silently reappear.
    """
    return name not in NON_NICHE_CATEGORIES


def select_niche_categories(
    categories: Iterable[Any],
    excluded_ids: frozenset[int] = frozenset(),
) -> list[Any]:
    """Categories a creator may be onboarded into, in sidebar order.

    Excluded by id first (authoritative, survives renames) and by name second
    (catches categories added after this list was written).
    """
    selected = [
        c
        for c in categories
        if int(getattr(c, "id", 0)) not in excluded_ids
        and is_niche_category(getattr(c, "name", ""))
    ]
    selected.sort(key=lambda c: getattr(c, "position", 0))
    return selected


def resolve_category_target(
    value: str, categories: Sequence[Any]
) -> tuple[Optional[Any], list[str]]:
    """Resolve a niche argument to one category object.

    ``value`` is normally a category **id** (what the dropdown submits), which is
    immune to renames. A non-numeric value is treated as a name and matched
    leniently, which keeps the autocomplete fallback and manual calls working.
    Returns ``(category, candidate_names)``; ``category`` is None on failure.
    """
    text = (value or "").strip()
    names = [getattr(c, "name", "") for c in categories]
    if not text:
        return None, names

    if text.isdigit():
        wanted = int(text)
        for c in categories:
            if int(getattr(c, "id", 0)) == wanted:
                return c, []
        return None, names

    matched, candidates = resolve_category(text, names)
    if matched is None:
        return None, candidates
    for c in categories:
        if getattr(c, "name", "") == matched:
            return c, []
    return None, names


def _normalize(value: str) -> str:
    return " ".join((value or "").strip().lower().split())


def resolve_category(niche: str, category_names: Iterable[str]) -> tuple[Optional[str], list[str]]:
    """Match a free-text niche to exactly one category name.

    Returns ``(match, candidates)``. ``match`` is None when nothing matched or
    when the input was ambiguous, in which case ``candidates`` carries the near
    misses so the caller can show a useful error. Matching widens from exact to
    prefix to substring, and only accepts a tier that yields a single hit -- so a
    typo never silently lands a creator in the wrong niche.
    """
    names = list(category_names)
    needle = _normalize(niche)
    if not needle:
        return None, names

    exact = [n for n in names if _normalize(n) == needle]
    if len(exact) == 1:
        return exact[0], []

    prefix = [n for n in names if _normalize(n).startswith(needle)]
    if len(prefix) == 1:
        return prefix[0], []

    substring = [n for n in names if needle in _normalize(n)]
    if len(substring) == 1:
        return substring[0], []

    return None, (exact or prefix or substring or names)


def build_welcome_message(user_id: int, links: WelcomeLinks) -> str:
    """The greeting, posted first.

    Kept separate from the checklist so the ping and the "this is your channel"
    orientation land as their own message. A creator opening the channel sees a
    short hello rather than a wall of tasks, and the checklist below is a
    standalone block they can scroll back to or pin on its own.
    """
    return (
        f"welcome <@{user_id}>! this is your channel — post your content and questions here."
    )


def build_onboarding_checklist_message(links: WelcomeLinks) -> str:
    """The day-one checklist, posted immediately after the greeting.

    Every channel goes in as ``<#id>`` and every custom emoji as ``<:name:id>``
    so they resolve to real links and images in the posted message. Written as
    a plain f-string rather than an embed because Discord does not render
    markdown headings (``##``) inside embed bodies, and the headings are what
    give this its shape.

    Takes no ``user_id``: the greeting already pinged them, and a second ping
    in the same second is just noise.
    """
    tt = f"<:tt:{links.emoji_tiktok}>"
    ig = f"<:ig:{links.emoji_instagram}>"
    return (
        "## today\n"
        f"- **create {tt}{ig} accounts:** wisdomwjoey, joeyprays, lockedwjoey, "
        "dialedinjoey etc. *(depends on your niche)*\n"
        f"- **setup tracking & payouts:** link accounts and join our <#{links.post_tracking}>\n"
        f"- **start warmup process:** <#{links.warmup}>\n"
        "    + send screenshots of time management as proof\n"
        f"- **<#{links.setup_ig_dms}> automation:** with your creator link\n"
        f"- **get folk access:** <#{links.folk_access}>\n"
        "- **start filming scripts:** we want to hit the ground running with posts\n\n"
        "## *Other Important Information*\n"
        f"- Demos: <#{links.demos}> & <#{links.demo_maker}> or create your own in Folk\n"
        f"- Take a look at these: <#{links.folk_domains}> <#{links.trial_reel_tool}> "
        f"<#{links.folk_branding}>\n"
        "- **Payouts:** *$40 Base + $1/CPM | 1,000 view threshold / 1mill view cap | "
        "14 days video mature | Payouts bi-weekly*"
    )


def build_overwrite_specs(*, include_launchpoint: bool = True) -> tuple[OverwriteSpec, ...]:
    """Permission overwrites for a new creator channel.

    Mirrors the convention already used by the existing ``coaching-*`` channels
    (the single most common overwrite signature in the guild): the channel is
    hidden from ``@everyone``, other creators may read but not post, the creator
    themselves may read and post, and the Launchpoint automation bot gets the
    richer set it needs to deliver approvals.
    """
    specs = [
        OverwriteSpec("everyone", view_channel=False),
        OverwriteSpec("creator_role", view_channel=True, send_messages=False),
        OverwriteSpec("creator_member", view_channel=True, send_messages=True),
    ]
    if include_launchpoint:
        specs.append(
            OverwriteSpec(
                "launchpoint_bot",
                view_channel=True,
                send_messages=True,
                embed_links=True,
                attach_files=True,
                read_message_history=True,
            )
        )
    return tuple(specs)


def can_assign_role(bot_top_role_position: int, role_position: int) -> bool:
    """Whether the bot outranks a role enough to grant it.

    Discord requires the actor's highest role to be strictly above the role being
    assigned. ADMINISTRATOR does **not** bypass this, which is why we check it up
    front instead of letting ``add_roles`` fail with an opaque 403.
    """
    return bot_top_role_position > role_position


def role_hierarchy_error(bot_role_name: str, role_name: str) -> str:
    """Operator-facing instructions for fixing a role-hierarchy failure."""
    return (
        f"i can't assign **{role_name}** — my **{bot_role_name}** role sits below it. "
        f"fix: Server Settings → Roles → drag **{bot_role_name}** above **{role_name}**, "
        "then run this again."
    )


def find_existing_channel(channels: Iterable[Any], channel_name: str) -> Optional[Any]:
    """Return a channel already named ``channel_name``, if any."""
    for channel in channels:
        if getattr(channel, "name", None) == channel_name:
            return channel
    return None


def _member_has_role(member: Any, role: Any) -> bool:
    role_id = getattr(role, "id", None)
    return any(getattr(r, "id", None) == role_id for r in getattr(member, "roles", []) or [])


def _find_role(guild: Any, role_name: str, role_id: Optional[int] = None) -> Optional[Any]:
    """Find the creator role, preferring its id so a rename can't break it."""
    roles = getattr(guild, "roles", []) or []
    if role_id is not None:
        for role in roles:
            if int(getattr(role, "id", 0)) == int(role_id):
                return role
    for role in roles:
        if getattr(role, "name", None) == role_name:
            return role
    return None


def _bot_top_role_position(me: Any) -> int:
    positions = [getattr(r, "position", 0) for r in getattr(me, "roles", []) or []]
    return max(positions) if positions else 0


def _bot_top_role_name(me: Any) -> str:
    roles = [r for r in getattr(me, "roles", []) or []]
    if not roles:
        return "the bot"
    top = max(roles, key=lambda r: getattr(r, "position", 0))
    return getattr(top, "name", "the bot")


async def execute_onboarding(
    *,
    guild: Any,
    member: Any,
    niche: str,
    channel_niche: Optional[str] = None,
    creator_role_name: str,
    welcome_links: WelcomeLinks,
    launchpoint_bot_id: Optional[int] = None,
    excluded_category_ids: frozenset[int] = frozenset(),
    creator_role_id: Optional[int] = None,
    niche_role_ids: Optional[Mapping[int, int]] = None,
    build_overwrite: Callable[[OverwriteSpec], Any],
    fetch_member: Optional[Callable[[int], Awaitable[Any]]] = None,
    sync_crm: Optional[Callable[[int, str, str, str, int, Optional[str]], None]] = None,
    get_channel_owner: Optional[Callable[[int], Optional[int]]] = None,
    provision_link: Optional[Callable[..., Any]] = None,
    reason: str = "creator onboarding via /onboard",
) -> OnboardOutcome:
    """Create the channel, grant the role, and post the welcome message.

    Deliberately degrades rather than aborting: a failure to grant the role or to
    record the creator in the CRM is reported back to the operator but does not
    undo a channel that was already created, because a half-made channel is
    easier to reason about than a silently rolled-back one.

    ``build_overwrite`` turns an :class:`OverwriteSpec` into whatever the caller's
    Discord layer expects, keeping this function free of discord.py types.
    ``get_channel_owner`` maps a channel id to the creator already assigned to it,
    used to refuse reusing someone else's channel.
    """
    warnings: list[str] = []

    display_name = getattr(member, "display_name", None) or getattr(member, "name", "")
    try:
        channel_name = build_channel_name(
            display_name, fallback=str(getattr(member, "id", "")), niche=channel_niche
        )
    except ValueError as exc:
        return OnboardOutcome(ok=False, error=str(exc))

    # Only real niche categories are selectable, and the dropdown submits a
    # category *id* rather than a name, so renaming a category can't break
    # onboarding or silently misfile a creator.
    categories = select_niche_categories(
        getattr(guild, "categories", []) or [], excluded_category_ids
    )
    category, candidates = resolve_category_target(niche, categories)
    if category is None:
        shown = ", ".join(f"`{c}`" for c in candidates) or "none"
        return OnboardOutcome(
            ok=False,
            error=f"couldn't match niche `{niche}` to one category. options: {shown}",
        )
    matched = getattr(category, "name", str(niche))

    # Distinct members can slugify to the same channel name (`Alex` and
    # `Alex 🔥` both give `coaching-alex`). Reusing a channel that already
    # belongs to someone else would repoint their CRM row and break attribution
    # for their own messages, so refuse before touching anything.
    existing = find_existing_channel(getattr(guild, "text_channels", []) or [], channel_name)
    if existing is not None and get_channel_owner is not None:
        owner_id = get_channel_owner(int(getattr(existing, "id", 0)))
        if owner_id is not None and owner_id != getattr(member, "id", None):
            return OnboardOutcome(
                ok=False,
                error=(
                    f"`#{channel_name}` already belongs to <@{owner_id}>. "
                    "rename one of them or create the channel manually."
                ),
            )

    creator_role = _find_role(guild, creator_role_name, creator_role_id)
    if creator_role is None:
        warnings.append(f"role `{creator_role_name}` not found in this server")

    # Resolve overwrite targets. A missing Launchpoint member is non-fatal: the
    # channel is still usable, it just won't have the bot pre-authorized.
    launchpoint_member = None
    if launchpoint_bot_id is not None and fetch_member is not None:
        try:
            launchpoint_member = await fetch_member(launchpoint_bot_id)
        except Exception:  # noqa: BLE001 - best-effort convenience overwrite
            launchpoint_member = None
            warnings.append("couldn't resolve the Launchpoint bot; skipped its channel access")

    targets = {
        "everyone": getattr(guild, "default_role", None),
        "creator_role": creator_role,
        "creator_member": member,
        "launchpoint_bot": launchpoint_member,
    }
    overwrites = {}
    for spec in build_overwrite_specs(include_launchpoint=launchpoint_member is not None):
        target = targets.get(spec.target)
        if target is None:
            continue
        overwrites[target] = build_overwrite(spec)

    channel_created = False
    if existing is not None:
        channel = existing
        warnings.append(f"channel `#{channel_name}` already existed, reused it")
    else:
        try:
            channel = await guild.create_text_channel(
                name=channel_name,
                category=category,
                overwrites=overwrites,
                reason=reason,
            )
            channel_created = True
        except Exception as exc:  # noqa: BLE001 - surfaced to the operator
            return OnboardOutcome(ok=False, error=f"couldn't create the channel: {exc}")

    # Role assignment. Checked against the hierarchy first so the common
    # misconfiguration produces instructions instead of a raw 403.
    role_assigned = False
    role_already_had = False
    role_error: Optional[str] = None
    if creator_role is not None:
        if _member_has_role(member, creator_role):
            role_already_had = True
        else:
            me = getattr(guild, "me", None)
            if me is not None and not can_assign_role(
                _bot_top_role_position(me), getattr(creator_role, "position", 0)
            ):
                role_error = role_hierarchy_error(
                    _bot_top_role_name(me), getattr(creator_role, "name", creator_role_name)
                )
            else:
                try:
                    await member.add_roles(creator_role, reason=reason)
                    role_assigned = True
                except Exception as exc:  # noqa: BLE001 - surfaced to the operator
                    role_error = f"couldn't assign **{creator_role_name}**: {exc}"

    niche_role_assigned = False
    niche_role_already_had = False
    niche_role_name: Optional[str] = None
    niche_role_error: Optional[str] = None
    category_id = int(getattr(category, "id", 0))
    niche_role_id = (niche_role_ids or {}).get(category_id)
    if niche_role_id is not None:
        niche_role = _find_role(guild, "", niche_role_id)
        if niche_role is None:
            niche_role_error = f"niche role `{niche_role_id}` not found in this server"
        else:
            niche_role_name = getattr(niche_role, "name", str(niche_role_id))
            if _member_has_role(member, niche_role):
                niche_role_already_had = True
            else:
                me = getattr(guild, "me", None)
                if me is not None and not can_assign_role(
                    _bot_top_role_position(me), getattr(niche_role, "position", 0)
                ):
                    niche_role_error = role_hierarchy_error(
                        _bot_top_role_name(me), niche_role_name
                    )
                else:
                    try:
                        await member.add_roles(niche_role, reason=reason)
                        niche_role_assigned = True
                    except Exception as exc:  # noqa: BLE001 - surfaced to the operator
                        niche_role_error = f"couldn't assign **{niche_role_name}**: {exc}"

    welcome_posted = False
    checklist_posted = False
    if channel_created:
        try:
            await channel.send(build_welcome_message(getattr(member, "id", 0), welcome_links))
            welcome_posted = True
        except Exception as exc:  # noqa: BLE001 - surfaced to the operator
            warnings.append(f"couldn't post the welcome message: {exc}")
        # Posted separately, and independently: a failed greeting must not cost
        # the creator their checklist, which is the half that carries the work.
        try:
            await channel.send(build_onboarding_checklist_message(welcome_links))
            checklist_posted = True
        except Exception as exc:  # noqa: BLE001 - surfaced to the operator
            warnings.append(f"couldn't post the onboarding checklist: {exc}")

    crm_synced = False
    if sync_crm is not None:
        try:
            sync_crm(
                int(getattr(channel, "id", 0)),
                channel_name,
                slugify_creator_name(display_name),
                matched,
                int(getattr(member, "id", 0)),
                channel_niche,
            )
            crm_synced = True
        except Exception as exc:  # noqa: BLE001 - CRM sync must not fail onboarding
            warnings.append(f"couldn't record the creator in the CRM: {exc}")

    # [CREATOR-PROVISION] Mint (or recover) the creator's folk tracking link.
    # Deliberately last and deliberately non-fatal: the channel, role and
    # welcome message are the things a creator cannot be onboarded without,
    # and folk-web being down must not undo any of them. A failure becomes a
    # warning the operator can act on, and re-running /onboard is safe because
    # the endpoint is idempotent on the Discord id.
    folk_link = None
    folk_link_status = None
    if provision_link is not None:
        try:
            result = provision_link(
                discord_user_id=int(getattr(member, "id", 0)),
                display_name=display_name,
                discord_username=getattr(member, "name", None),
                niche=channel_niche,
            )
            folk_link_status = getattr(result, "status", None)
            folk_link = getattr(result, "url", None)
            if folk_link_status in ("needs_link", "error", "skipped"):
                warnings.append(
                    f"no folk link: {getattr(result, 'detail', None) or folk_link_status}"
                )
        except Exception as exc:  # noqa: BLE001 - link minting must not fail onboarding
            folk_link_status = "error"
            warnings.append(f"couldn't create the folk tracking link: {exc}")

    return OnboardOutcome(
        ok=True,
        channel_id=int(getattr(channel, "id", 0)) or None,
        channel_name=channel_name,
        category_name=matched,
        channel_created=channel_created,
        role_assigned=role_assigned,
        role_already_had=role_already_had,
        role_error=role_error,
        niche_role_assigned=niche_role_assigned,
        niche_role_already_had=niche_role_already_had,
        niche_role_name=niche_role_name,
        niche_role_error=niche_role_error,
        welcome_posted=welcome_posted,
        checklist_posted=checklist_posted,
        crm_synced=crm_synced,
        folk_link=folk_link,
        folk_link_status=folk_link_status,
        warnings=tuple(warnings),
    )


def render_outcome(outcome: OnboardOutcome, creator_role_name: str) -> str:
    """Format an :class:`OnboardOutcome` as the operator-facing reply."""
    if not outcome.ok:
        return f"❌ {outcome.error}"

    lines: list[str] = []
    if outcome.channel_created:
        lines.append(f"✅ created <#{outcome.channel_id}> in **{outcome.category_name}**")
    else:
        lines.append(f"ℹ️ reused <#{outcome.channel_id}> in **{outcome.category_name}**")

    if outcome.role_error:
        lines.append(f"⚠️ {outcome.role_error}")
    elif outcome.role_already_had:
        lines.append(f"ℹ️ already had **{creator_role_name}**")
    elif outcome.role_assigned:
        lines.append(f"✅ assigned **{creator_role_name}**")

    if outcome.niche_role_error:
        lines.append(f"⚠️ {outcome.niche_role_error}")
    elif outcome.niche_role_already_had and outcome.niche_role_name:
        lines.append(f"ℹ️ already had **{outcome.niche_role_name}**")
    elif outcome.niche_role_assigned and outcome.niche_role_name:
        lines.append(f"✅ assigned **{outcome.niche_role_name}**")

    if outcome.welcome_posted:
        lines.append("✅ posted the welcome message")
    if outcome.checklist_posted:
        lines.append("✅ posted the onboarding checklist")

    if outcome.crm_synced:
        lines.append("✅ tracked in the CRM")
    # [CREATOR-PROVISION] Show the link itself, not just that it worked: the
    # operator is about to paste it to the creator.
    if outcome.folk_link and outcome.folk_link_status == "created":
        lines.append(f"✅ folk link **{outcome.folk_link}**")
    elif outcome.folk_link and outcome.folk_link_status == "existing":
        lines.append(f"ℹ️ folk link already existed: **{outcome.folk_link}**")

    lines.extend(f"⚠️ {w}" for w in outcome.warnings)
    return "\n".join(lines)


def niche_choices(category_names: Sequence[str], query: str = "", limit: int = 25) -> list[str]:
    """Filter niche categories for the ``/onboard`` autocomplete."""
    needle = _normalize(query)
    names = [n for n in category_names if is_niche_category(n)]
    if needle:
        names = [n for n in names if needle in _normalize(n)]
    return names[:limit]
