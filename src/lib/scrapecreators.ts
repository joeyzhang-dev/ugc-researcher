/**
 * Server-only Scrape Creators client. SCRAPECREATORS_API_KEY must never reach
 * the browser.
 *
 * Replaced Apify. Apify ran an *actor* per request — a container boot, a
 * scrape, and a dataset read — which meant a profile pull took minutes and had
 * to be treated as a long job. Scrape Creators is a plain REST API that answers
 * in seconds, so a scrape is now a handful of ordinary GETs.
 *
 * Two platforms are supported. Each has its own endpoints and response shapes,
 * but both normalize to the same NormalizedMediaItem so the jobs above stay
 * platform-agnostic once items are parsed.
 *
 * Endpoints used:
 *   GET /v1/instagram/profile?handle=            profile details
 *   GET /v1/instagram/user/reels?handle=&max_id=  reels, ~12 per page
 *   GET /v1/tiktok/profile?handle=                profile details
 *   GET /v3/tiktok/profile/videos?handle=&max_cursor=  videos, ~10 per page
 */

import type { Platform } from "@/lib/types";

const SC_BASE = "https://api.scrapecreators.com";
const REQUEST_TIMEOUT_MS = 60_000;

/** Pages are small (10–12 items), so a deep pull needs several. Cap the loop so
 *  a lying `more_available` can't spin forever burning credits. */
const MAX_PAGES = 12;

export function getScrapeCreatorsKey(): string {
  const key = process.env.SCRAPECREATORS_API_KEY;
  if (!key) throw new Error("SCRAPECREATORS_API_KEY is not set");
  return key;
}

/** GET a Scrape Creators endpoint. Network-level fetch failures (DNS blip,
 *  reset keep-alive socket) get one retry; the final error carries the undici
 *  cause code instead of a bare "fetch failed". HTTP errors are not retried —
 *  402 (out of credits) and 404 (no such profile) don't get better by asking
 *  again. */
