"""Slash command surface — the discord.py adapter over the pure cores.

Ported from discord-crm's commands.py with the config machinery simplified:
this repo runs env/default-driven (no server_settings / crm_niches tables), so
the guild config and niche mapping come straight from BotConfig. CRM sync goes
through store.py (PostgREST) and also updates the live allowlist + role map so
a freshly onboarded channel is ingested immediately.
"""
from __future__ import annotations

import asyncio
import logging
import time
from typing import Optional, Sequence

import discord
from discord import app_commands

from discord_bot import socials, store, webapi
from discord_bot.permissions import command_is_open, may_run_commands, staff_only_message
from discord_bot.command_ui import (
    EmbedSpec,
    build_my_stats_embed,
    build_stats_embed,
    build_creator_embed,
    build_creators_embed,
    build_help_embed,
    build_offboard_message_embed,
    clip,
    command_description,
    creator_name_choices,
    evaluate_health,
    find_creator_row,
    render_health_embed,
)
from discord_bot.config import BotConfig
from discord_bot.onboarding import (
    NICHE_CHANNEL_PREFIXES,
    OverwriteSpec,
    execute_onboarding,
    render_outcome,
    select_niche_categories,
)
from discord_bot.offboarding import execute_offboarding, render_offboard_outcome

logger = logging.getLogger(__name__)

MAX_CHOICES = 25  # Discord's cap on predefined choices per option

# Data-driven replies never ping. Creator names and niches come from Discord
# channel names, so an @everyone hiding in one must not become a mass mention.
NO_MENTIONS = discord.AllowedMentions.none()


class BotState:
    """Live ingest state shared between commands and the gateway client.

    ``role_map`` is a discord_pull_worker.RoleMap; its channel_creator dict is
    mutated in place by /onboard so attribution picks up the new channel with
    no restart — same trick discord-crm used.
    """

    def __init__(self, allowlisted_channel_ids: set[int], role_map) -> None:
        self.allowlisted_channel_ids = allowlisted_channel_ids
        self.role_map = role_map

    @property
    def channel_creator(self) -> dict[int, int]:
        return self.role_map.channel_creator


def _to_embed(spec: EmbedSpec) -> discord.Embed:
    embed = discord.Embed(title=spec.title, description=spec.description, color=spec.color)
    for f in spec.fields:
        embed.add_field(name=f.name, value=f.value, inline=f.inline)
    if spec.footer:
        embed.set_footer(text=spec.footer)
    return embed


def _to_overwrite(spec: OverwriteSpec) -> discord.PermissionOverwrite:
    return discord.PermissionOverwrite(**spec.as_permission_kwargs())


# Autocomplete fires on every keystroke, so the roster is cached briefly rather
# than hitting PostgREST per character typed.
_ROSTER_TTL_SECONDS = 30
_roster_cache: dict[str, object] = {"at": 0.0, "rows": None}

# Autocomplete has its own cache and its own (much cheaper) query: Discord
# discards an autocomplete interaction after 3 seconds, so it cannot share the
# overview read that pages the message history.
_NAMES_TTL_SECONDS = 300
_names_cache: dict[str, object] = {"at": 0.0, "rows": None}


async def _creator_names(force: bool = False) -> list[dict]:
    now = time.monotonic()
    cached = _names_cache.get("rows")
    if not force and cached is not None and now - float(_names_cache["at"]) < _NAMES_TTL_SECONDS:
        return cached  # type: ignore[return-value]
    rows = await asyncio.to_thread(store.creator_names)
    _names_cache["rows"] = rows
    _names_cache["at"] = now
    return rows


async def _creator_rows(force: bool = False) -> list[dict]:
    """Creator roster, cached briefly and fetched off the event loop —
    store uses blocking urllib, which would stall the gateway inline."""
    now = time.monotonic()
    cached = _roster_cache.get("rows")
    if not force and cached is not None and now - float(_roster_cache["at"]) < _ROSTER_TTL_SECONDS:
        return cached  # type: ignore[return-value]
    rows = await asyncio.to_thread(store.creator_overview)
    _roster_cache["rows"] = rows
    _roster_cache["at"] = now
    return rows


