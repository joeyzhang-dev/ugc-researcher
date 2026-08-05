#!/usr/bin/env python3
"""
Local Discord ingestion worker (consolidated from the standalone discord-crm
project; same pipeline, pointed at this repo's shared Supabase).

Pulls the Folk UGC per-creator coaching channels over the Discord REST API and
lands them in research_discord_* — blank slate, no imported history. On the
first run of an empty channel Discord returns the newest ~100 messages, then
every later pull only fetches messages after the stored watermark
(MAX(message_id) per channel). Edits to already-stored messages are not
re-fetched (REST-only, no gateway — same trade-off as discord-crm's pull path).

Pipeline per message, identical to discord-crm:
  normalize (dedupe_key guild/channel/message/edit_version, attachments)
  -> attribute author_role (first match wins: launchpoint-listed webhook/bot ->
     launchpoint, any other webhook/bot -> unknown, channel's creator ->
     creator, coach list -> coach, else unknown)
  -> idempotent upsert on dedupe_key

Commands:
  python3 worker/discord_pull_worker.py discover        # guild channels -> research_discord_channels + roster links
  python3 worker/discord_pull_worker.py pull --once     # single pull across tracked channels
  python3 worker/discord_pull_worker.py enrich          # derive creator discord ids + coach/launchpoint roles, re-attribute
  python3 worker/discord_pull_worker.py enrich --dry-run
  python3 worker/discord_pull_worker.py sync            # launchpoint scripts -> research_scripts
  python3 worker/discord_pull_worker.py                 # 24/7: pull + scripts sync every 60s

Env (read from ../.env.local automatically): NEXT_PUBLIC_SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, DISCORD_BOT_TOKEN, DISCORD_GUILD_ID.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent


# --- env -------------------------------------------------------------------

def load_env() -> None:
    """Pull missing vars from the repo's .env.local so setup is zero-config."""
    env_file = ROOT.parent / ".env.local"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"'))


load_env()
SUPA = os.environ["NEXT_PUBLIC_SUPABASE_URL"].rstrip("/")
KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
BOT_TOKEN = os.environ["DISCORD_BOT_TOKEN"]
GUILD_ID = int(os.environ["DISCORD_GUILD_ID"])

DISCORD_API = "https://discord.com/api/v10"
# Cloudflare rejects urllib's default UA with a 403 that reads exactly like a
# permissions error — always send a bot User-Agent.
USER_AGENT = "DiscordBot (https://github.com/joeyzhang-dev/ugc-researcher, 0.1)"
PAGE_LIMIT = 100
POLL_SECONDS = 60
COACH_ROLE_NAME = "Coach"

# Discord message types that carry real authored content (0=default, 19=reply).
# Everything else (joins, pins, boosts, ...) is a system event we do not ingest.
_CONTENT_MESSAGE_TYPES = {0, 19}


# --- supabase REST ----------------------------------------------------------

def sb(method: str, path: str, payload=None, prefer="return=representation"):
    req = urllib.request.Request(
        f"{SUPA}/rest/v1/{path}",
        data=json.dumps(payload).encode() if payload is not None else None,
        headers={
            "apikey": KEY,
            "Authorization": f"Bearer {KEY}",
            "Content-Type": "application/json",
            "Prefer": prefer,
        },
        method=method,
    )
    try:
        with urllib.request.urlopen(req) as r:
            body = r.read()
            return json.loads(body) if body else None
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:500]
        raise RuntimeError(f"supabase {method} {path} -> {exc.code}: {detail}") from exc


def sb_all(path_query: str, page: int = 1000) -> list:
    """GET every row of a filtered query, paging past PostgREST's row cap."""
    rows: list = []
    offset = 0
    while True:
        batch = sb("GET", f"{path_query}&limit={page}&offset={offset}") or []
        rows.extend(batch)
        if len(batch) < page:
            return rows
        offset += page


# --- discord REST -----------------------------------------------------------

def discord_get(path: str):
    """GET a Discord REST endpoint. None on 404; one retry honouring 429."""
    req = urllib.request.Request(
        f"{DISCORD_API}{path}",
        headers={"Authorization": f"Bot {BOT_TOKEN}", "User-Agent": USER_AGENT},
    )
    for attempt in range(2):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return None
            if exc.code == 429 and attempt == 0:
                retry_after = 1.0
                try:
                    retry_after = float(json.loads(exc.read().decode("utf-8")).get("retry_after", 1.0))
                except Exception:  # noqa: BLE001 - best-effort backoff
                    pass
                time.sleep(retry_after + 0.25)
                continue
            raise
    return None


# --- discovery (pure, ported from discord-crm) ------------------------------