async function scGet<T>(
  path: string,
  params: Record<string, string | number | undefined>
): Promise<T> {
  const url = new URL(path, SC_BASE);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") url.searchParams.set(k, String(v));
  }
  const key = getScrapeCreatorsKey();

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        headers: { "x-api-key": key },
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Scrape Creators ${path} failed (${res.status}): ${body.slice(0, 500)}`
        );
      }
      return (await res.json()) as T;
    } catch (e) {
      const isNetworkError = e instanceof TypeError;
      if (isNetworkError && attempt === 0) continue;
      if (isNetworkError) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const detail = cause?.code ?? cause?.message ?? "network error";
        throw new Error(`Scrape Creators request failed after retry (${detail})`);
      }
      throw e;
    }
  }
}

// ===========================================================================
// Normalized shapes
// ===========================================================================

export interface NormalizedProfile {
  username: string | null;
  displayName: string | null;
  profilePicUrl: string | null;
  followersCount: number | null;
}

export interface NormalizedMediaItem {
  url: string | null;
  externalId: string | null;
  shortcode: string | null;
  caption: string | null;
  ownerUsername: string | null;
  postedAt: string | null; // ISO
  isVideo: boolean;
  viewCount: number | null;
  likeCount: number | null;
  commentCount: number | null;
  shareCount: number | null;
  /** Only present if the platform exposes it (IG sends aren't public; TikTok has none). */
  sendCount: number | null;
  /** Signed CDN URL — expires within days, so copy it to storage. */
  thumbnailUrl: string | null;
  /** Direct playable video file (also a signed, expiring CDN URL — copy it to storage). */
  videoUrl: string | null;
  /** Owner's profile picture (also an expiring CDN URL). */
  ownerProfilePicUrl: string | null;
  raw: Record<string, unknown>;
}

type Json = Record<string, unknown>;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function obj(v: unknown): Json {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {};
}

function firstNum(item: Json, keys: string[]): number | null {
  for (const key of keys) {
    const v = num(item[key]);
    if (v != null) return v;
  }
  return null;
}

function firstStr(item: Json, keys: string[]): string | null {
  for (const key of keys) {
    const v = str(item[key]);
    if (v != null) return v;
  }
  return null;
}

/** TikTok wraps every media URL as `{ url_list: [...mirrors] }`. */
function urlListFirst(v: unknown): string | null {
  const list = obj(v)["url_list"];
  return Array.isArray(list) ? str(list[0]) : null;
}

function isoFromEpochSeconds(v: unknown): string | null {
  const epoch = num(v);
  if (epoch == null || epoch === 0) return null;
  const d = new Date(epoch * 1000);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// ===========================================================================
// Instagram
// ===========================================================================

/**
 * Normalize one entry of /v1/instagram/user/reels. Items arrive wrapped as
 * `{ media: {...} }`; callers may pass either the wrapper or the inner media.
 */
export function normalizeInstagramItem(entry: Json): NormalizedMediaItem {
  const item = obj(entry["media"] ?? entry);
  const user = obj(item["user"]);
  const code = str(item["code"]);
  const videoVersions = Array.isArray(item["video_versions"]) ? item["video_versions"] : [];
  // Candidates come widest-first, so [0] is the highest-resolution still.
  const candidates = obj(item["image_versions2"])["candidates"];

  return {
    // Reels have no `url` field — the shortcode is what identifies the post.
    url: code ? `https://www.instagram.com/reel/${code}/` : null,
    externalId: firstStr(item, ["pk", "id"]),
    shortcode: code,
    caption: str(obj(item["caption"])["text"]),
    ownerUsername: str(user["username"]),
    postedAt: isoFromEpochSeconds(item["taken_at"]),
    isVideo:
      num(item["media_type"]) === 2 ||
      str(item["product_type"]) === "clips" ||
      videoVersions.length > 0,
    // play_count is the "plays" number shown on the reel; view_count is often
    // null on this endpoint, so it's only a fallback.
    viewCount: firstNum(item, ["play_count", "ig_play_count", "view_count"]),
    likeCount: firstNum(item, ["like_count"]),
    commentCount: firstNum(item, ["comment_count"]),
    shareCount: firstNum(item, ["reshare_count", "share_count"]),
    sendCount: null,
    thumbnailUrl: Array.isArray(candidates) ? str(obj(candidates[0])["url"]) : null,
    videoUrl: str(obj(videoVersions[0])["url"]),
    ownerProfilePicUrl: firstStr(user, ["profile_pic_url"]),
    raw: item,
  };
}

/** Normalize /v1/instagram/profile → data.user. */
export function normalizeInstagramProfile(payload: Json): NormalizedProfile {
  const user = obj(obj(payload["data"])["user"]);
  return {
    username: str(user["username"]),
    displayName: str(user["full_name"]),
    // Only the GraphQL edge carries the count here; follower_count is null.
    followersCount:
      num(obj(user["edge_followed_by"])["count"]) ?? firstNum(user, ["follower_count"]),
    profilePicUrl: firstStr(user, ["profile_pic_url_hd", "profile_pic_url"]),
  };
}

// ===========================================================================
// TikTok
// ===========================================================================

/** Photo carousels come back in the video feed with aweme_type 150 and an
 *  audio track in place of a video file. */
const TIKTOK_PHOTO_AWEME_TYPE = 150;

/** Normalize one entry of /v3/tiktok/profile/videos (`aweme_list`). */
export function normalizeTikTokItem(entry: Json): NormalizedMediaItem {
  const item = obj(entry["aweme_detail"] ?? entry);
  const author = obj(item["author"]);
  const video = obj(item["video"]);
  const stats = obj(item["statistics"]);
  const awemeId = firstStr(item, ["aweme_id"]);
  const shareUrl = str(item["share_url"]);
  const username = firstStr(author, ["unique_id", "uniqueId"]);
  const isPhoto = num(item["aweme_type"]) === TIKTOK_PHOTO_AWEME_TYPE;

  return {
    // share_url carries tracking params; rebuild the clean form when we can.
    url:
      username && awemeId
        ? `https://www.tiktok.com/@${username}/${isPhoto ? "photo" : "video"}/${awemeId}`
        : shareUrl,
    externalId: awemeId,
    // TikTok has no shortcode; the numeric video id is the closest stable handle.
    shortcode: awemeId,
    caption: firstStr(item, ["desc"]),
    ownerUsername: username,
    postedAt: isoFromEpochSeconds(item["create_time"]),
    isVideo: !isPhoto,
    viewCount: firstNum(stats, ["play_count"]),
    likeCount: firstNum(stats, ["digg_count"]),
    commentCount: firstNum(stats, ["comment_count"]),
    shareCount: firstNum(stats, ["share_count"]),
    // TikTok has no public "sends"; collect_count (saves) is a different metric.
    sendCount: null,
    thumbnailUrl:
      urlListFirst(video["origin_cover"]) ??
      urlListFirst(video["cover"]) ??
      urlListFirst(video["dynamic_cover"]),
    videoUrl: urlListFirst(video["play_addr"]) ?? urlListFirst(video["download_addr"]),
    ownerProfilePicUrl:
      urlListFirst(author["avatar_larger"]) ?? urlListFirst(author["avatar_medium"]),
    raw: item,
  };
}

