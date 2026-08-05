"""CRM reads/writes for the bot, over PostgREST — no DSN, same service key.

Reuses worker/discord_pull_worker.py (importable because run_discord_bot.py
puts worker/ on sys.path) for the Supabase helpers, niche cleanup and role
attribution, so the bot and the pull loop can never disagree on semantics.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import discord_pull_worker as pull

PAUSED_CATEGORY = "Not Creating 🚫"
_CHANNEL_PREFIXES = ("coaching-", "coachking-", "influencer-")


def onboard_creator_channel(
    *,
    guild_id: int,
    channel_id: int,
    channel_name: str,
    category_name: str,
    discord_user_id: int,
    username: Optional[str] = None,
    display_name: Optional[str] = None,
) -> None:
    """Track a freshly onboarded channel, mirroring what discover would derive.

    If the member's discord id already belongs to a roster creator, the channel
    is linked immediately; otherwise it stays unlinked until /discord's link
    field (or a future /link command) names their Instagram.
    """
    row = {
        "channel_id": channel_id,
        "guild_id": guild_id,
        "channel_name": channel_name,
        "category": category_name,
        "niche": pull.niche_from_category(category_name),
        "is_tracked": True,
    }
    roster = pull.sb(
        "GET", f"research_creators?select=id&discord_user_id=eq.{discord_user_id}&limit=1"
    )
    if roster:
        row["research_creator_id"] = roster[0]["id"]
    pull.sb(
        "POST",
        "research_discord_channels?on_conflict=channel_id",
        [row],
        prefer="resolution=merge-duplicates,return=minimal",
    )
    pull.sb(
        "POST",
        "research_discord_users?on_conflict=discord_user_id",
        [{
            "discord_user_id": discord_user_id,
            "username": username,
            "global_name": display_name,
            "display_name": display_name or username,
            "is_bot": False,
        }],
        prefer="resolution=merge-duplicates,return=minimal",
    )


def offboard_creator_channel(channel_id: int) -> bool:
    """Mark a channel paused the same way discover reads it from the category."""
    updated = pull.sb(
        "PATCH",
        f"research_discord_channels?channel_id=eq.{channel_id}",
        {"category": PAUSED_CATEGORY, "niche": None},
        prefer="return=representation",
    )
    return bool(updated)


def parse_instagram(raw: str) -> Optional[tuple[str, str]]:
    """'@handle', 'handle' or a profile URL -> (platform, handle).

    Mirrors src/lib/creator-input.ts so /link and the web form accept the
    same inputs.
    """
    import re
    from urllib.parse import urlparse

    text = (raw or "").strip()
    if not text:
        return None
    if "instagram.com" in text or "tiktok.com" in text:
        u = urlparse(text if text.startswith("http") else f"https://{text}")
        if "instagram.com" in u.netloc:
            m = re.match(r"^/([A-Za-z0-9._]+)", u.path)
            if m and m.group(1) not in {"p", "reel", "reels", "tv", "explore", "stories"}:
                return ("instagram", m.group(1).lower())
            return None
        if "tiktok.com" in u.netloc:
            m = re.match(r"^/@([A-Za-z0-9._]+)", u.path)
            return ("tiktok", m.group(1).lower()) if m else None
    handle = text.lstrip("@")
    if not re.fullmatch(r"[A-Za-z0-9._]+", handle):
        return None
    return ("instagram", handle.lower())


def link_creator(
    *,
    channel_id: int,
    member_id: int,
    member_username: Optional[str],
    member_display: Optional[str],
    platform: str,
    handle: str,
) -> dict:
    """Link an Instagram creator to a Discord profile + coaching channel.

    Creates the roster row when the handle is new (pending + scrape-queued,
    same shape the web form produces), stamps discord_user_id/discord_username
    on it, and points the channel at it. Returns {"error": ...} instead of
    writing when the link would steal an identity that belongs to someone else.
    """
    from datetime import datetime as _dt

    channel_rows = pull.sb(
        "GET",
        f"research_discord_channels?select=channel_id,channel_name,niche,research_creator_id"
        f"&channel_id=eq.{channel_id}",
    )
    if not channel_rows:
        return {"error": "this channel isn't tracked in the CRM yet"}
    channel = channel_rows[0]

    existing = pull.sb(
        "GET",
        f"research_creators?select=id,kind&platform=eq.{platform}&handle=eq.{handle}",
    )
    existing_id = existing[0]["id"] if existing else None

    # Identity guards BEFORE any write: a discord account belongs to at most
    # one creator, and a channel to at most one creator — refuse to steal
    # either, and leave nothing behind on refusal.
    holder_query = f"research_creators?select=handle&discord_user_id=eq.{member_id}"
    if existing_id:
        holder_query += f"&id=neq.{existing_id}"
    holder = pull.sb("GET", holder_query)
    if holder:
        return {"error": f"that Discord account is already linked to @{holder[0]['handle']}"}
    if channel.get("research_creator_id") and channel["research_creator_id"] != existing_id:
        other = pull.sb(
            "GET", f"research_creators?select=handle&id=eq.{channel['research_creator_id']}"
        )
        owner = f"@{other[0]['handle']}" if other else "another creator"
        return {"error": f"<#{channel_id}> is already linked to {owner} — unlink it on /discord first"}

    if existing_id:
        creator_id = existing_id
        created = False
        if existing[0]["kind"] != "roster":
            pull.sb("PATCH", f"research_creators?id=eq.{creator_id}", {"kind": "roster"},
                    prefer="return=minimal")
    else:
        inserted = pull.sb("POST", "research_creators", [{
            "platform": platform,
            "handle": handle,
            "kind": "roster",
            "status": "pending",
            "scrape_queued_at": _dt.utcnow().isoformat() + "Z",
        }])
        creator_id = inserted[0]["id"]
        created = True

    pull.sb("PATCH", f"research_creators?id=eq.{creator_id}",
            {"discord_user_id": member_id, "discord_username": member_username},
            prefer="return=minimal")
    pull.sb("PATCH", f"research_discord_channels?channel_id=eq.{channel_id}",
            {"research_creator_id": creator_id}, prefer="return=minimal")

    # Same niche forward-fill as the web form: channel category niche lands on
    # the Folk membership when it's still empty.
    folk = pull.sb("GET", f"research_apps?select=id&name=eq.{pull.FOLK_APP_NAME}")
    if folk:
        app_id = folk[0]["id"]
        pull.sb(
            "POST",
            "research_app_creators?on_conflict=app_id,research_creator_id",
            [{"app_id": app_id, "research_creator_id": creator_id, "niche": channel.get("niche")}],
            prefer="resolution=ignore-duplicates,return=minimal",
        )
        if channel.get("niche"):
            pull.sb(
                "PATCH",
                f"research_app_creators?app_id=eq.{app_id}&research_creator_id=eq.{creator_id}"
                "&niche=is.null",
                {"niche": channel["niche"]},
                prefer="return=minimal",
            )

    return {
        "handle": handle,
        "platform": platform,
        "creator_created": created,
        "channel_id": channel_id,
        "channel_name": channel.get("channel_name"),
        "niche": channel.get("niche"),
    }


# --- reporting (for /creator and /creators) ---------------------------------

def _relative(iso: Optional[str]) -> str:
    if not iso:
        return "no activity yet"
    try:
        then = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    except ValueError:
        return "—"
    if then.tzinfo is None:
        then = then.replace(tzinfo=timezone.utc)
    mins = int((datetime.now(timezone.utc) - then).total_seconds() // 60)
    if mins < 1:
        return "just now"
    if mins < 60:
        return f"{mins}m ago"
    if mins < 1440:
        return f"{mins // 60}h ago"
    return f"{mins // 1440}d ago"


def _creator_name(channel_name: Optional[str]) -> str:
    name = channel_name or ""
    for prefix in _CHANNEL_PREFIXES:
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def creator_overview() -> list[dict]:
    """One row per tracked channel, shaped for command_ui's embeds."""
    channels = pull.sb_all(
        "research_discord_channels?select=channel_id,channel_name,niche,category,"
        "research_creator_id,research_creators(handle,discord_user_id)&is_tracked=eq.true"
    )
    messages = pull.sb_all(
        "research_discord_messages?select=channel_id,author_role,posted_at,attachments"
        "&order=posted_at.desc"
    )
    stats: dict[int, dict] = {}
    for m in messages:
        s = stats.setdefault(m["channel_id"], {
            "total": 0, "creator": 0, "coach": 0, "launchpoint": 0, "unknown": 0,
            "drafts": 0, "last": None,
        })
        s["total"] += 1
        s[m["author_role"]] = s.get(m["author_role"], 0) + 1
        s["drafts"] += len(m.get("attachments") or [])
        if s["last"] is None:
            s["last"] = m["posted_at"]

    rows = []
    for c in channels:
        s = stats.get(c["channel_id"], {
            "total": 0, "creator": 0, "coach": 0, "launchpoint": 0, "unknown": 0,
            "drafts": 0, "last": None,
        })
        linked = c.get("research_creators") or {}
        rows.append({
            "creator_name": _creator_name(c.get("channel_name")),
            "niche": c.get("niche"),
            "status": "paused" if c.get("category") == PAUSED_CATEGORY else "active",
            "channel_id": c["channel_id"],
            "discord_user_id": linked.get("discord_user_id"),
            "instagram": linked.get("handle"),
            "total_messages": s["total"],
            "creator_messages": s["creator"],
            "coach_messages": s["coach"],
            "launchpoint_messages": s["launchpoint"],
            "unknown_messages": s["unknown"],
            "drafts": s["drafts"],
            "last_activity_display": _relative(s["last"]),
        })
    return rows


def summary_stats(rows: list[dict]) -> dict:
    """Roster/message totals for /creators, derived from the overview rows."""
    return {
        "creators": {
            "total": len(rows),
            "active": sum(1 for r in rows if r["status"] == "active"),
            "paused": sum(1 for r in rows if r["status"] == "paused"),
        },
        "messages": {
            "total": sum(r["total_messages"] for r in rows),
            "drafts": sum(r["drafts"] for r in rows),
        },
    }
