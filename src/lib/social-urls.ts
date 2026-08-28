/**
 * Platform URL helpers — canonicalization, detection, share-link resolution.
 *
 * These are properties of Instagram/TikTok, not of whichever scraping vendor
 * we happen to use, so they live apart from the API client.
 */

import type { Platform } from "@/lib/types";

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
    return (
      host === "vm.tiktok.com" ||
      host === "vt.tiktok.com" ||
      (host.includes("tiktok.com") && u.pathname.startsWith("/t/"))
    );
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
      headers: { "user-agent": "Mozilla/5.0 (compatible; NozomioBot/1.0)" },
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
    if (platform === "tiktok") {
      return /\/(video|photo)\/\d+/.test(u.pathname) || isTikTokShareLink(url);
    }
    if (platform === "instagram") return /\/(p|reel|reels|tv)\/[^/]+/.test(u.pathname);
  } catch {
    /* fall through */
  }
  return false;
}

/** @deprecated Instagram-specific; prefer canonicalVideoUrl. Kept for callers. */
export const canonicalReelUrl = canonicalInstagramUrl;
