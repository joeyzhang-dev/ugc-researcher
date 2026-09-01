"""[CREATOR-PROVISION] Mint a folk tracking link when a creator is onboarded.

Why here and not from Launchpoint: Launchpoint only lists a creator once they
have posted (all 119 tracked accounts have >=1 post; none have zero), and the
creator needs the link to put *in* that first post. ``/onboard`` fires before
anyone posts, so this is the only hook that can be early enough.

Contract with folk-web (``POST /api/admin/creators/provision``):

  201 {"status": "created",   "creator": {...}}
  200 {"status": "existing",  "creator": {...}}   idempotent re-run
  409 {"status": "needs_link","conflicts": [...]} ambiguous, human required

The endpoint is create-or-return ONLY - it cannot delete a creator or
deactivate a live link - and it is gated on ``FOLK_PROVISION_TOKEN``, a
credential that opens nothing else. Both halves matter: narrowing only the
endpoint while carrying folk's shared ``FOLK_ADMIN_TOKEN`` would still let a
compromised worker delete user sandboxes and activate releases. Never point
this at the general ``/api/admin/creators`` route, and never give this worker
the shared token.

The Discord id is sent as a STRING. A snowflake is a 64-bit int and JSON
numbers are IEEE doubles: 1335356398049038400 round-trips as ...038300. That
corruption already caused a live incident in ``scripts/merge-creators.mjs``,
and here it would be worse than cosmetic - a corrupted id deduplicates against
nothing, so every re-onboard would mint another link for the same person.
folk-web rejects a numeric id outright; this module never produces one.
"""

from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Optional

REQUEST_TIMEOUT_S = 10


@dataclass(frozen=True)
class FolkLinkResult:
    """What provisioning did, rendered back to the operator."""

    status: str  # created | existing | needs_link | skipped | error
    url: Optional[str] = None
    username: Optional[str] = None
    detail: Optional[str] = None


def _base_url() -> str:
    return (os.environ.get("FOLK_API_URL", "").strip() or "https://www.folk.com").rstrip("/")


def provision_folk_link(
    *,
    discord_user_id: int | str,
    display_name: str,
    discord_username: Optional[str] = None,
    niche: Optional[str] = None,
    slug: Optional[str] = None,
) -> FolkLinkResult:
    """Create-or-return this creator's folk tracking link.

    Never raises: onboarding must not fail because folk-web is down. Every
    failure comes back as a status the caller turns into a warning, so the
    channel, role and welcome message still land and a human can retry.
    """
    # [SCOPED-MACHINE-TOKEN] Its OWN credential, not folk's shared admin
    # token. The shared one also opens sandbox deletion, memory wipe and
    # release activation; this one opens exactly this endpoint, so a
    # compromise of this worker cannot reach any of that.
    token = os.environ.get("FOLK_PROVISION_TOKEN", "").strip()
    if not token:
        return FolkLinkResult(status="skipped", detail="FOLK_PROVISION_TOKEN not set")

    payload = {
        # str() is the whole ballgame - see the module docstring.
        "discord_user_id": str(discord_user_id),
        "display_name": display_name,
    }
    if discord_username:
        payload["discord"] = discord_username
    if niche:
        payload["niche"] = niche
    if slug:
        payload["slug"] = slug

    request = urllib.request.Request(
        f"{_base_url()}/api/admin/creators/provision",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "content-type": "application/json",
            "x-admin-token": token,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=REQUEST_TIMEOUT_S) as response:
            body = json.loads(response.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", errors="replace")
        try:
            body = json.loads(raw or "{}")
        except json.JSONDecodeError:
            body = {}
        if exc.code == 409 and body.get("status") == "needs_link":
            names = ", ".join(
                str(c.get("username")) for c in body.get("conflicts") or []
            )
            return FolkLinkResult(
                status="needs_link",
                detail=(
                    f"a creator named {names} already exists with no linked Discord "
                    "account - link it in /admin/creators, or re-run with an explicit slug"
                ),
            )
        # Never echo the response body wholesale: it is operator-facing text
        # and an upstream error can carry request detail we should not paste
        # into a Discord channel.
        return FolkLinkResult(
            status="error",
            detail=f"folk-web returned HTTP {exc.code}",
        )
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError, OSError) as exc:
        return FolkLinkResult(status="error", detail=f"could not reach folk-web: {exc}")

    creator = body.get("creator") or {}
    username = creator.get("username")
    if not username:
        return FolkLinkResult(status="error", detail="folk-web returned no creator")
    domain = creator.get("link_domain")
    url = f"https://{domain}/{username}" if domain else f"https://folk.com/u/{username}"
    return FolkLinkResult(
        status=body.get("status") or "created",
        url=url,
        username=username,
    )