CREATOR_PREFIXES: tuple[str, ...] = ("coaching-", "coachking-", "influencer-")
EXCLUDE_CATEGORIES = frozenset({"👤・Creators"})
# Categories that describe a state, not a niche.
NON_NICHE_CATEGORIES = frozenset({"Not Creating 🚫"})
_NICHE_JUNK = re.compile(r"[^\w\s&/-]", re.UNICODE)


def niche_from_category(category: str | None) -> str | None:
    """'Creators: 💸 Finance General' -> 'Finance General'; state buckets -> None."""
    if not category or category in NON_NICHE_CATEGORIES:
        return None
    name = category.split(":", 1)[-1]
    name = _NICHE_JUNK.sub("", name).strip()
    return name or None
_TEXT_CHANNEL_TYPES = frozenset({0, 5})
_CATEGORY_TYPE = 4
_TRAILING_NON_WORD = re.compile(r"[^0-9a-z]+$")

# Verified Discord channel name -> roster handle (evidence: display names +
# channel content, checked 2026-08-04). vincent is lockedinwvinny, NOT
# nick.vincenttt — a coach message in coaching-vincent links lockedinwvinny.
VERIFIED_HANDLES = {
    "amrin": "amrinrants",
    "ann": "ann.isbuilding",
    "anna": "floyaps_",
    "abdully": "abdul.lockedin",
    "cole": "colemotivatesyou",
    "daeglan": "daeglan.motivates",
    "daniel": "lockedin.daniel",
    "evan": "stayfocusedevan",
    "gia": "giavolution",
    "grace": "gglockedinn",
    "jacob": "aheadwithjacob",
    "jake": "jakelocks.in",
    "jas": "wisdomwjas",
    "joey": "joeysixfive",
    "kaelin": "lockedinwkae",
    "madison": "justttmadsthings",
    "nick": "nick.vincenttt",
    "richky": "lockedinwithrichky",
    "roman": "rodoeswork",
    "sarah": "copingwitharah",
    "tatiana": "tatianaluvsjesus3",
    "victor": "vicklockedin",
    "vincent": "lockedinwvinny",
}


def _stripped_name(channel_name: str) -> str:
    """Channel name minus the coaching- prefix, emoji tail intact."""
    name = channel_name.strip().lower()
    for prefix in CREATOR_PREFIXES:
        if name.startswith(prefix):
            return name[len(prefix):]
    return name


def derive_creator_name(channel_name: str) -> str:
    """Turn a channel name like ``coaching-malik💪`` into ``malik``."""
    name = channel_name.strip().lower()
    for prefix in CREATOR_PREFIXES:
        if name.startswith(prefix):
            name = name[len(prefix):]
            break
    return _TRAILING_NON_WORD.sub("", name)


def classify_creator_channels(channels: list[dict]) -> list[dict]:
    """Pick the per-creator text channels out of a raw guild channel list."""
    category_names = {
        str(c["id"]): c.get("name", "") for c in channels if c.get("type") == _CATEGORY_TYPE
    }
    rows = []
    for c in channels:
        if c.get("type") not in _TEXT_CHANNEL_TYPES:
            continue
        name = c.get("name", "")
        if not any(name.strip().lower().startswith(p) for p in CREATOR_PREFIXES):
            continue
        parent_id = c.get("parent_id")
        niche = category_names.get(str(parent_id)) if parent_id is not None else None
        if niche in EXCLUDE_CATEGORIES:
            continue
        rows.append({
            "channel_id": int(c["id"]),
            "channel_name": name,
            "creator_name": derive_creator_name(name),
            "niche": niche_from_category(niche),
            "category": niche,
        })
    return rows


def match_roster(creator_name: str, roster: dict[str, str]) -> str | None:
    """Roster creator id for a derived channel name.

    Verified mapping first; otherwise a substring match on handle, accepted
    only when it is unambiguous (exactly one roster handle contains the name).
    """
    handle = VERIFIED_HANDLES.get(creator_name)
    if handle and handle in roster:
        return roster[handle]
    candidates = [h for h in roster if creator_name and creator_name in h]
    if len(candidates) == 1:
        return roster[candidates[0]]
    return None


