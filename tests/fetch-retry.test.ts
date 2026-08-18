import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withNetworkRetry } from "@/lib/fetch-retry";

describe("withNetworkRetry", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const settle = async <T>(p: Promise<T>): Promise<T> => {
    const guarded = p.catch((e) => {
      throw e;
    });
    await vi.runAllTimersAsync();
    return guarded;
  };

  it("retries a network-level rejection and returns the eventual response", async () => {
    let calls = 0;
    const flaky = async () => {
      calls++;
      if (calls < 3) throw new TypeError("fetch failed");
      return new Response("ok");
    };
    const res = await settle(withNetworkRetry(flaky)("https://x.test/a"));
    expect(await res.text()).toBe("ok");
    expect(calls).toBe(3);
  });

  it("gives up after exhausting attempts and rethrows the last error", async () => {
    let calls = 0;
    const dead = async () => {
      calls++;
      throw new TypeError("fetch failed");
    };
    const promise = withNetworkRetry(dead)("https://x.test/a");
    const assertion = expect(promise).rejects.toThrow(/fetch failed/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(3);
  });

  it("retries thrown values that only look like TypeErrors from another realm", async () => {
    let calls = 0;
    const crossRealm = async () => {
      calls++;
      if (calls < 2) throw { name: "TypeError", message: "fetch failed" };
      return new Response("ok");
    };
    const res = await settle(withNetworkRetry(crossRealm)("https://x.test/a"));
    expect(res.ok).toBe(true);
    expect(calls).toBe(2);
  });

  it("does not retry HTTP error responses — they are answers, not failures", async () => {
    let calls = 0;
    const notFound = async () => {
      calls++;
      return new Response("nope", { status: 404 });
    };
    const res = await settle(withNetworkRetry(notFound)("https://x.test/a"));
    expect(res.status).toBe(404);
    expect(calls).toBe(1);
  });

  it("does not retry an aborted request — the caller gave up on purpose", async () => {
    let calls = 0;
    const aborted = async () => {
      calls++;
      throw new DOMException("This operation was aborted", "AbortError");
    };
    const promise = withNetworkRetry(aborted)("https://x.test/a");
    const assertion = expect(promise).rejects.toThrow(/aborted/);
    await vi.runAllTimersAsync();
    await assertion;
    expect(calls).toBe(1);
  });
});
