/**
 * Turn a script's inspo link into an actual video file for Discord.
 *
 * Instagram blocks Discord's unfurler, so a bare link renders as dead text —
 * the only way a reference video reliably PLAYS in the channel is attaching
 * the mp4 itself. Resolution order:
 *   1. our own copy — research_videos rows whose url matches (stored CDN /
 *      storage link from the transcribe worker);
 *   2. Scrape Creators post lookup (same endpoints the transcribe worker
 *      uses) for a fresh signed CDN URL;
 *   3. direct download when the link already points at a media file.
 * Anything unresolvable (or over Discord's upload cap) returns null and the
 * caller falls back to the plain link line.
 *
 * worker/discord_bot/script_pager.py mirrors this for page flips.
 */

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAdminClient } from "@/lib/supabase/admin";

/** Bot upload cap is 10MB on this guild (verified: 12.9MB → 413). */
export const MAX_ATTACHMENT_BYTES = 9_500_000;
/** Oversize sources are transcoded down to about this instead of dropped. */
export const TARGET_TRANSCODE_BYTES = 8_500_000;
const HARD_DOWNLOAD_CAP = 200_000_000;

const MEDIA_EXT = /\.(mp4|mov|webm|m4v)(\?|$)/i;

/** Video bitrate that lands the transcode near the target size: total budget
 *  minus 96k audio, 10% container headroom. Mirrors the Python pager. */
export function targetBitrateKbps(durationSeconds: number): number {
  const budget = (TARGET_TRANSCODE_BYTES * 8) / 1000 / durationSeconds * 0.9 - 96;
  return Math.max(200, Math.floor(budget));
}

/** Transcode an oversize video under the upload cap (720p H.264). */
function fitVideo(data: ArrayBuffer): ArrayBuffer | null {
  const dir = mkdtempSync(join(tmpdir(), "inspo-"));
  const src = join(dir, "src.mp4");
  const out = join(dir, "out.mp4");
  try {
    writeFileSync(src, Buffer.from(data));
    const probe = spawnSync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", src],
      { encoding: "utf8", timeout: 60_000 }
    );
    const duration = parseFloat(probe.stdout?.trim() ?? "");
    if (!Number.isFinite(duration) || duration <= 0) return null;
    const kbps = targetBitrateKbps(duration);
    const run = spawnSync(
      "ffmpeg",
      ["-y", "-i", src, "-vf", "scale=-2:'min(720,ih)'",
       "-c:v", "libx264", "-preset", "veryfast",
       "-b:v", `${kbps}k`, "-maxrate", `${Math.floor(kbps * 1.4)}k`, "-bufsize", `${kbps * 2}k`,
       "-c:a", "aac", "-b:a", "96k", "-movflags", "+faststart", out],
      { timeout: 600_000 }
    );
    if (run.status !== 0) return null;
    const fitted = readFileSync(out);
    if (fitted.byteLength === 0 || fitted.byteLength > MAX_ATTACHMENT_BYTES) return null;
    return fitted.buffer.slice(fitted.byteOffset, fitted.byteOffset + fitted.byteLength);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where a resolved inspo video lands in the `videos` bucket — deterministic
 *  (md5 of the ORIGINAL link), so the portal can look up already-resolved
 *  videos without downloading anything. Mirrors the Python pager's stem. */
export function inspoStoragePath(url: string): string {
  return `inspo/${createHash("md5").update(url).digest("hex").slice(0, 16)}.mp4`;
}

export type InspoPlatform = "instagram" | "tiktok" | "file";

export function detectPlatform(url: string): InspoPlatform | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
  if (/(^|\.)tiktok\.com$/.test(host)) return "tiktok";
  if (MEDIA_EXT.test(url)) return "file";
  return null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Direct video URL out of a Scrape Creators post payload. Shapes mirror
 *  worker/transcribe_worker.py's scrapecreators_download. */
export function extractVideoUrl(platform: "instagram" | "tiktok", payload: any): string | null {
  if (platform === "instagram") {
    const item = payload?.data?.xdt_shortcode_media ?? {};
    return item.video_url ?? item.video_versions?.[0]?.url ?? null;
  }
  const vid = payload?.aweme_detail?.video ?? {};
  return vid.play_addr?.url_list?.[0] ?? vid.download_addr?.url_list?.[0] ?? null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function fetchVideo(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(120_000) });
    if (!res.ok) return null;
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > HARD_DOWNLOAD_CAP) return null;
    const data = await res.arrayBuffer();
    if (data.byteLength === 0 || data.byteLength > HARD_DOWNLOAD_CAP) return null;
    if (data.byteLength <= MAX_ATTACHMENT_BYTES) return data;
    return fitVideo(data);
  } catch {
    return null;
  }
}

