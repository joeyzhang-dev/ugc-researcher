import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  __noteRateLimitHeaders,
  __rateLimitState,
  __resetRateLimitState,
  fetchPostInsights,
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

// `lpGet` is private, so drive it through the thinnest public caller that
// reaches it. Only the retry predicate is under test here — what counts as
// worth asking again, and what does not.
describe("Launchpoint transient-failure retries", () => {
  const savedKey = process.env.LAUNCHPOINT_API_KEY;

  beforeEach(() => {
    __resetRateLimitState();
    process.env.LAUNCHPOINT_API_KEY = "test-key";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedKey === undefined) delete process.env.LAUNCHPOINT_API_KEY;
    else process.env.LAUNCHPOINT_API_KEY = savedKey;
  });

  const insightsOk = () =>
    new Response(JSON.stringify({ data: { insights: { status: "available", views: 7 } } }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });

  // The bug this pins: `AbortSignal.timeout` rejects with a DOMException named
  // TimeoutError, which is neither a TypeError nor a TransientLaunchpointError.
  // It therefore fell straight past the retry predicate, and one slow upstream
  // page aborted an entire multi-minute pass with nothing persisted.
  // (Spends one real backoff — RETRY_BACKOFF_MS — between the two attempts.)
  it("retries a timed-out request instead of failing the whole pass", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException("The operation was aborted due to timeout", "TimeoutError")
      )
      .mockResolvedValueOnce(insightsOk());
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPostInsights("abc")).resolves.toMatchObject({ available: true, views: 7 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  // The other half of the predicate: a 404 is a fact about the post, not a
  // blip, so spending two more requests and two backoffs on it is pure waste.
  it("does not retry a 404, which asking again cannot fix", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("no such post", { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchPostInsights("gone")).rejects.toThrow(/404/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
