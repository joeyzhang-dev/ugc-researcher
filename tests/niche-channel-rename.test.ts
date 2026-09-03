import { describe, expect, it } from "vitest";
import {
  leadingEmojiRun,
  liveEmojiBases,
  normalizeNicheEmoji,
  planNicheChannelRenames,
} from "@/lib/niche-channel-rename";

const ch = (id: string, name: string, type = 0) => ({ id, name, type });
const niche = (name: string, emoji: string | null) => ({ name, emoji });

// U+271D CROSS + U+FE0F, written as escapes: a literal variation selector is
// invisible in a source file and this branch has already shipped two defects
// from exactly that.
const CROSS = "\u271D";
const CROSS_VS = "\u271D\uFE0F";

describe("planNicheChannelRenames", () => {
  it("renames only the channels carrying the old emoji", () => {
    const plan = planNicheChannelRenames(
      [ch("1", "🌱ethan-lau"), ch("2", `${CROSS_VS}nino-aguilar`), ch("3", "folk-branding")],
      "🌱",
      "💪"
    );
    expect(plan).toEqual([{ channelId: "1", from: "🌱ethan-lau", to: "💪ethan-lau" }]);
  });

  it("matches a channel written without the variation selector", () => {
    // The two crosses are one track everywhere else; a rename that missed the
    // bare form would leave channels stranded on an emoji no niche claims.
    const plan = planNicheChannelRenames([ch("1", `${CROSS}jas-alcantara`)], CROSS_VS, "🙏");
    expect(plan).toEqual([{ channelId: "1", from: `${CROSS}jas-alcantara`, to: "🙏jas-alcantara" }]);
  });

  it("skips categories and voice channels", () => {
    expect(planNicheChannelRenames([ch("1", "🌱Team", 4), ch("2", "🌱voice", 2)], "🌱", "💪")).toEqual([]);
  });

  it("is a no-op when the emoji did not change", () => {
    expect(planNicheChannelRenames([ch("1", "🌱ethan-lau")], "🌱", "🌱")).toEqual([]);
  });

  it("never writes a padded emoji into a channel name", () => {
    // The target goes straight into the Discord name; a stray space there
    // would strand the channel on a base nothing matches.
    const plan = planNicheChannelRenames([ch("1", "🌱ethan-lau")], "🌱", " 💪 ");
    expect(plan).toEqual([{ channelId: "1", from: "🌱ethan-lau", to: "💪ethan-lau" }]);
  });
});

describe("normalizeNicheEmoji", () => {
  it("removes whitespace a trim cannot reach", () => {
    // clean() already trims the ends, so the surviving hole is a space with a
    // decoration after it: Python and TS strip AFTER removing U+FE0F and read
    // one base, SQL's niche_emoji_base() does not trim and reads another, so
    // the unique index would let two rows classify identically.
    expect(normalizeNicheEmoji(`${CROSS} \uFE0F`)).toBe(CROSS_VS);
    expect(normalizeNicheEmoji(`${CROSS_VS} `)).toBe(CROSS_VS);
    expect(normalizeNicheEmoji(" 🌱")).toBe("🌱");
  });

  it("leaves a well-formed emoji alone", () => {
    expect(normalizeNicheEmoji(CROSS_VS)).toBe(CROSS_VS);
    const rainbow = "\u{1F3F3}\uFE0F\u200D\u{1F308}";
    expect(normalizeNicheEmoji(rainbow)).toBe(rainbow);
  });
});

describe("leadingEmojiRun", () => {
  it("reads the emoji off a creator channel", () => {
    expect(leadingEmojiRun("🌱ethan-lau")).toEqual({ base: "🌱", display: "🌱" });
    expect(leadingEmojiRun(`${CROSS_VS}jas-alcantara`)).toEqual({
      base: CROSS,
      display: CROSS_VS,
    });
  });

  it("ignores server furniture and plain names", () => {
    // Same rule as split_track_channel: what follows the emoji has to start
    // alphanumeric, so a decorative separator disqualifies the channel.
    expect(leadingEmojiRun("🌱・getting-started")).toBeNull();
    expect(leadingEmojiRun("📃・creator-brief")).toBeNull();
    expect(leadingEmojiRun("folk-branding")).toBeNull();
    expect(leadingEmojiRun("coaching-cole")).toBeNull();
  });
});

describe("liveEmojiBases", () => {
  const channels = [
    ch("1", "🌱ethan-lau"),
    ch("2", "🌱ally-li"),
    ch("3", `${CROSS_VS}nino`),
    ch("4", "🌱Team", 4),
    ch("5", "🌱・getting-started"),
    ch("6", "folk-branding"),
  ];

  it("reports the niche claiming each live emoji", () => {
    const rows = liveEmojiBases(channels, [
      niche("General Motivation / Hustle", "🌱"),
      niche("Christian", CROSS_VS),
    ]);
    expect(rows.map((r) => [r.base, r.niche])).toEqual([
      [CROSS, "Christian"],
      ["🌱", "General Motivation / Hustle"],
    ]);
  });

  it("surfaces an emoji no niche claims, which is otherwise silent", () => {
    // The exact state an emoji edit creates: the niche now says 🪴, the
    // channels still say 🌱, track_bases() no longer maps 🌱 and discover
    // skips them without an error. If this row is missing there is no UI path
    // back short of remembering the old emoji.
    const rows = liveEmojiBases(channels, [
      niche("General Motivation / Hustle", "🪴"),
      niche("Christian", CROSS_VS),
    ]);
    const orphan = rows.find((r) => r.base === "🌱");
    expect(orphan?.niche).toBeNull();
    // Unclaimed sorts first: that row is the stall report.
    expect(rows[0].base).toBe("🌱");
  });

  it("counts exactly what the rename would touch", () => {
    // The list on the row and the work the confirm does must agree, or the
    // preview is describing something other than what it will do.
    const rows = liveEmojiBases(channels, [niche("General Motivation / Hustle", "🌱")]);
    const row = rows.find((r) => r.base === "🌱")!;
    expect(row.channels).toEqual(
      planNicheChannelRenames(channels, "🌱", "💪").map((s) => s.from)
    );
  });

  it("treats an archived niche as still claiming its emoji", () => {
    // track_bases() reads every row, archived included, so those channels are
    // classifying fine and are not stranded.
    const rows = liveEmojiBases([ch("1", "🌱ethan-lau")], [niche("Retired", "🌱")]);
    expect(rows[0].niche).toBe("Retired");
  });

  it("does not invent a row for a decorative channel", () => {
    expect(liveEmojiBases([ch("1", "📃・creator-brief"), ch("2", "\u{1F5E3}\uFE0F\u30FBapp-feedback")], [])).toEqual([]);
  });

  it("matches a niche emoji written without the variation selector", () => {
    expect(liveEmojiBases([ch("1", `${CROSS_VS}jas`)], [niche("Christian", CROSS)])[0].niche).toBe(
      "Christian"
    );
  });
});
