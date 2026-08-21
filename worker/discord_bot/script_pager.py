"""Paged script messages: rendering + the data reads behind the buttons.

The app (src/lib/discord-send.ts) posts page 0 of a batch; the gateway bot
answers the buttons by re-rendering other pages with THIS module. The two
renderers must stay in lockstep — same clamps, same custom_id contract:

    scrnav:<page>        show that page of the message's batch
    scrpost:<page>       mark that page's script Posted for this channel's creator
    scrnote:<script_id>  open the add-a-note modal for that page's script
    scrnotem:<script_id> the modal's submit (text input custom_id "note")

Stdlib only (like the pull worker), so tests run without discord.py; the
gateway glue in client.py turns these dicts into discord.py objects.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

import discord_pull_worker as pull

ACCENT_COLOR = 0x5865F2
V2_FLAG = 1 << 15
INSPO_FILENAME = "inspo.mp4"
_URL_RE = re.compile(r"^https?://\S+$")

# Discord button styles, kept as ints so this module stays stdlib.
STYLE_SECONDARY = 2
STYLE_SUCCESS = 3
STYLE_LINK = 5


def _clamp(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"


def collect_text(components: list[dict]) -> list[str]:
    """Every text-display string in a V2 component tree, containers included."""
    out = []
    for c in components or []:
        if c.get("type") == 10 and isinstance(c.get("content"), str):
            out.append(c["content"])
        out.extend(collect_text(c.get("components") or []))
    return out


def test_marker(script_ids: list[str]) -> str:
    """Same shape as testSendContent() in src/lib/discord-send.ts."""
    return f"-# 🧪 Test send — not tracked\n||scr:{','.join(script_ids)}||"


def render_page(
    scripts: list[dict], index: int, *, video_url: str | None = None, marker: str | None = None,
    view_all_url: str | None = None, leading: list[str] | None = None, paged: bool = True
) -> dict:
    """One page of a batch as a Components V2 card. Mirrors the TS builder:
    accent container, hook heading, video INSIDE the card via a PUBLIC URL
    (storage-hosted, so nothing uploads to Discord and page flips stay a
    pure JSON edit), separated Script / Demo / Song(s) sections."""
    s = scripts[index]
    total = len(scripts)
    inspo = (s.get("inspo_url") or "").strip()
    has_inspo = bool(_URL_RE.match(inspo))

    inner: list[dict] = []
    if s.get("hook"):
        # Canonical Doc-view number, when the caller computed one — page
        # flips of old messages have no number and keep the plain heading.
        number_tag = f"#{s['number']} — " if s.get("number") else ""
        inner.append({"type": 10, "content": f"## {number_tag}{_clamp(s['hook'], 200)}"})
    if s.get("body"):
        inner.append({"type": 14, "divider": True, "spacing": 1})
        inner.append({"type": 10, "content": f"### Script\n{_clamp(s['body'], 2800)}"})
    # The video sits in its own section directly above Demo/Songs.
    if video_url:
        inner.append({"type": 14, "divider": True, "spacing": 1})
        inner.append({
            "type": 12,
            "items": [{"media": {"url": video_url}, "description": "Inspo video"}],
        })
    elif has_inspo:
        inner.append({"type": 14, "divider": True, "spacing": 1})
        inner.append({"type": 10, "content": f"-# Inspo video\n{inspo}"})
    meta = []
    if s.get("demo"):
        meta.append(f"### Demo to use\n{_clamp(s['demo'], 400)}")
    if s.get("songs"):
        meta.append(f"### Song(s) to use\n{_clamp(s['songs'], 400)}")
    if meta:
        inner.append({"type": 14, "divider": True, "spacing": 1})
        inner.append({"type": 10, "content": "\n".join(meta)})
    inner.append({"type": 10, "content": f"-# Script {index + 1}/{total}"})

    # No "I posted this" button: tracking lives in the webapp (scrape →
    # transcript match → deliberate link); a self-report only made
    # half-tracked rows. The scrpost handler stays for old messages.
    buttons = []
    if total > 1 and paged:
        buttons.append({
            "type": 2, "label": "◀ Prev", "style": STYLE_SECONDARY,
            "custom_id": f"scrnav:{max(0, index - 1)}", "disabled": index == 0,
        })
        buttons.append({
            "type": 2, "label": "Next ▶", "style": STYLE_SECONDARY,
            "custom_id": f"scrnav:{min(total - 1, index + 1)}", "disabled": index == total - 1,
        })
    if has_inspo:
        buttons.append({"type": 2, "label": "Inspo video", "style": STYLE_LINK, "url": inspo})
    # Note button carries the script id, not the page index: a note must land
    # on the right script even if the batch changes under an old message. The
    # card never DISPLAYS notes — they are internal, and this card lives in
    # creator-facing channels — so the modal appends rather than edits.
    buttons.append({
        "type": 2, "label": "📝 Note", "style": STYLE_SECONDARY,
        "custom_id": f"scrnote:{s.get('id', '')}",
    })
    inner.append({"type": 1, "components": buttons})
    # The creator's portal — the send's main CTA. Discord forces link buttons
    # grey (colored styles can't carry a url), so prominence comes from its
    # own row + the green book instead.
    if view_all_url:
        inner.append({"type": 1, "components": [{
            "type": 2, "label": "View all scripts", "style": STYLE_LINK,
            "emoji": {"name": "📗"}, "url": view_all_url,
        }]})

    components: list[dict] = []
    # `leading` re-renders a message's existing prefix texts verbatim on page
    # flips (header + ping + test marker all survive); `marker` remains for
    # composing a fresh test send.
    #
    # A long header plus a full-length script can exceed MAX_V2_CHARS, and
    # Discord answers that with a 400 that _edit_original treats as
    # non-retryable — the click would just report "Something went wrong" every
    # time. Spend what the card left over, newest prefix first.
    budget = MAX_V2_CHARS - sum(len(c.get("content") or "") for c in inner)
    for text in leading if leading is not None else ([marker] if marker else []):
        if budget <= 0:
            break
        components.append({"type": 10, "content": _clamp(text, budget)})
        budget -= min(len(text), budget)
    components.append({"type": 17, "accent_color": ACCENT_COLOR, "components": inner})
    return {"flags": V2_FLAG, "components": components}


# Test sends (the app's 🧪 button) write nothing to the DB; the batch's
# script ids ride the message content instead, in the spoiler emitted by
# testSendContent() in src/lib/discord-send.ts.
_TEST_IDS_RE = re.compile(r"\|\|scr:([0-9a-fA-F,-]+)\|\|")
# The whole marker block (label line + spoiler), for preserving it on edits.
_TEST_MARKER_RE = re.compile(r"(?:-# [^\n]*\n)?\|\|scr:[0-9a-fA-F,-]+\|\|")


def parse_test_ids(content: str) -> list[str]:
    """Script ids from a test-send message's content marker, batch order."""
    m = _TEST_IDS_RE.search(content or "")
    return [i for i in m.group(1).split(",") if i] if m else []


