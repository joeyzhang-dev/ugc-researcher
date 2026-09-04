/**
 * The app's security headers, extracted from next.config.ts so the policy can
 * be tested.
 *
 * It was inline before, and the CSP's `img-src` fell out of sync with the data:
 * the Launchpoint sync began writing `cdn.launchpointhq.com` thumbnails into
 * `research_videos.thumbnail_url`, nothing added that host to the policy, and
 * /research rendered 69% of its grid as blank tiles. A CSP block is a console
 * warning rather than a thrown error, so nothing surfaced it — the tiles just
 * fell back to their play glyph and looked like missing data.
 */

/**
 * Every host we store or hotlink media from.
 *
 * ONE list feeding both `img-src` and `media-src`, deliberately. Splitting them
 * is how a new media source gets added to one directive and forgotten in the
 * other; a poster and its video come from the same places.
 */
export const MEDIA_HOSTS = [
  // Our own storage: the standalone project, plus the old shared one that
  // still serves everything captured before the 2026-08-26 fork.
  "https://*.supabase.co",
  // Launchpoint's CDN — first-party post thumbnails from the analytics sync.
  "https://cdn.launchpointhq.com",
  // Instagram, for media not yet copied into our buckets.
  "https://*.cdninstagram.com",
  "https://*.fbcdn.net",
] as const;

/** The policy. `isDev` loosens exactly two directives and nothing else. */
export function contentSecurityPolicy(isDev: boolean): string {
  const media = MEDIA_HOSTS.join(" ");
  return [
    "default-src 'self'",
    // Next.js needs inline scripts/styles without a nonce setup; dev
    // additionally evaluates code via eval() for HMR.
    `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    // Supabase API; dev additionally needs ws:/wss: for HMR.
    `connect-src 'self' https://*.supabase.co${isDev ? " ws: wss:" : ""}`,
    `img-src 'self' data: ${media}`,
    `media-src 'self' ${media}`,
    "frame-ancestors 'none'",
    "form-action 'self'",
    "base-uri 'self'",
  ].join("; ");
}

/** Read one directive back out of a policy string — used by the tests, and by
 *  anyone debugging what is actually being served. */
export function directive(csp: string, name: string): string {
  const found = csp
    .split(";")
    .map((part) => part.trim())
    .find((part) => part === name || part.startsWith(`${name} `));
  return found ? found.slice(name.length).trim() : "";
}

export function securityHeaders(isDev: boolean): { key: string; value: string }[] {
  return [
    // Force HTTPS for two years, subdomains included.
    { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
    // Never allow this internal tool inside an iframe (clickjacking).
    { key: "X-Frame-Options", value: "DENY" },
    { key: "X-Content-Type-Options", value: "nosniff" },
    // Don't leak internal URLs when following outbound links (e.g. to Instagram).
    { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
    // Keep the internal tool out of search engines.
    { key: "X-Robots-Tag", value: "noindex, nofollow" },
    { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
    { key: "Content-Security-Policy", value: contentSecurityPolicy(isDev) },
  ];
}
