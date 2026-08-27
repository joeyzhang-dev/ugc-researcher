/**
 * Server-only Launchpoint Public API client. LAUNCHPOINT_API_KEY must never
 * reach the browser.
 *
 * Launchpoint is where the Folk creator program actually lives — contracts,
 * payouts, and (because creators authorize their own accounts to it) the
 * first-party Instagram metrics that a public scrape can never see: reach,
 * saves, total/average watch time, and skip rate.
 *
 * The API is in private preview. Everything we use is read-only; the two write
 * routes it exposes (`POST /posts/export`, `POST /programs/{id}/invite`) are
 * deliberately absent from this client — an export creates a file and an
 * invite creates a shareable link, neither of which a sync job should do on
 * its own.
 *
 * Endpoints used:
 *   GET /posts?page&limit&platform          every tracked post (limit ≤ 500)
 *   GET /posts/{id}/insights                first-party IG metrics (IG only)
 *   GET /posts/{id}/metrics-history?days    daily snapshots, ~10–31 per post
 *   GET /analytics/accounts?page&limit       tracked handles → contractor id
 *
 * Shapes worth knowing:
 *   - Every response is enveloped as `{ data: ... }`; list routes add
 *     `page`/`total`/`totalPages`.
 *   - Timestamps are Unix **milliseconds**, not seconds.
 *   - `insights` answers 200 with `status: "no_data"` for anything that is not
 *     Instagram, so a TikTok post is a successful empty answer, not an error.
 */

import type { Platform } from "@/lib/types";

const LP_BASE = "https://dashboard.launchpointhq.com/api/v1";
const REQUEST_TIMEOUT_MS = 60_000;

const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 1_000;

/** Standard keys get 100 requests/minute, partner keys 400. Pacing at 100 is
 *  the safe floor; a 429 is handled separately in case the ceiling is lower
 *  than advertised for a given route. */
const REQUESTS_PER_MINUTE = 100;

/** Guard against a `totalPages` that never terminates. At 500 posts a page
 *  this covers 25k posts — an order of magnitude past the live corpus. */
const MAX_PAGES = 50;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A failure worth retrying: Launchpoint broke, or the socket did. */
class TransientLaunchpointError extends Error {}

/** Thrown when the key is rejected outright (401/402/403). Retrying cannot fix
 *  a key problem, and a sync that keeps hammering a disabled key just burns
 *  the cron budget — callers surface this as a configuration error. */
export class LaunchpointAuthError extends Error {}

export function getLaunchpointKey(): string {
  const key = process.env.LAUNCHPOINT_API_KEY;
  if (!key) throw new Error("LAUNCHPOINT_API_KEY is not set");
  return key;
}

export function hasLaunchpointKey(): boolean {
  return Boolean(process.env.LAUNCHPOINT_API_KEY);
}

/**
 * Client-side pacing.
 *
 * The sync walks thousands of single-post endpoints, so it will hit the
 * per-minute ceiling long before it hits any time budget. Rather than react to
 * 429s, hold a rolling window of send times and wait out the oldest one when
 * the window is full — the same request count, minus the wasted round trips
 * and the retry storm.
 *
 * Module-level because the limit is per API key, not per caller: two jobs in
 * one process share the key and must share the window.
 */
const sendTimes: number[] = [];

async function pace(): Promise<void> {
  const now = Date.now();
  while (sendTimes.length > 0 && now - sendTimes[0] > 60_000) sendTimes.shift();
  if (sendTimes.length >= REQUESTS_PER_MINUTE) {
    const waitMs = 60_000 - (now - sendTimes[0]) + 50;
    await sleep(waitMs);
    return pace();
  }
  sendTimes.push(Date.now());
}

/** GET a Launchpoint endpoint. Transient failures (5xx, network blips, 429)
 *  are retried with backoff; auth and 404 are not — they do not get better by
 *  asking again. */
