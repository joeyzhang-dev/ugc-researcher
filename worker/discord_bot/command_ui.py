"""Pure presentation layer for the bot's slash commands.

Everything a command renders is built here as plain data (:class:`EmbedSpec`),
so the copy, the Discord size limits and the health rules are all unit-testable
without a gateway connection. :mod:`discord_crm.commands` converts these
specs into ``discord.Embed`` objects.

:data:`COMMAND_CATALOG` is the single source of truth for command descriptions:
it feeds both the registered slash-command descriptions (what Discord shows in
the ``/`` picker) and the ``/help`` output, so the two cannot drift apart.
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterable, Optional, Sequence

# Discord's documented embed limits. Exceeding any of them makes the whole
# message fail to send, so builders clip defensively rather than trusting that
# CRM data stays small.
MAX_TITLE = 256
MAX_DESCRIPTION = 4096
MAX_FIELD_NAME = 256
MAX_FIELD_VALUE = 1024
MAX_FIELDS = 25

COLOR_BRAND = 0x5865F2
COLOR_OK = 0x57F287
COLOR_WARN = 0xFEE75C
COLOR_FAIL = 0xED4245

_MARKDOWN = re.compile(r"([*_~`|\\>])")


def escape_markdown(text: str) -> str:
    """Neutralize Discord markdown in data-driven values.

    Creator names come from channel names, so a creator called ``**pt**`` would
    otherwise reflow an entire embed.
    """
    return _MARKDOWN.sub(r"\\\1", text or "")


def clip(text: str, limit: int) -> str:
    """Truncate to a Discord limit, keeping the result obviously truncated."""
    text = text or ""
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"


@dataclass(frozen=True)
class EmbedField:
    name: str
    value: str
    inline: bool = False


@dataclass(frozen=True)
class EmbedSpec:
    """A Discord embed as plain data, already clipped to Discord's limits."""

    title: str
    description: str = ""
    fields: tuple[EmbedField, ...] = ()
    color: int = COLOR_BRAND
    footer: Optional[str] = None


def build_embed(
    title: str,
    description: str = "",
    fields: Iterable[EmbedField] = (),
    color: int = COLOR_BRAND,
    footer: Optional[str] = None,
) -> EmbedSpec:
    """Assemble an :class:`EmbedSpec`, enforcing every Discord size limit."""
    clipped = [
        EmbedField(
            name=clip(f.name, MAX_FIELD_NAME),
            value=clip(f.value, MAX_FIELD_VALUE) or "—",
            inline=f.inline,
        )
        for f in list(fields)[:MAX_FIELDS]
    ]
    return EmbedSpec(
        title=clip(title, MAX_TITLE),
        description=clip(description, MAX_DESCRIPTION),
        fields=tuple(clipped),
        color=color,
        footer=footer,
    )


# --- command catalog --------------------------------------------------------


@dataclass(frozen=True)
class CommandInfo:
    """One slash command, as advertised in the ``/`` picker and in ``/help``."""

    name: str
    description: str
    usage: str = ""
    detail: str = ""


