import { describe, expect, it } from "vitest";
import {
  fetchProfile,
  fetchProfileVideos,
  normalizeInstagramItem,
  normalizeInstagramProfile,
  normalizeTikTokItem,
  normalizeTikTokProfile,
} from "@/lib/scrapecreators";
import { canonicalVideoUrl, detectPlatform, isPostUrl } from "@/lib/social-urls";

/**
 * Fixtures mirror the real Scrape Creators response shapes (captured from
 * /v1/instagram/user/reels, /v1/instagram/profile, /v3/tiktok/profile/videos
 * and /v1/tiktok/profile), trimmed to the fields we read. URLs are shortened;
 * the nesting is verbatim.
 */

const igReel = {
  media: {
    pk: "3957946697812227159",
    id: "3957946697812227159_13708114793",
    code: "Dbtc40zBzRX",
    taken_at: 1786044104,
    media_type: 2,
    product_type: "clips",
    play_count: 1728,
    ig_play_count: 1728,
    view_count: null,
    like_count: 79,
    comment_count: 2,
    reshare_count: null,
    caption: { text: "upgrade your life in 6 simple steps #productivity" },
    user: {
      pk: "13708114793",
      username: "adriel.motivates",
      full_name: "Adriel domfeh",
      profile_pic_url: "https://cdn.example/avatar.jpg",
    },
    image_versions2: {
      candidates: [
        { url: "https://cdn.example/thumb-1320.jpg", width: 1320, height: 2347 },
        { url: "https://cdn.example/thumb-1080.jpg", width: 1080, height: 1920 },
      ],
    },
    video_versions: [
      { type: 101, url: "https://cdn.example/reel-101.mp4", width: 720, height: 1280 },
      { type: 102, url: "https://cdn.example/reel-102.mp4", width: 720, height: 1280 },
    ],
  },
};

const igProfile = {
  success: true,
  data: {
    user: {
      username: "adriel.motivates",
      full_name: "Adriel domfeh",
      follower_count: null,
      edge_followed_by: { count: 372 },
      profile_pic_url: "https://cdn.example/pic-150.jpg",
      profile_pic_url_hd: "https://cdn.example/pic-320.jpg",
    },
  },
};

const tiktokVideo = {
  aweme_id: "7670963633991453982",
  aweme_type: 0,
  desc: "My team said i should wear this fit",
  create_time: 1786206145,
  share_url:
    "https://www.tiktok.com/@mrbeast/video/7670963633991453982?_r=1&u_code=abc&share_item_id=7670963633991453982",
  author: {
    unique_id: "mrbeast",
    nickname: "MrBeast",
    avatar_larger: { url_list: ["https://cdn.example/tt-avatar.jpg"] },
  },
  statistics: {
    play_count: 9430198,
    digg_count: 1905428,
    comment_count: 60858,
    share_count: 114267,
    collect_count: 108378,
  },
  video: {
    duration: 37800,
    cover: { url_list: ["https://cdn.example/tt-cover.jpg"] },
    origin_cover: { url_list: ["https://cdn.example/tt-origin-cover.jpg"] },
    play_addr: { url_list: ["https://cdn.example/tt-play.mp4"] },
    download_addr: { url_list: ["https://cdn.example/tt-download.mp4"] },
  },
};

const tiktokProfile = {
  user: {
    uniqueId: "mrbeast",
    nickname: "MrBeast",
    avatarLarger: "https://cdn.example/tt-avatar-lg.jpg",
    avatarMedium: "https://cdn.example/tt-avatar-md.jpg",
  },
  stats: { followerCount: 134700000, videoCount: 469 },
};

