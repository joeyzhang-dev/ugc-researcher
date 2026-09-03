#!/usr/bin/env python3
"""The niche track vocabulary, read from research_niches.

This used to be TRACK_EMOJI_NICHES, a dict in discord_pull_worker.py, which
made adding a niche a code edit plus a gateway reconnect. It lives here rather
than in the pull worker because three consumers share it — the pull worker's
classifier, the bot's /onboard, and the web app — and until now the bot
imported the *pull worker* to read its own configuration.

The one rule that matters: **the vocabulary is never empty**. An unknown emoji
makes classify_creator_channels skip a channel, and cmd_discover only ever
upserts, so an empty list does not raise or delete anything — it silently
stops new channels being discovered. So a read failure degrades to the last
good list, and a cold-start failure degrades to FALLBACK_NICHES.
"""
from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable, Optional, Sequence

CACHE_TTL_SECONDS = 60

# Last-resort vocabulary, used only when the very first read fails. Keeping it
# in sync with the table is not required for correctness — it only has to keep
# a cold-started worker classifying something sane until Supabase answers.
FALLBACK_NICHES: tuple[tuple[str, str], ...] = (
    ("Christian", "✝️"),
    ("Female General Self-Improvement", "🤍"),
    ("General Motivation / Hustle", "🌱"),
)

# Variation selector and zero-width joiner, written as escapes because they
# are invisible in a source file. Mirrors niche_emoji_base() in the migration,
# so Python and Postgres agree on when two emojis are one track.
_DECORATIONS = ("\ufe0f", "\u200d")


@dataclass(frozen=True)
class Niche:
    name: str
    emoji: Optional[str]
    discord_role_id: Optional[int]
    is_active: bool


def strip_emoji_base(emoji: Optional[str]) -> str:
    """``✝️`` and ``✝`` are the same track."""
    if not emoji:
        return ""
    stripped = emoji
    for ch in _DECORATIONS:
        stripped = stripped.replace(ch, "")
    return stripped.strip()


def _default_fetch() -> list[dict]:
    # Local import: discord_pull_worker imports this module, so a top-level
    # import here would be circular.
    from discord_pull_worker import sb_all

    return sb_all(
        "research_niches?select=name,emoji,discord_role_id,is_active&order=name"
    )


_fetch: Callable[[], Sequence[dict]] = _default_fetch
_clock: Callable[[], float] = time.monotonic
_cache: Optional[tuple[Niche, ...]] = None
_last_attempt: float = 0.0


def configure(fetch=None, clock=None) -> None:
    """Test seam. Passing None restores the real reader / clock."""
    global _fetch, _clock
    _fetch = fetch or _default_fetch
    _clock = clock or time.monotonic


def reset_cache() -> None:
    global _cache, _last_attempt
    _cache = None
    _last_attempt = 0.0


def _parse(rows: Sequence[dict]) -> tuple[Niche, ...]:
    out = []
    for r in rows or ():
        name = (r.get("name") or "").strip()
        if not name:
            continue
        role = r.get("discord_role_id")
        out.append(
            Niche(
                name=name,
                emoji=(r.get("emoji") or None),
                discord_role_id=int(role) if role not in (None, "") else None,
                is_active=bool(r.get("is_active", True)),
            )
        )
    return tuple(out)


def load_niches(force: bool = False) -> tuple[Niche, ...]:
    """Every niche, archived included. Cached for CACHE_TTL_SECONDS.

    The TTL throttles failures as well as successes: without that, an outage
    would make /onboard's autocomplete hit Supabase on every keystroke.
    """
    global _cache, _last_attempt
    now = _clock()
    if not force and _last_attempt and (now - _last_attempt) < CACHE_TTL_SECONDS:
        return _cache if _cache is not None else _fallback()

    _last_attempt = now
    try:
        parsed = _parse(_fetch())
    except Exception:  # noqa: BLE001 - a stale vocabulary beats an empty one
        parsed = ()
    if parsed:
        _cache = parsed
    return _cache if _cache is not None else _fallback()


def _fallback() -> tuple[Niche, ...]:
    return tuple(
        Niche(name=name, emoji=emoji, discord_role_id=None, is_active=True)
        for name, emoji in FALLBACK_NICHES
    )


def active_niches() -> tuple[Niche, ...]:
    """What /onboard offers. Archived niches are gone from here but still
    classify — see track_bases."""
    return tuple(n for n in load_niches() if n.is_active)


def track_bases() -> tuple[tuple[str, str], ...]:
    """``(stripped emoji, niche name)``, longest base first.

    Built from EVERY niche, archived included: archiving must not make the
    existing channels on that emoji unclassifiable. Longest first so a
    multi-codepoint emoji can never be shadowed by a shorter one.
    """
    pairs = [
        (strip_emoji_base(n.emoji), n.name)
        for n in load_niches()
        if strip_emoji_base(n.emoji)
    ]
    return tuple(sorted(pairs, key=lambda pair: len(pair[0]), reverse=True))


def emoji_for(name: Optional[str]) -> Optional[str]:
    for n in load_niches():
        if n.name == name:
            return n.emoji
    return None


def role_id_for(name: Optional[str]) -> Optional[int]:
    if not name:
        return None
    for n in load_niches():
        if n.name == name:
            return n.discord_role_id
    return None
