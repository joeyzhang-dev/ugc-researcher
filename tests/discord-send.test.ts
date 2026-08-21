import { describe, expect, it } from "vitest";
import {
  buildScriptPage,
  collectText,
  testSendContent,
  type SendableScript,
} from "@/lib/discord-send";

const script = (over: Partial<SendableScript> = {}): SendableScript => ({
  id: "s1",
  hook: "4 things you should not be doing if you're a Christian",
  body: "Number one is cussing.\n\nNumber two is gossip.",
  inspoUrl: "https://www.instagram.com/reel/DblvZeePL-F/",
  demo: "Folk saving you $500",
  songs: "Every living breathing moment",
  niche: "Christian",
  ...over,
});

/* Components V2: type 17 container, 10 text, 12 media gallery, 14 separator,
   1 action row. The page is one container; texts() flattens its displays. */
const container = (page: ReturnType<typeof buildScriptPage>) =>
  page.components.find((c: { type: number }) => c.type === 17)!;
const texts = (page: ReturnType<typeof buildScriptPage>) => collectText(page.components);
const buttons = (page: ReturnType<typeof buildScriptPage>) =>
  (container(page).components as { type: number; components?: { label: string; custom_id?: string; url?: string; disabled?: boolean }[] }[])
    .find((c) => c.type === 1)!.components!;

