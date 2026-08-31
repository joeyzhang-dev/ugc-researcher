/**
 * Signing for the recap card image.
 *
 * Kept in its own module so the route that *serves* the image and the digest
 * job that *links* it derive the signature from one function — a mismatch
 * would mean every digest embeds an image that 403s, which is exactly the
 * class of bug that only shows up in production.
 */

import { createHmac } from "node:crypto";

/** Hex HMAC of `coach|week|nonce`, or null when CRON_SECRET is unset.
 *  Truncated to 32 hex chars: still 128 bits, and it keeps the URL readable in
 *  a log. The nonce is inside the signature so it cannot be edited away. */
export function recapImageSignature(coach: string, week: string, nonce = ""): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`${coach}|${week}|${nonce}`).digest("hex").slice(0, 32);
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