def _bot_permissions(guild) -> discord.Permissions:
    me = getattr(guild, "me", None)
    perms = getattr(me, "guild_permissions", None)
    return perms if perms is not None else discord.Permissions.none()


def sort_niche_categories(categories: Sequence, excluded_ids: frozenset[int] = frozenset()) -> list:
    """Niche categories in sidebar order, for the /onboard dropdown."""
    return select_niche_categories(categories, excluded_ids)[:MAX_CHOICES]


async def fetch_niche_categories(client, guild_id: int, excluded_ids: frozenset[int] = frozenset()) -> list:
    """Fetch the guild's creator-channel categories over HTTP — setup_hook runs
    before the gateway connects, so the channel cache is empty."""
    guild = await client.fetch_guild(guild_id)
    channels = await guild.fetch_channels()
    return sort_niche_categories(
        [c for c in channels if isinstance(c, discord.CategoryChannel)], excluded_ids
    )


async def _gather_health(guild, cfg: BotConfig):
    """Collect live guild + DB facts and evaluate them into a health report."""
    perms = _bot_permissions(guild)
    creator_role = discord.utils.find(
        lambda r: cfg.creator_role_id is not None and int(getattr(r, "id", 0)) == int(cfg.creator_role_id),
        getattr(guild, "roles", []),
    ) or discord.utils.get(getattr(guild, "roles", []), name=cfg.creator_role_name)
    me = getattr(guild, "me", None)
    bot_roles = list(getattr(me, "roles", []) or [])
    top_role = max(bot_roles, key=lambda r: getattr(r, "position", 0)) if bot_roles else None

    missing_channels = [
        label
        for label, channel_id in (
            ("set-up-post-tracking", cfg.welcome_links.post_tracking),
            ("how-to-warm-up", cfg.welcome_links.warmup),
            ("get-folk-access", cfg.welcome_links.folk_access),
        )
        if channel_id and guild.get_channel(channel_id) is None
    ]

    tracked = None
    db_error = None
    untracked: list[str] = []
    unlinked: list[str] = []
    unpingable: list[str] = []
    try:
        rows = await _creator_rows(force=True)
        tracked = len(rows)
        drift = await asyncio.to_thread(store.tracking_drift)
        unlinked = drift["unlinked"]
        unpingable = drift["unpingable"]
        # Guild-side coverage: a channel under a coach category with no
        # tracked row is invisible to the app (its name doesn't classify).
        # Uncategorized channels that grant a single member their own view
        # overwrite are creator channels too (that's how onboarding builds
        # them) — an orphan like a bare "firstname-lastname" channel shows
        # up here instead of silently not existing.
        coach_category_ids = {
            int(c.id)
            for c in getattr(guild, "categories", []) or []
            if getattr(c, "name", "").lower().startswith("coach")
        }

        def _member_overwritten(ch) -> bool:
            overwrites = getattr(ch, "overwrites", {}) or {}
            return any(
                hasattr(target, "display_name") and getattr(ow, "view_channel", None) is True
                for target, ow in (overwrites.items() if isinstance(overwrites, dict) else [])
            )

        untracked = sorted(
            ch.name
            for ch in getattr(guild, "text_channels", []) or []
            if int(ch.id) not in drift["tracked_channel_ids"]
            and (
                getattr(ch, "category_id", None) in coach_category_ids
                or (getattr(ch, "category_id", None) is None and _member_overwritten(ch))
            )
        )
    except Exception as exc:  # noqa: BLE001 - reported as a failed check
        db_error = str(exc)

    return evaluate_health(
        is_admin=bool(perms.administrator),
        can_manage_channels=bool(perms.manage_channels),
        can_manage_roles=bool(perms.manage_roles),
        can_send_messages=bool(perms.send_messages),
        creator_role_name=cfg.creator_role_name,
        creator_role_position=getattr(creator_role, "position", None) if creator_role else None,
        bot_top_role_name=getattr(top_role, "name", "the bot"),
        bot_top_role_position=getattr(top_role, "position", 0),
        missing_welcome_channels=missing_channels,
        tracked_channel_count=tracked,
        db_error=db_error,
        untracked_channels=untracked,
        unlinked_channels=unlinked,
        unpingable_creators=unpingable,
    )