/** Last resort: yt-dlp (from the worker venv) handles CDN quirks —
 *  TikTok 403s on plain fetches, Instagram DASH splits. */
function ytdlpDownload(url: string): ArrayBuffer | null {
  const ytdlp = join(process.cwd(), "worker", ".venv", "bin", "yt-dlp");
  const dir = mkdtempSync(join(tmpdir(), "ytdlp-"));
  const out = join(dir, "video.mp4");
  try {
    const run = spawnSync(
      ytdlp,
      ["-f", "mp4/bestvideo*+bestaudio/best", "--merge-output-format", "mp4",
       "-o", out, "--no-playlist", "--quiet", url],
      { timeout: 300_000 }
    );
    if (run.status !== 0) return null;
    const data = readFileSync(out);
    if (data.byteLength === 0) return null;
    const buf = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
    return buf.byteLength <= MAX_ATTACHMENT_BYTES ? buf : fitVideo(buf);
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The bytes behind an inspo link (downloaded + fitted), or null. */
async function obtainVideoBytes(url: string): Promise<ArrayBuffer | null> {
  const platform = detectPlatform(url);
  if (!platform) return null;
  if (platform === "file") return fetchVideo(url);

  const key = process.env.SCRAPECREATORS_API_KEY;
  if (key) {
    const endpoint =
      platform === "instagram"
        ? "https://api.scrapecreators.com/v1/instagram/post"
        : "https://api.scrapecreators.com/v2/tiktok/video";
    try {
      const res = await fetch(`${endpoint}?${new URLSearchParams({ url })}`, {
        headers: { "x-api-key": key },
        signal: AbortSignal.timeout(90_000),
      });
      if (res.ok) {
        const videoUrl = extractVideoUrl(platform, await res.json());
        const data = videoUrl ? await fetchVideo(videoUrl) : null;
        if (data) return data;
      }
    } catch {
      // fall through to yt-dlp
    }
  }
  return ytdlpDownload(url);
}

/**
 * Permanent PUBLIC URL for an inspo link's video, or null to fall back to a
 * plain link. The V2 gallery references this URL directly — nothing uploads
 * to Discord. Order: our own storage copy in research_videos → download
 * (ScrapeCreators / yt-dlp, transcoded under the cap) then a one-time upload
 * into the public `videos` bucket. Mirrors resolve_inspo_public_url in
 * worker/discord_bot/script_pager.py.
 */
export async function resolveInspoVideoUrl(url: string): Promise<string | null> {
  const platform = detectPlatform(url);
  if (!platform) return null;
  const db = createAdminClient();

  if (platform !== "file") {
    const clean = url.split("?")[0].replace(/\/$/, "");
    const { data: rows } = await db
      .from("research_videos")
      .select("video_url")
      .or(`url.eq.${clean},url.eq.${clean}/`)
      .not("video_url", "is", null)
      .limit(1);
    const stored = rows?.[0]?.video_url as string | undefined;
    // Only our own storage links are permanent; raw CDN links expire.
    if (stored?.includes("/storage/v1/object/public/")) return stored;
  }

  // Already resolved once (a previous send, the bot's pager, or a portal
  // pre-resolve) — reuse the deterministic copy. This is also what keeps
  // Vercel sends working: the download fallbacks below need yt-dlp/ffmpeg,
  // which only exist on the local machine.
  const path = inspoStoragePath(url);
  const name = path.split("/")[1];
  const { data: existing } = await db.storage.from("videos").list("inspo", { search: name });
  if (existing?.some((f) => f.name === name)) {
    return db.storage.from("videos").getPublicUrl(path).data.publicUrl;
  }

  const bytes = await obtainVideoBytes(url);
  if (!bytes) return null;
  const { error } = await db.storage
    .from("videos")
    .upload(path, Buffer.from(bytes), { contentType: "video/mp4", upsert: true });
  if (error) return null;
  return db.storage.from("videos").getPublicUrl(path).data.publicUrl;
}
