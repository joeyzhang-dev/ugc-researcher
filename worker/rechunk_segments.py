#!/usr/bin/env python3
"""Re-chunk transcript segments already stored in Supabase.

Transcripts written before the script-style chunker landed contain 30-second,
700-character run-on blocks (Whisper returns fast-talking reels unpunctuated,
and the old splitter only broke on [.!?]). This replays `refine_segments` over
the stored text so the review panel reads like a script, without paying to
re-transcribe 1,600 videos.

Timestamps for split lines are interpolated by character share — the original
block boundaries are preserved exactly, so nothing drifts.

    python3 worker/rechunk_segments.py --dry-run      # report only
    python3 worker/rechunk_segments.py                # rewrite changed videos
    python3 worker/rechunk_segments.py --limit 20
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_env() -> None:
    try:
        for line in (ROOT / ".env.local").read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip().strip('"'))
    except OSError:
        pass


load_env()

SUPA = os.environ.get("NEXT_PUBLIC_SUPABASE_URL")
KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
if not SUPA or not KEY:
    sys.exit("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local)")

# Import the worker for refine_segments so the chunking rules live in exactly
# one place. Importing it is side-effect free (it only runs on __main__).
spec = importlib.util.spec_from_file_location("transcribe_worker", ROOT / "worker" / "transcribe_worker.py")
worker = importlib.util.module_from_spec(spec)
assert spec.loader
spec.loader.exec_module(worker)


def rest(method: str, path: str, body=None, prefer: str | None = None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{SUPA}/rest/v1/{path}", data=data, method=method)
    req.add_header("apikey", KEY)
    req.add_header("Authorization", f"Bearer {KEY}")
    req.add_header("Content-Type", "application/json")
    if prefer:
        req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{e.code} {e.read().decode('utf-8', 'replace')[:300]}") from None


def fetch_all_segments() -> dict[str, list[dict]]:
    """Page through every segment, grouped by video, ordered by position."""
    by_video: dict[str, list[dict]] = {}
    page = 1000
    offset = 0
    while True:
        rows = rest(
            "GET",
            "research_video_segments"
            "?select=research_video_id,position,start_time,end_time,text"
            f"&order=research_video_id.asc,position.asc&limit={page}&offset={offset}",
        )
        if not rows:
            break
        for row in rows:
            by_video.setdefault(row["research_video_id"], []).append(row)
        if len(rows) < page:
            break
        offset += page
    return by_video


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--limit", type=int)
    args = ap.parse_args()

    by_video = fetch_all_segments()
    print(f"{len(by_video)} videos, {sum(len(v) for v in by_video.values())} segments")

    changed: list[tuple[str, list[dict], int]] = []
    for vid, rows in by_video.items():
        current = [
            {
                "position": r["position"],
                "start_time": r["start_time"],
                "end_time": r["end_time"],
                "text": r["text"],
            }
            for r in rows
        ]
        refined = worker.refine_segments(current)
        if [s["text"] for s in refined] != [s["text"] for s in current]:
            changed.append((vid, refined, len(current)))

    if args.limit:
        changed = changed[: args.limit]

    worst = max((len(r["text"]) for rows in by_video.values() for r in rows), default=0)
    print(f"{len(changed)} videos need re-chunking (longest stored line: {worst} chars)")

    if args.dry_run:
        for vid, refined, before in changed[:5]:
            print(f"\n--- {vid}: {before} -> {len(refined)} lines")
            for s in refined[:8]:
                print(f"    {s['start_time']}  {s['text'][:100]}")
        return

    ok = failed = 0
    for i, (vid, refined, _before) in enumerate(changed, 1):
        try:
            rest("DELETE", f"research_video_segments?research_video_id=eq.{vid}", prefer="return=minimal")
            rows = [{**seg, "research_video_id": vid} for seg in refined]
            for j in range(0, len(rows), 200):
                rest("POST", "research_video_segments", rows[j : j + 200], prefer="return=minimal")
            ok += 1
        except Exception as e:
            failed += 1
            print(f"  ✗ {vid}: {e}")
        if i % 25 == 0:
            print(f"  … {i}/{len(changed)}")

    print(f"re-chunked {ok} videos, {failed} failed")


if __name__ == "__main__":
    main()