COMMAND_CATALOG: tuple[CommandInfo, ...] = (
    CommandInfo(
        name="onboard",
        description="Create a creator's channel, give them the creator role, and post the welcome message.",
        usage="/onboard username:@person team:Coach: Will's Team track:✝️ Christian",
        detail=(
            "Creates `<track-emoji><name>` (e.g. `✝️jas`) under the coach team's category, "
            "grants the creator role, posts the welcome message, and tracks the channel "
            "(the emoji IS the niche) in the CRM. Finish with `/link` to attach their "
            "Instagram — the reply tells you if that step is still needed."
        ),
    ),
    CommandInfo(
        name="offboard",
        description="move a creator to not creating, remove their role, and optionally kick from the server.",
        usage="/offboard user:@person kick:no",
        detail=(
            "moves their channel to Not Creating 🚫, syncs its permissions, keeps the "
            "creator's own access to that channel, removes the creator role, marks them "
            "paused in the CRM, and kicks them from the server only when `kick` is `yes`. "
            "the reply includes the offboarding note to copy into their channel."
        ),
    ),
    CommandInfo(
        name="stats",
        description="Pull one creator's performance panel — trend, CPM, earnings, best posts.",
        usage="/stats creator:jas-alcantara",
        detail=(
            "private to you. shows this week against the last 8, the 30-day CPM and what "
            "they've earned, and their best posts — all on the same numbers as the weekly "
            "coach recap, trial-reel uploads excluded."
        ),
    ),
    CommandInfo(
        name="link",
        description="Link a creator's Instagram to their Discord profile and coaching channel.",
        usage="/link username:@person instagram:@handle",
        detail=(
            "Run it in the creator's channel, or anywhere — it finds their channel via the "
            "CRM link or their channel permissions. A new Instagram handle joins the roster "
            "and the scrape queue; scripts sent to the channel count as their assignments."
        ),
    ),
    CommandInfo(
        name="socials",
        description="View or manage a creator's social links, with missing ones flagged.",
        usage="/socials view user:@person · /socials add user:@person platform:TikTok link:@handle",
        detail=(
            "`view` lists Instagram and TikTok with links (or ❌ missing) — the roster's "
            "own Instagram shows automatically. `add`/`remove` are staff-only and accept "
            "a full profile URL or a bare @handle."
        ),
    ),
    CommandInfo(
        name="creator",
        description="Show a creator's CRM snapshot: activity, drafts, and last seen.",
        usage="/creator name:tatiana",
        detail="Message counts broken down by who sent them, draft count, and last activity.",
    ),
    CommandInfo(
        name="creators",
        description="Roster overview: totals, busiest creators, and who needs attention.",
        usage="/creators",
        detail="Also flags creators with no tracked activity or no linked Discord account.",
    ),
    CommandInfo(
        name="health",
        description="Check the bot's permissions, role setup, and database connection.",
        usage="/health",
        detail="Run this first if a command misbehaves — it names the exact fix.",
    ),
    CommandInfo(
        name="help",
        description="What this bot can do and how to use it.",
        usage="/help",
    ),
)

CATALOG_BY_NAME = {c.name: c for c in COMMAND_CATALOG}


def command_description(name: str) -> str:
    """Description registered with Discord for a command (shown in the picker)."""
    return CATALOG_BY_NAME[name].description


def build_offboard_message_embed(
    message: str, *, coach_name: Optional[str] = None
) -> EmbedSpec:
    """The copy-paste offboarding note, wrapped in a code block.

    A fenced block is the whole point: Discord renders one with a copy button
    and, more importantly, paste-safe — the note is written to be sent verbatim
    by a human in the creator's channel, not rendered as embed markdown.
    The text is NOT markdown-escaped for the same reason: its ``**this**`` is
    intentional emphasis in the message the operator will send.
    """
    footer = (
        None if coach_name
        else "couldn't tell which coach team this channel was under — fill in [coach]"
    )
    return build_embed(
        title="offboarding message",
        description=clip(f"```\n{message}\n```", MAX_DESCRIPTION),
        color=COLOR_WARN if footer else COLOR_BRAND,
        footer=footer,
    )


def build_help_embed() -> EmbedSpec:
    """Render ``/help`` from the catalog."""
    fields = [
        EmbedField(
            name=f"/{c.name}",
            value="\n".join(
                part
                for part in (
                    c.description,
                    f"`{c.usage}`" if c.usage else "",
                    c.detail,
                )
                if part
            ),
        )
        for c in COMMAND_CATALOG
    ]
    return build_embed(
        title="Creator CRM bot",
        description=(
            "Tracks every creator channel and handles onboarding.\n"
            "Type `/` to see these commands at any time."
        ),
        fields=fields,
        footer="Replies are only visible to you.",
    )


# --- health -----------------------------------------------------------------

STATUS_ICON = {"ok": "✅", "warn": "⚠️", "fail": "❌"}


@dataclass(frozen=True)
class HealthCheck:
    name: str
    status: str  # ok | warn | fail
    detail: str


@dataclass(frozen=True)
class HealthReport:
    checks: tuple[HealthCheck, ...] = field(default_factory=tuple)

    @property
    def overall(self) -> str:
        statuses = {c.status for c in self.checks}
        if "fail" in statuses:
            return "fail"
        if "warn" in statuses:
            return "warn"
        return "ok"