def cmd_discover() -> None:
    raw = discord_get(f"/guilds/{GUILD_ID}/channels") or []
    rows = classify_creator_channels(raw)
    roster = {
        r["handle"]: r["id"]
        for r in sb_all("research_creators?select=id,handle&kind=eq.roster")
    }
    # Links already in the DB (auto or hand-made in the UI) always win over
    # this run's name-matching — a human link must survive re-discovery.
    existing_links = {
        c["channel_id"]: c["research_creator_id"]
        for c in sb_all("research_discord_channels?select=channel_id,research_creator_id")
        if c["research_creator_id"]
    }
    payload, unlinked = [], []
    for row in rows:
        creator_id = match_roster(row["creator_name"], roster)
        payload.append({
            "channel_id": row["channel_id"],
            "guild_id": GUILD_ID,
            "channel_name": row["channel_name"],
            "research_creator_id": creator_id,
            "niche": row["niche"],
            "category": row["category"],
            # coaching-madison vs coaching-madison✝️ both derive "madison" but
            # are different people; only the exact-named channel may keep a
            # roster link when a collision happens below.
            "_exact": _stripped_name(row["channel_name"]) == row["creator_name"],
        })
    by_creator: dict[str, list[dict]] = {}
    for p in payload:
        if p["research_creator_id"]:
            by_creator.setdefault(p["research_creator_id"], []).append(p)
    for group in by_creator.values():
        if len(group) > 1:
            exact = [p for p in group if p["_exact"]]
            keep = exact[0] if len(exact) == 1 else None
            for p in group:
                if p is not keep:
                    p["research_creator_id"] = None
    for p in payload:
        del p["_exact"]
        if p["channel_id"] in existing_links:
            p["research_creator_id"] = existing_links[p["channel_id"]]
        if p["research_creator_id"] is None:
            unlinked.append(p["channel_name"])
    if payload:
        sb(
            "POST",
            "research_discord_channels?on_conflict=channel_id",
            payload,
            prefer="resolution=merge-duplicates,return=minimal",
        )
    print(f"discover: {len(payload)} creator channels upserted, {len(payload) - len(unlinked)} linked to roster")
    if unlinked:
        print(f"  no roster match (stay tracked, unlinked): {', '.join(sorted(unlinked))}")

    # Forward-fill research_app_creators.niche from the channel category —
    # only where niche is still null, so hand-edited values always win.
    apps = sb("GET", f"research_apps?select=id&name=eq.{FOLK_APP_NAME}")
    if apps:
        app_id = apps[0]["id"]
        niche_by_rcid = {
            p["research_creator_id"]: p["niche"]
            for p in payload if p["research_creator_id"] and p["niche"]
        }
        filled = 0
        for r in sb_all(f"research_app_creators?select=id,research_creator_id,niche&app_id=eq.{app_id}"):
            niche = niche_by_rcid.get(r["research_creator_id"])
            if niche and not r["niche"]:
                sb("PATCH", f"research_app_creators?id=eq.{r['id']}", {"niche": niche}, prefer="return=minimal")
                filled += 1
        if filled:
            print(f"  filled niche for {filled} roster creators from channel categories")


# --- attribution (pure, ported from discord-crm) ----------------------------

class RoleMap:
    def __init__(self, channel_creator: dict[int, int], coach_ids: set[int], launchpoint_ids: set[int]):
        self.channel_creator = channel_creator
        self.coach_ids = coach_ids
        self.launchpoint_ids = launchpoint_ids


def resolve_author_role(channel_id: int, author_id, is_bot: bool, webhook_id, role_map: RoleMap) -> str:
    """Classify creator / coach / launchpoint / unknown — first match wins."""
    if webhook_id is not None:
        return "launchpoint" if author_id in role_map.launchpoint_ids else "unknown"
    if is_bot:
        return "launchpoint" if author_id in role_map.launchpoint_ids else "unknown"
    if author_id is None:
        return "unknown"
    if role_map.channel_creator.get(channel_id) == author_id:
        return "creator"
    if author_id in role_map.coach_ids:
        return "coach"
    return "unknown"


def load_role_map(channels: list[dict]) -> RoleMap:
    channel_creator = {
        c["channel_id"]: c["research_creators"]["discord_user_id"]
        for c in channels
        if c.get("research_creators") and c["research_creators"].get("discord_user_id")
    }
    roles = sb_all("research_discord_user_roles?select=discord_user_id,role")
    return RoleMap(
        channel_creator=channel_creator,
        coach_ids={r["discord_user_id"] for r in roles if r["role"] == "coach"},
        launchpoint_ids={r["discord_user_id"] for r in roles if r["role"] == "launchpoint"},
    )


def tracked_channels() -> list[dict]:
    return sb_all(
        "research_discord_channels?select=channel_id,channel_name,research_creator_id,"
        "research_creators(discord_user_id)&is_tracked=eq.true"
    )


# --- pull -------------------------------------------------------------------

def _normalize_attachments(raw) -> list[dict]:
    normalized = []
    for item in raw or []:
        url = item.get("url") or item.get("proxy_url")
        if not url:
            continue
        normalized.append({
            "id": str(item["id"]) if item.get("id") is not None else None,
            "filename": item.get("filename"),
            "url": url,
            "content_type": item.get("content_type"),
            "size": item.get("size"),
        })
    return normalized