# Test-only overlay: until the inspo_url/demo/songs migration is applied, the
# DB rows can't carry those fields, so test sends smuggle them in a second
# spoiler as JSON. Real sends never use this — it dies with the migration.
_TEST_EXT_RE = re.compile(r"\|\|ext:(\{.*?\})\|\|", re.S)


def parse_test_ext(content: str) -> dict:
    """{script_id: {field: value}} from a test-send's ||ext:json|| spoiler."""
    m = _TEST_EXT_RE.search(content or "")
    if not m:
        return {}
    try:
        parsed = json.loads(m.group(1))
        return parsed if isinstance(parsed, dict) else {}
    except json.JSONDecodeError:
        return {}


def merge_ext(scripts: list[dict], ext: dict) -> list[dict]:
    """Overlay per-script ext fields onto fetched rows (rows win nothing —
    ext only fills what the DB can't hold yet)."""
    return [{**s, **(ext.get(s.get("id")) or {})} for s in scripts]


def find_marker_text(texts: list[str]) -> str | None:
    """The marker text display, verbatim — re-used as-is on page flips so
    the ids AND any ext spoiler survive re-rendering."""
    return next((t for t in texts if "||scr:" in t), None)


# --- data reads/writes (blocking urllib; callers wrap in asyncio.to_thread) --


