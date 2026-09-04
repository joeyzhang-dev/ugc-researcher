import { describe, expect, it } from "vitest";
import { MEDIA_HOSTS, contentSecurityPolicy, directive } from "@/lib/security-headers";

describe("content security policy", () => {
  it("allows images from every host we store media URLs on", () => {
    // Regression: `img-src` listed Supabase and the Instagram CDNs but never
    // gained cdn.launchpointhq.com, which the Launchpoint sync started writing
    // into research_videos.thumbnail_url. Measured 2026-09-04: 69% of roster
    // posts in the last 30 days had a Launchpoint thumbnail, so /research
    // rendered a grid of blank tiles — and silently, because a CSP block is a
    // console warning, not an error anyone sees.
    const imgSrc = directive(contentSecurityPolicy(false), "img-src");
    for (const host of MEDIA_HOSTS) expect(imgSrc).toContain(host);
  });

  it("allows video from the same hosts", () => {
    // One list feeds both directives. The bug above was adding a media source
    // and updating neither; splitting the lists is how it happens again.
    const mediaSrc = directive(contentSecurityPolicy(false), "media-src");
    for (const host of MEDIA_HOSTS) expect(mediaSrc).toContain(host);
  });

  it("keeps the page itself locked down", () => {
    const csp = contentSecurityPolicy(false);
    expect(directive(csp, "default-src")).toBe("'self'");
    expect(directive(csp, "frame-ancestors")).toBe("'none'");
    expect(directive(csp, "base-uri")).toBe("'self'");
    expect(directive(csp, "form-action")).toBe("'self'");
  });

  it("only loosens script-src and connect-src in development", () => {
    // HMR evaluates code via eval() and talks over a websocket; production
    // builds use neither, so the strict policy has to survive there.
    expect(directive(contentSecurityPolicy(true), "script-src")).toContain("'unsafe-eval'");
    expect(directive(contentSecurityPolicy(false), "script-src")).not.toContain("'unsafe-eval'");
    expect(directive(contentSecurityPolicy(true), "connect-src")).toContain("ws:");
    expect(directive(contentSecurityPolicy(false), "connect-src")).not.toContain("ws:");
  });
});
