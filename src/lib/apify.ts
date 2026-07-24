/**
 * Server-only Apify client. APIFY_TOKEN must never reach the browser.
 *
 * Uses the run-sync-get-dataset-items endpoint so a single call runs the
 * actor and returns its dataset. Field names vary by actor and platform, so
 * all parsing goes through the normalize* helpers below.
 *
 * Two platforms are supported. Each has its own actor (env-configured) and its
 * own field shapes, but both normalize to the same NormalizedMediaItem so the
 * discovery/analytics jobs stay platform-agnostic once items are parsed.
 */

import type { Platform } from "@/lib/types";

const APIFY_BASE = "https://api.apify.com/v2";
const RUN_TIMEOUT_SECS = 300;

export interface ApifyConfig {
  token: string;
  actorId: string;
}

const ACTOR_ENV: Record<Platform, string> = {
  instagram: "APIFY_INSTAGRAM_ACTOR_ID",
  tiktok: "APIFY_TIKTOK_ACTOR_ID",
};

export function getApifyConfig(platform: Platform): ApifyConfig {
  const token = process.env.APIFY_TOKEN;
  const actorId = process.env[ACTOR_ENV[platform]];
  if (!token) throw new Error("APIFY_TOKEN is not set");
  if (!actorId) throw new Error(`${ACTOR_ENV[platform]} is not set`);
  return { token, actorId };
}

/** Run the actor synchronously and return its dataset items. Network-level
 *  fetch failures (DNS blip, reset keep-alive socket) get one retry; the final
 *  error carries the undici cause code instead of a bare "fetch failed". */
export async function runActorSync(
  config: ApifyConfig,
  input: Record<string, unknown>
): Promise<Record<string, unknown>[]> {
  // Actor IDs like "apify/instagram-scraper" use ~ in the URL path.
  const actorPath = config.actorId.replace("/", "~");
  const url =
    `${APIFY_BASE}/acts/${actorPath}/run-sync-get-dataset-items` +
    `?token=${encodeURIComponent(config.token)}&timeout=${RUN_TIMEOUT_SECS}`;
  const body = JSON.stringify(input);

  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
        cache: "no-store",
        signal: AbortSignal.timeout(RUN_TIMEOUT_SECS * 1000 + 30_000),
      });

      if (!res.ok) {
        const resBody = await res.text().catch(() => "");
        throw new Error(`Apify actor run failed (${res.status}): ${resBody.slice(0, 500)}`);
      }

      const items = await res.json();
      if (!Array.isArray(items)) {
        throw new Error("Apify returned a non-array dataset response");
      }
      return items;
    } catch (e) {
      // undici surfaces network failures as TypeError("fetch failed") with the
      // real reason on .cause; HTTP/timeout errors above are not retried.
      const isNetworkError = e instanceof TypeError;
      if (isNetworkError && attempt === 0) continue;
      if (isNetworkError) {
        const cause = (e as { cause?: { code?: string; message?: string } }).cause;
        const detail = cause?.code ?? cause?.message ?? "network error";
        throw new Error(`Apify request failed after retry (${detail})`);
      }
      throw e;
    }
  }
}

// ===========================================================================
// Actor inputs (per platform)
// ===========================================================================

/** Discovery input: recent posts from each creator's profile. */
export function buildDiscoveryInput(
  platform: Platform,
  handles: string[],
  resultsLimit: number
): Record<string, unknown> {
  const clean = handles.map((h) => h.replace(/^@/, ""));
  if (platform === "instagram") {
    return {
      directUrls: clean.map((h) => `https://www.instagram.com/${h}/`),
      resultsType: "posts",
      resultsLimit,
      addParentData: false,
    };
  }
  // clockworks/tiktok-scraper
  return {
    profiles: clean,
    resultsPerPage: resultsLimit,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
  };
}

/** Analytics input: scrape specific posts by URL. */
export function buildAnalyticsInput(
  platform: Platform,
  urls: string[]
): Record<string, unknown> {
  if (platform === "instagram") {
    return { directUrls: urls, resultsType: "posts", addParentData: false };
  }
  return {
    postURLs: urls,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
  };
}