def fetch_scripts_by_ids(ids: list[str]) -> list[dict]:
    """Scripts in numbering order (created_at ascending — the Doc view's
    'Script 1' is the oldest)."""
    if not ids:
        return []
    # select=* on purpose: inspo_url/demo/songs arrive via a migration that
    # may not be applied yet, and enumerating a missing column is a 400 that
    # kills the buttons. render_page .get()s everything it uses.
    return pull.sb(
        "GET",
        f"research_scripts?select=*&id=in.({','.join(sorted(set(ids)))})&order=created_at.asc",
    )


def fetch_share_token_for_channel(channel_id: int) -> str | None:
    """The portal token of the creator this channel belongs to — None for
    unlinked channels (and the test channel), which simply drops the
    View-all button from re-rendered pages."""
    rows = pull.sb(
        "GET",
        "research_discord_channels"
        f"?channel_id=eq.{channel_id}&select=research_creators(share_token)&limit=1",
    )
    creator = (rows or [{}])[0].get("research_creators") or {}
    return creator.get("share_token") or None


def fetch_batch(message_id: int) -> list[dict]:
    """The scripts a paged message carries, via its assignment rows."""
    assignments = pull.sb(
        "GET",
        f"research_script_assignments?select=script_id&discord_message_id=eq.{message_id}",
    )
    return fetch_scripts_by_ids([a["script_id"] for a in assignments])


# --- inspo video resolution --------------------------------------------------
# Mirrors src/lib/inspo-media.ts: Instagram blocks Discord's unfurler, so the
# reference only reliably PLAYS when the mp4 itself is attached. Files cache
# under worker/data/media/inspo/ so page flips don't re-download.

# Discord's total character budget for a Components V2 message. The per-field
# clamps above sum to ~3850, which leaves very little for `leading` — so the
# prefix is trimmed to what actually remains rather than assumed free.
MAX_V2_CHARS = 4000

MAX_ATTACHMENT_BYTES = 9_500_000
# Oversize sources get transcoded down to this instead of dropped — "always
# displays as a video" beats full quality. Verified empirically: this guild
# 413s bot uploads over 10MB.
TARGET_TRANSCODE_BYTES = 8_500_000
_HARD_DOWNLOAD_CAP = 200_000_000
_MEDIA_EXT_RE = re.compile(r"\.(mp4|mov|webm|m4v)(\?|$)", re.I)
_CACHE_DIR = Path(__file__).resolve().parent.parent / "data" / "media" / "inspo"


def target_bitrate_kbps(duration_seconds: float) -> int:
    """Video bitrate that lands the transcode near the target size:
    total budget minus 96k audio, with 10% container headroom."""
    budget = TARGET_TRANSCODE_BYTES * 8 / 1000 / duration_seconds * 0.9 - 96
    return max(200, int(budget))


def _fit_video(src: Path, dest: Path) -> Path | None:
    """Transcode an oversize video under the upload cap (720p H.264)."""
    import subprocess

    try:
        probe = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "csv=p=0", str(src)],
            capture_output=True, text=True, timeout=60,
        )
        duration = float(probe.stdout.strip())
    except Exception:
        return None
    if duration <= 0:
        return None
    kbps = target_bitrate_kbps(duration)
    result = subprocess.run(
        ["ffmpeg", "-y", "-i", str(src),
         "-vf", "scale=-2:'min(720,ih)'",
         "-c:v", "libx264", "-preset", "veryfast",
         "-b:v", f"{kbps}k", "-maxrate", f"{int(kbps * 1.4)}k", "-bufsize", f"{kbps * 2}k",
         "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", str(dest)],
        capture_output=True, timeout=600,
    )
    if result.returncode != 0 or not dest.exists():
        return None
    return dest if dest.stat().st_size <= MAX_ATTACHMENT_BYTES else None


def detect_platform(url: str) -> str | None:
    try:
        host = urllib.parse.urlparse(url).hostname or ""
    except ValueError:
        return None
    if host == "instagram.com" or host.endswith(".instagram.com"):
        return "instagram"
    if host == "tiktok.com" or host.endswith(".tiktok.com"):
        return "tiktok"
    if _MEDIA_EXT_RE.search(url):
        return "file"
    return None


