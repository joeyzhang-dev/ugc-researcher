import { describe, expect, it } from "vitest";
import {
  isoFromEpochMillis,
  normalizeAccount,
  normalizeHistory,
  normalizeInsights,
  normalizePost,
  nameKey,
  pickPrimaryAccount,
  profileUrl,
  shortcodeFromUrl,
  toPlatform,
  type LaunchpointAccount,
} from "@/lib/launchpoint";
import { matchChannelToContractor, withinTranscribeWindow } from "@/lib/jobs/launchpoint";

describe("shortcodeFromUrl", () => {
  // The entire Launchpoint ↔ research_videos join rests on this function.
  it("parses the canonical reel URL Launchpoint stores", () => {
    expect(shortcodeFromUrl("https://www.instagram.com/reel/DceXz3rTr9Q/")).toBe("DceXz3rTr9Q");
  });

  it("accepts the /p/ and /tv/ forms", () => {
    expect(shortcodeFromUrl("https://instagram.com/p/ABC-123_x/")).toBe("ABC-123_x");
    expect(shortcodeFromUrl("https://www.instagram.com/tv/XyZ/")).toBe("XyZ");
  });

  it("ignores query strings and trailing path", () => {
    expect(shortcodeFromUrl("https://www.instagram.com/reel/DceXz3rTr9Q/?igsh=abc")).toBe(
      "DceXz3rTr9Q"
    );
  });

  // A wrong shortcode would attach one creator's retention numbers to another
  // creator's post, so anything unrecognized must fail closed.
  it("returns null for TikTok, YouTube and junk rather than guessing", () => {
    expect(shortcodeFromUrl("https://www.tiktok.com/@psychorinn/video/7678181756532509983")).toBeNull();
    expect(shortcodeFromUrl("https://youtube.com/shorts/abc")).toBeNull();
    expect(shortcodeFromUrl("")).toBeNull();
    expect(shortcodeFromUrl(null)).toBeNull();
    expect(shortcodeFromUrl("not a url")).toBeNull();
  });
});

describe("isoFromEpochMillis", () => {
  it("converts Launchpoint's millisecond timestamps", () => {
    expect(isoFromEpochMillis(1786916245000)).toBe("2026-08-16T21:37:25.000Z");
  });

  // Seconds-vs-milliseconds is the classic silent corruption: a seconds value
  // interpreted as ms lands in 1970 and quietly poisons every date filter.
  it("rejects a seconds-scale value instead of landing it in 1970", () => {
    expect(isoFromEpochMillis(1786916245)).toBeNull();
  });

  it("handles missing values", () => {
    expect(isoFromEpochMillis(null)).toBeNull();
    expect(isoFromEpochMillis(0)).toBeNull();
    expect(isoFromEpochMillis("nope")).toBeNull();
  });
});

describe("normalizePost", () => {
  it("normalizes a live Instagram post, deriving the join key from the URL", () => {
    const post = normalizePost({
      id: "b9208ba0-dee0-4722-baeb-ec11e0eb55e7",
      creatorId: "crt_RYWFkFb6",
      title: "Open-ended",
      platform: "instagram",
      url: "https://www.instagram.com/reel/DceXz3rTr9Q/",
      thumbnail: "https://cdn.launchpointhq.com/x.jpeg",
      views: 1351966,
      likes: 39166,
      comments: 549,
      shares: 5565,
      earnings: 0,
      paid: false,
      contractorName: "Liam Christianson",
      uploadedAt: 1786916245000,
    });
    expect(post).toMatchObject({
      id: "b9208ba0-dee0-4722-baeb-ec11e0eb55e7",
      shortcode: "DceXz3rTr9Q",
      platform: "instagram",
      views: 1351966,
      earnings: 0,
      paid: false,
      uploadedAt: "2026-08-16T21:37:25.000Z",
    });
  });

  it("leaves shortcode null for a TikTok post", () => {
    const post = normalizePost({
      id: "x",
      platform: "tiktok",
      url: "https://www.tiktok.com/@psychorinn/video/7678181756532509983",
      paid: true,
    });
    expect(post.shortcode).toBeNull();
    expect(post.paid).toBe(true);
  });

  // `paid` drives money display; a missing field must read as unpaid, never as
  // a truthy object.
  it("treats a missing paid flag as false", () => {
    expect(normalizePost({ id: "x", platform: "instagram" }).paid).toBe(false);
  });
});

