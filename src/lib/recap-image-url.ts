/**
 * Signing for the recap card image.
 *
 * Kept in its own module so the route that *serves* the image and the digest
 * job that *links* it derive the signature from one function — a mismatch
 * would mean every digest embeds an image that 403s, which is exactly the
 * class of bug that only shows up in production.
 */

import { createHmac } from "node:crypto";

/** Hex HMAC of an arbitrary set of parts, or null when CRON_SECRET is unset.
 *  Parts are joined with `|`, so a caller must keep their order stable. */
export function signParts(...parts: string[]): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(parts.join("|")).digest("hex").slice(0, 32);
}

/** Constant-time compare over two strings. Length is compared first, which is
 *  not secret — the signature length is fixed and public. */
export function signatureMatches(given: string | null, expected: string | null): boolean {
  if (!given || !expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Hex HMAC of `coach|week|nonce`, or null when CRON_SECRET is unset.
 *  Truncated to 32 hex chars: still 128 bits, and it keeps the URL readable in
 *  a log. The nonce is inside the signature so it cannot be edited away. */
export function recapImageSignature(coach: string, week: string, nonce = ""): string | null {
  return signParts(coach, week, nonce);
}

/** The creator card's signature. A distinct subject prefix keeps a recap
 *  signature from being replayed at the creator card, which exposes a
 *  different slice of the same data. */
export function creatorCardSignature(handle: string, asOf: string, nonce = ""): string | null {
  return signParts("creator", handle.toLowerCase(), asOf, nonce);
}

/** The absolute creator-card URL, or null when it cannot be signed. */
export function creatorCardUrl(
  appUrl: string | null | undefined,
  handle: string,
  asOf: Date,
  nonce = ""
): string | null {
  if (!appUrl) return null;
  const day = asOf.toISOString().slice(0, 10);
  const sig = creatorCardSignature(handle, day, nonce);
  if (!sig) return null;
  const q = new URLSearchParams({ handle, asOf: day, sig });
  if (nonce) q.set("n", nonce);
  return `${appUrl.replace(/\/$/, "")}/api/jobs/creator-card?${q.toString()}`;
}

/**
 * The absolute image URL for a coach's week, or null when it cannot be signed
 * or we do not know our own origin. Both are non-fatal: the digest simply
 * posts without the card.
 *
 * `nonce` exists because of how Discord fails. Its media proxy caches a fetch
 * failure against the URL, and it keys on the path — a `?v=2` on the same path
 * still serves the cached 404 (verified live 2026-08-31; only a genuinely new
 * path recovered). Without a nonce the recap URL is fully deterministic, so a
 * single bad send — a missing CRON_SECRET, an un-migrated column, a cold
 * start that timed out — would leave that week's card permanently blank even
 * after the route was fixed, with no way to force a re-fetch. Passing a fresh
 * nonce per send makes every attempt a new URL, so a retry can actually work.
 */
export function recapImageUrl(
  appUrl: string | null | undefined,
  coach: string,
  week: Date,
  nonce = ""
): string | null {
  if (!appUrl) return null;
  const day = week.toISOString().slice(0, 10);
  const sig = recapImageSignature(coach, day, nonce);
  if (!sig) return null;
  const q = new URLSearchParams({ coach, week: day, sig });
  if (nonce) q.set("n", nonce);
  return `${appUrl.replace(/\/$/, "")}/api/jobs/recap-image?${q.toString()}`;
}

/**
 * Render the card once before it is linked, so Discord's fetch is warm.
 *
 * Discord's media proxy fetches the URL the moment the message is posted and
 * gives up quickly. A cold `next/og` render on Vercel takes 4-16s — measured
 * live 2026-08-31, cold 4.75s vs 0.24s warm — so the first fetch loses the
 * race and the card renders as a broken-image box. `next/og` already returns
 * `cache-control: public, immutable, max-age=31536000`, so one request from us
 * is enough to make every later fetch instant.
 *
 * Verified by probe: the identical URL, query string and all, renders in
 * Discord once warmed and fails cold. Best-effort — a failure here is not
 * worth losing the digest over, and the nonce means a later send gets a fresh
 * URL rather than inheriting a cached failure.
 */
export async function warmRecapImage(url: string, timeoutMs = 25_000): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    // Drain the body: the render is only cached once the response completes.
    await res.arrayBuffer();
    return res.ok;
  } catch {
    return false;
  }
}