/** Normalize /v1/tiktok/profile. */
export function normalizeTikTokProfile(payload: Json): NormalizedProfile {
  const user = obj(payload["user"]);
  const stats = obj(payload["stats"] ?? payload["statsV2"]);
  return {
    username: firstStr(user, ["uniqueId"]),
    displayName: firstStr(user, ["nickname"]),
    followersCount: firstNum(stats, ["followerCount"]),
    profilePicUrl: firstStr(user, ["avatarLarger", "avatarMedium", "avatarThumb"]),
  };
}

// ===========================================================================
// Platform dispatch
// ===========================================================================

export function normalizeItem(platform: Platform, item: Json): NormalizedMediaItem {
  return platform === "instagram" ? normalizeInstagramItem(item) : normalizeTikTokItem(item);
}

export function normalizeProfile(platform: Platform, payload: Json): NormalizedProfile {
  return platform === "instagram"
    ? normalizeInstagramProfile(payload)
    : normalizeTikTokProfile(payload);
}

// ===========================================================================
// Fetchers
// ===========================================================================

const cleanHandle = (handle: string) => handle.replace(/^@/, "").trim().toLowerCase();

/** Profile details: display name, follower count, avatar. One credit. */
export async function fetchProfile(
  platform: Platform,
  handle: string
): Promise<NormalizedProfile> {
  const h = cleanHandle(handle);
  const payload =
    platform === "instagram"
      ? await scGet<Json>("/v1/instagram/profile", { handle: h })
      : await scGet<Json>("/v1/tiktok/profile", { handle: h });
  return normalizeProfile(platform, payload);
}

interface InstagramReelsPage {
  items?: Json[];
  paging_info?: { max_id?: string; more_available?: boolean };
}

interface TikTokVideosPage {
  aweme_list?: Json[];
  max_cursor?: number | string;
  has_more?: number | boolean;
}

/**
 * Newest videos from a profile, paging until `limit` is reached.
 *
 * Each page is billed, so the loop stops as soon as it has enough items rather
 * than finishing the page run — and it stops on an empty page even if the API
 * still claims more are available, which is what a private or emptied profile
 * looks like.
 */
export async function fetchProfileVideos(
  platform: Platform,
  handle: string,
  limit: number
): Promise<NormalizedMediaItem[]> {
  const h = cleanHandle(handle);
  const items: NormalizedMediaItem[] = [];
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PAGES && items.length < limit; page++) {
    let batch: Json[];
    let more: boolean;

    if (platform === "instagram") {
      const res = await scGet<InstagramReelsPage>("/v1/instagram/user/reels", {
        handle: h,
        max_id: cursor,
      });
      batch = res.items ?? [];
      cursor = res.paging_info?.max_id;
      more = Boolean(res.paging_info?.more_available) && Boolean(cursor);
    } else {
      const res = await scGet<TikTokVideosPage>("/v3/tiktok/profile/videos", {
        handle: h,
        max_cursor: cursor,
      });
      batch = res.aweme_list ?? [];
      cursor = res.max_cursor != null ? String(res.max_cursor) : undefined;
      more = Boolean(res.has_more) && Boolean(cursor);
    }

    if (batch.length === 0) break;
    for (const raw of batch) items.push(normalizeItem(platform, raw));
    if (!more) break;
  }

  return items.slice(0, limit);
}