describe("normalizeInstagramItem", () => {
  it("maps a reel from the wrapped {media} envelope", () => {
    const item = normalizeInstagramItem(igReel);
    expect(item.shortcode).toBe("Dbtc40zBzRX");
    expect(item.externalId).toBe("3957946697812227159");
    expect(item.caption).toBe("upgrade your life in 6 simple steps #productivity");
    expect(item.ownerUsername).toBe("adriel.motivates");
    expect(item.likeCount).toBe(79);
    expect(item.commentCount).toBe(2);
    expect(item.isVideo).toBe(true);
  });

  it("accepts an already-unwrapped media object", () => {
    expect(normalizeInstagramItem(igReel.media).shortcode).toBe("Dbtc40zBzRX");
  });

  it("builds the post URL from the shortcode, since reels carry no url field", () => {
    expect(normalizeInstagramItem(igReel).url).toBe(
      "https://www.instagram.com/reel/Dbtc40zBzRX/"
    );
  });

  it("returns a null url rather than a broken one when the code is missing", () => {
    const { code: _code, ...rest } = igReel.media;
    expect(normalizeInstagramItem({ media: rest }).url).toBeNull();
  });

  it("prefers play_count, because view_count is null on this endpoint", () => {
    expect(normalizeInstagramItem(igReel).viewCount).toBe(1728);
  });

  it("takes the widest thumbnail — candidates come widest-first", () => {
    expect(normalizeInstagramItem(igReel).thumbnailUrl).toBe(
      "https://cdn.example/thumb-1320.jpg"
    );
  });

  it("takes the first video rendition", () => {
    expect(normalizeInstagramItem(igReel).videoUrl).toBe("https://cdn.example/reel-101.mp4");
  });

  it("converts taken_at from epoch seconds to ISO", () => {
    expect(normalizeInstagramItem(igReel).postedAt).toBe("2026-08-06T19:21:44.000Z");
  });

  it("flags a photo post as not a video so the scrape can skip it", () => {
    const photo = {
      media: {
        ...igReel.media,
        media_type: 1,
        product_type: "feed",
        video_versions: [],
      },
    };
    expect(normalizeInstagramItem(photo).isVideo).toBe(false);
  });

  it("survives an empty object without throwing", () => {
    const item = normalizeInstagramItem({});
    expect(item.url).toBeNull();
    expect(item.viewCount).toBeNull();
    expect(item.isVideo).toBe(false);
  });
});

describe("normalizeInstagramProfile", () => {
  it("reads the follower count off the GraphQL edge, not follower_count", () => {
    expect(normalizeInstagramProfile(igProfile).followersCount).toBe(372);
  });

  it("prefers the HD profile picture", () => {
    expect(normalizeInstagramProfile(igProfile).profilePicUrl).toBe(
      "https://cdn.example/pic-320.jpg"
    );
  });

  it("maps username and display name", () => {
    const p = normalizeInstagramProfile(igProfile);
    expect(p.username).toBe("adriel.motivates");
    expect(p.displayName).toBe("Adriel domfeh");
  });

  it("survives a payload with no user", () => {
    expect(normalizeInstagramProfile({ data: {} }).username).toBeNull();
  });
});

describe("normalizeTikTokItem", () => {
  it("maps stats from the statistics object", () => {
    const item = normalizeTikTokItem(tiktokVideo);
    expect(item.viewCount).toBe(9430198);
    expect(item.likeCount).toBe(1905428);
    expect(item.commentCount).toBe(60858);
    expect(item.shareCount).toBe(114267);
  });

  it("rebuilds a clean url instead of keeping share_url's tracking params", () => {
    expect(normalizeTikTokItem(tiktokVideo).url).toBe(
      "https://www.tiktok.com/@mrbeast/video/7670963633991453982"
    );
  });

  it("falls back to share_url when the author handle is missing", () => {
    const { author: _author, ...rest } = tiktokVideo;
    expect(normalizeTikTokItem(rest).url).toBe(tiktokVideo.share_url);
  });

  it("unwraps url_list for covers and video files", () => {
    const item = normalizeTikTokItem(tiktokVideo);
    expect(item.thumbnailUrl).toBe("https://cdn.example/tt-origin-cover.jpg");
    expect(item.videoUrl).toBe("https://cdn.example/tt-play.mp4");
    expect(item.ownerProfilePicUrl).toBe("https://cdn.example/tt-avatar.jpg");
  });

  it("flags a photo carousel (aweme_type 150) as not a video", () => {
    // These come back in the video feed with an mp3 in play_addr.
    expect(normalizeTikTokItem({ ...tiktokVideo, aweme_type: 150 }).isVideo).toBe(false);
  });

  it("points a photo carousel at /photo/, which is where TikTok serves it", () => {
    expect(normalizeTikTokItem({ ...tiktokVideo, aweme_type: 150 }).url).toBe(
      "https://www.tiktok.com/@mrbeast/photo/7670963633991453982"
    );
  });

  it("unwraps the aweme_detail envelope from the single-video endpoint", () => {
    expect(normalizeTikTokItem({ aweme_detail: tiktokVideo }).externalId).toBe(
      "7670963633991453982"
    );
  });

  it("converts create_time from epoch seconds to ISO", () => {
    expect(normalizeTikTokItem(tiktokVideo).postedAt).toBe("2026-08-08T16:22:25.000Z");
  });

  it("survives an empty object without throwing", () => {
    expect(normalizeTikTokItem({}).externalId).toBeNull();
  });
});