def register_commands(
    tree: app_commands.CommandTree,
    cfg: BotConfig,
    state: BotState,
    niche_options: Optional[Sequence[str]] = None,
) -> None:
    """Register every command against the configured guild.

    Eight top-level entries: /onboard /offboard /link /socials (a group of
    view|add|remove) /help /health /creator /creators.
    """

    # One gate for every command, including any added later: a per-command
    # decorator is a rule you can forget to apply, and the failure mode is a
    # command that silently runs for the whole server.
    async def _staff_gate(interaction: discord.Interaction) -> bool:
        name = getattr(interaction.command, "name", None)
        # /my-stats is for creators, who hold none of the staff roles. It is
        # safe to open because it cannot address anyone but the caller.
        if command_is_open(name):
            return True
        if may_run_commands(interaction.user, cfg.staff_role_ids):
            return True
        try:
            await interaction.response.send_message(staff_only_message(), ephemeral=True)
        except discord.InteractionResponded:
            await interaction.followup.send(staff_only_message(), ephemeral=True)
        return False

    tree.interaction_check = _staff_gate

    guild = discord.Object(id=cfg.discord_guild_id)

    def channel_owner(channel_id: int) -> Optional[int]:
        return state.channel_creator.get(int(channel_id))

    def creator_channel(user_id: int) -> Optional[int]:
        for mapped_channel_id, owner_id in state.channel_creator.items():
            if owner_id == int(user_id):
                return int(mapped_channel_id)
        return None

    def onboard_crm_sync(
        channel_id: int, channel_name: str, creator_name: str, niche: str, user_id: int,
        channel_niche: Optional[str] = None,
    ) -> None:
        # `niche` here is the matched category *name* (now a coach team);
        # `channel_niche` is the /onboard track choice, which is the real
        # niche under the live convention.
        store.onboard_creator_channel(
            guild_id=cfg.discord_guild_id,
            channel_id=channel_id,
            channel_name=channel_name,
            category_name=niche,
            niche=channel_niche,
            discord_user_id=user_id,
        )
        state.allowlisted_channel_ids.add(channel_id)
        state.channel_creator[channel_id] = user_id

    def offboard_crm_sync(channel_id: int, channel_name: str, creator_name: str, niche: str, user_id: int) -> bool:
        # The channel deliberately stays tracked: paused is a displayed state,
        # dropping it would erase the creator from /discord.
        return store.offboard_creator_channel(channel_id)

    # ---- /onboard -----------------------------------------------------

    async def onboard(
        interaction: discord.Interaction,
        username: discord.Member,
        niche: str,
        track: str,
    ) -> None:
        # Channel creation + role assignment + posting is several round trips,
        # comfortably past Discord's 3s initial-response budget.
        await interaction.response.defer(ephemeral=True)

        async def fetch_member(user_id: int):
            return interaction.guild.get_member(user_id) or await interaction.guild.fetch_member(user_id)

        outcome = await execute_onboarding(
            guild=interaction.guild,
            member=username,
            niche=niche,
            # "legacy" is the escape hatch for a niche outside the mapped
            # tracks — the channel gets the old coaching- prefix.
            channel_niche=None if track == "legacy" else track,
            creator_role_name=cfg.creator_role_name,
            creator_role_id=cfg.creator_role_id,
            welcome_links=cfg.welcome_links,
            launchpoint_bot_id=cfg.launchpoint_bot_id,
            excluded_category_ids=cfg.excluded_category_ids,
            niche_role_ids=cfg.niche_role_ids,
            build_overwrite=_to_overwrite,
            fetch_member=fetch_member,
            sync_crm=onboard_crm_sync,
            get_channel_owner=channel_owner,
            reason=f"/onboard by {interaction.user}",
        )
        logger.info(
            "onboard %s -> channel=%s created=%s role=%s",
            getattr(username, "id", None), outcome.channel_id, outcome.channel_created, outcome.role_assigned,
        )
        reply = render_outcome(outcome, cfg.creator_role_name)
        # Tracking status is part of the outcome: either the Discord id already
        # matched a roster creator (auto-linked) or /link is the required next
        # step — say which, so nobody drifts untracked.
        if outcome.ok and outcome.channel_id:
            linked = await asyncio.to_thread(store.channel_creator_handle, int(outcome.channel_id))
            if linked:
                state.channel_creator[int(outcome.channel_id)] = int(username.id)
                reply += f"\n✅ linked to **@{linked}** (matched by Discord id)"
            else:
                reply += (
                    f"\n⚠️ not linked to an Instagram yet — run "
                    f"`/link username:@{getattr(username, 'display_name', username)} instagram:<handle>` to finish tracking."
                )
        await interaction.followup.send(reply, ephemeral=True, allowed_mentions=NO_MENTIONS)

    # The param Discord shows as `niche` historically picked a niche category;
    # categories are coach teams now, so rename what the operator sees while
    # the internal plumbing keeps its name.
    onboard = app_commands.rename(niche="team")(onboard)
    track_emojis = "/".join(NICHE_CHANNEL_PREFIXES.values())
    onboard = app_commands.describe(
        username="The creator to onboard",
        niche="Which coach team category their channel goes in",
        track=f"Niche track — names the channel {track_emojis}<name> and sets their niche everywhere",
    )(onboard)
    onboard = app_commands.choices(
        track=[
            *(
                app_commands.Choice(name=f"{emoji} {niche_name}"[:100], value=niche_name)
                for niche_name, emoji in NICHE_CHANNEL_PREFIXES.items()
            ),
            app_commands.Choice(name="coaching- (legacy, niche set later)", value="legacy"),
        ]
    )(onboard)
    options = list(niche_options or [])[:MAX_CHOICES]
    if options:
        # The choice *value* is the category id, so renaming a category can't
        # break onboarding; the label stays the human-readable name.
        onboard = app_commands.choices(
            niche=[
                app_commands.Choice(name=clip(getattr(c, "name", str(c)), 100), value=str(getattr(c, "id", c)))
                for c in options
            ]
        )(onboard)
    # Gated to staff: coaches hold Administrator, which implies Manage Channels.
    onboard = app_commands.guild_only()(onboard)
    onboard_command = tree.command(
        name="onboard", description=command_description("onboard"), guild=guild
    )(onboard)

    if not options:

        @onboard_command.autocomplete("niche")
        async def niche_autocomplete(
            interaction: discord.Interaction, current: str
        ) -> list[app_commands.Choice[str]]:
            cats = select_niche_categories(
                getattr(interaction.guild, "categories", []) or [], cfg.excluded_category_ids
            )
            needle = (current or "").strip().lower()
            if needle:
                cats = [c for c in cats if needle in getattr(c, "name", "").lower()]
            return [app_commands.Choice(name=c.name, value=str(c.id)) for c in cats[:MAX_CHOICES]]

    # ---- /offboard ----------------------------------------------------

    async def offboard(interaction: discord.Interaction, user: discord.User, kick: str) -> None:
        await interaction.response.defer(ephemeral=True)

        # A User resolves even for someone who already left. Upgrade to Member
        # when present — the members intent is off, so the cache can't be
        # trusted and a fetch is required before skipping role removal.
        target = interaction.guild.get_member(getattr(user, "id", 0))
        if target is None:
            try:
                target = await interaction.guild.fetch_member(getattr(user, "id", 0))
            except (discord.NotFound, discord.HTTPException):
                target = user  # genuinely gone; channel + CRM still get handled

        async def move_channel(*, channel, category, sync_permissions, reason):
            await channel.edit(category=category, sync_permissions=sync_permissions, reason=reason)

        async def grant_channel_access(*, channel, member, permissions, reason):
            await channel.set_permissions(
                member, overwrite=discord.PermissionOverwrite(**permissions), reason=reason
            )

        async def remove_role(*, member, role, reason):
            await member.remove_roles(role, reason=reason)

        async def kick_member(*, member, reason):
            await member.kick(reason=reason)

        outcome = await execute_offboarding(
            guild=interaction.guild,
            member=target,
            kick=kick == "yes",
            creator_role_name=cfg.creator_role_name,
            creator_role_id=cfg.creator_role_id,
            niche_role_ids=cfg.niche_role_ids,
            move_channel=move_channel,
            grant_channel_access=grant_channel_access,
            remove_role=remove_role,
            kick_member=kick_member,
            sync_crm=offboard_crm_sync,
            get_channel_owner=channel_owner,
            get_creator_channel_id=creator_channel,
            reason=f"/offboard by {interaction.user}",
        )
        logger.info(
            "offboard %s -> channel=%s moved=%s access_kept=%s role_removed=%s kicked=%s",
            getattr(user, "id", None), outcome.channel_id, outcome.channel_moved,
            outcome.access_retained, outcome.role_removed, outcome.kicked,
        )
        # The note goes out as a separate ephemeral embed rather than inline in
        # the status text: only the operator sees it, and it is a draft for THEM
        # to send in the channel — the bot never posts it itself.
        embeds = []
        if outcome.ok and outcome.offboard_message:
            embeds.append(_to_embed(build_offboard_message_embed(
                outcome.offboard_message, coach_name=outcome.coach_name
            )))
        await interaction.followup.send(
            render_offboard_outcome(outcome, cfg.creator_role_name),
            embeds=embeds,
            ephemeral=True, allowed_mentions=NO_MENTIONS,
        )

    offboard = app_commands.describe(
        user="The creator to offboard",
        kick="Also remove them from the server entirely",
    )(offboard)
    # Static yes/no rather than a bool: kicking is destructive and irreversible.
    offboard = app_commands.choices(
        kick=[app_commands.Choice(name="no", value="no"), app_commands.Choice(name="yes", value="yes")]
    )(offboard)
    offboard = app_commands.guild_only()(offboard)
    tree.command(name="offboard", description=command_description("offboard"), guild=guild)(offboard)

    # ---- /link --------------------------------------------------------

    async def link(interaction: discord.Interaction, username: discord.Member, instagram: str) -> None:
        await interaction.response.defer(ephemeral=True)
        parsed = store.parse_instagram(instagram)
        if parsed is None:
            await interaction.followup.send(
                "❌ that doesn't look like an Instagram/TikTok handle or profile URL.",
                ephemeral=True, allowed_mentions=NO_MENTIONS,
            )
            return
        platform, handle = parsed

        # The channel, in order of confidence: the one the command runs in
        # (when tracked) → the CRM-linked channel for this member → the
        # member's own permission overwrite (names have changed conventions
        # twice, so name reconstruction is no longer trusted).
        channel_id: Optional[int] = None
        if interaction.channel_id in state.allowlisted_channel_ids:
            channel_id = interaction.channel_id
        if channel_id is None:
            channel_id = creator_channel(int(username.id))
        if channel_id is None:
            from discord_bot.offboarding import find_member_channel

            candidates = [
                int(c.id)
                for c in find_member_channel(
                    getattr(interaction.guild, "text_channels", []) or [], username
                )
                if int(c.id) in state.allowlisted_channel_ids
            ]
            if len(candidates) == 1:
                channel_id = candidates[0]
            elif len(candidates) > 1:
                shown = ", ".join(f"<#{c}>" for c in candidates[:5])
                await interaction.followup.send(
                    f"❌ <@{username.id}> has access to several tracked channels ({shown}) — "
                    "run this inside the right one.",
                    ephemeral=True, allowed_mentions=NO_MENTIONS,
                )
                return
        if channel_id is None:
            await interaction.followup.send(
                f"❌ couldn't find a tracked channel for <@{username.id}> — run this inside their channel.",
                ephemeral=True, allowed_mentions=NO_MENTIONS,
            )
            return

        result = await asyncio.to_thread(
            store.link_creator,
            channel_id=channel_id,
            member_id=int(username.id),
            member_username=getattr(username, "name", None),
            member_display=getattr(username, "display_name", None),
            platform=platform,
            handle=handle,
        )
        if result.get("error"):
            await interaction.followup.send(
                f"❌ {result['error']}", ephemeral=True, allowed_mentions=NO_MENTIONS
            )
            return

        # Live role map so their very next message attributes as creator.
        state.channel_creator[channel_id] = int(username.id)
        _roster_cache["rows"] = None  # bust the /creator cache

        lines = [
            f"✅ linked **@{result['handle']}** ↔ <@{username.id}> ↔ <#{channel_id}>",
        ]
        if result.get("creator_created"):
            lines.append("✅ added to the roster and queued for the next profile scrape")
        if result.get("niche"):
            lines.append(f"✅ niche **{result['niche']}** carried onto their roster membership")
        lines.append("scripts dropped in this channel now count as their assignments.")
        logger.info("link %s -> @%s (channel %s)", username.id, result["handle"], channel_id)
        await interaction.followup.send(
            "\n".join(lines), ephemeral=True, allowed_mentions=NO_MENTIONS
        )

    link = app_commands.describe(
        username="The creator's Discord account",
        instagram="Their Instagram handle or profile URL",
    )(link)
    link = app_commands.guild_only()(link)
    tree.command(name="link", description=command_description("link"), guild=guild)(link)

    # ---- /socials -----------------------------------------------------
    # A group: /socials view|add|remove. Discord permissions only gate whole
    # top-level commands, so the group stays open (view is for everyone) and
    # add/remove enforce the staff check at runtime.

    socials_group = app_commands.Group(
        name="socials",
        description=command_description("socials"),
        guild_only=True,
    )

    def _is_staff(interaction: discord.Interaction) -> bool:
        perms = getattr(interaction.user, "guild_permissions", None)
        return bool(perms and perms.manage_channels)

    async def _socials_creator(
        interaction: discord.Interaction, user: discord.Member
    ) -> Optional[dict]:
        """The roster creator behind a member, or None after replying."""
        creator = await asyncio.to_thread(socials.creator_by_discord_id, user.id)
        if creator is None:
            await interaction.followup.send(
                f"❌ {user.mention} isn't linked to a roster creator yet — run "
                "`/link` in their coaching channel first.",
                ephemeral=True, allowed_mentions=NO_MENTIONS,
            )
        return creator

    _PLATFORM_CHOICES = [
        app_commands.Choice(name=socials.LABELS[p], value=p) for p in socials.PLATFORMS
    ]

    @socials_group.command(name="view", description="Show a creator's socials, with missing ones flagged.")
    @app_commands.describe(user="The creator's Discord account")
    async def socials_view(interaction: discord.Interaction, user: discord.Member) -> None:
        await interaction.response.defer(ephemeral=True)
        creator = await _socials_creator(interaction, user)
        if creator is None:
            return
        links, migrated = await asyncio.to_thread(socials.fetch_socials, creator)
        note = None if migrated else "socials table not migrated yet — add/remove are disabled"
        await interaction.followup.send(
            socials.format_socials(f"@{creator['handle']}", links, note),
            ephemeral=True, allowed_mentions=NO_MENTIONS, suppress_embeds=True,
        )

    @socials_group.command(name="add", description="Add or update one of a creator's socials (staff).")
    @app_commands.describe(
        user="The creator's Discord account",
        platform="Which platform",
        link="Profile URL or @handle",
    )
    @app_commands.choices(platform=_PLATFORM_CHOICES)
    async def socials_add(
        interaction: discord.Interaction,
        user: discord.Member,
        platform: app_commands.Choice[str],
        link: str,
    ) -> None:
        await interaction.response.defer(ephemeral=True)
        if not _is_staff(interaction):
            await interaction.followup.send("❌ staff only.", ephemeral=True)
            return
        url = socials.normalize_social(platform.value, link)
        if url is None:
            await interaction.followup.send(
                f"❌ `{clip(link, 60)}` doesn't look like a profile URL or handle.",
                ephemeral=True, allowed_mentions=NO_MENTIONS,
            )
            return
        creator = await _socials_creator(interaction, user)
        if creator is None:
            return
        try:
            await asyncio.to_thread(socials.set_social, creator["id"], platform.value, url)
        except socials.SocialsNotMigrated:
            await interaction.followup.send(
                "❌ the socials table isn't migrated yet — rotate the Supabase "
                "token and apply the pending migrations first.",
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            f"✅ {socials.LABELS[platform.value]} for @{creator['handle']}: {url}",
            ephemeral=True, allowed_mentions=NO_MENTIONS, suppress_embeds=True,
        )

    @socials_group.command(name="remove", description="Remove one of a creator's socials (staff).")
    @app_commands.describe(user="The creator's Discord account", platform="Which platform")
    @app_commands.choices(platform=_PLATFORM_CHOICES)
    async def socials_remove(
        interaction: discord.Interaction,
        user: discord.Member,
        platform: app_commands.Choice[str],
    ) -> None:
        await interaction.response.defer(ephemeral=True)
        if not _is_staff(interaction):
            await interaction.followup.send("❌ staff only.", ephemeral=True)
            return
        creator = await _socials_creator(interaction, user)
        if creator is None:
            return
        try:
            removed = await asyncio.to_thread(
                socials.remove_social, creator["id"], platform.value
            )
        except socials.SocialsNotMigrated:
            await interaction.followup.send(
                "❌ the socials table isn't migrated yet — rotate the Supabase "
                "token and apply the pending migrations first.",
                ephemeral=True,
            )
            return
        await interaction.followup.send(
            f"✅ removed {socials.LABELS[platform.value]} for @{creator['handle']}."
            if removed
            else f"nothing stored for {socials.LABELS[platform.value]} — note the roster's own Instagram can't be removed here.",
            ephemeral=True, allowed_mentions=NO_MENTIONS,
        )

    tree.add_command(socials_group, guild=guild)

    # ---- /help --------------------------------------------------------

    @tree.command(name="help", description=command_description("help"), guild=guild)
    @app_commands.guild_only()
    async def help_command(interaction: discord.Interaction) -> None:
        await interaction.response.send_message(embed=_to_embed(build_help_embed()), ephemeral=True)

    # ---- /health ------------------------------------------------------

    @tree.command(name="health", description=command_description("health"), guild=guild)
    @app_commands.guild_only()
    async def health_command(interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        report = await _gather_health(interaction.guild, cfg)
        await interaction.followup.send(
            embed=_to_embed(render_health_embed(report)), ephemeral=True, allowed_mentions=NO_MENTIONS
        )

    # ---- /creator -----------------------------------------------------

    @tree.command(name="creator", description=command_description("creator"), guild=guild)
    @app_commands.describe(name="Which creator to look up")
    @app_commands.guild_only()
    async def creator_command(interaction: discord.Interaction, name: str) -> None:
        await interaction.response.defer(ephemeral=True)
        try:
            rows = await _creator_rows()
        except Exception as exc:  # noqa: BLE001 - surfaced to the operator
            await interaction.followup.send(f"❌ couldn't reach the CRM database: {exc}", ephemeral=True)
            return
        row = find_creator_row(rows, name)
        if row is None:
            await interaction.followup.send(
                f"❌ no creator matching `{name}`. try `/creators` for the roster.",
                ephemeral=True, allowed_mentions=NO_MENTIONS,
            )
            return
        await interaction.followup.send(
            embed=_to_embed(build_creator_embed(row)), ephemeral=True, allowed_mentions=NO_MENTIONS
        )

    @creator_command.autocomplete("name")
    async def creator_autocomplete(
        interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        try:
            rows = await _creator_names()
        except Exception:  # noqa: BLE001 - autocomplete must never raise at the user
            return []
        return [app_commands.Choice(name=n, value=n) for n in creator_name_choices(rows, current)]

    # ---- /stats -------------------------------------------------------

    @tree.command(name="stats", description=command_description("stats"), guild=guild)
    @app_commands.describe(creator="Which creator to pull stats for")
    @app_commands.guild_only()
    async def stats_command(interaction: discord.Interaction, creator: str) -> None:
        # Ephemeral from the first frame: the deferral sets visibility, so a
        # later followup cannot quietly make earnings public.
        await interaction.response.defer(ephemeral=True)

        # The autocomplete offers channel names; a typed value may be a raw
        # handle instead. Resolve a name when we recognise it, otherwise pass
        # the text through and let the API's handle lookup decide.
        handle = creator.strip().lstrip("@")
        try:
            row = find_creator_row(await _creator_names(), creator)
            if row and row.get("instagram"):
                handle = str(row["instagram"]).lstrip("@")
        except Exception:  # noqa: BLE001 - the roster is a convenience here
            pass

        try:
            data = await asyncio.to_thread(webapi.creator_stats, handle)
        except webapi.WebApiError as exc:
            await interaction.followup.send(
                f"❌ couldn't load stats for `@{handle}`: {exc}",
                ephemeral=True, allowed_mentions=NO_MENTIONS,
            )
            return

        embed = _to_embed(build_stats_embed(data))
        # The card is the panel; the embed is the quotable summary. A card that
        # failed to render comes back null rather than as a broken-image box.
        if data.get("imageUrl"):
            embed.set_image(url=data["imageUrl"])
        logger.info(
            "stats %s -> handle=%s posts=%s image=%s",
            interaction.user, handle,
            (data.get("current") or {}).get("posts"), bool(data.get("imageUrl")),
        )
        await interaction.followup.send(embed=embed, ephemeral=True, allowed_mentions=NO_MENTIONS)

    @stats_command.autocomplete("creator")
    async def stats_autocomplete(
        interaction: discord.Interaction, current: str
    ) -> list[app_commands.Choice[str]]:
        try:
            rows = await _creator_names()
        except Exception:  # noqa: BLE001 - autocomplete must never raise at the user
            return []
        return [app_commands.Choice(name=n, value=n) for n in creator_name_choices(rows, current)]

    # ---- /my-stats ----------------------------------------------------

    @tree.command(name="my-stats", description=command_description("my-stats"), guild=guild)
    @app_commands.guild_only()
    async def my_stats_command(interaction: discord.Interaction) -> None:
        # Open to every member (see permissions.OPEN_COMMANDS) — and safe to
        # be, because it takes no target: the caller's own id is the only key.
        await interaction.response.defer(ephemeral=True)
        try:
            data = await asyncio.to_thread(webapi.my_stats, interaction.user.id)
        except webapi.WebApiError as exc:
            if "not-linked" in str(exc):
                await interaction.followup.send(
                    "❌ your Discord isn't linked to a creator account yet — "
                    "ask your coach to run `/link` for you, then try again.",
                    ephemeral=True, allowed_mentions=NO_MENTIONS,
                )
                return
            await interaction.followup.send(
                f"❌ couldn't load your stats: {exc}", ephemeral=True, allowed_mentions=NO_MENTIONS
            )
            return

        embed = _to_embed(build_my_stats_embed(data))
        if data.get("imageUrl"):
            embed.set_image(url=data["imageUrl"])
        logger.info(
            "my-stats %s -> handle=%s posts=%s",
            interaction.user, data.get("handle"), (data.get("current") or {}).get("posts"),
        )
        await interaction.followup.send(embed=embed, ephemeral=True, allowed_mentions=NO_MENTIONS)

    # ---- /creators ----------------------------------------------------

    @tree.command(name="creators", description=command_description("creators"), guild=guild)
    @app_commands.guild_only()
    async def creators_command(interaction: discord.Interaction) -> None:
        await interaction.response.defer(ephemeral=True)
        try:
            rows = await _creator_rows()
        except Exception as exc:  # noqa: BLE001 - surfaced to the operator
            await interaction.followup.send(f"❌ couldn't reach the CRM database: {exc}", ephemeral=True)
            return
        await interaction.followup.send(
            embed=_to_embed(build_creators_embed(rows, store.summary_stats(rows))),
            ephemeral=True, allowed_mentions=NO_MENTIONS,
        )
