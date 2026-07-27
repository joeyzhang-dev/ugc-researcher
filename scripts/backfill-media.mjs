#!/usr/bin/env node
// Copy research media that still points at the platform CDN into our own
// Supabase Storage buckets, then repoint the row at the permanent URL.
//
//   node scripts/backfill-media.mjs              # thumbnails only (fast)
//   node scripts/backfill-media.mjs --videos     # thumbnails + video files
//   node scripts/backfill-media.mjs --limit 50   # process at most 50 rows
//
// Why this exists: Apify hands back signed CDN URLs that expire within days and
// are hotlink-blocked in the browser, so a third of the grid rendered as blank
// tiles. `src/lib/jobs/research.ts` already captures thumbnails on scrape and
// the transcription worker uploads the mp4 — this backfills everything scraped
// before that, and anything whose capture failed at the time.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
try {
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] ??= rest.join("=").trim().replace(/^"|"$/g, "");
  }
} catch {}

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local)");
  process.exit(1);
}

const args = process.argv.slice(2);
const withVideos = args.includes("--videos");
const limitArg = args.indexOf("--limit");
const LIMIT = limitArg !== -1 ? Number(args[limitArg + 1]) : Infinity;

const STORAGE_MARKER = "/storage/v1/object/public/";
const IMAGE_TIMEOUT_MS = 20_000;
const VIDEO_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_VIDEO_BYTES = 60 * 1024 * 1024;
const CONCURRENCY = Number(process.env.BACKFILL_CONCURRENCY || 6);

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };

async function rest(path, init = {}) {
  const res = await fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

/** Fetch a CDN asset without a referrer — Instagram blocks hotlinked requests. */
async function download(url, { timeout, maxBytes, kind }) {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { Referer: "", "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`source ${res.status}`);
  const contentType = res.headers.get("content-type") || (kind === "image" ? "image/jpeg" : "video/mp4");
  const ok =
    kind === "image"
      ? contentType.startsWith("image/")
      : contentType.startsWith("video/") || contentType === "application/octet-stream";
  if (!ok) throw new Error(`unexpected content-type ${contentType}`);
  const body = Buffer.from(await res.arrayBuffer());
  if (!body.length) throw new Error("empty body");
  if (body.length > maxBytes) throw new Error(`too large (${body.length} bytes)`);
  return { body, contentType };
}

async function upload(bucket, path, body, contentType) {
  const res = await fetch(`${SUPA}/storage/v1/object/${bucket}/${path}`, {
    method: "POST",
    headers: { ...headers, "Content-Type": contentType, "x-upsert": "true" },
    body,
  });
  if (!res.ok) throw new Error(`upload ${res.status} ${await res.text()}`);
  return `${SUPA}${STORAGE_MARKER}${bucket}/${path}`;
}

/** Page through every row whose column still holds a non-storage URL. */
async function fetchPending(column) {
  const out = [];
  const pageSize = 1000;
  for (let offset = 0; out.length < LIMIT; offset += pageSize) {
    const rows = await rest(
      `research_videos?select=id,${column}` +
        `&${column}=not.is.null` +
        `&${column}=not.like.*${encodeURIComponent(STORAGE_MARKER)}*` +
        `&order=posted_at.desc&limit=${pageSize}&offset=${offset}`
    );
    out.push(...rows);
    if (rows.length < pageSize) break;
  }
  return out.slice(0, LIMIT === Infinity ? undefined : LIMIT);
}

async function runPool(items, worker) {
  let cursor = 0;
  const stats = { ok: 0, failed: 0 };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, items.length) }, async () => {
      while (cursor < items.length) {
        const index = cursor++;
        try {
          await worker(items[index]);
          stats.ok++;
        } catch (err) {
          stats.failed++;
          console.log(`  ✗ ${items[index].id}: ${err.message}`);
        }
        const done = stats.ok + stats.failed;
        if (done % 25 === 0) console.log(`  … ${done}/${items.length}`);
      }
    })
  );
  return stats;
}

async function backfillThumbnails() {
  const rows = await fetchPending("thumbnail_url");
  console.log(`thumbnails: ${rows.length} still on the CDN`);
  if (!rows.length) return;

  const stats = await runPool(rows, async (row) => {
    const { body, contentType } = await download(row.thumbnail_url, {
      timeout: IMAGE_TIMEOUT_MS,
      maxBytes: MAX_IMAGE_BYTES,
      kind: "image",
    });
    const ext = contentType.includes("png") ? "png" : contentType.includes("webp") ? "webp" : "jpg";
    const url = await upload("thumbnails", `videos/${row.id}.${ext}`, body, contentType);
    await rest(`research_videos?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ thumbnail_url: url }),
    });
  });
  console.log(`thumbnails: ${stats.ok} captured, ${stats.failed} failed`);
}

async function backfillVideos() {
  const rows = await fetchPending("video_url");
  console.log(`videos: ${rows.length} still on the CDN`);
  if (!rows.length) return;

  const stats = await runPool(rows, async (row) => {
    const { body, contentType } = await download(row.video_url, {
      timeout: VIDEO_TIMEOUT_MS,
      maxBytes: MAX_VIDEO_BYTES,
      kind: "video",
    });
    const ext = contentType.includes("webm") ? "webm" : "mp4";
    const type = contentType.startsWith("video/") ? contentType : "video/mp4";
    const url = await upload("videos", `${row.id}.${ext}`, body, type);
    await rest(`research_videos?id=eq.${row.id}`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ video_url: url }),
    });
  });
  console.log(`videos: ${stats.ok} captured, ${stats.failed} failed`);
}

await backfillThumbnails();
if (withVideos) await backfillVideos();
console.log("done");