def _watermark(channel_id: int):
    rows = sb(
        "GET",
        f"research_discord_messages?select=message_id&channel_id=eq.{channel_id}"
        "&order=message_id.desc&limit=1",
    )
    return rows[0]["message_id"] if rows else None


def _fetch_new(channel_id: int, after) -> list[dict]:
    """Raw Discord message objects newer than ``after`` (oldest-first)."""
    messages: list[dict] = []
    cursor = after
    while True:
        query = f"?limit={PAGE_LIMIT}"
        if cursor:
            query += f"&after={cursor}"
        try:
            batch = discord_get(f"/channels/{channel_id}/messages{query}")
        except urllib.error.HTTPError:
            break  # no access to this channel — skip, keep the loop alive
        if not batch:
            break
        ascending = sorted(batch, key=lambda m: int(m["id"]))
        messages.extend(ascending)
        cursor = int(ascending[-1]["id"])
        if len(batch) < PAGE_LIMIT:
            break
    return messages


def pull_once() -> dict:
    channels = tracked_channels()
    role_map = load_role_map(channels)
    ids = [c["channel_id"] for c in channels]

    # Phase 1: fetch in parallel (HTTP only, no DB).
    with ThreadPoolExecutor(max_workers=8) as pool:
        fetched = list(pool.map(lambda cid: (cid, _fetch_new(cid, _watermark(cid))), ids))

    # Phase 2: normalize + attribute + upsert.
    message_rows: list[dict] = []
    users: dict[int, dict] = {}
    for channel_id, raw_messages in fetched:
        for m in raw_messages:
            if m.get("type") not in _CONTENT_MESSAGE_TYPES:
                continue
            author = m.get("author") or {}
            author_id = int(author["id"]) if author.get("id") else None
            is_bot = bool(author.get("bot", False))
            webhook_id = int(m["webhook_id"]) if m.get("webhook_id") else None
            message_id = int(m["id"])
            role = resolve_author_role(channel_id, author_id, is_bot, webhook_id, role_map)
            message_rows.append({
                "guild_id": GUILD_ID,
                "channel_id": channel_id,
                "message_id": message_id,
                "edit_version": 0,
                "dedupe_key": f"{GUILD_ID}/{channel_id}/{message_id}/0",
                "author_discord_user_id": author_id,
                "author_role": role,
                "is_bot": is_bot,
                "webhook_id": webhook_id,
                "content": m.get("content", "") or "",
                "attachments": _normalize_attachments(m.get("attachments")),
                "posted_at": m.get("timestamp"),
                "edited_at": m.get("edited_timestamp"),
            })
            if author_id is not None and webhook_id is None:
                users[author_id] = {
                    "discord_user_id": author_id,
                    "username": author.get("username"),
                    "global_name": author.get("global_name"),
                    "display_name": author.get("global_name") or author.get("username"),
                    "is_bot": is_bot,
                }

    if users:
        sb(
            "POST",
            "research_discord_users?on_conflict=discord_user_id",
            list(users.values()),
            prefer="resolution=merge-duplicates,return=minimal",
        )
    for i in range(0, len(message_rows), 500):
        sb(
            "POST",
            "research_discord_messages?on_conflict=dedupe_key",
            message_rows[i : i + 500],
            prefer="resolution=merge-duplicates,return=minimal",
        )
    return {"channels": len(ids), "messages": len(message_rows), "users": len(users)}


MAINTENANCE_SECONDS = 15 * 60  # discover new channels + refresh summaries


def cmd_pull(once: bool) -> None:
    last_maintenance = 0.0
    while True:
        try:
            counts = pull_once()
            # flush so the log is readable live when stdout is a file, not a tty
            print(f"[{time.strftime('%H:%M:%S')}] pulled {counts['messages']} messages "
                  f"across {counts['channels']} channels ({counts['users']} authors seen)", flush=True)
            if counts["messages"]:
                synced = sync_scripts()
                if synced["scripts"] or synced["assignments"]:
                    print(f"[{time.strftime('%H:%M:%S')}] scripts sync: "
                          f"+{synced['scripts']} scripts, +{synced['assignments']} assignments", flush=True)
            # Every 15 min: pick up newly created channels and re-summarize
            # whatever changed (incremental — quiet periods cost nothing).
            if not once and time.time() - last_maintenance >= MAINTENANCE_SECONDS:
                last_maintenance = time.time()
                cmd_discover()
                s = summarize_channels()
                if s["stale"]:
                    print(f"[{time.strftime('%H:%M:%S')}] summaries: {s['summarized']}/{s['stale']} refreshed", flush=True)
        except Exception as exc:  # noqa: BLE001 - a bad cycle must not kill 24/7
            print(f"[{time.strftime('%H:%M:%S')}] pull failed: {exc}", flush=True)
        if once:
            return
        time.sleep(POLL_SECONDS)


