"""Who may run the bot's slash commands.

Kept out of ``commands.py`` for the same reason ``onboarding.py`` is: that
module imports discord.py, and the rule about who gets to read a creator's
earnings deserves a unit test that does not need a gateway connection.
"""
from __future__ import annotations

from typing import Sequence


# Commands any member of the server may run. Everything else is staff-only.
#
# `/my-stats` is deliberately open: it is FOR creators, who by definition do
# not hold Coach/dev/Folk Team, and it can only ever return the caller's own
# row — the web route keys on the Discord id from the signed interaction and
# takes no handle at all. Gating it would have made it unusable by exactly the
# people it exists for.
OPEN_COMMANDS: frozenset[str] = frozenset({"my-stats"})


def command_is_open(command_name: str | None) -> bool:
    return (command_name or "") in OPEN_COMMANDS


def may_run_commands(member, staff_role_ids) -> bool:
    """Whether this member may run the bot's slash commands.

    Gated on the three staff roles (Coach / dev / Folk Team) rather than on a
    Discord permission bit. The bit was doing the wrong job: commands used
    `manage_channels`, which coaches happened to satisfy only because they hold
    Administrator — so the real rule was invisible and anyone granted channel
    management inherited the bot by accident.

    Administrator still passes, deliberately. A role-id allowlist that the
    server owner can fall outside of is a lockout waiting to happen, and the
    owner can grant themselves any role anyway — the escape hatch costs nothing
    and prevents an unrecoverable state.

    A non-guild context (a DM) has no roles and is refused; every command is
    already `guild_only`, so this is defence in depth rather than a new rule.
    """
    perms = getattr(member, "guild_permissions", None)
    if getattr(perms, "administrator", False):
        return True
    allowed = {int(r) for r in (staff_role_ids or ())}
    if not allowed:
        return False
    return any(int(getattr(r, "id", 0)) in allowed for r in getattr(member, "roles", []) or [])


def staff_only_message(role_names: Sequence[str] = ("Coach", "dev", "Folk Team")) -> str:
    """What a refused user sees. Names the roles so they know what to ask for
    rather than being told a flat no."""
    joined = ", ".join(f"**{n}**" for n in role_names)
    return f"⛔ this bot is for {joined} only. ask a lead if you need access."