describe("normalizeTikTokProfile", () => {
  it("maps handle, display name, followers and avatar", () => {
    const p = normalizeTikTokProfile(tiktokProfile);
    expect(p.username).toBe("mrbeast");
    expect(p.displayName).toBe("MrBeast");
    expect(p.followersCount).toBe(134700000);
    expect(p.profilePicUrl).toBe("https://cdn.example/tt-avatar-lg.jpg");
  });
});

describe("url helpers", () => {
  it("collapses every Instagram post form to one canonical reel url", () => {
    const canonical = "https://www.instagram.com/reel/ABC123/";
    for (const form of ["p", "reel", "reels", "tv"]) {
      expect(canonicalVideoUrl(`https://www.instagram.com/${form}/ABC123/`)).toBe(canonical);
    }
  });

  it("strips query params from TikTok urls", () => {
    expect(canonicalVideoUrl("https://www.tiktok.com/@a/video/123?_r=1&is_from=x")).toBe(
      "https://www.tiktok.com/@a/video/123"
    );
  });

  it("detects the platform from a url", () => {
    expect(detectPlatform("https://www.instagram.com/reel/x/")).toBe("instagram");
    expect(detectPlatform("https://www.tiktok.com/@a/video/1")).toBe("tiktok");
    expect(detectPlatform("https://youtube.com/watch?v=1")).toBeNull();
  });

  it("rejects profile urls as post urls", () => {
    expect(isPostUrl("https://www.instagram.com/adriel.motivates/")).toBe(false);
    expect(isPostUrl("https://www.tiktok.com/@mrbeast")).toBe(false);
    expect(isPostUrl("https://www.instagram.com/reel/ABC123/")).toBe(true);
  });
});

/**
 * The API reports a missing or deactivated account as HTTP 200 with
 * `success: true` and the failure buried in the body. Trusting the status code
 * let a typo'd handle normalize to all-nulls and an empty video list, which the
 * scrape recorded as a creator with status 'ready' and no videos — visually
 * identical to a real account that hadn't posted. These pin the loud failure.
 */
describe("in-body error envelopes", () => {
  const withFetch = async (body: unknown, run: () => Promise<unknown>) => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;
    process.env.SCRAPECREATORS_API_KEY ??= "test-key";
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it("rejects a not_found instagram profile", async () => {
    await withFetch(
      {
        success: true,
        error: "not_found",
        errorStatus: 404,
        message: "Account doesn't exist",
      },
      async () => {
        await expect(fetchProfile("instagram", "nope")).rejects.toThrow(/Account doesn't exist/);
      }
    );
  });

  it("rejects a deactivated tiktok account, which carries no error field", async () => {
    await withFetch(
      { success: true, account_deactivated: true, message: "Account doesn't exist" },
      async () => {
        await expect(fetchProfile("tiktok", "nope")).rejects.toThrow(/account_deactivated/);
      }
    );
  });

  it("rejects a paged video fetch for a missing account", async () => {
    await withFetch({ success: true, error: "not_found", errorStatus: 404 }, async () => {
      await expect(fetchProfileVideos("instagram", "nope", 10)).rejects.toThrow(/not_found/);
    });
  });

  it("does not mistake a successful payload for a failure", async () => {
    await withFetch(
      { success: true, status: "ok", status_code: 0, data: { user: { username: "real" } } },
      async () => {
        expect((await fetchProfile("instagram", "real")).username).toBe("real");
      }
    );
  });
});