/**
 * Profile-details input: one result per profile with bio-level data (profile
 * picture, follower count). Instagram post items don't include the profile
 * pic, so avatars need this separate cheap call. TikTok items already carry
 * the author avatar, but this gives a uniform one-result-per-handle probe.
 */
export function buildProfileDetailsInput(
  platform: Platform,
  handles: string[]
): Record<string, unknown> {
  const clean = handles.map((h) => h.replace(/^@/, ""));
  if (platform === "instagram") {
    return {
      directUrls: clean.map((h) => `https://www.instagram.com/${h}/`),
      resultsType: "details",
      resultsLimit: 1,
      addParentData: false,
    };
  }
  return {
    profiles: clean,
    resultsPerPage: 1,
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
  };
}

// ===========================================================================
// Normalized shapes
// ===========================================================================

export interface NormalizedProfile {
  username: string | null;
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
  /** Only present if the actor exposes it (IG sends aren't public; TikTok has none). */
  sendCount: number | null;
  /** Signed CDN URL — expires within days, so copy it to storage. */
  thumbnailUrl: string | null;
  /** Direct playable video file (also a signed, expiring CDN URL — copy it to storage). */
  videoUrl: string | null;
  /** Owner's profile picture (also an expiring CDN URL). */
  ownerProfilePicUrl: string | null;
  raw: Record<string, unknown>;
}

/** Back-compat alias — the shape is now platform-agnostic. */
export type NormalizedInstagramItem = NormalizedMediaItem;

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v) && v >= 0) return Math.round(v);
  if (typeof v === "string" && /^\d+$/.test(v)) return parseInt(v, 10);
  return null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

function firstNum(item: Record<string, unknown>, keys: string[]): number | null {
  for (const key of keys) {
    const v = num(item[key]);
    if (v != null) return v;
  }
  return null;
}

function firstStr(item: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const v = str(item[key]);
    if (v != null) return v;
  }
  return null;
}

function obj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

/** First string element of an array field (some actors return URL lists). */
function firstOfArray(v: unknown): string | null {
  return Array.isArray(v) && typeof v[0] === "string" && v[0].length > 0 ? v[0] : null;
}

// ===========================================================================
// Instagram normalization
// ===========================================================================

export function normalizeProfileItem(item: Record<string, unknown>): NormalizedProfile {
  return {
    username: firstStr(item, ["username", "ownerUsername"]),
    profilePicUrl: firstStr(item, [
      "profilePicUrlHD", "profilePicUrl", "profile_pic_url_hd", "profile_pic_url",
    ]),
    followersCount: firstNum(item, ["followersCount", "followers_count", "followedByCount"]),
  };
}

/**
 * Normalize an item from an Apify Instagram actor. Field names differ across
 * actors (apify/instagram-scraper, apify/instagram-reel-scraper, ...), so try
 * the common variants for each metric and keep the raw payload for debugging.
 */