def extract_video_url(platform: str, payload: dict) -> str | None:
    if platform == "instagram":
        item = (payload.get("data") or {}).get("xdt_shortcode_media") or {}
        versions = item.get("video_versions") or [{}]
        return item.get("video_url") or versions[0].get("url")
    vid = (payload.get("aweme_detail") or {}).get("video") or {}
    for key in ("play_addr", "download_addr"):
        lst = (vid.get(key) or {}).get("url_list") or []
        if lst:
            return lst[0]
    return None


def _download(url: str, dest: Path) -> Path | None:
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            data = r.read(_HARD_DOWNLOAD_CAP + 1)
    except Exception:
        return None
    if not data or len(data) > _HARD_DOWNLOAD_CAP:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_bytes(data)
    return dest


def _obtain(url: str, cached: Path) -> Path | None:
    """Download to the cache; transcode down when over the upload cap."""
    tmp = cached.with_suffix(".dl.mp4")
    try:
        if _download(url, tmp) is None:
            return None
        if tmp.stat().st_size <= MAX_ATTACHMENT_BYTES:
            tmp.replace(cached)
            return cached
        return _fit_video(tmp, cached)
    finally:
        tmp.unlink(missing_ok=True)


# A failed resolution is remembered briefly (don't hammer the APIs on every
# click) but never forever — the goal is ALWAYS showing the video, and CDN
# hiccups are transient.
SKIP_TTL_SECONDS = 3600


def _skip_active(skip: Path) -> bool:
    import time

    try:
        return time.time() - skip.stat().st_mtime < SKIP_TTL_SECONDS
    except OSError:
        return False


def _ytdlp_download(url: str, dest: Path) -> Path | None:
    """Last resort: yt-dlp handles the CDN quirks (TikTok 403s, IG DASH)."""
    import subprocess

    # The local venv first (Joey's Mac), then PATH (the container, where
    # .dockerignore excludes worker/.venv so the venv copy can never exist).
    venv_ytdlp = Path(__file__).resolve().parent.parent / ".venv" / "bin" / "yt-dlp"
    ytdlp = str(venv_ytdlp) if venv_ytdlp.exists() else shutil.which("yt-dlp")
    if not ytdlp:
        return None
    dest.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [ytdlp, "-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4",
         "-o", str(dest), "--no-playlist", "--quiet", url],
        capture_output=True, timeout=300,
    )
    if result.returncode != 0 or not dest.exists() or dest.stat().st_size == 0:
        return None
    if dest.stat().st_size <= MAX_ATTACHMENT_BYTES:
        return dest
    fitted = dest.with_suffix(".fit.mp4")
    ok = _fit_video(dest, fitted)
    if ok:
        fitted.replace(dest)
        return dest
    dest.unlink(missing_ok=True)
    return None


def resolve_inspo_media(url: str) -> Path | None:
    """Local mp4 for an inspo link, or None to fall back to the link line."""
    platform = detect_platform(url)
    if not platform:
        return None
    stem = hashlib.md5(url.encode()).hexdigest()[:16]
    cached = _CACHE_DIR / f"{stem}.mp4"
    skip = _CACHE_DIR / f"{stem}.skip"
    if cached.exists():
        return cached
    if _skip_active(skip):
        return None

    result: Path | None = None
    if platform == "file":
        result = _obtain(url, cached)
    else:
        # Our own stored copy first, then a fresh Scrape Creators lookup.
        clean = url.split("?")[0].rstrip("/")
        quoted = urllib.parse.quote(clean, safe="")
        rows = pull.sb(
            "GET",
            f"research_videos?select=video_url&or=(url.eq.{quoted},url.eq.{quoted}%2F)"
            "&video_url=not.is.null&limit=1",
        )
        if rows and rows[0].get("video_url"):
            result = _obtain(rows[0]["video_url"], cached)
        if result is None:
            key = os.environ.get("SCRAPECREATORS_API_KEY")
            if key:
                endpoint = (
                    "https://api.scrapecreators.com/v1/instagram/post"
                    if platform == "instagram"
                    else "https://api.scrapecreators.com/v2/tiktok/video"
                )
                try:
                    req = urllib.request.Request(
                        endpoint + "?" + urllib.parse.urlencode({"url": url}),
                        headers={"x-api-key": key},
                    )
                    with urllib.request.urlopen(req, timeout=90) as r:
                        payload = json.loads(r.read())
                    video_url = extract_video_url(platform, payload)
                    if video_url:
                        result = _obtain(video_url, cached)
                except Exception:
                    result = None
        if result is None:
            result = _ytdlp_download(url, cached)

    if result is None:
        skip.parent.mkdir(parents=True, exist_ok=True)
        skip.touch()
    return result


