/**
 * Signing for the recap card image.
 *
 * Kept in its own module so the route that *serves* the image and the digest
 * job that *links* it derive the signature from one function — a mismatch
 * would mean every digest embeds an image that 403s, which is exactly the
 * class of bug that only shows up in production.
 */

import { createHmac } from "node:crypto";

/** Hex HMAC of `coach|week`, or null when CRON_SECRET is unset. Truncated to
 *  32 hex chars: still 128 bits, and it keeps the URL readable in a log. */
export function recapImageSignature(coach: string, week: string): string | null {
  const secret = process.env.CRON_SECRET;
  if (!secret) return null;
  return createHmac("sha256", secret).update(`${coach}|${week}`).digest("hex").slice(0, 32);
}

/** The absolute image URL for a coach's week, or null when it cannot be
 *  signed or we do not know our own origin. Both are non-fatal: the digest
 *  simply posts without the card. */
export function recapImageUrl(
  appUrl: string | null | undefined,
  coach: string,
  week: Date
): string | null {
  if (!appUrl) return null;
  const day = week.toISOString().slice(0, 10);
  const sig = recapImageSignature(coach, day);
  if (!sig) return null;
  const q = new URLSearchParams({ coach, week: day, sig });
  return `${appUrl.replace(/\/$/, "")}/api/jobs/recap-image?${q.toString()}`;
}