export function normalizeInstagramItem(
  item: Record<string, unknown>
): NormalizedMediaItem {
  const type = str(item["type"]);
  const productType = str(item["productType"]);
  const isVideo =
    type === "Video" ||
    productType === "clips" ||
    item["isVideo"] === true ||
    str(item["videoUrl"]) != null;

  const timestamp = firstStr(item, ["timestamp", "takenAt", "taken_at", "createdAt"]);
  let postedAt: string | null = null;
  if (timestamp) {
    const d = new Date(timestamp);
    if (!Number.isNaN(d.getTime())) postedAt = d.toISOString();
  } else {
    const epoch = num(item["takenAtTimestamp"] ?? item["taken_at_timestamp"]);
    if (epoch != null) postedAt = new Date(epoch * 1000).toISOString();
  }

  const ownerObj = obj(item["owner"]);
  const owner = item["ownerUsername"] ?? ownerObj?.["username"];
  const ownerPic =
    firstStr(item, ["ownerProfilePicUrl", "profilePicUrl", "userProfilePicUrl"]) ??
    (typeof ownerObj?.["profile_pic_url"] === "string" ? (ownerObj["profile_pic_url"] as string) : null) ??
    (typeof ownerObj?.["profilePicUrl"] === "string" ? (ownerObj["profilePicUrl"] as string) : null);

  return {
    url: firstStr(item, ["url", "postUrl", "link"]),
    externalId: firstStr(item, ["id", "pk", "mediaId"]),
    shortcode: firstStr(item, ["shortCode", "shortcode", "code"]),
    caption: firstStr(item, ["caption", "text", "title"]),
    ownerUsername: typeof owner === "string" ? owner : null,
    postedAt,
    isVideo,
    viewCount: firstNum(item, [
      "videoPlayCount", "playCount", "playsCount", "videoViewCount", "viewCount", "viewsCount", "igPlayCount",
    ]),
    likeCount: firstNum(item, ["likesCount", "likeCount", "likes"]),
    commentCount: firstNum(item, ["commentsCount", "commentCount", "comments"]),
    shareCount: firstNum(item, ["sharesCount", "shareCount", "reshareCount", "repostCount"]),
    sendCount: firstNum(item, ["sendCount", "sendsCount"]),
    thumbnailUrl: firstStr(item, [
      "displayUrl", "display_url", "thumbnailUrl", "thumbnail_url", "imageUrl", "previewUrl",
    ]),
    videoUrl:
      firstStr(item, ["videoUrl", "video_url", "videoUrlHD"]) ?? firstOfArray(item["videoUrls"]),
    ownerProfilePicUrl: ownerPic,
    raw: item,
  };
}

// ===========================================================================
// TikTok normalization (clockworks/tiktok-scraper field shapes)
// ===========================================================================

export function normalizeTikTokProfileItem(item: Record<string, unknown>): NormalizedProfile {
  const author = obj(item["authorMeta"]) ?? obj(item["author"]);
  return {
    username: firstStr(author ?? item, ["name", "uniqueId", "userName"]),
    profilePicUrl:
      firstStr(author ?? {}, ["avatar", "avatarLarger", "avatarMedium"]) ??
      firstStr(item, ["avatar", "avatarUrl"]),
    followersCount:
      firstNum(author ?? {}, ["fans", "followers", "followerCount"]) ??
      firstNum(item, ["fans", "followers"]),
  };
}

/** Normalize a clockworks/tiktok-scraper post item. */
export function normalizeTikTokItem(item: Record<string, unknown>): NormalizedMediaItem {
  const author = obj(item["authorMeta"]) ?? obj(item["author"]);
  const videoMeta = obj(item["videoMeta"]);

  // TikTok gives createTimeISO on newer runs, createTime (epoch secs) on older.
  let postedAt: string | null = null;
  const iso = firstStr(item, ["createTimeISO", "createTimeIso"]);
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) postedAt = d.toISOString();
  }
  if (!postedAt) {
    const epoch = num(item["createTime"] ?? item["createTimeUnix"]);
    if (epoch != null) postedAt = new Date(epoch * 1000).toISOString();
  }

  const thumbnail =
    firstStr(videoMeta ?? {}, ["coverUrl", "cover", "originCover", "dynamicCover"]) ??
    firstStr(item, ["covers", "cover", "thumbnailUrl"]);

  return {
    url: firstStr(item, ["webVideoUrl", "url", "postPage", "videoUrl"]),
    externalId: firstStr(item, ["id", "awemeId"]),
    // TikTok has no shortcode; the numeric video id is the closest stable handle.
    shortcode: firstStr(item, ["id", "awemeId"]),
    caption: firstStr(item, ["text", "desc", "caption"]),
    ownerUsername: firstStr(author ?? item, ["name", "uniqueId", "userName"]),
    postedAt,
    // Everything clockworks returns for a profile/post scrape is a video.
    isVideo: true,
    viewCount: firstNum(item, ["playCount", "playsCount"]),
    likeCount: firstNum(item, ["diggCount", "likeCount", "likesCount"]),
    commentCount: firstNum(item, ["commentCount", "commentsCount"]),
    shareCount: firstNum(item, ["shareCount", "sharesCount"]),
    // TikTok has no public "sends"; collectCount (saves) is a different metric.
    sendCount: null,
    thumbnailUrl: thumbnail,
    // File URL only — webVideoUrl/videoUrl here are the post PAGE, not the video.
    videoUrl:
      firstStr(videoMeta ?? {}, ["downloadAddr", "playAddr"]) ?? firstOfArray(item["mediaUrls"]),
    ownerProfilePicUrl: firstStr(author ?? {}, ["avatar", "avatarLarger", "avatarMedium"]),
    raw: item,
  };
}

