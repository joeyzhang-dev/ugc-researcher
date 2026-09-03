import { describe, expect, it } from "vitest";
import { isPublicPath, isCreatorSurface } from "@/lib/routing";

describe("isPublicPath", () => {
  it("lets the scheduled-job cron through the staff-session gate", () => {
    // Regression: the cron route first shipped at /api/cron/research, which
    // isPublicPath does not cover. Vercel Cron authenticates with a bearer
    // token and carries no Supabase session cookie, so the middleware saw a
    // signed-out request and 307'd every firing to /login — the handler never
    // ran. Living under /api/jobs is what makes it reachable.
    expect(isPublicPath("/api/jobs/cron")).toBe(true);
    expect(isPublicPath("/api/jobs/research")).toBe(true);
  });

  it("keeps staff surfaces behind the gate", () => {
    expect(isPublicPath("/research")).toBe(false);
    expect(isPublicPath("/creators")).toBe(false);
    expect(isPublicPath("/settings")).toBe(false);
    expect(isPublicPath("/discord")).toBe(false);
  });

  it("keeps the coach surface behind the session gate, and out of the creator surfaces", () => {
    // /coach is a signed-in page for the coach role. It must not be public
    // (a team's numbers are not for the open web) and must not read as a
    // creator surface — `/c/` needs the slash, so "/coach" is a staff-style
    // path that the MFA gate applies to like any other.
    expect(isPublicPath("/coach")).toBe(false);
    expect(isCreatorSurface("/coach")).toBe(false);
  });

  it("treats creator surfaces and login as public", () => {
    expect(isPublicPath("/c/abc123")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
  });

  it("does not mistake the staff /creators page for a creator surface", () => {
    expect(isCreatorSurface("/creator")).toBe(true);
    expect(isCreatorSurface("/creators")).toBe(false);
  });
});