# --- enrich (ported from discord-crm's enrich_discord_crm.py) ---------------

def _identify_creator(channel_name: str, authors: list[dict], exclude_ids: set[int]):
    """The discord_user_id of the channel's creator, or None.

    Name-match (channel's derived name inside username/global_name) is the
    primary signal and beats raw volume, so a louder coach never wins; volume
    is only the tiebreaker / fallback.
    """
    derived = derive_creator_name(channel_name)
    humans = [
        a for a in authors
        if not a["is_bot"] and a["webhook_id"] is None and a["author_id"] not in exclude_ids
    ]
    if not humans:
        return None
    named = [
        a for a in humans
        if derived and any(derived in (a.get(k) or "").lower() for k in ("username", "global_name"))
    ]
    pool = named if named else humans
    return max(pool, key=lambda a: a["count"])["author_id"]


def cmd_enrich(dry_run: bool) -> None:
    channels = tracked_channels()

    # Author activity per channel, from what the pull has already landed.
    stats: dict[int, dict[int, dict]] = {}
    for c in channels:
        per_author: dict[int, dict] = {}
        rows = sb_all(
            "research_discord_messages?select=author_discord_user_id,is_bot,webhook_id"
            f"&channel_id=eq.{c['channel_id']}&author_discord_user_id=not.is.null"
        )
        for r in rows:
            a = per_author.setdefault(r["author_discord_user_id"], {
                "author_id": r["author_discord_user_id"],
                "count": 0, "bot_user_posts": 0,
                "is_bot": False, "webhook_id": None,
                "username": "", "global_name": None,
            })
            a["count"] += 1
            if r["webhook_id"] is None:
                a["bot_user_posts"] += 1
        if per_author:
            stats[c["channel_id"]] = per_author

    # Resolve each distinct author once over Discord REST (bot flag, names,
    # Coach guild-role membership).
    roles = discord_get(f"/guilds/{GUILD_ID}/roles") or []
    coach_role_id = next((int(r["id"]) for r in roles if r.get("name") == COACH_ROLE_NAME), None)
    identity: dict[int, dict] = {}

    def resolve_identity(author_id: int) -> dict:
        if author_id in identity:
            return identity[author_id]
        user = discord_get(f"/users/{author_id}")
        if user is None:  # 404 -> the id is a webhook, not a real user
            info = {"kind": "webhook", "username": "", "global_name": None, "is_coach": False, "nickname": None}
        else:
            info = {
                "kind": "bot" if user.get("bot") else "user",
                "username": user.get("username") or "",
                "global_name": user.get("global_name"),
                "is_coach": False,
                "nickname": None,
            }
            if info["kind"] == "user":
                member = discord_get(f"/guilds/{GUILD_ID}/members/{author_id}")
                if member:
                    info["nickname"] = member.get("nick")
                    if coach_role_id is not None:
                        info["is_coach"] = coach_role_id in {int(r) for r in member.get("roles", [])}
        identity[author_id] = info
        time.sleep(0.15)  # gentle pacing under the REST rate limit
        return info

    coach_ids: set[int] = set()
    launchpoint: dict[int, str] = {}
    for per_author in stats.values():
        for author_id, a in per_author.items():
            info = resolve_identity(author_id)
            a["is_bot"] = info["kind"] == "bot"
            a["webhook_id"] = author_id if info["kind"] == "webhook" else None
            a["username"] = info["username"]
            a["global_name"] = info["global_name"]
            # Real automation posts as a genuine bot *user*; webhook-only bots
            # (Carl-bot etc.) stay unknown rather than polluting launchpoint.
            if a["is_bot"] and a["bot_user_posts"] > 0:
                launchpoint[author_id] = info["username"] or "automation"
            elif info["is_coach"]:
                coach_ids.add(author_id)

    exclude = coach_ids | set(launchpoint)
    creator_writes = []  # (research_creator_id, discord_user_id, username, channel_name)
    for c in channels:
        per_author = stats.get(c["channel_id"])
        if not per_author or not c.get("research_creator_id"):
            continue
        uid = _identify_creator(c["channel_name"], list(per_author.values()), exclude)
        if uid is not None:
            creator_writes.append(
                (c["research_creator_id"], uid, identity[uid]["username"], c["channel_name"])
            )

    # Two channels resolving to the same roster creator with different discord
    # ids means a mislink upstream — refuse to guess, keep neither.
    seen_rcid: dict[str, set[int]] = {}
    for rcid, uid, _u, _n in creator_writes:
        seen_rcid.setdefault(rcid, set()).add(uid)
    conflicted = {rcid for rcid, uids in seen_rcid.items() if len(uids) > 1}
    if conflicted:
        for rcid, _uid, _u, name in creator_writes:
            if rcid in conflicted:
                print(f"  CONFLICT: {name} shares a roster creator with another channel — skipped")
        creator_writes = [w for w in creator_writes if w[0] not in conflicted]

    print(f"enrich: {len(stats)} channels with activity")
    print(f"  coach ids ({COACH_ROLE_NAME} role): {sorted(coach_ids)}")
    print(f"  launchpoint ids: {sorted(launchpoint)}")
    for _rcid, uid, username, name in creator_writes:
        print(f"  {name}: discord_user_id={uid} ({username})")
    if dry_run:
        print("dry-run: no writes performed")
        return

    role_rows = [
        {"discord_user_id": uid, "channel_id": 0, "role": "launchpoint", "is_bot": True, "note": note}
        for uid, note in sorted(launchpoint.items())
    ] + [
        {"discord_user_id": uid, "channel_id": 0, "role": "coach", "is_bot": False,
         "note": identity.get(uid, {}).get("username") or None}
        for uid in sorted(coach_ids)
    ]
    if role_rows:
        sb(
            "POST",
            "research_discord_user_roles?on_conflict=discord_user_id,channel_id",
            role_rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )
    for rcid, uid, username, _name in creator_writes:
        sb(
            "PATCH",
            f"research_creators?id=eq.{rcid}",
            {"discord_user_id": uid, "discord_username": username},
            prefer="return=minimal",
        )
    # Refresh nicknames/display names for everyone we resolved.
    user_rows = [
        {
            "discord_user_id": uid,
            "username": info["username"],
            "global_name": info["global_name"],
            "nickname": info["nickname"],
            "display_name": info["nickname"] or info["global_name"] or info["username"],
            "is_bot": info["kind"] == "bot",
        }
        for uid, info in identity.items()
        if info["kind"] != "webhook"
    ]
    if user_rows:
        sb(
            "POST",
            "research_discord_users?on_conflict=discord_user_id",
            user_rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )
    print(f"wrote: {len(launchpoint)} launchpoint, {len(coach_ids)} coach, {len(creator_writes)} creator ids")

    # Re-attribute already-stored rows now that the role map is richer.
    reattribute()


