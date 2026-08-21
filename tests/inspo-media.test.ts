import { describe, expect, it } from "vitest";
import {
  detectPlatform,
  extractVideoUrl,
  inspoStoragePath,
  targetBitrateKbps,
} from "@/lib/inspo-media";

describe("inspoStoragePath", () => {
  it("derives the deterministic bucket path the Python pager also uses", () => {
    const path = inspoStoragePath("https://www.tiktok.com/t/ZTD6W5AAH/");
    expect(path).toMatch(/^inspo\/[0-9a-f]{16}\.mp4$/);
    // Deterministic — the portal can predict where a resolved video lives.
    expect(inspoStoragePath("https://www.tiktok.com/t/ZTD6W5AAH/")).toBe(path);
    expect(inspoStoragePath("https://www.tiktok.com/t/OTHER/")).not.toBe(path);
  });
});

describe("targetBitrateKbps", () => {
  it("matches the Python pager's math exactly", () => {
    // Same fixtures as worker/tests/test_script_pager.py.
    expect(targetBitrateKbps(60)).toBe(924);
    expect(targetBitrateKbps(3600)).toBe(200);
  });
});

describe("detectPlatform", () => {
  it("recognizes instagram and tiktok post links", () => {
    expect(detectPlatform("https://www.instagram.com/reel/DbbkP_UBCIL/")).toBe("instagram");
    expect(detectPlatform("https://www.tiktok.com/t/ZTAchq95u/")).toBe("tiktok");
  });

  it("treats direct media links as files", () => {
    expect(detectPlatform("https://cdn.example.com/clip.mp4")).toBe("file");
    expect(detectPlatform("https://cdn.example.com/clip.MOV?sig=x")).toBe("file");
  });

  it("rejects everything else", () => {
    expect(detectPlatform("https://example.com/some-page")).toBeNull();
    expect(detectPlatform("not a url")).toBeNull();
  });
});

describe("extractVideoUrl", () => {
  it("reads instagram video_url first, then video_versions", () => {
    expect(
      extractVideoUrl("instagram", {
        data: { xdt_shortcode_media: { video_url: "https://cdn/v.mp4" } },
      })
    ).toBe("https://cdn/v.mp4");
    expect(
      extractVideoUrl("instagram", {
        data: { xdt_shortcode_media: { video_versions: [{ url: "https://cdn/vv.mp4" }] } },
      })
    ).toBe("https://cdn/vv.mp4");
  });

  it("reads tiktok play_addr then download_addr url lists", () => {
    expect(
      extractVideoUrl("tiktok", {
        aweme_detail: { video: { play_addr: { url_list: ["https://cdn/t.mp4"] } } },
      })
    ).toBe("https://cdn/t.mp4");
    expect(
      extractVideoUrl("tiktok", {
        aweme_detail: { video: { download_addr: { url_list: ["https://cdn/d.mp4"] } } },
      })
    ).toBe("https://cdn/d.mp4");
  });

  it("returns null when the payload has nothing usable", () => {
    expect(extractVideoUrl("instagram", {})).toBeNull();
    expect(extractVideoUrl("tiktok", { aweme_detail: { video: {} } })).toBeNull();
  });
});