describe("normalizeInsights", () => {
  it("unwraps the data envelope for an available Instagram post", () => {
    const insights = normalizeInsights({
      data: {
        insights: {
          status: "available",
          reason: null,
          updatedAt: 1787718273407,
          views: 1351963,
          reach: 1132304,
          saves: 27796,
          shares: 5565,
          totalWatchTimeMs: 18817022779,
          avgWatchTimeMs: 16682,
          skipRate: 41,
        },
      },
    });
    expect(insights).toMatchObject({
      available: true,
      reach: 1132304,
      saves: 27796,
      avgWatchTimeMs: 16682,
      skipRate: 41,
      totalWatchTimeMs: 18817022779,
    });
  });

  // TikTok answers 200 with no_data — a successful empty answer, not a failure.
  // The sync must record it as "synced, nothing there" or the post sits at the
  // head of the queue forever.
  it("reads an unsupported-platform answer as unavailable, not an error", () => {
    const insights = normalizeInsights({
      data: { insights: { status: "no_data", reason: "unsupported_platform", views: null } },
    });
    expect(insights.available).toBe(false);
    expect(insights.reason).toBe("unsupported_platform");
    expect(insights.reach).toBeNull();
  });

  it("survives a malformed payload", () => {
    expect(normalizeInsights({}).available).toBe(false);
    expect(normalizeInsights({ data: null }).available).toBe(false);
  });
});

describe("normalizeHistory", () => {
  const payload = {
    data: {
      history: [
        { date: "2026-08-17", views: 715218, viewsDelta: 715218, likes: 20000 },
        { date: "2026-08-18", views: 1141156, viewsDelta: 425938, likes: 30000 },
      ],
    },
  };

  it("returns the daily curve in order", () => {
    const rows = normalizeHistory(payload);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ date: "2026-08-17", views: 715218, viewsDelta: 715218 });
  });

  // A row with no usable date cannot be keyed or deduped. Inventing one from
  // `timestamp` would stamp the fetch time, not the day being described.
  it("drops rows with a missing or malformed date", () => {
    expect(
      normalizeHistory({ data: { history: [{ views: 1 }, { date: "17/08/2026", views: 2 }] } })
    ).toEqual([]);
  });

  it("returns empty for a post with no history", () => {
    expect(normalizeHistory({ data: { history: [] } })).toEqual([]);
    expect(normalizeHistory({})).toEqual([]);
  });
});

describe("normalizeAccount", () => {
  it("lowercases and strips the handle so it joins to research_creators", () => {
    const account = normalizeAccount({
      handle: "@WisdomWJas",
      platform: "instagram",
      contractorId: "crt_5fsCV4",
      contractorName: "Jas Alcantara",
      totalPosts: 154,
      totalViews: 5032075,
      totalEarnings: 5185.54,
      firstPostDate: 1781407195000,
    });
    expect(account.handle).toBe("wisdomwjas");
    expect(account.totalEarnings).toBe(5185.54);
    expect(account.firstPostDate).toBe("2026-06-14T03:19:55.000Z");
  });

  // The accounts phase persists the whole activity picture, and absent fields
  // must stay null — a missing engagementRate is "unknown", not 0%.
  it("carries the activity stats and leaves absent ones null", () => {
    const account = normalizeAccount({
      handle: "amrinrants",
      platform: "instagram",
      contractorId: "crt_9",
      lastPostDate: 1787717101000,
      totalLikes: 120_000,
      engagementRate: 8.4,
      averageViewsPerPost: 22_000,
      cpm: 1.25,
      paidPosts: 40,
      unpaidPosts: 19,
    });
    expect(account.lastPostDate).toBe("2026-08-26T04:05:01.000Z");
    expect(account.totalLikes).toBe(120_000);
    expect(account.engagementRate).toBe(8.4);
    expect(account.averageViewsPerPost).toBe(22_000);
    expect(account.cpm).toBe(1.25);
    expect(account.paidPosts).toBe(40);
    expect(account.unpaidPosts).toBe(19);
    expect(account.totalComments).toBeNull();
    expect(account.totalShares).toBeNull();
  });
});

describe("toPlatform", () => {
  // Launchpoint tracks five platforms; this app models two. Coercing a YouTube
  // post onto an Instagram row would corrupt the creator's numbers.
  it("maps the two we model and rejects the rest", () => {
    expect(toPlatform("instagram")).toBe("instagram");
    expect(toPlatform("tiktok")).toBe("tiktok");
    expect(toPlatform("youtube")).toBeNull();
    expect(toPlatform("facebook")).toBeNull();
    expect(toPlatform("snapchat")).toBeNull();
  });
});

