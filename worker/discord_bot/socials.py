"""/socials — a roster creator's social links, tracked internally.

Pure helpers (normalization, view formatting) live up top so tests run
stdlib-only; the PostgREST accessors at the bottom are blocking (urllib via
pull.sb) and get wrapped in asyncio.to_thread by the command glue.

The platform set is deliberately just what the tracker scrapes today.
"""
from __future__ import annotations

import re

import discord_pull_worker as pull

PLATFORMS: tuple[str, ...] = ("instagram", "tiktok")
LABELS = {"instagram": "Instagram", "tiktok": "TikTok"}
_PROFILE_URL = {
    "instagram": "https://www.instagram.com/{handle}/",
    "tiktok": "https://www.tiktok.com/@{handle}",
}
_HANDLE_RE = re.compile(r"^[A-Za-z0-9._-]{1,80}$")


def normalize_social(platform: str, raw: str) -> str | None:
    """A full profile URL, from either a pasted link or a bare @handle.
    None means the input is unusable and the caller should say so."""
    value = (raw or "").strip()
    if value.startswith(("http://", "https://")):
        return value
    handle = value.lstrip("@")
    if not _HANDLE_RE.match(handle):
        return None
    return _PROFILE_URL[platform].format(handle=handle)


def format_socials(display_name: str, links: dict[str, str], note: str | None = None) -> str:
    """The /socials view: every tracked platform, linked or marked missing."""
    lines = [f"**Socials for {display_name}**"]
    for platform in PLATFORMS:
        url = links.get(platform)
        lines.append(f"**{LABELS[platform]}** — {url if url else '❌ missing'}")
    if note:
        lines.append(f"-# {note}")
    return "\n".join(lines)


# --- blocking PostgREST accessors (wrap in asyncio.to_thread) ----------------


class SocialsNotMigrated(RuntimeError):
    """The research_creator_socials table doesn't exist yet."""


def _raise_if_unmigrated(exc: Exception) -> None:
    if "42P01" in str(exc) or "research_creator_socials" in str(exc):
        raise SocialsNotMigrated() from exc
    raise exc


def creator_by_discord_id(discord_user_id: int) -> dict | None:
    """The roster creator linked to this Discord account, if any."""
    rows = pull.sb(
        "GET",
        "research_creators?select=id,handle,platform,profile_url"
        f"&discord_user_id=eq.{discord_user_id}&limit=1",
    )
    return rows[0] if rows else None


def fetch_socials(creator: dict) -> tuple[dict[str, str], bool]:
    """(platform -> url, migrated?) for a creator. The roster's own Instagram
    identity fills in when no explicit row exists, so /socials is useful
    before anyone has added anything."""
    links: dict[str, str] = {}
    migrated = True
    try:
        for row in pull.sb(
            "GET",
            "research_creator_socials?select=platform,url"
            f"&research_creator_id=eq.{creator['id']}",
        ):
            links[row["platform"]] = row["url"]
    except SocialsNotMigrated:
        raise
    except Exception as exc:  # noqa: BLE001
        try:
            _raise_if_unmigrated(exc)
        except SocialsNotMigrated:
            migrated = False
    if "instagram" not in links and creator.get("platform") == "instagram" and creator.get("handle"):
        links["instagram"] = creator.get("profile_url") or _PROFILE_URL["instagram"].format(
            handle=creator["handle"]
        )
    return links, migrated


def set_social(creator_id: str, platform: str, url: str) -> None:
    try:
        pull.sb(
            "POST",
            "research_creator_socials?on_conflict=research_creator_id,platform",
            [{"research_creator_id": creator_id, "platform": platform, "url": url}],
            prefer="resolution=merge-duplicates,return=minimal",
        )
    except Exception as exc:  # noqa: BLE001
        _raise_if_unmigrated(exc)


def remove_social(creator_id: str, platform: str) -> bool:
    try:
        deleted = pull.sb(
            "DELETE",
            f"research_creator_socials?research_creator_id=eq.{creator_id}&platform=eq.{platform}",
        )
    except Exception as exc:  # noqa: BLE001
        _raise_if_unmigrated(exc)
        return False
    return bool(deleted)
