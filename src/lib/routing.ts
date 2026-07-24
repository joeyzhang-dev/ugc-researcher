// ---------------------------------------------------------------------------
// URL/path routing helpers — creator/staff surface classification + the OAuth
// callback's open-redirect allow-list.
// ---------------------------------------------------------------------------
//
// These are pure, dependency-free functions (no `next/*` imports) so they can be
// unit-tested and shared by the middleware (`updateSession`) and the OAuth
// callback (`/auth/callback`) without duplicating — and drifting — the rules
// that keep creator and staff surfaces isolated.

// ---------------------------------------------------------------------------
// OAuth redirect-destination allow-list (open-redirect prevention)
// ---------------------------------------------------------------------------

// Only relative, path-only destinations matching one of these creator-surface
// patterns may be used as a post-OAuth redirect. CREATOR_RE intentionally does
// NOT match the staff page /creators (after "creator" the next char must be "/"
// or end-of-string).
const LEGACY_PORTAL_RE = /^\/c\/[A-Za-z0-9]+\/?$/;
const INVITE_RE = /^\/invite\/([a-f0-9]{64})\/?$/;
const CREATOR_RE = /^\/creator(?:\/[A-Za-z0-9_\-/]*)?$/;

/**
 * Returns the sanitized redirect path, or null when the value is not in the
 * allow-list. Absolute URLs, protocol-relative URLs, and any unlisted path are
 * rejected so the OAuth callback can never be used as an open redirect.
 */
export function sanitizeRedirectNext(next: string): string | null {
  if (!next.startsWith("/") || next.startsWith("//")) return null;
  if (LEGACY_PORTAL_RE.test(next)) return next;
  if (INVITE_RE.test(next)) return next;
  if (CREATOR_RE.test(next)) return next;
  return null;
}

/**
 * Extracts the raw 64-hex invite token from an `/invite/<token>` destination,
 * or null when `next` is not a well-formed invite path. Callers should pass an
 * already-sanitized destination.
 */
export function inviteTokenFromNext(next: string): string | null {
  const match = INVITE_RE.exec(next);
  return match ? match[1] : null;
}

// ---------------------------------------------------------------------------
// Self-authenticating webhook receivers (middleware bypass allow-list)
// ---------------------------------------------------------------------------

// Webhook endpoints that verify every request themselves with a fail-closed
// HMAC/signature check, so the staff-session gate must let their
// unauthenticated POSTs reach the route handler (otherwise they'd be redirected
// to /login and never processed). This is an EXPLICIT enumeration: arbitrary
// `/api/webhooks/*` paths are NOT public — only the routes listed here bypass
// the gate, and each one is responsible for authenticating its own callers.
const AUTHENTICATED_WEBHOOK_PATHS: ReadonlySet<string> = new Set([
  "/api/webhooks/signwell",
]);

/**
 * True for an enumerated webhook route that authenticates its own requests
 * (e.g. the SignWell HMAC receiver). Matches an allow-listed path exactly, with
 * an optional single trailing slash — never as a prefix, so sub-paths and
 * lookalikes (`/api/webhooks/signwell/x`, `/api/webhooks/signwellx`) and any
 * unlisted `/api/webhooks/*` route stay protected by the staff gate.
 */
export function isAuthenticatedWebhook(path: string): boolean {
  const normalized =
    path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  return AUTHENTICATED_WEBHOOK_PATHS.has(normalized);
}

// ---------------------------------------------------------------------------
// Creator / staff surface classification (middleware routing)
// ---------------------------------------------------------------------------

/**
 * True for the public, non-staff surfaces: the legacy creator portal (/c/*),
 * the OAuth callback (/auth*), invite redemption (/invite/*), and the
 * authenticated creator flow (/creator and /creator/*). `/creator` matches
 * exactly or with a trailing slash so the STAFF pages /creators (and
 * /creators/*) are NOT treated as a creator surface. Staff MFA routing must
 * never be applied to any of these.
 */
export function isCreatorSurface(path: string): boolean {
  return (
    path.startsWith("/c/") ||
    path.startsWith("/auth") ||
    path.startsWith("/invite/") ||
    path === "/creator" ||
    path.startsWith("/creator/")
  );
}

/**
 * True for paths that do NOT require an authenticated staff session: the login
 * pages, scheduled-job endpoints (authorized separately by CRON_SECRET),
 * self-authenticating webhook receivers (authorized by their own fail-closed
 * HMAC check — see {@link isAuthenticatedWebhook}), and every creator surface.
 * A signed-out request to any other path is redirected to /login by the
 * middleware.
 */
export function isPublicPath(path: string): boolean {
  return (
    path.startsWith("/login") ||
    path.startsWith("/api/jobs") ||
    isAuthenticatedWebhook(path) ||
    isCreatorSurface(path)
  );
}