describe("buildScriptPage (Components V2)", () => {
  it("is a V2 message: flag set, no content/embeds keys", () => {
    const page = buildScriptPage([script()], 0, { videoUrl: null });
    expect(page.flags).toBe(1 << 15);
    expect("content" in page).toBe(false);
    expect("embeds" in page).toBe(false);
  });

  it("stamps the canonical number into the hook heading", () => {
    const page = buildScriptPage([script({ number: 5 })], 0, { videoUrl: null });
    expect(texts(page).join("\n")).toContain("## #5 — 4 things you should not be doing");
  });

  it("keeps the plain heading when a script has no number", () => {
    const all = texts(buildScriptPage([script()], 0, { videoUrl: null })).join("\n");
    expect(all).toContain("## 4 things you should not be doing");
    expect(all).not.toContain("## #");
  });

  it("sections the card: hook heading, Script, Demo, Songs", () => {
    const all = texts(buildScriptPage([script()], 0, { videoUrl: null })).join("\n");
    expect(all).toContain("## 4 things you should not be doing");
    expect(all).toContain("### Script");
    expect(all).toContain("### Demo to use");
    expect(all).toContain("### Song(s) to use");
    expect(all).toContain("-# Script 1/1");
  });

  it("puts the video INSIDE the container by public url — no upload", () => {
    const page = buildScriptPage([script()], 0, { videoUrl: "https://store/x.mp4" });
    const gallery = (container(page).components as { type: number; items?: { media: { url: string } }[] }[])
      .find((c) => c.type === 12);
    expect(gallery?.items?.[0].media.url).toBe("https://store/x.mp4");
  });

  it("falls back to a link line only when no video url resolved", () => {
    const withVideo = buildScriptPage([script()], 0, { videoUrl: "https://store/x.mp4" });
    const linkless = buildScriptPage([script()], 0, { videoUrl: null });
    expect(texts(withVideo).join()).not.toContain("Inspo video\nhttps");
    expect(texts(linkless).join("\n")).toContain(
      "https://www.instagram.com/reel/DblvZeePL-F/"
    );
  });

  it("keeps the nav custom_id contract, with no posted button", () => {
    const scripts = [script(), script({ id: "s2" }), script({ id: "s3" })];
    const row = buttons(buildScriptPage(scripts, 1, { videoUrl: null }));
    expect(row.find((b) => b.label === "◀ Prev")!.custom_id).toBe("scrnav:0");
    expect(row.find((b) => b.label === "Next ▶")!.custom_id).toBe("scrnav:2");
    // Tracking lives in the webapp (scrape → match → link); the self-report
    // button just created half-tracked Posted rows.
    expect(row.some((b) => b.label === "✅ I posted this")).toBe(false);
    const first = buttons(buildScriptPage(scripts, 0, { videoUrl: null }));
    expect(first.find((b) => b.label === "◀ Prev")!.disabled).toBe(true);
  });

  it("still offers the note button for a single script without inspo", () => {
    const row = buttons(buildScriptPage([script({ inspoUrl: null })], 0, { videoUrl: null }));
    expect(row.map((b) => b.label)).toEqual(["📝 Note"]);
  });

  it("keeps the inspo link and the note button for a single script with inspo", () => {
    const row = buttons(buildScriptPage([script()], 0, { videoUrl: null }));
    expect(row.map((b) => b.label)).toEqual(["Inspo video", "📝 Note"]);
  });

  it("gives View all scripts its own row with the green-book emoji", () => {
    const page = buildScriptPage([script()], 0, {
      videoUrl: null,
      viewAllUrl: "https://bludgc.vercel.app/c/abc123",
    });
    const rows = (container(page).components as {
      type: number;
      components?: { label: string; url?: string; custom_id?: string; emoji?: { name: string } }[];
    }[]).filter((c) => c.type === 1);
    // Utility row first, then the portal CTA alone on its own row.
    expect(rows).toHaveLength(2);
    const viewAll = rows[1].components![0];
    expect(viewAll.label).toBe("View all scripts");
    expect(viewAll.url).toBe("https://bludgc.vercel.app/c/abc123");
    expect(viewAll.emoji).toEqual({ name: "📗" });
    expect(viewAll.custom_id).toBeUndefined();
    expect(rows[1].components).toHaveLength(1);
  });

  it("renders a single button row without a portal url", () => {
    const page = buildScriptPage([script()], 0, { videoUrl: null });
    const rows = (container(page).components as { type: number }[]).filter((c) => c.type === 1);
    expect(rows).toHaveLength(1);
    expect(buttons(page).some((b) => b.label === "View all scripts")).toBe(false);
  });

  it("unpaged cards keep the numbering but drop the nav buttons", () => {
    const scripts = [script(), script({ id: "s2" }), script({ id: "s3" })];
    const page = buildScriptPage(scripts, 1, { videoUrl: null, paged: false });
    const row = buttons(page);
    expect(row.some((b) => b.label === "◀ Prev" || b.label === "Next ▶")).toBe(false);
    expect(texts(page).join("\n")).toContain("-# Script 2/3");
  });

  it("puts the script id, not the page, in the note custom_id", () => {
    const scripts = [script(), script({ id: "s2" }), script({ id: "s3" })];
    const row = buttons(buildScriptPage(scripts, 1, { videoUrl: null }));
    expect(row.find((b) => b.label === "📝 Note")!.custom_id).toBe("scrnote:s2");
  });

  it("orders the card: hook, script, then the video right above demo/songs", () => {
    const page = buildScriptPage([script()], 0, { videoUrl: "https://store/x.mp4" });
    const kids = container(page).components as { type: number; content?: string }[];
    const iScript = kids.findIndex((c) => c.type === 10 && c.content?.startsWith("### Script"));
    const iGallery = kids.findIndex((c) => c.type === 12);
    const iMeta = kids.findIndex((c) => c.type === 10 && c.content?.startsWith("### Demo"));
    expect(iScript).toBeGreaterThan(-1);
    expect(iGallery).toBeGreaterThan(iScript);
    expect(iMeta).toBeGreaterThan(iGallery);
  });

  it("carries a header text display above the container for phone notifications", () => {
    const page = buildScriptPage([script()], 0, {
      videoUrl: null,
      header: "**New scripts for Folk** — <@123>",
    });
    const first = page.components[0] as { type: number; content: string };
    expect(first.type).toBe(10);
    expect(first.content).toBe("**New scripts for Folk** — <@123>");
    expect(page.components[1].type).toBe(17);
  });

  it("carries the test marker as its own text display when given", () => {
    const page = buildScriptPage([script()], 0, {
      videoUrl: "https://store/x.mp4",
      testMarker: testSendContent(["s1"]),
    });
    expect(texts(page).join("\n")).toContain("||scr:s1||");
  });

  it("stays under the 4000-char total text budget for huge scripts", () => {
    const page = buildScriptPage(
      [script({ body: "x".repeat(6000), demo: "y".repeat(2000), songs: "z".repeat(2000) })],
      0,
      { videoUrl: null }
    );
    const total = texts(page).join("").length;
    expect(total).toBeLessThanOrEqual(4000);
  });
});

describe("collectText", () => {
  it("finds text displays nested inside containers", () => {
    expect(
      collectText([
        { type: 17, components: [{ type: 10, content: "inner" }] },
        { type: 10, content: "outer" },
      ])
    ).toEqual(["inner", "outer"]);
  });
});

describe("testSendContent", () => {
  it("labels the message and hides the batch ids in a spoiler the bot can parse", () => {
    const content = testSendContent(["aaa-1", "bbb-2"]);
    expect(content.startsWith("-# 🧪 Test send — not tracked")).toBe(true);
    expect(content).toContain("||scr:aaa-1,bbb-2||");
  });
});