def evaluate_health(
    *,
    is_admin: bool,
    can_manage_channels: bool,
    can_manage_roles: bool,
    can_send_messages: bool,
    creator_role_name: str,
    creator_role_position: Optional[int],
    bot_top_role_name: str,
    bot_top_role_position: int,
    missing_welcome_channels: Sequence[str] = (),
    tracked_channel_count: Optional[int] = None,
    db_error: Optional[str] = None,
    untracked_channels: Sequence[str] = (),
    unlinked_channels: Sequence[str] = (),
    unpingable_creators: Sequence[str] = (),
) -> HealthReport:
    """Turn gathered guild/DB facts into pass/warn/fail checks.

    Pure so the rules — especially the role-hierarchy one, which is the single
    most likely misconfiguration — can be tested exhaustively.
    """
    checks: list[HealthCheck] = []

    # Administrator implies the rest, so report it as the reason they pass.
    if is_admin:
        checks.append(HealthCheck("Permissions", "ok", "Administrator (covers everything needed)"))
    else:
        missing = [
            label
            for label, granted in (
                ("Manage Channels", can_manage_channels),
                ("Manage Roles", can_manage_roles),
                ("Send Messages", can_send_messages),
            )
            if not granted
        ]
        if missing:
            checks.append(
                HealthCheck("Permissions", "fail", "missing: " + ", ".join(missing))
            )
        else:
            checks.append(HealthCheck("Permissions", "ok", "Manage Channels, Manage Roles, Send Messages"))

    if creator_role_position is None:
        checks.append(
            HealthCheck(
                "Creator role",
                "fail",
                f"no role named **{creator_role_name}** in this server — "
                "set `CREATOR_ROLE_NAME` to the right one",
            )
        )
    else:
        checks.append(HealthCheck("Creator role", "ok", f"**{creator_role_name}** found"))
        # Discord requires the actor's top role to be strictly above the target
        # role. Administrator does NOT bypass this, so it is checked separately.
        if bot_top_role_position > creator_role_position:
            checks.append(
                HealthCheck(
                    "Role hierarchy",
                    "ok",
                    f"**{bot_top_role_name}** is above **{creator_role_name}**",
                )
            )
        else:
            checks.append(
                HealthCheck(
                    "Role hierarchy",
                    "fail",
                    f"**{bot_top_role_name}** sits below **{creator_role_name}**, so I can't "
                    f"assign it. Server Settings → Roles → drag **{bot_top_role_name}** above "
                    f"**{creator_role_name}**. (Administrator does not override this.)",
                )
            )

    if missing_welcome_channels:
        checks.append(
            HealthCheck(
                "Welcome channels",
                "warn",
                "couldn't resolve: " + ", ".join(missing_welcome_channels),
            )
        )
    else:
        checks.append(HealthCheck("Welcome channels", "ok", "all three resolve"))

    if db_error:
        checks.append(HealthCheck("Database", "fail", clip(db_error, 300)))
    elif tracked_channel_count is not None:
        status = "ok" if tracked_channel_count else "warn"
        detail = (
            f"connected, tracking {tracked_channel_count} channels"
            if tracked_channel_count
            else "connected, but no channels are tracked yet"
        )
        checks.append(HealthCheck("Database", status, detail))

    # Tracking drift — the process guardrail: every channel under a coach
    # category must be classified, linked to a creator, and pingable, or
    # sends/stats quietly skip people.
    if untracked_channels:
        checks.append(
            HealthCheck(
                "Channel coverage",
                "fail",
                "invisible to the app (name doesn't classify): "
                + ", ".join(f"`{escape_markdown(n)}`" for n in untracked_channels)
                + " — rename to `<track-emoji><name>` (✝️/🤍/🌱, e.g. `✝️jas`)",
            )
        )
    else:
        checks.append(HealthCheck("Channel coverage", "ok", "every coach-team channel classifies"))

    if unlinked_channels:
        checks.append(
            HealthCheck(
                "Creator links",
                "warn",
                "no creator linked (sends can't target them): "
                + ", ".join(f"`{escape_markdown(n)}`" for n in unlinked_channels)
                + " — run /link in each",
            )
        )
    else:
        checks.append(HealthCheck("Creator links", "ok", "every tracked channel is linked"))

    if unpingable_creators:
        checks.append(
            HealthCheck(
                "Ping readiness",
                "warn",
                "linked but no Discord id (sends won't ping): "
                + ", ".join(escape_markdown(n) for n in unpingable_creators),
            )
        )
    else:
        checks.append(HealthCheck("Ping readiness", "ok", "every linked creator is pingable"))

    return HealthReport(checks=tuple(checks))


