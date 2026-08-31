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

# Ceiling on the message rows /creator and /creators summarise. Matches the
# web app's own .limit(10000) on the /discord page.
MESSAGE_STATS_CAP = 10_000

_ROLE_KEYS = frozenset({"creator", "coach", "launchpoint", "unknown"})
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
    niche: Optional[str] = None,
) -> Optional[str]:
    """Track a freshly onboarded channel, mirroring what discover would derive.

    ``niche`` is the /onboard track choice — under coach-team categories the
    category no longer implies a niche, so the explicit track wins and the
    old category derivation is only a legacy fallback.

    If the member's discord id already belongs to a roster creator, the channel
    is linked immediately and that creator's handle is returned; otherwise the
    channel stays unlinked (returns None) until /link names their Instagram.
    """
    row = {
        "channel_id": channel_id,
        "guild_id": guild_id,
        "channel_name": channel_name,
        "category": category_name,
        "niche": niche or pull.niche_from_category(category_name),
        "is_tracked": True,
    }
    linked_handle: Optional[str] = None
    roster = pull.sb(
        "GET", f"research_creators?select=id,handle&discord_user_id=eq.{discord_user_id}&limit=1"
    )
    if roster:
        row["research_creator_id"] = roster[0]["id"]
        linked_handle = roster[0]["handle"]
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
    return linked_handle


def tracking_drift() -> dict:
    """DB-side tracking gaps for /health: active tracked channels that are
    unlinked, and linked creators sends can't ping. Paused channels are
    parked on purpose and excluded."""
    channels = pull.sb_all(
        "research_discord_channels"
        "?select=channel_id,channel_name,category,research_creator_id&is_tracked=eq.true"
    )
    creators = {
        c["id"]: c
        for c in pull.sb_all("research_creators?select=id,handle,discord_user_id")
    }
    unlinked: list[str] = []
    unpingable: list[str] = []
    for ch in channels:
        if not ch.get("category") or ch["category"] == PAUSED_CATEGORY:
            continue
        creator_id = ch.get("research_creator_id")
        if not creator_id:
            unlinked.append(ch["channel_name"])
            continue
        creator = creators.get(creator_id)
        if creator and not creator.get("discord_user_id"):
            unpingable.append(f"{ch['channel_name']} (@{creator['handle']})")
    return {
        "unlinked": sorted(unlinked),
        "unpingable": sorted(unpingable),
        "tracked_channel_ids": {int(ch["channel_id"]) for ch in channels},
    }


def channel_creator_handle(channel_id: int) -> Optional[str]:
    """Handle of the roster creator a channel is linked to, or None."""
    rows = pull.sb(
        "GET",
        "research_discord_channels"
        f"?channel_id=eq.{channel_id}&select=research_creators(handle)&limit=1",
    )
    creator = (rows or [{}])[0].get("research_creators") or {}
    return creator.get("handle") or None


def offboard_creator_channel(channel_id: int) -> bool:
    """Mark a channel paused the same way discover reads it from the category.

    The niche stays: it is carried by the channel's track emoji now, and
    discover would re-derive it from the name on the next run anyway.
    """
    updated = pull.sb(
        "PATCH",
        f"research_discord_channels?channel_id=eq.{channel_id}",
        {"category": PAUSED_CATEGORY},
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
            "scrape_queued_at": datetime.now(timezone.utc).isoformat(),
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
    # One derivation for every convention (legacy coaching-* and the live
    # emoji-track names) — see derive_creator_name in the pull worker.
    return pull.derive_creator_name(channel_name or "")


def creator_names() -> list[dict]:
    """Just enough to drive a name autocomplete: the channel-derived name and
    the linked Instagram handle.

    Deliberately NOT `creator_overview`: that one also pages thousands of
    messages to compute per-channel activity counters, which an autocomplete
    does not use and cannot afford. Discord kills an autocomplete interaction
    after 3 seconds, and the roster read was blowing straight through it —
    every first keystroke came back empty with a 10062.
    """
    channels = pull.sb_all(
        "research_discord_channels?select=channel_name,research_creators(handle)&is_tracked=eq.true"
    )
    rows = []
    for c in channels:
        linked = c.get("research_creators") or {}
        rows.append({
            "creator_name": _creator_name(c.get("channel_name")),
            "instagram": linked.get("handle"),
        })
    return rows


def creator_overview() -> list[dict]:
    """One row per tracked channel, shaped for command_ui's embeds."""
    channels = pull.sb_all(
        "research_discord_channels?select=channel_id,channel_name,niche,category,"
        "research_creator_id,research_creators(handle,discord_user_id)&is_tracked=eq.true"
    )
    # Bounded on purpose: this runs on every /creator, /creators, /health and
    # autocomplete cache miss, and the table grows 24/7. The counters are a
    # recent-activity summary, not an audit — an unbounded sb_all here would
    # page the entire message history into the bot's 512MB machine.
    messages = pull.sb_all(
        "research_discord_messages?select=channel_id,author_role,posted_at,attachments"
        "&order=posted_at.desc",
        cap=MESSAGE_STATS_CAP,
    )
    stats: dict[int, dict] = {}
    for m in messages:
        s = stats.setdefault(m["channel_id"], {
            "total": 0, "creator": 0, "coach": 0, "launchpoint": 0, "unknown": 0,
            "drafts": 0, "last": None,
        })
        s["total"] += 1
        # Only the four known roles get a tally. Writing author_role straight
        # in would share a namespace with total/drafts/last, so a future role
        # named "last" would corrupt the counts instead of being ignored.
        role = m["author_role"] if m["author_role"] in _ROLE_KEYS else "unknown"
        s[role] += 1
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