// ===========================================================================
// Platform dispatch + URL helpers
// ===========================================================================

export function normalizeItem(
  platform: Platform,
  item: Record<string, unknown>
): NormalizedMediaItem {
  return platform === "instagram" ? normalizeInstagramItem(item) : normalizeTikTokItem(item);
}

export function normalizeProfile(
  platform: Platform,
  item: Record<string, unknown>
): NormalizedProfile {
  return platform === "instagram" ? normalizeProfileItem(item) : normalizeTikTokProfileItem(item);
}

/** Which platform a post URL belongs to, or null if unrecognized. */
export function detectPlatform(url: string): Platform | null {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host.includes("instagram.com")) return "instagram";
    if (host.includes("tiktok.com")) return "tiktok";
    return null;
  } catch {
    return null;
  }
}

/**
 * Canonical Instagram post URL. Instagram serves the SAME post at /p/<code>/,
 * /reel/<code>/, /reels/<code>/ and /tv/<code>/ — normalize them all to one
 * shortcode-based form so the same Reel can't be tracked twice.
 */
export function canonicalInstagramUrl(url: string): string {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:p|reel|reels|tv)\/([^/]+)/i);
    if (m) return `https://www.instagram.com/reel/${m[1]}/`;
    let path = u.pathname;
    if (!path.endsWith("/")) path += "/";
    return `https://www.instagram.com${path}`;
  } catch {
    return url;
  }
}

/** Canonical TikTok post URL (strip query/hash, drop trailing slash, lower host). */
export function canonicalTikTokUrl(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.replace(/\/+$/, "");
    return `https://www.tiktok.com${path}`;
  } catch {
    return url;
  }
}

/** Platform-detecting canonicalization used to dedupe post URLs. */
export function canonicalVideoUrl(url: string): string {
  const platform = detectPlatform(url);
  if (platform === "tiktok") return canonicalTikTokUrl(url);
  if (platform === "instagram") return canonicalInstagramUrl(url);
  return url;
}

/** True for TikTok's redirecting short-share links (vm./vt./tiktok.com/t/…). */
function isTikTokShareLink(url: string): boolean {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return host === "vm.tiktok.com" || host === "vt.tiktok.com" || (host.includes("tiktok.com") && u.pathname.startsWith("/t/"));
  } catch {
    return false;
  }
}

/**
 * Resolve a TikTok short-share link (e.g. https://vm.tiktok.com/ZM…) to the real
 * /@user/video/<id> URL by following its redirect. Returns the input unchanged
 * for normal links or if the lookup fails.
 */
export async function resolveShareLink(url: string): Promise<string> {
  if (!isTikTokShareLink(url)) return url;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": "Mozilla/5.0 (compatible; TraceBot/1.0)" },
    });
    return res.url || url; // res.url is the final URL after redirects
  } catch {
    return url;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * True when the URL points at a specific post/video, not a profile or bare
 * short link. Used to reject profile URLs (e.g. tiktok.com/@handle) at submit.
 */
export function isPostUrl(url: string): boolean {
  const platform = detectPlatform(url);
  try {
    const u = new URL(url);
    if (platform === "tiktok") return /\/(video|photo)\/\d+/.test(u.pathname) || isTikTokShareLink(url);
    if (platform === "instagram") return /\/(p|reel|reels|tv)\/[^/]+/.test(u.pathname);
  } catch {
    /* fall through */
  }
  return false;
}

/** @deprecated Instagram-specific; prefer canonicalVideoUrl. Kept for callers. */
export const canonicalReelUrl = canonicalInstagramUrl;