def render_health_embed(report: HealthReport) -> EmbedSpec:
    color = {"ok": COLOR_OK, "warn": COLOR_WARN, "fail": COLOR_FAIL}[report.overall]
    headline = {
        "ok": "Everything looks good.",
        "warn": "Working, with some things worth fixing.",
        "fail": "Something needs fixing before onboarding will fully work.",
    }[report.overall]
    fields = [
        EmbedField(name=f"{STATUS_ICON[c.status]} {c.name}", value=c.detail)
        for c in report.checks
    ]
    return build_embed(title="Bot health", description=headline, fields=fields, color=color)


# --- creator reporting ------------------------------------------------------


def _int(value) -> int:
    try:
        return int(value or 0)
    except (TypeError, ValueError):
        return 0


def find_creator_row(rows: Iterable[dict], query: str) -> Optional[dict]:
    """Find one creator by name, preferring exact then prefix then substring."""
    needle = (query or "").strip().lower()
    if not needle:
        return None
    rows = list(rows)

    def name_of(r: dict) -> str:
        return str(r.get("creator_name") or "").lower()

    for predicate in (
        lambda n: n == needle,
        lambda n: n.startswith(needle),
        lambda n: needle in n,
    ):
        matches = [r for r in rows if predicate(name_of(r))]
        if matches:
            return matches[0]
    return None


def creator_name_choices(rows: Iterable[dict], query: str = "", limit: int = 25) -> list[str]:
    """Creator names for the ``/creator`` autocomplete."""
    needle = (query or "").strip().lower()
    names = [str(r.get("creator_name") or "") for r in rows]
    names = [n for n in names if n]
    if needle:
        names = [n for n in names if needle in n.lower()]
    seen: list[str] = []
    for n in names:
        if n not in seen:
            seen.append(n)
    return seen[:limit]


def build_creator_embed(row: dict) -> EmbedSpec:
    """Render one creator's CRM snapshot."""
    name = escape_markdown(str(row.get("creator_name") or "unknown"))
    niche = escape_markdown(str(row.get("niche") or "—"))
    status = escape_markdown(str(row.get("status") or "—"))
    channel_id = row.get("channel_id")
    total = _int(row.get("total_messages"))

    breakdown = (
        f"creator **{_int(row.get('creator_messages'))}** · "
        f"coach **{_int(row.get('coach_messages'))}** · "
        f"launchpoint **{_int(row.get('launchpoint_messages'))}** · "
        f"unknown **{_int(row.get('unknown_messages'))}**"
    )
    last = row.get("last_activity_display") or "no activity yet"
    linked = "linked" if row.get("discord_user_id") else "not linked to a Discord account"

    fields = [
        EmbedField(name="Niche", value=niche, inline=True),
        EmbedField(name="Status", value=status, inline=True),
        EmbedField(name="Channel", value=f"<#{channel_id}>" if channel_id else "—", inline=True),
        EmbedField(name="Messages", value=f"**{total}** total\n{breakdown}"),
        EmbedField(name="Drafts shared", value=str(_int(row.get("drafts"))), inline=True),
        EmbedField(name="Last activity", value=escape_markdown(str(last)), inline=True),
        EmbedField(name="Discord account", value=linked, inline=True),
    ]
    return build_embed(title=f"Creator · {name}", fields=fields)


def build_creators_embed(rows: Sequence[dict], stats: Optional[dict] = None, top: int = 5) -> EmbedSpec:
    """Render the roster overview: totals, busiest creators, and who needs attention."""
    rows = list(rows)
    if not rows:
        return build_embed(
            title="Creators",
            description="No creators are tracked yet. Run `/onboard` or the discovery script.",
            color=COLOR_WARN,
        )

    fields: list[EmbedField] = []
    if stats:
        creators = stats.get("creators") or {}
        messages = stats.get("messages") or {}
        fields.append(
            EmbedField(
                name="Roster",
                value=(
                    f"**{_int(creators.get('total'))}** creators · "
                    f"**{_int(creators.get('active'))}** active · "
                    f"**{_int(creators.get('paused'))}** paused"
                ),
                inline=True,
            )
        )
        fields.append(
            EmbedField(
                name="Messages",
                value=(
                    f"**{_int(messages.get('total'))}** total · "
                    f"**{_int(messages.get('drafts'))}** drafts"
                ),
                inline=True,
            )
        )

    busiest = sorted(rows, key=lambda r: _int(r.get("total_messages")), reverse=True)[:top]
    fields.append(
        EmbedField(
            name=f"Busiest ({len(busiest)})",
            value="\n".join(
                f"**{escape_markdown(str(r.get('creator_name') or '?'))}** — "
                f"{_int(r.get('total_messages'))} msgs · {r.get('last_activity_display') or 'no activity'}"
                for r in busiest
            ),
        )
    )

    quiet = [r for r in rows if not _int(r.get("total_messages"))]
    unlinked = [r for r in rows if not r.get("discord_user_id")]
    attention = []
    if quiet:
        attention.append(f"**{len(quiet)}** with no tracked messages")
    if unlinked:
        attention.append(f"**{len(unlinked)}** with no linked Discord account")
    if attention:
        fields.append(EmbedField(name="Needs attention", value="\n".join(attention)))

    return build_embed(
        title="Creators",
        description=f"{len(rows)} tracked creator channels.",
        fields=fields,
        footer="Full dashboard: /creators page in the web app",
    )