def reattribute() -> None:
    """Recompute author_role for stored messages with the current role map."""
    role_map = load_role_map(tracked_channels())
    rows = sb_all(
        "research_discord_messages?select=id,channel_id,author_discord_user_id,is_bot,webhook_id,author_role"
    )
    by_role: dict[str, list[int]] = {}
    for r in rows:
        role = resolve_author_role(
            r["channel_id"], r["author_discord_user_id"], r["is_bot"], r["webhook_id"], role_map
        )
        if role != r["author_role"]:
            by_role.setdefault(role, []).append(r["id"])
    for role, ids in by_role.items():
        for i in range(0, len(ids), 200):
            chunk = ",".join(str(x) for x in ids[i : i + 200])
            sb(
                "PATCH",
                f"research_discord_messages?id=in.({chunk})",
                {"author_role": role},
                prefer="return=minimal",
            )
    changed = sum(len(v) for v in by_role.values())
    print(f"re-attributed {changed} messages" + (f" ({ {k: len(v) for k, v in by_role.items()} })" if changed else ""))


# --- scripts sync -----------------------------------------------------------
# launchpoint "## Script N/M" messages -> research_scripts + assignments.
# Dedupe marker [lp:<md5(raw block.strip())[:10]>] in notes — byte-compatible
# with the 2026-08-04 CSV load, so nothing already imported ever duplicates.

FOLK_APP_NAME = "Folk"
MIN_SCRIPT_CHARS = 100  # bodies shorter than this are bot test placeholders

_BLOCK_RE = re.compile(r"```(?:\w*\n)?(.*?)```", re.S)
_URL_RE = re.compile(r"https?://\S+")
_LP_NOTES_RE = re.compile(r"📝\s*\*{0,2}Notes:?\*{0,2}\s*(.+)", re.S)
_MARKER_RE = re.compile(r"\[lp:([0-9a-f]+)\]")


def parse_script_message(content: str):
    """Extract (raw_script, inspiration_url, notes) from a launchpoint message."""
    block = _BLOCK_RE.search(content)
    if not block:
        return None
    raw = block.group(1).strip()
    if len(raw) < MIN_SCRIPT_CHARS:
        return None
    head = content[: block.start()]
    url = _URL_RE.search(head)
    tail = content[block.end():]
    notes = _LP_NOTES_RE.search(tail)
    return {
        "raw": raw,
        "inspiration": url.group(0) if url else None,
        "lp_notes": notes.group(1).strip() if notes else None,
    }


