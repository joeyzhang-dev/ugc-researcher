import type { NextConfig } from "next";

// Next.js dev (HMR / React Refresh) evaluates code via eval() and talks to the
// dev server over a websocket — both need to be allowed in development only.
// Production builds use neither, so the stricter policy stays there.
const isDev = process.env.NODE_ENV !== "production";
const scriptSrc = isDev
  ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
  : "script-src 'self' 'unsafe-inline'";
const connectSrc = isDev
  ? "connect-src 'self' https://*.supabase.co ws: wss:"
  : "connect-src 'self' https://*.supabase.co";

const securityHeaders = [
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
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next.js requires inline scripts/styles without a nonce setup.
      // Dev additionally needs 'unsafe-eval' for HMR (see scriptSrc above).
      scriptSrc,
      "style-src 'self' 'unsafe-inline'",
      // Supabase API + storage (thumbnails); Instagram CDN as fallback.
      // Dev additionally needs ws:/wss: for HMR (see connectSrc above).
      connectSrc,
      "img-src 'self' data: https://*.supabase.co https://*.cdninstagram.com https://*.fbcdn.net",
      // Reel playback in review mode — video files live in Supabase storage.
      "media-src 'self' https://*.supabase.co",
      "frame-ancestors 'none'",
      "form-action 'self'",
      "base-uri 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // Verification builds run alongside `npm run dev`, and both default to
  // writing .next — the build clobbers the dev server's compiled assets
  // (pages 404, CSS vanishes) until dev is restarted. Point ad-hoc builds at
  // a separate dir instead: NEXT_DIST_DIR=.next-build npm run build
  // (Vercel builds don't set the var, so deploys keep the default .next.)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders }];
  },
};

export default nextConfig;
