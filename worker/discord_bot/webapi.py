"""Thin client for the web app's job API.

`/stats` needs the same numbers the weekly recap shows: the trial-reel
collapse, the settled-CPM window, the bucket lines. All of that is TypeScript
in the Next.js app, and porting it here would fork load-bearing logic into a
second language where the two copies drift the first time either changes.

So the bot asks and renders. Same rule the digest follows — the page and the
ping cannot disagree on a number.

stdlib only (urllib), matching discord_pull_worker: the hosted image stays
small on purpose, and this is two GETs.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_APP_URL = "https://bludgc.vercel.app"
TIMEOUT_SECONDS = 90


class WebApiError(RuntimeError):
    """Surfaced to the operator; never swallowed into an empty panel."""


def app_url() -> str:
    return (os.environ.get("NEXT_PUBLIC_APP_URL") or DEFAULT_APP_URL).rstrip("/")


def _get(path: str) -> dict:
    secret = os.environ.get("CRON_SECRET")
    if not secret:
        raise WebApiError(
            "CRON_SECRET is not set for the bot, so it cannot reach the stats API "
            "(`fly secrets set CRON_SECRET=... -a bludgc-workers`)"
        )
    req = urllib.request.Request(
        f"{app_url()}{path}",
        headers={"Authorization": f"Bearer {secret}", "User-Agent": "bludgc-bot/1.0"},
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT_SECONDS) as res:
            return json.load(res)
    except urllib.error.HTTPError as exc:
        body = exc.read().decode("utf-8", "replace")[:200]
        try:
            message = json.loads(body).get("error") or body
        except Exception:  # noqa: BLE001 - the body is whatever the edge returned
            message = body
        raise WebApiError(f"{exc.code}: {message}") from exc
    except Exception as exc:  # noqa: BLE001 - timeouts, DNS, TLS
        raise WebApiError(str(exc)) from exc


def creator_stats(handle: str) -> dict:
    """One creator's stats panel, with an already-warmed card image URL."""
    return _get("/api/jobs/creator-stats?" + urllib.parse.urlencode({"handle": handle}))


def my_stats(discord_user_id: int | str) -> dict:
    """The caller's own stats. Keyed on their Discord id, never a handle — the
    id comes from the interaction Discord signed, so it is the one identifier
    a creator cannot put words into."""
    return _get(
        "/api/jobs/my-stats?" + urllib.parse.urlencode({"discordUserId": str(discord_user_id)})
    )
