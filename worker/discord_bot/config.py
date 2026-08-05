"""Bot configuration — env-overridable, defaulting to the live Folk UGC ids.

Ported from discord-crm's config.py minus the parts this repo doesn't need:
no Postgres DSN (storage goes through PostgREST with the same service key the
other workers use) and no CREATOR_CHANNEL_IDS allowlist (tracked channels live
in research_discord_channels and are loaded at startup).
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from discord_bot.onboarding import WelcomeLinks

# Where offboarded creators' channels go. Matches the worker's discover step.
PAUSED_CATEGORIES: frozenset[str] = frozenset({"Not Creating 🚫"})

DEFAULT_CREATOR_ROLE_NAME = "Folk Creator"
DEFAULT_CREATOR_ROLE_ID = 1507900545359282308  # Folk Creator
DEFAULT_POST_TRACKING_CHANNEL_ID = 1508703255490859079  # 📊・set-up-post-tracking
DEFAULT_WARMUP_CHANNEL_ID = 1508636037214371861  # 🍳・how-to-warm-up
DEFAULT_FOLK_ACCESS_CHANNEL_ID = 1509268689021833306  # get-folk-access
DEFAULT_LAUNCHPOINT_BOT_ID = 1516872874512613446  # Launchpoint automation bot
DEFAULT_NICHE_ROLE_ID_PAIRS: tuple[tuple[int, int], ...] = (
    (1512236272742043698, 1531750777062822002),  # Creators: 🌸 Girly Finance -> Finance Girls Niche
    (1510142851676111039, 1531750975675695244),  # Creators: 💸 Finance General -> Finance General Niche
    (1523482165416034314, 1531750872995070133),  # Creators: ✝️ Christian -> Christian Niche
)

# Categories /onboard must never create a channel in. Server plumbing, plus
# "Not Creating 🚫", which is where creators are moved once they stop rather
# than somewhere a new creator is onboarded.
DEFAULT_EXCLUDED_CATEGORY_IDS: frozenset[int] = frozenset(
    {
        1512251478922756257,  # ⭐CALLS ⭐
        1508037824266506271,  # VERIFY
        1507900555245387908,  # 🏠Home
        1507900557174767646,  # 👤・Creators
        1510409951720243250,  # Resources
        1507900560680943657,  # ℹ️・Info
        1526813616878260234,  # Meta ads groups
        1507900562455400529,  # FOLK TEAM
        1511568384200806481,  # Not Creating 🚫
        1511897708359847937,  # Toxic / gym motivation: retired niche, no role
    }
)


def _default_niche_role_ids() -> dict[int, int]:
    return dict(DEFAULT_NICHE_ROLE_ID_PAIRS)


@dataclass(frozen=True)
class BotConfig:
    discord_bot_token: str
    discord_guild_id: int
    creator_role_name: str = DEFAULT_CREATOR_ROLE_NAME
    creator_role_id: int | None = DEFAULT_CREATOR_ROLE_ID
    launchpoint_bot_id: int | None = DEFAULT_LAUNCHPOINT_BOT_ID
    excluded_category_ids: frozenset[int] = DEFAULT_EXCLUDED_CATEGORY_IDS
    niche_role_ids: dict[int, int] = field(default_factory=_default_niche_role_ids)
    welcome_links: WelcomeLinks = field(
        default_factory=lambda: WelcomeLinks(
            post_tracking=DEFAULT_POST_TRACKING_CHANNEL_ID,
            warmup=DEFAULT_WARMUP_CHANNEL_ID,
            folk_access=DEFAULT_FOLK_ACCESS_CHANNEL_ID,
        )
    )


def _env_int(name: str, default: int | None) -> int | None:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return int(raw)


def _env_id_set(name: str, default: frozenset[int]) -> frozenset[int]:
    raw = os.environ.get(name, "").strip()
    if not raw:
        return default
    return frozenset(int(part.strip()) for part in raw.split(",") if part.strip())


def _env_id_pair_map(name: str, default: tuple[tuple[int, int], ...]) -> dict[int, int]:
    """Comma-separated category_id:role_id pairs; malformed input fails startup
    rather than silently applying a partial onboarding mapping."""
    raw = os.environ.get(name, "").strip()
    if not raw:
        return dict(default)
    parsed: dict[int, int] = {}
    for entry in (part.strip() for part in raw.split(",") if part.strip()):
        pieces = entry.split(":")
        if len(pieces) != 2 or not pieces[0].strip() or not pieces[1].strip():
            raise ValueError(f"{name} must be comma-separated category_id:role_id pairs")
        category_id, role_id = pieces
        parsed[int(category_id.strip())] = int(role_id.strip())
    return parsed


def load_bot_config() -> BotConfig:
    return BotConfig(
        discord_bot_token=os.environ["DISCORD_BOT_TOKEN"],
        discord_guild_id=int(os.environ["DISCORD_GUILD_ID"]),
        creator_role_name=os.environ.get("CREATOR_ROLE_NAME", "").strip() or DEFAULT_CREATOR_ROLE_NAME,
        creator_role_id=_env_int("CREATOR_ROLE_ID", DEFAULT_CREATOR_ROLE_ID),
        launchpoint_bot_id=_env_int("LAUNCHPOINT_BOT_ID", DEFAULT_LAUNCHPOINT_BOT_ID),
        excluded_category_ids=_env_id_set("ONBOARD_EXCLUDED_CATEGORY_IDS", DEFAULT_EXCLUDED_CATEGORY_IDS),
        niche_role_ids=_env_id_pair_map("ONBOARD_NICHE_ROLE_IDS", DEFAULT_NICHE_ROLE_ID_PAIRS),
        welcome_links=WelcomeLinks(
            post_tracking=_env_int("ONBOARD_POST_TRACKING_CHANNEL_ID", DEFAULT_POST_TRACKING_CHANNEL_ID),
            warmup=_env_int("ONBOARD_WARMUP_CHANNEL_ID", DEFAULT_WARMUP_CHANNEL_ID),
            folk_access=_env_int("ONBOARD_FOLK_ACCESS_CHANNEL_ID", DEFAULT_FOLK_ACCESS_CHANNEL_ID),
        ),
    )