def _compact(n) -> str:
    """Mirror of the web app's formatCompact, so a number reads the same in the
    embed as it does on the card beneath it."""
    try:
        n = float(n)
    except (TypeError, ValueError):
        return "—"
    n = round(n)
    if n < 10_000:
        return f"{n:,}"
    for limit, suffix in ((1_000_000_000, "B"), (1_000_000, "M"), (1_000, "K")):
        if abs(n) >= limit:
            value = n / limit
            return f"{value:.1f}".rstrip("0").rstrip(".") + suffix
    return f"{n:,}"


def _usd(n) -> str:
    try:
        return f"${float(n):,.2f}"
    except (TypeError, ValueError):
        return "—"


def build_stats_embed(data: dict) -> EmbedSpec:
    """One creator's stats, for `/stats`.

    The card image carries the trend and the top posts; this text carries the
    handful of numbers someone might want to quote in a reply without opening
    an image. Deliberately not a second copy of the whole card — two renderings
    of the same data invite them to disagree.
    """
    cur = data.get("current") or {}
    totals = data.get("totals") or {}
    money = data.get("money") or {}
    quota = data.get("quota") or 7

    posts = cur.get("posts") or 0
    subtitle_bits = [f"@{data.get('handle')}"]
    if data.get("coach"):
        subtitle_bits.append(str(data["coach"]))
    if data.get("niche"):
        subtitle_bits.append(str(data["niche"]))
    if data.get("archived"):
        subtitle_bits.append("**archived**")

    cpm = money.get("cpm")
    projected = money.get("projectedCpm")
    if cpm is not None:
        cpm_text = _usd(cpm)
        delta = money.get("deltaUsd")
        if delta is not None and abs(delta) >= 0.005 and not money.get("lowSample"):
            cpm_text += f" {'▼' if delta < 0 else '▲'}{_usd(abs(delta))[1:]}"
        if money.get("lowSample"):
            cpm_text += " *(low sample)*"
    elif projected is not None:
        cpm_text = f"≈{_usd(projected)} *(projected)*"
    else:
        cpm_text = "—"

    lines = [
        " · ".join(subtitle_bits),
        "",
        f"**{posts}**/{quota} posts this week · "
        f"**{_compact(cur.get('avgViews')) if posts else '—'}** avg views"
        + (f" · 🚀 {cur['spikes']}" if cur.get("spikes") else ""),
        f"**{totals.get('posts', 0)}** posts over 8 weeks · "
        f"**{_compact((totals.get('views') or 0) / totals['posts']) if totals.get('posts') else '—'}** avg views",
        f"30d CPM **{cpm_text}** · earned **{_usd(money.get('earnedUsd'))}** · "
        f"{money.get('paidPosts', 0)} paid, {money.get('unpaidPosts', 0)} awaiting",
    ]
    if totals.get("trialUploads"):
        lines.append(
            f"-# {_compact(totals['trialUploads'])} trial-reel uploads excluded — "
            "posts and views count published reels only"
        )

    fields: list[EmbedField] = []
    top = data.get("topPosts") or []
    if top:
        fields.append(
            EmbedField(
                name="🏆 Best posts",
                value="\n".join(
                    f"{i + 1}. [{_compact(p.get('views'))} views]({p.get('url')}) · {p.get('week')}"
                    for i, p in enumerate(top[:5])
                ),
            )
        )
    if data.get("discordChannelId"):
        fields.append(EmbedField(name="Channel", value=f"<#{data['discordChannelId']}>", inline=True))

    return build_embed(
        title=f"📈 {data.get('name') or data.get('handle')}",
        description="\n".join(lines),
        fields=fields,
        color=COLOR_BRAND,
        footer=f"week of {data.get('week')}" if data.get("week") else None,
    )
