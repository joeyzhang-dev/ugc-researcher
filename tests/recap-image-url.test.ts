import { beforeEach, describe, expect, it } from "vitest";
import { recapImageSignature, recapImageUrl } from "@/lib/recap-image-url";

const WEEK = new Date("2026-08-24T00:00:00Z");

describe("recapImageUrl", () => {
  beforeEach(() => {
    process.env.CRON_SECRET = "test-secret";
  });

  it("signs coach and week together", () => {
    // A link leaked for one week must not open another.
    expect(recapImageSignature("Coach: Will's Team", "2026-08-24")).not.toBe(
      recapImageSignature("Coach: Will's Team", "2026-08-31")
    );
    expect(recapImageSignature("Coach: Will's Team", "2026-08-24")).not.toBe(
      recapImageSignature("Coach: Luke's Team", "2026-08-24")
    );
  });

  it("gives a different URL per nonce, so a retry can beat Discord's cache", () => {
    const a = recapImageUrl("https://bludgc.vercel.app", "Coach: Will's Team", WEEK, "abc");
    const b = recapImageUrl("https://bludgc.vercel.app", "Coach: Will's Team", WEEK, "def");
    expect(a).not.toBe(b);
    expect(a).toContain("n=abc");
  });

  it("covers the nonce in the signature, so it cannot be swapped", () => {
    expect(recapImageSignature("c", "2026-08-24", "abc")).not.toBe(
      recapImageSignature("c", "2026-08-24", "def")
    );
  });

  it("omits the nonce param entirely when there is none", () => {
    // Keeps the un-nonced signature stable for callers that don't pass one.
    const url = recapImageUrl("https://bludgc.vercel.app", "c", WEEK);
    expect(url).not.toContain("n=");
    expect(url).toContain(recapImageSignature("c", "2026-08-24")!);
  });

  it("returns null rather than an unsigned URL when CRON_SECRET is unset", () => {
    delete process.env.CRON_SECRET;
    expect(recapImageUrl("https://bludgc.vercel.app", "c", WEEK)).toBeNull();
  });

  it("returns null when we do not know our own origin", () => {
    expect(recapImageUrl(null, "c", WEEK)).toBeNull();
  });
});
