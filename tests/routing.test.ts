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

  it("treats creator surfaces and login as public", () => {
    expect(isPublicPath("/c/abc123")).toBe(true);
    expect(isPublicPath("/login")).toBe(true);
  });

  it("does not mistake the staff /creators page for a creator surface", () => {
    expect(isCreatorSurface("/creator")).toBe(true);
    expect(isCreatorSurface("/creators")).toBe(false);
  });
});
