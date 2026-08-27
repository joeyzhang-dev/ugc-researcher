import { beforeEach, describe, expect, it } from "vitest";
import {
  __noteRateLimitHeaders,
  __rateLimitState,
  __resetRateLimitState,
} from "@/lib/launchpoint";

const headers = (h: Record<string, string>) => new Headers(h);

describe("Launchpoint rate-limit accounting", () => {
  beforeEach(() => __resetRateLimitState());

  // The bug this pins: `x-ratelimit-reset` is an ABSOLUTE Unix timestamp in
  // seconds, not a seconds-to-wait duration. Reading it as a duration produced
  // a ~56-year wait, which then clamped to the ceiling on every single 429.
  it("reads reset as an absolute epoch-seconds timestamp", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 42;
    __noteRateLimitHeaders(headers({ "x-ratelimit-remaining": "17", "x-ratelimit-reset": String(resetAt) }));
    const state = __rateLimitState();
    expect(state.remaining).toBe(17);
    expect(state.resetAtMs).toBe(resetAt * 1000);
    // The derived wait must be seconds away, not decades.
    expect(state.resetAtMs - Date.now()).toBeLessThan(60_000);
  });

  // A small value is a different unit than we expect. Guessing at it would
  // reintroduce exactly the bug above, so it is ignored instead.
  it("ignores a reset value that is too small to be an epoch timestamp", () => {
    __noteRateLimitHeaders(headers({ "x-ratelimit-remaining": "3", "x-ratelimit-reset": "60" }));
    expect(__rateLimitState().resetAtMs).toBe(0);
    expect(__rateLimitState().remaining).toBe(3);
  });

  it("tracks a spent window", () => {
    const resetAt = Math.floor(Date.now() / 1000) + 10;
    __noteRateLimitHeaders(headers({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetAt) }));
    expect(__rateLimitState().remaining).toBe(0);
  });

  // Missing headers must leave the limiter unopinionated rather than assuming
  // a spent window and stalling every request.
  it("stays null when the server sends no rate-limit headers", () => {
    __noteRateLimitHeaders(headers({}));
    expect(__rateLimitState().remaining).toBeNull();
  });
});