def sync_scripts() -> dict:
    import hashlib

    apps = sb("GET", f"research_apps?select=id&name=eq.{FOLK_APP_NAME}")
    if not apps:
        raise RuntimeError(f"research_apps has no '{FOLK_APP_NAME}' app")
    app_id = apps[0]["id"]

    channel_creator = {
        c["channel_id"]: c["research_creator_id"]
        for c in tracked_channels()
        if c.get("research_creator_id")
    }
    niche_by_creator = {
        r["research_creator_id"]: r["niche"]
        for r in sb_all(f"research_app_creators?select=research_creator_id,niche&app_id=eq.{app_id}")
        if r.get("niche")
    }

    pattern = urllib.parse.quote("*## Script*")
    messages = sb_all(
        "research_discord_messages?select=channel_id,content,posted_at"
        f"&author_role=eq.launchpoint&content=like.{pattern}&order=posted_at.asc"
    )

    # Group identical scripts across channels (a batch is one menu sent to many).
    grouped: dict[str, dict] = {}
    for m in messages:
        parsed = parse_script_message(m["content"])
        if not parsed:
            continue
        h = hashlib.md5(parsed["raw"].encode()).hexdigest()[:10]
        g = grouped.setdefault(h, {**parsed, "first_sent": m["posted_at"], "recipients": {}})
        g["recipients"].setdefault(m["channel_id"], m["posted_at"])
        if m["posted_at"] and (g["first_sent"] is None or m["posted_at"] < g["first_sent"]):
            g["first_sent"] = m["posted_at"]

    existing = {}  # lp hash -> script id
    for s in sb_all(f"research_scripts?select=id,notes&app_id=eq.{app_id}&notes=like.{urllib.parse.quote('*[lp:*')}"):
        marker = _MARKER_RE.search(s["notes"] or "")
        if marker:
            existing[marker.group(1)] = s["id"]

    new_scripts = 0
    for h, g in grouped.items():
        creator_ids = sorted({channel_creator[cid] for cid in g["recipients"] if cid in channel_creator})
        if not creator_ids:
            continue  # no roster recipients — same skip rule as the CSV load
        if h not in existing:
            lines = g["raw"].split("\n")
            title = lines[0].strip()
            body = "\n".join(lines[1:]).strip()
            niches = [niche_by_creator[c] for c in creator_ids if c in niche_by_creator]
            note_lines = []
            if g["inspiration"]:
                note_lines.append(f"Inspiration: {g['inspiration']}")
            if g["lp_notes"]:
                note_lines.append(f"Notes: {g['lp_notes']}")
            first_sent_day = (g["first_sent"] or "")[:10]
            note_lines.append(
                f"Imported from Folk UGC Discord (launchpoint bot), first sent {first_sent_day}. [lp:{h}]"
            )
            row = {
                "app_id": app_id,
                "title": title,
                "hook": title,
                "body": body,
                "niche": max(set(niches), key=niches.count) if niches else None,
                "notes": "\n".join(note_lines),
                "status": "Active",
                "created_at": g["first_sent"],  # send-out date drives the dashboard
            }
            inserted = sb("POST", "research_scripts", [row])
            existing[h] = inserted[0]["id"]
            new_scripts += 1

    # Top up assignments for every synced script (never touches existing rows,
    # so statuses set in the UI survive re-runs).
    assignment_rows = []
    for h, g in grouped.items():
        script_id = existing.get(h)
        if not script_id:
            continue
        for cid, sent_at in g["recipients"].items():
            rcid = channel_creator.get(cid)
            if rcid:
                assignment_rows.append({
                    "script_id": script_id,
                    "research_creator_id": rcid,
                    "status": "Assigned",
                    "assigned_at": sent_at,
                })
    new_assignments = 0
    for i in range(0, len(assignment_rows), 500):
        inserted = sb(
            "POST",
            "research_script_assignments?on_conflict=script_id,research_creator_id",
            assignment_rows[i : i + 500],
            prefer="resolution=ignore-duplicates,return=representation",
        )
        new_assignments += len(inserted or [])
    return {"scripts": new_scripts, "assignments": new_assignments}


# --- summaries --------------------------------------------------------------
# Ported from discord-crm's copilot summaries, generated with `claude -p`
# instead (no API key to manage). Incremental: a channel is re-summarized only
# when its newest message_id moved past based_on_message_id, and every stale
# channel goes into ONE batched claude call.

SUMMARY_MODEL = "claude -p"
SUMMARY_CONTEXT_MESSAGES = 30
SUMMARY_STATUSES = [
    "Onboarding", "Awaiting videos", "Needs video review", "Revision requested",
    "Ready to post", "In discussion", "Inactive",
]