async function lpGet<T>(
  path: string,
  params: Record<string, string | number | undefined> = {}
): Promise<T> {
  const url = new URL(`${LP_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const key = getLaunchpointKey();

  for (let attempt = 0; ; attempt++) {
    try {
      await pace();
      const res = await fetch(url, {
        headers: { "x-api-key": key, accept: "application/json" },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (res.status === 429) {
        // Trust the server's own reset hint over our rolling window — the key
        // may be shared with another process we cannot see.
        const reset = Number(res.headers.get("x-ratelimit-reset"));
        const waitMs = Number.isFinite(reset) && reset > 0 ? Math.min(reset * 1000, 60_000) : 15_000;
        throw new TransientLaunchpointError(`rate limited; retry in ${waitMs}ms`);
      }
      if (res.status === 401 || res.status === 402 || res.status === 403) {
        const body = await res.text().catch(() => "");
        throw new LaunchpointAuthError(
          `Launchpoint rejected the API key (${res.status}): ${body.slice(0, 200)}`
        );
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        const message = `Launchpoint ${path} failed (${res.status}): ${body.slice(0, 300)}`;
        throw res.status >= 500 ? new TransientLaunchpointError(message) : new Error(message);
      }
      return (await res.json()) as T;
    } catch (e) {
      if (e instanceof LaunchpointAuthError) throw e;
      const networkError = (e as { name?: string })?.name === "TypeError";
      const retryable = networkError || e instanceof TransientLaunchpointError;
      if (retryable && attempt < MAX_ATTEMPTS - 1) {
        await sleep(RETRY_BACKOFF_MS * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
}

// ===========================================================================
// Normalized shapes
// ===========================================================================

/** One tracked post. Mirrors GET /posts, which is the cheap bulk route —
 *  25–500 posts per call, everything except the first-party insights. */
export interface LaunchpointPost {
  id: string;
  creatorId: string | null;
  /** Concept name. Mostly the catch-all "Open-ended" — see the column comment
   *  on research_videos.launchpoint_title before trusting it. */
  title: string | null;
  platform: string;
  url: string | null;
  /** Instagram shortcode parsed from `url` — the join key to research_videos. */
  shortcode: string | null;
  thumbnail: string | null;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  /** Dollars, as sent. Kept as a number here and written to a numeric column. */
  earnings: number | null;
  paid: boolean;
  contractorName: string | null;
  /** ISO, converted from Launchpoint's epoch **milliseconds**. */
  uploadedAt: string | null;
}

/** First-party Instagram metrics. `available` is false for every non-Instagram
 *  post and for Instagram posts Launchpoint has never fetched. */
export interface LaunchpointInsights {
  available: boolean;
  reason: string | null;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  saves: number | null;
  totalWatchTimeMs: number | null;
  avgWatchTimeMs: number | null;
  /** Percent, 0–100. Lower is better. */
  skipRate: number | null;
  updatedAt: string | null;
}

/** One daily snapshot from GET /posts/{id}/metrics-history. */
export interface LaunchpointDailyMetric {
  date: string; // YYYY-MM-DD
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  bookmarks: number | null;
  viewsDelta: number | null;
  likesDelta: number | null;
  commentsDelta: number | null;
  sharesDelta: number | null;
  bookmarksDelta: number | null;
}

/** One tracked social account from GET /analytics/accounts — the creator
 *  identity map, and the reason we do not need GET /creators (which answers
 *  `total: 0` on this account, contracts being unused). */
export interface LaunchpointAccount {
  handle: string;
  platform: string;
  contractorId: string | null;
  contractorName: string | null;
  totalPosts: number | null;
  totalViews: number | null;
  totalEarnings: number | null;
  firstPostDate: string | null;
  lastPostDate: string | null;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function int(v: unknown): number | null {
  const n = num(v);
  return n == null ? null : Math.round(n);
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Launchpoint timestamps are epoch milliseconds. Seconds-vs-milliseconds is
 *  the classic silent corruption here — a seconds value would land in 1970 —
 *  so anything below year 2001 in ms is treated as absent rather than
 *  guessed at. */
export function isoFromEpochMillis(v: unknown): string | null {
  const ms = num(v);
  if (ms == null || ms < 978_307_200_000) return null;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Instagram shortcode from a post URL — the entire basis of the join between
 * Launchpoint and research_videos, so it is deliberately strict.
 *
 * Launchpoint stores clean canonical URLs (`instagram.com/reel/<code>/`), but
 * accepts `/p/` and `/tv/` forms too, and query strings appear on the TikTok
 * side. Anything else returns null and the post simply goes unmatched, which
 * is the safe failure: a wrong shortcode would attach one creator's retention
 * numbers to another creator's post.
 */
export function shortcodeFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const match = /instagram\.com\/(?:reel|reels|p|tv)\/([A-Za-z0-9_-]+)/.exec(url);
  return match ? match[1] : null;
}

export function normalizePost(raw: Json): LaunchpointPost {
  const url = str(raw["url"]);
  return {
    id: String(raw["id"] ?? ""),
    creatorId: str(raw["creatorId"]),
    title: str(raw["title"]),
    platform: str(raw["platform"]) ?? "unknown",
    url,
    shortcode: shortcodeFromUrl(url),
    thumbnail: str(raw["thumbnail"]),
    views: int(raw["views"]),
    likes: int(raw["likes"]),
    comments: int(raw["comments"]),
    shares: int(raw["shares"]),
    earnings: num(raw["earnings"]),
    paid: raw["paid"] === true,
    contractorName: str(raw["contractorName"]),
    uploadedAt: isoFromEpochMillis(raw["uploadedAt"]),
  };
}

export function normalizeInsights(payload: Json): LaunchpointInsights {
  const ins = obj(obj(payload["data"])["insights"]);
  const available = str(ins["status"]) === "available";
  return {
    available,
    reason: str(ins["reason"]),
    views: int(ins["views"]),
    reach: int(ins["reach"]),
    likes: int(ins["likes"]),
    comments: int(ins["comments"]),
    shares: int(ins["shares"]),
    saves: int(ins["saves"]),
    totalWatchTimeMs: int(ins["totalWatchTimeMs"]),
    avgWatchTimeMs: int(ins["avgWatchTimeMs"]),
    skipRate: num(ins["skipRate"]),
    updatedAt: isoFromEpochMillis(ins["updatedAt"]),
  };
}

export function normalizeHistory(payload: Json): LaunchpointDailyMetric[] {
  const history = obj(payload["data"])["history"];
  if (!Array.isArray(history)) return [];
  const rows: LaunchpointDailyMetric[] = [];
  for (const entry of history) {
    const e = obj(entry);
    const date = str(e["date"]);
    // A snapshot with no date cannot be keyed or deduped — drop it rather than
    // inventing one from `timestamp`, which is the fetch time, not the day.
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    rows.push({
      date,
      views: int(e["views"]),
      likes: int(e["likes"]),
      comments: int(e["comments"]),
      shares: int(e["shares"]),
      bookmarks: int(e["bookmarks"]),
      viewsDelta: int(e["viewsDelta"]),
      likesDelta: int(e["likesDelta"]),
      commentsDelta: int(e["commentsDelta"]),
      sharesDelta: int(e["sharesDelta"]),
      bookmarksDelta: int(e["bookmarksDelta"]),
    });
  }
  return rows;
}

export function normalizeAccount(raw: Json): LaunchpointAccount {
  return {
    handle: (str(raw["handle"]) ?? "").replace(/^@/, "").toLowerCase(),
    platform: str(raw["platform"]) ?? "unknown",
    contractorId: str(raw["contractorId"]),
    contractorName: str(raw["contractorName"]),
    totalPosts: int(raw["totalPosts"]),
    totalViews: int(raw["totalViews"]),
    totalEarnings: num(raw["totalEarnings"]),
    firstPostDate: isoFromEpochMillis(raw["firstPostDate"]),
    lastPostDate: isoFromEpochMillis(raw["lastPostDate"]),
  };
}

/** Launchpoint tracks five platforms; we model two. Anything else is skipped
 *  rather than coerced, so a YouTube post never lands on an Instagram row. */
export function toPlatform(launchpointPlatform: string): Platform | null {
  if (launchpointPlatform === "instagram") return "instagram";
  if (launchpointPlatform === "tiktok") return "tiktok";
  return null;
}

// ===========================================================================
// Fetchers
// ===========================================================================

interface ListEnvelope {
  data?: unknown;
  total?: number;
  totalPages?: number;
}

/** Page through a list endpoint until it runs out. */
async function fetchAllPages<T>(
  path: string,
  normalize: (raw: Json) => T,
  pageSize: number,
  params: Record<string, string | number | undefined> = {}
): Promise<T[]> {
  const out: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await lpGet<ListEnvelope>(path, { ...params, page, limit: pageSize });
    const batch = Array.isArray(res.data) ? res.data : [];
    for (const raw of batch) out.push(normalize(obj(raw)));
    const total = res.total ?? 0;
    if (batch.length < pageSize || out.length >= total) break;
  }
  return out;
}

/** Every tracked post. ~2.9k rows in six calls at the 500 page size. */
export async function fetchAllPosts(): Promise<LaunchpointPost[]> {
  return fetchAllPages("/posts", normalizePost, 500);
}

/** Every tracked social account — the handle → contractor identity map. */
export async function fetchAllAccounts(): Promise<LaunchpointAccount[]> {
  return fetchAllPages("/analytics/accounts", normalizeAccount, 100);
}

export async function fetchPostInsights(postId: string): Promise<LaunchpointInsights> {
  return normalizeInsights(await lpGet<Json>(`/posts/${postId}/insights`));
}

/** Daily snapshots. `days` is a lookback window, capped by Launchpoint at 500
 *  returned points — far more than the ~31 any live post actually has. */
export async function fetchPostHistory(
  postId: string,
  days = 365
): Promise<LaunchpointDailyMetric[]> {
  return normalizeHistory(
    await lpGet<Json>(`/posts/${postId}/metrics-history`, { days, limit: 500 })
  );
}
