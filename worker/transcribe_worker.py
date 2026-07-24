#!/usr/bin/env python3
"""
Local research transcription worker (runs on your machine, not Vercel).

Claims `pending` rows from `research_videos`, then per video:
  1. fetch media — stored CDN URL, yt-dlp, or Apify fallback (muxing DASH
     video-only + audio renditions with ffmpeg when needed)
  2. upload the playable mp4 to the public `videos` storage bucket
  3. transcribe with WhisperX (if installed) or OpenAI Whisper (if key set)
  4. push transcript + timestamped segments back to Supabase

Media files stay local in worker/data/media/ — only text goes to the cloud.

Setup:  pip install -r worker/requirements.txt          (yt-dlp only)
        optional: pip install whisperx  (+ ffmpeg)      for local transcription
Run:    python3 worker/transcribe_worker.py --once      (process queue and exit)
        python3 worker/transcribe_worker.py             (poll every 60s)

Env (read from ../.env.local automatically): NEXT_PUBLIC_SUPABASE_URL,
SUPABASE_SERVICE_ROLE_KEY, optional OPENAI_API_KEY, APIFY_TOKEN,
APIFY_INSTAGRAM_ACTOR_ID, APIFY_TIKTOK_ACTOR_ID.
"""
from __future__ import annotations

import argparse
import json
import mimetypes
import os
import re
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MEDIA_DIR = ROOT / "data" / "media"
MEDIA_DIR.mkdir(parents=True, exist_ok=True)


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
    with urllib.request.urlopen(req) as r:
        body = r.read()
        return json.loads(body) if body else None


# --- SRT helpers -------------------------------------------------------------

TIME_RE = re.compile(r"(\d+):(\d+):(\d+)[,.](\d+)")


def srt_time_to_secs(value: str) -> float | None:
    m = TIME_RE.search(value)
    if not m:
        return None
    h, mn, s, ms = (int(x) for x in m.groups())
    return h * 3600 + mn * 60 + s + ms / 1000


def parse_srt(srt: str) -> list[dict]:
    """SRT/VTT blocks -> [{position, start_time, end_time, text}]."""
    segments: list[dict] = []
    for block in re.split(r"\n\s*\n", srt.replace("\r\n", "\n").strip()):
        lines = [l.strip() for l in block.split("\n") if l.strip()]
        if not lines:
            continue
        if re.fullmatch(r"\d+", lines[0]):
            lines = lines[1:]  # drop index line
        if not lines or "-->" not in lines[0]:
            continue
        start_raw, _, end_raw = lines[0].partition("-->")
        text = " ".join(lines[1:]).strip()
        text = re.sub(r"<[^>]+>", "", text)  # strip VTT styling tags
        if not text:
            continue
        segments.append({
            "position": len(segments),
            "start_time": srt_time_to_secs(start_raw),
            "end_time": srt_time_to_secs(end_raw),
            "text": text,
        })
    return segments


# --- yt-dlp ------------------------------------------------------------------