def _summary_context(channel_id: int, names: dict) -> tuple[int, str]:
    """(newest_message_id, transcript excerpt) for one channel, oldest-first."""
    rows = sb(
        "GET",
        "research_discord_messages?select=message_id,author_discord_user_id,author_role,content,attachments"
        f"&channel_id=eq.{channel_id}&order=message_id.desc&limit={SUMMARY_CONTEXT_MESSAGES}",
    ) or []
    newest = rows[0]["message_id"] if rows else 0
    lines = []
    for r in reversed(rows):
        who = names.get(r["author_discord_user_id"]) or r["author_role"]
        text = (r["content"] or "").strip().replace("\n", " ")
        if len(text) > 300:
            text = text[:300] + "…"
        if not text and r["attachments"]:
            text = f"[{len(r['attachments'])} attachment(s)]"
        lines.append(f"{who} ({r['author_role']}): {text}")
    return newest, "\n".join(lines)


def summarize_channels(limit: int | None = None) -> dict:
    import subprocess

    channels = tracked_channels()
    names = {
        u["discord_user_id"]: u["display_name"] or u["username"]
        for u in sb_all("research_discord_users?select=discord_user_id,username,display_name")
    }
    existing = {
        s["channel_id"]: s
        for s in sb_all("research_discord_summaries?select=channel_id,based_on_message_id")
    }

    stale: list[dict] = []
    for c in channels:
        newest, context = _summary_context(c["channel_id"], names)
        if not newest:
            continue
        seen = (existing.get(c["channel_id"]) or {}).get("based_on_message_id") or 0
        if newest > seen:
            stale.append({**c, "newest": newest, "context": context})
    if limit is not None:
        stale = stale[:limit]
    if not stale:
        return {"summarized": 0, "stale": 0}

    sections = "\n\n".join(
        f"### channel_id={c['channel_id']} ({c['channel_name']})\n{c['context']}" for c in stale
    )
    prompt = f"""You are summarizing coaching-channel conversations from a UGC creator Discord.
For EACH channel below, produce where the workflow stands right now.

Rules:
- "status": exactly one of {SUMMARY_STATUSES}.
- "summary": ONE sentence, concrete and factual (who did/said what, what is awaited). No fluff.
- Judge from the newest messages; older context is background.

Respond with ONLY a JSON object mapping channel_id (string) to {{"status": ..., "summary": ...}}.

{sections}"""
    out = subprocess.run(
        ["claude", "-p", "--output-format", "text", prompt],
        capture_output=True, text=True, timeout=600,
    )
    if out.returncode != 0:
        raise RuntimeError(f"claude -p failed: {out.stderr[:300]}")
    text = out.stdout.strip()
    m = re.search(r"\{.*\}", text, re.S)
    if not m:
        raise RuntimeError(f"claude -p returned no JSON: {text[:200]}")
    parsed = json.loads(m.group(0))

    rows = []
    for c in stale:
        entry = parsed.get(str(c["channel_id"]))
        if not entry or not entry.get("summary"):
            continue
        status = entry.get("status")
        rows.append({
            "channel_id": c["channel_id"],
            "summary": str(entry["summary"])[:500],
            "status": status if status in SUMMARY_STATUSES else None,
            "based_on_message_id": c["newest"],
            "model": SUMMARY_MODEL,
        })
    if rows:
        sb(
            "POST",
            "research_discord_summaries?on_conflict=channel_id",
            rows,
            prefer="resolution=merge-duplicates,return=minimal",
        )
    return {"summarized": len(rows), "stale": len(stale)}


# --- main -------------------------------------------------------------------

def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command")
    sub.add_parser("discover", help="guild channels -> research_discord_channels")
    pull_p = sub.add_parser("pull", help="pull new messages")
    pull_p.add_argument("--once", action="store_true")
    enrich_p = sub.add_parser("enrich", help="derive creator ids + roles, re-attribute")
    enrich_p.add_argument("--dry-run", action="store_true")
    sub.add_parser("sync", help="launchpoint script messages -> research_scripts")
    summ_p = sub.add_parser("summarize", help="refresh AI channel summaries via claude -p")
    summ_p.add_argument("--limit", type=int, default=None, help="summarize at most N stale channels")
    args = parser.parse_args()

    if args.command == "discover":
        cmd_discover()
    elif args.command == "enrich":
        cmd_enrich(args.dry_run)
    elif args.command == "sync":
        counts = sync_scripts()
        print(f"scripts sync: +{counts['scripts']} scripts, +{counts['assignments']} assignments")
    elif args.command == "summarize":
        counts = summarize_channels(limit=args.limit)
        print(f"summaries: {counts['summarized']}/{counts['stale']} stale channels refreshed")
    elif args.command == "pull":
        cmd_pull(once=args.once)
    else:
        cmd_pull(once=False)


if __name__ == "__main__":
    main()