describe("pickPrimaryAccount", () => {
  const acct = (over: Partial<LaunchpointAccount>): LaunchpointAccount => ({
    handle: "x",
    platform: "instagram",
    contractorId: "crt_1",
    contractorName: "Someone",
    totalPosts: 0,
    totalViews: 0,
    totalEarnings: 0,
    firstPostDate: null,
    lastPostDate: null,
    isGhostHandle: false,
    totalLikes: null,
    totalComments: null,
    totalShares: null,
    engagementRate: null,
    averageViewsPerPost: null,
    cpm: null,
    paidPosts: null,
    unpaidPosts: null,
    ...over,
  });

  // research_creator_socials allows one row per (creator, platform), and the
  // live data really does hold two Instagram accounts for one person — an old
  // handle beside the working one. "Where they actually post" is the answer.
  it("prefers the account with more posts", () => {
    const winner = pickPrimaryAccount([
      acct({ handle: "notamrinn", totalPosts: 1 }),
      acct({ handle: "amrinrants", totalPosts: 59 }),
    ]);
    expect(winner?.handle).toBe("amrinrants");
  });

  it("ranks a real handle above a ghost even when the ghost has more posts", () => {
    const winner = pickPrimaryAccount([
      acct({ handle: "ghost", totalPosts: 500, isGhostHandle: true }),
      acct({ handle: "real", totalPosts: 3 }),
    ]);
    expect(winner?.handle).toBe("real");
  });

  it("falls back to views when post counts tie", () => {
    const winner = pickPrimaryAccount([
      acct({ handle: "quiet", totalPosts: 5, totalViews: 100 }),
      acct({ handle: "loud", totalPosts: 5, totalViews: 90_000 }),
    ]);
    expect(winner?.handle).toBe("loud");
  });

  it("returns null for an empty set", () => {
    expect(pickPrimaryAccount([])).toBeNull();
  });
});

describe("profileUrl", () => {
  it("builds the canonical profile link per platform", () => {
    expect(profileUrl("instagram", "wisdomwjas")).toBe("https://www.instagram.com/wisdomwjas/");
    expect(profileUrl("tiktok", "wisdomwjas")).toBe("https://www.tiktok.com/@wisdomwjas");
  });
});

describe("withinTranscribeWindow", () => {
  const NOW = Date.parse("2026-08-27T00:00:00Z");
  const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

  it("queues a recent post", () => {
    expect(withinTranscribeWindow(daysAgo(3), NOW)).toBe(true);
    expect(withinTranscribeWindow(daysAgo(29), NOW)).toBe(true);
  });

  // Transcription exists to match a post back to the script that produced it.
  // Scripts are handed out and posted within days, so a four-month-old reel has
  // no open assignment waiting for it and the transcript answers nothing.
  it("skips anything past the window", () => {
    expect(withinTranscribeWindow(daysAgo(31), NOW)).toBe(false);
    expect(withinTranscribeWindow(daysAgo(200), NOW)).toBe(false);
  });

  // Guessing "recent" for an undated post would queue an unbounded tail of
  // unknown-age media, which is the exact cost this window exists to avoid.
  it("treats a missing or unparseable date as out of window", () => {
    expect(withinTranscribeWindow(null, NOW)).toBe(false);
    expect(withinTranscribeWindow("not a date", NOW)).toBe(false);
  });
});

describe("matchChannelToContractor", () => {
  const c = (name: string, id: string) => ({ contractorId: id, name, key: nameKey(name) });
  const roster = [c("Jas Alcantara", "crt_jas"), c("Jacob Libiran", "crt_jacob")];

  // The whole point: a channel is named <track-emoji><first>-<last>, which is
  // Launchpoint's contractorName. That equivalence is what lets the link be
  // computed instead of hand-typed into VERIFIED_HANDLES.
  it("matches an emoji-prefixed channel to its contractor", () => {
    expect(matchChannelToContractor("✝️jas-alcantara", roster)).toEqual({ contractorId: "crt_jas" });
    expect(matchChannelToContractor("🌱jacob-libiran", roster)).toEqual({ contractorId: "crt_jacob" });
  });

  it("handles the legacy coaching- prefix", () => {
    expect(matchChannelToContractor("coaching-jas-alcantara", roster)).toEqual({
      contractorId: "crt_jas",
    });
  });

  // A wrong link attributes one creator's posts, scripts and payouts to another
  // person. Staying unlinked for a day is the cheaper failure by far.
  it("refuses to guess when two contractors share a name", () => {
    const twins = [c("Anna Florek", "crt_a"), c("Anna Florek", "crt_b")];
    const out = matchChannelToContractor("🤍anna-florek", twins);
    expect(out).toHaveProperty("ambiguous");
  });

  it("returns null for a channel Launchpoint has never heard of", () => {
    expect(matchChannelToContractor("🌱tittywiggles", roster)).toBeNull();
    expect(matchChannelToContractor("🌱archived-terai", roster)).toBeNull();
  });
});

describe("nameKey", () => {
  it("collapses punctuation, case and accents so slugs compare to real names", () => {
    expect(nameKey("Jas Alcantara")).toBe("jasalcantara");
    expect(nameKey("jas-alcantara")).toBe("jasalcantara");
    expect(nameKey("Anastasiía  Krasnopérova")).toBe(nameKey("anastasiia-krasnoperova"));
  });

  it("is empty for nothing usable", () => {
    expect(nameKey(null)).toBe("");
    expect(nameKey("🌱")).toBe("");
  });
});