def ytdlp_download(url: str, dest_stem: Path) -> Path | None:
    import yt_dlp  # type: ignore

    opts = {
        "quiet": True,
        "outtmpl": str(dest_stem) + ".%(ext)s",
        "format": "mp4/bestvideo*+bestaudio/best",
        "noplaylist": True,
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            ydl.extract_info(url, download=True)
    except Exception as e:
        print(f"    yt-dlp download failed: {e}")
        return None
    for f in dest_stem.parent.glob(dest_stem.name + ".*"):
        if f.suffix in (".mp4", ".webm", ".mkv", ".mov", ".m4a"):
            return f
    return None


# --- Apify fallback (stubborn Instagram/TikTok downloads) --------------------

def apify_download(url: str, platform: str | None, dest_stem: Path) -> tuple[Path | None, dict]:
    token = os.environ.get("APIFY_TOKEN")
    if not token or platform not in ("instagram", "tiktok"):
        return None, {}
    if platform == "instagram":
        actor = os.environ.get("APIFY_INSTAGRAM_ACTOR_ID", "apify~instagram-scraper")
        payload = {"directUrls": [url], "resultsLimit": 1, "resultsType": "posts"}
    else:
        actor = os.environ.get("APIFY_TIKTOK_ACTOR_ID", "clockworks~tiktok-scraper")
        payload = {"postURLs": [url], "resultsPerPage": 1, "shouldDownloadVideos": True}
    actor = actor.replace("/", "~")
    endpoint = f"https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items?token={urllib.parse.quote(token)}&timeout=180"
    try:
        req = urllib.request.Request(endpoint, data=json.dumps(payload).encode(),
                                     headers={"Content-Type": "application/json"}, method="POST")
        with urllib.request.urlopen(req, timeout=200) as r:
            items = json.loads(r.read())
    except Exception as e:
        print(f"    apify failed: {e}")
        return None, {}
    if not items:
        return None, {}
    item = items[0]
    # We transcribe, so AUDIO is what matters. IG often serves DASH renditions
    # where videoUrl is video-only and the audio track is separate (audioUrl).
    candidates = [
        (item.get("audioUrl"), ".m4a"),
        (item.get("videoUrl") or item.get("video_url"), ".mp4"),
        ((item.get("videoUrls") or [None])[0], ".mp4"),
        ((item.get("mediaUrls") or [None])[0], ".mp4"),
        ((item.get("videoMeta") or {}).get("downloadAddr"), ".mp4"),
    ]
    for media_url, ext in candidates:
        if not media_url:
            continue
        dest = dest_stem.with_suffix(ext)
        try:
            with urllib.request.urlopen(media_url, timeout=120) as r, open(dest, "wb") as f:
                f.write(r.read())
            return dest, item
        except Exception as e:
            print(f"    apify media download failed ({ext}): {e}")
    return None, item


# --- transcription -----------------------------------------------------------

_WHISPERX_MODEL = None  # cached across videos — large-v3 takes ~a minute to load


def transcribe_whisperx(media: Path) -> list[dict] | None:
    global _WHISPERX_MODEL
    try:
        import whisperx  # type: ignore
    except ImportError:
        return None
    device = "cpu"
    try:
        import torch  # type: ignore
        if torch.cuda.is_available():
            device = "cuda"
    except ImportError:
        pass
    model_name = os.environ.get("WHISPERX_MODEL", "large-v3")
    compute = os.environ.get("WHISPERX_COMPUTE_TYPE", "int8" if device == "cpu" else "float16")
    # Silero avoids the pyannote-VAD torch.load(weights_only=True) failure.
    vad_method = os.environ.get("WHISPERX_VAD_METHOD", "silero")
    print(f"    whisperx: {model_name} on {device} ({compute}, vad={vad_method})")
    if _WHISPERX_MODEL is None:
        _WHISPERX_MODEL = whisperx.load_model(model_name, device, compute_type=compute, vad_method=vad_method)
    model = _WHISPERX_MODEL
    audio = whisperx.load_audio(str(media))
    result = model.transcribe(audio, batch_size=8)
    segs = []
    for i, seg in enumerate(result.get("segments", [])):
        text = (seg.get("text") or "").strip()
        if text:
            segs.append({"position": i, "start_time": seg.get("start"), "end_time": seg.get("end"), "text": text})
    return segs or None


def transcribe_openai(media: Path) -> list[dict] | None:
    api_key = os.environ.get("OPENAI_API_KEY")
    if not api_key:
        return None
    boundary = uuid.uuid4().hex
    content_type = mimetypes.guess_type(media.name)[0] or "video/mp4"
    parts = [
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"model\"\r\n\r\nwhisper-1\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"response_format\"\r\n\r\nsrt\r\n".encode(),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{media.name}\"\r\n"
        f"Content-Type: {content_type}\r\n\r\n".encode(),
        media.read_bytes(),
        f"\r\n--{boundary}--\r\n".encode(),
    ]
    req = urllib.request.Request(
        "https://api.openai.com/v1/audio/transcriptions",
        data=b"".join(parts),
        headers={"Authorization": f"Bearer {api_key}",
                 "Content-Type": f"multipart/form-data; boundary={boundary}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as r:
            srt = r.read().decode("utf-8", "replace")
        return parse_srt(srt) or None
    except Exception as e:
        print(f"    openai whisper failed: {e}")
        return None


# --- helpers ------------------------------------------------------------------

def detect_platform(url: str) -> str | None:
    """Derive platform from the URL host — never trust the stored column
    (legacy imports carry strings like 'Instagram URL download')."""
    host = urllib.parse.urlparse(url).hostname or ""
    if "instagram.com" in host:
        return "instagram"
    if "tiktok.com" in host:
        return "tiktok"
    if "youtube.com" in host or "youtu.be" in host:
        return "youtube"
    return None


SENTENCE_RE = re.compile(r"[^.!?]+[.!?]*\s*")
# "a.m."/"p.m." was splitting into "…5 a." + "m." — the INNER dot must never
# split. The trailing dot is a real sentence end only when a capital follows.
# No re.I — it would make the [A-Z] "capital follows" lookahead match lowercase.
ABBREV_END_RE = re.compile(r"\b([apAP])\.[mM]\.(?=\s+[A-Z])")
ABBREV_MID_RE = re.compile(r"\b([apAP])\.[mM]\.")


def split_sentences(text: str) -> list[str]:
    protected = ABBREV_END_RE.sub(lambda m: f"{m.group(1)}․m.", text)  # keep final dot
    protected = ABBREV_MID_RE.sub(lambda m: f"{m.group(1)}․m․", protected)
    return [
        m.group(0).strip().replace("․", ".")
        for m in SENTENCE_RE.finditer(protected)
        if m.group(0).strip()
    ]


def refine_segments(segments: list[dict]) -> list[dict]:
    """WhisperX + Silero VAD often returns 30s+ blocks on fast-talking reels.
    Split each block into sentences, interpolating timestamps by character
    position, so the app can show a readable line-by-line script."""
    out: list[dict] = []
    for seg in segments:
        sentences = split_sentences(seg["text"])
        if len(sentences) <= 1:
            out.append({**seg, "position": len(out)})
            continue
        start = seg.get("start_time")
        end = seg.get("end_time")
        dur = (end - start) if (start is not None and end is not None and end > start) else None
        total_chars = sum(len(s) for s in sentences) or 1
        t = start
        for s in sentences:
            seg_end = (t + dur * (len(s) / total_chars)) if (dur is not None and t is not None) else None
            out.append({
                "position": len(out),
                "start_time": round(t, 2) if t is not None else None,
                "end_time": round(seg_end, 2) if seg_end is not None else None,
                "text": s,
            })
            if seg_end is not None:
                t = seg_end
    return out


def download_direct(media_url: str, dest_stem: Path, ext: str = ".mp4") -> Path | None:
    """Straight download of a signed CDN URL from the scrape — no rate limits,
    but the URL expires within days of the scrape."""
    dest = dest_stem.with_suffix(ext)
    try:
        req = urllib.request.Request(media_url, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=120) as r, open(dest, "wb") as f:
            f.write(r.read())
        return dest if dest.stat().st_size > 1024 else None
    except Exception as e:
        print(f"    direct download failed: {e}")
        return None


def has_audio(media: Path) -> bool:
    """Instagram serves DASH renditions where videoUrl is video-ONLY — such a
    file transcribes to nothing, so reject it before wasting a WhisperX run."""
    import subprocess
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "a",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(media)],
            capture_output=True, text=True, timeout=30,
        )
        return "audio" in out.stdout
    except Exception:
        return True  # no ffprobe — let the transcriber try its luck


def mux_av(video_f: Path, audio_f: Path, dest: Path) -> Path | None:
    """Join a DASH video-only mp4 with its separate audio track (stream copy,
    no re-encode) so the app gets ONE playable file with sound."""
    import subprocess
    try:
        r = subprocess.run(
            ["ffmpeg", "-y", "-i", str(video_f), "-i", str(audio_f),
             "-c", "copy", "-map", "0:v:0", "-map", "1:a:0", str(dest)],
            capture_output=True, timeout=180,
        )
        if r.returncode == 0 and dest.exists() and dest.stat().st_size > 1024:
            return dest
        print(f"    ffmpeg mux failed: {r.stderr.decode()[-200:]}")
        return None
    except Exception as e:
        print(f"    ffmpeg mux failed: {e}")
        return None


def upload_storage(local: Path, bucket: str, path: str, content_type: str) -> str | None:
    """Upload into a public Supabase Storage bucket, return the permanent URL.
    CDN links 403 when hotlinked + expire."""
    try:
        req = urllib.request.Request(
            f"{SUPA}/storage/v1/object/{bucket}/{path}",
            data=local.read_bytes(),
            method="POST",
            headers={
                "Authorization": f"Bearer {KEY}", "apikey": KEY,
                "Content-Type": content_type, "x-upsert": "true",
            },
        )
        with urllib.request.urlopen(req, timeout=300) as r:
            r.read()
        return f"{SUPA}/storage/v1/object/public/{bucket}/{path}"
    except Exception as e:
        print(f"    storage upload failed: {e}")
        return None


# --- research pipeline --------------------------------------------------------

def acquire_research_media(video: dict) -> tuple[Path | None, Path | None]:
    """Get (playable_mp4_with_audio, transcription_source) for a research row.
    The video file and audio track are fetched separately when Instagram
    serves DASH renditions, then muxed."""
    vid = video["id"]
    url = video["url"]
    stem = MEDIA_DIR / f"research-{vid}"

    # Reuse what a previous run already produced.
    muxed_dest = MEDIA_DIR / f"research-{vid}-muxed.mp4"
    if muxed_dest.exists() and muxed_dest.stat().st_size > 1024:
        return muxed_dest, muxed_dest
    local_mp4 = stem.with_suffix(".mp4")
    if local_mp4.exists() and has_audio(local_mp4):
        return local_mp4, local_mp4

    video_f = None
    stored = video.get("video_url")
    if stored and "/storage/" not in stored:
        video_f = download_direct(stored, stem, ".mp4")
    if not video_f:
        video_f = ytdlp_download(url, stem)  # yt-dlp merges A/V itself
    if not video_f:
        video_f, _ = apify_download(url, detect_platform(url), stem)

    if video_f and has_audio(video_f):
        return video_f, video_f

    # Video-only (or nothing): pull the separate audio rendition.
    audio_f = None
    audio_url = video.get("audio_url")
    if audio_url:
        audio_f = download_direct(audio_url, MEDIA_DIR / f"research-{vid}-audio", ".m4a")

    if video_f and audio_f:
        muxed = mux_av(video_f, audio_f, muxed_dest)
        if muxed:
            return muxed, muxed
        return None, audio_f  # can still transcribe; nothing playable to upload
    if audio_f:
        return None, audio_f
    if video_f:
        return None, None  # silent video is useless for transcription AND playback
    return None, None


def process_research(video: dict) -> None:
    """Transcribe one research_videos row AND publish a playable copy: fetch
    video + audio (muxing DASH renditions), upload the playable mp4 to the
    public `videos` bucket, transcribe, push everything back."""
    vid = video["id"]
    url = video["url"]
    print(f"  → [research] {url}")
    sb("PATCH", f"research_videos?id=eq.{vid}",
       {"transcript_status": "fetching", "error_message": None}, prefer="return=minimal")

    playable, transcribe_src = acquire_research_media(video)
    if not transcribe_src:
        raise RuntimeError(
            "could not fetch audio (stored URLs, yt-dlp and apify all failed or were audio-less)"
        )

    segments = transcribe_whisperx(transcribe_src)
    method = "whisperx local" if segments else None
    if not segments:
        segments = transcribe_openai(transcribe_src)
        method = "openai whisper-1" if segments else None
    if not segments:
        raise RuntimeError(
            "media downloaded but no transcriber available — "
            "pip install whisperx (recommended) or set OPENAI_API_KEY"
        )
    segments = refine_segments(segments)

    update = {
        "transcript_status": "transcribed",
        "transcript_text": " ".join(s["text"] for s in segments),
        "transcript_method": method,
        "updated_at": "now()",
    }
    if playable:
        public_url = upload_storage(playable, "videos", f"research/{vid}.mp4", "video/mp4")
        if public_url:
            update["video_url"] = public_url
    # Duration from the last segment end — better than nothing, cheap.
    if video.get("duration_seconds") is None and segments[-1].get("end_time"):
        update["duration_seconds"] = segments[-1]["end_time"]
    sb("PATCH", f"research_videos?id=eq.{vid}", update, prefer="return=minimal")

    sb("DELETE", f"research_video_segments?research_video_id=eq.{vid}", prefer="return=minimal")
    rows = [{**seg, "research_video_id": vid} for seg in segments]
    for i in range(0, len(rows), 200):
        sb("POST", "research_video_segments", rows[i:i + 200], prefer="return=minimal")
    print(f"    ✓ {len(segments)} segments via {method}")


def backfill_research_media(limit: int = 15) -> int:
    """Publish playable copies for rows transcribed BEFORE storage uploads
    existed (their video_url still points at the expiring Instagram CDN)."""
    rows = sb(
        "GET",
        "research_videos?transcript_status=eq.transcribed"
        "&or=(video_url.is.null,video_url.not.like.*storage/v1*)"
        f"&select=id,url,video_url,audio_url:raw_metadata->>audioUrl"
        f"&order=view_count.desc.nullslast&limit={limit}",
    )
    done = 0
    for video in rows or []:
        try:
            print(f"  → [media backfill] {video['url']}")
            playable, _ = acquire_research_media(video)
            if not playable:
                print("    ✗ no playable media with audio")
                continue
            public_url = upload_storage(playable, "videos", f"research/{video['id']}.mp4", "video/mp4")
            if public_url:
                sb("PATCH", f"research_videos?id=eq.{video['id']}",
                   {"video_url": public_url, "updated_at": "now()"}, prefer="return=minimal")
                done += 1
                print("    ✓ uploaded")
        except Exception as e:
            print(f"    ✗ {e}")
    return done


def run_once() -> int:
    done = 0

    # Highest view count first so likely S-tier videos get transcripts soonest
    # (format analysis starts with the winners).
    research = sb(
        "GET",
        "research_videos?transcript_status=eq.pending"
        "&order=view_count.desc.nullslast&limit=25"
        "&select=id,url,video_url,duration_seconds,audio_url:raw_metadata->>audioUrl",
    )
    for video in research or []:
        try:
            process_research(video)
            done += 1
        except Exception as e:
            print(f"    ✗ {e}")
            sb("PATCH", f"research_videos?id=eq.{video['id']}",
               {"transcript_status": "failed", "error_message": str(e)[:500]},
               prefer="return=minimal")

    # Rows transcribed before storage uploads existed still need playable copies.
    done += backfill_research_media()
    return done


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true", help="process the queue once and exit")
    args = parser.parse_args()
    print(f"worker: {SUPA}")
    while True:
        n = run_once()
        print(f"processed {n} video(s)")
        if args.once:
            break
        time.sleep(60)
