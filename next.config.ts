import type { NextConfig } from "next";

import { securityHeaders } from "./src/lib/security-headers";

// The policy itself lives in src/lib/security-headers.ts so it can be unit
// tested. It was inline here, and img-src silently fell out of sync with the
// media hosts the app actually stores — see that file's header.
const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  // Verification builds run alongside `npm run dev`, and both default to
  // writing .next — the build clobbers the dev server's compiled assets
  // (pages 404, CSS vanishes) until dev is restarted. Point ad-hoc builds at
  // a separate dir instead: NEXT_DIST_DIR=.next-build npm run build
  // (Vercel builds don't set the var, so deploys keep the default .next.)
  distDir: process.env.NEXT_DIST_DIR || ".next",
  // undici is loaded by src/instrumentation.ts to force HTTP/1.1. Webpack
  // can't bundle it — its mock agent imports node:console, an unhandled
  // scheme — so leave it to the Node runtime's own require.
  serverExternalPackages: ["undici"],
  // The transcription worker writes downloaded media into worker/data/ and
  // appends to worker.log / dev.log — all inside the repo. Without these
  // ignores the dev server rebuilds on every download, which starves the CPU
  // and leaves real page compiles (e.g. /research) stuck behind the loop.
  webpack(config, { isServer }) {
    // serverExternalPackages doesn't cover the instrumentation bundle, so
    // externalize undici here too — otherwise webpack tries to parse its mock
    // agent's `node:console` import and the build fails.
    if (isServer) {
      config.externals = [...(config.externals || []), { undici: "commonjs undici" }];
    }
    config.watchOptions = {
      ...config.watchOptions,
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/worker/data/**",
        "**/*.log",
      ],
    };
    return config;
  },
  async headers() {
    return [{ source: "/(.*)", headers: securityHeaders(isDev) }];
  },
};

export default nextConfig;