def _upload_storage(local: Path, path: str) -> str | None:
    """Into the public `videos` bucket (same pattern as the transcribe
    worker); returns the permanent public URL."""
    try:
        req = urllib.request.Request(
            f"{pull.SUPA}/storage/v1/object/videos/{path}",
            data=local.read_bytes(),
            method="POST",
            headers={
                "Authorization": f"Bearer {pull.KEY}", "apikey": pull.KEY,
                "Content-Type": "video/mp4", "x-upsert": "true",
            },
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            r.read()
        return f"{pull.SUPA}/storage/v1/object/public/videos/{path}"
    except Exception:
        return None


def resolve_inspo_public_url(url: str) -> str | None:
    """Permanent public URL for an inspo link's video.

    The V2 gallery references this URL directly, so nothing is ever uploaded
    to Discord — page flips are a pure JSON edit. Order: already-public
    storage copy in research_videos → local obtain (SC / yt-dlp / transcode)
    then a one-time upload into the `videos` bucket. URL cached in a sidecar
    next to the media cache."""
    platform = detect_platform(url)
    if not platform:
        return None
    stem = hashlib.md5(url.encode()).hexdigest()[:16]
    sidecar = _CACHE_DIR / f"{stem}.url"
    if sidecar.exists():
        return sidecar.read_text().strip() or None
    skip = _CACHE_DIR / f"{stem}.skip"
    if _skip_active(skip):
        return None

    public = None
    if platform != "file":
        clean = url.split("?")[0].rstrip("/")
        quoted = urllib.parse.quote(clean, safe="")
        rows = pull.sb(
            "GET",
            f"research_videos?select=video_url&or=(url.eq.{quoted},url.eq.{quoted}%2F)"
            "&video_url=not.is.null&limit=1",
        )
        stored = rows[0].get("video_url") if rows else None
        # Only our own storage links are permanent; raw CDN links expire.
        if stored and "/storage/v1/object/public/" in stored:
            public = stored
    if public is None:
        local = resolve_inspo_media(url)
        if local is not None:
            public = _upload_storage(local, f"inspo/{stem}.mp4")

    if public:
        _CACHE_DIR.mkdir(parents=True, exist_ok=True)
        sidecar.write_text(public)
    else:
        skip.parent.mkdir(parents=True, exist_ok=True)
        skip.touch()
    return public


def modal_note_value(data: dict) -> str:
    """The "note" text-input value from a modal_submit interaction payload."""
    for row in data.get("components") or []:
        for c in row.get("components") or []:
            if c.get("custom_id") == "note":
                return str(c.get("value") or "").strip()
    return ""


def append_note(script_id: str, author: str, text: str) -> bool:
    """Append one attributed line to the script's internal notes.

    Append, never overwrite: the modal is open to anyone who can see the card,
    and it deliberately does not pre-fill existing notes (they are internal),
    so a submit must not be able to clobber what is already there. The webapp's
    notes field is where notes get edited or pruned.
    """
    text = text.strip()
    if not text:
        return False
    rows = pull.sb("GET", f"research_scripts?select=notes&id=eq.{script_id}")
    if not rows:
        return False
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    line = f"[{stamp} {author}] {text}"
    existing = (rows[0].get("notes") or "").rstrip()
    updated = pull.sb(
        "PATCH",
        f"research_scripts?id=eq.{script_id}",
        {"notes": f"{existing}\n{line}" if existing else line},
    )
    return bool(updated)


def mark_posted(message_id: int, script_id: str) -> bool:
    """Flip the assignment behind this message page to Posted."""
    updated = pull.sb(
        "PATCH",
        "research_script_assignments"
        f"?discord_message_id=eq.{message_id}&script_id=eq.{script_id}",
        {
            "status": "Posted",
            "posted_at": datetime.now(timezone.utc).isoformat(),
        },
    )
    return bool(updated)
