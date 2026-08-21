/**
 * The Discord message that delivers a batch of scripts to one creator.
 *
 * Built on Components V2 (flag 1<<15): one accent-colored container holding
 * the hook as a heading, the inspo video INSIDE the card as a media gallery,
 * and visually separated Script / Demo / Song(s) sections — things classic
 * embeds cannot do (bots cannot put playable video in an embed).
 *
 * One message carries the whole batch as a paged card: the app posts page 0,
 * and the gateway bot answers the nav buttons by re-rendering other pages
 * (worker/discord_bot/script_pager.py mirrors this format — keep them in
 * sync). Custom ids carry the TARGET page, so neither side parses anything:
 *   scrnav:<page>        — show that page
 *   scrpost:<page>       — mark that page's script Posted for this channel's creator
 *   scrnote:<script_id>  — open the add-a-note modal for that page's script
 *
 * V2 messages have no `content`, so the test-send marker rides as its own
 * text display above the container.
 */

export interface SendableScript {
  id: string;
  hook: string | null;
  body: string | null;
  inspoUrl: string | null;
  demo: string | null;
  songs: string | null;
  niche: string | null;
  /** Canonical Doc-view number (#N within the script's week + niche) —
   *  stamped into the heading so "#5" means the same thing everywhere. */
  number?: number | null;
}

export const V2_FLAG = 1 << 15;
const ACCENT = 0x5865f2;
const STYLE = { secondary: 2, success: 3, link: 5 } as const;

// V2 caps the SUM of all text-display characters at 4000. Budget:
// marker ~120 + hook 200 + body 2800 + demo 400 + songs 400 + chrome < 4000.
const clamp = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface MessagePage {
  flags: number;
  components: any[];
}

/** Every text-display string in a V2 component tree (containers included). */
export function collectText(components: any[]): string[] {
  const out: string[] = [];
  for (const c of components ?? []) {
    if (c?.type === 10 && typeof c.content === "string") out.push(c.content);
    if (Array.isArray(c?.components)) out.push(...collectText(c.components));
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Content line for test sends — parsed back by the pager, so the shape is a
 *  contract with worker/discord_bot/script_pager.py. */
export function testSendContent(scriptIds: string[]): string {
  return `-# 🧪 Test send — not tracked\n||scr:${scriptIds.join(",")}||`;
}

/**
 * Render page `index` of a batch. `videoUrl` is the inspo video's PUBLIC
 * storage URL — the card's gallery references it directly, so nothing is
 * uploaded to Discord and page flips stay a pure JSON edit; without it a
 * plain link line stands in (only when the script has a usable URL).
 */
export function buildScriptPage(
  scripts: SendableScript[],
  index: number,
  opts: {
    videoUrl?: string | null;
    testMarker?: string;
    viewAllUrl?: string | null;
    /** Leading text display — first line doubles as the push-notification
     *  preview, and it's where the creator's mention lives. */
    header?: string | null;
    /** false = the whole batch posts as consecutive cards (one message per
     *  script), so there is nothing to page — numbering stays, nav goes. */
    paged?: boolean;
  }
): MessagePage {
  const s = scripts[index];
  const total = scripts.length;
  const inspo = s.inspoUrl && /^https?:\/\/\S+$/.test(s.inspoUrl.trim()) ? s.inspoUrl.trim() : null;

  const inner: unknown[] = [];
  if (s.hook) {
    const numberTag = s.number ? `#${s.number} — ` : "";
    inner.push({ type: 10, content: `## ${numberTag}${clamp(s.hook, 200)}` });
  }
  if (s.body) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({ type: 10, content: `### Script\n${clamp(s.body, 2800)}` });
  }
  // The video sits in its own section directly above Demo/Songs.
  if (opts.videoUrl) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({
      type: 12,
      items: [{ media: { url: opts.videoUrl }, description: "Inspo video" }],
    });
  } else if (inspo) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({ type: 10, content: `-# Inspo video\n${inspo}` });
  }
  const meta: string[] = [];
  if (s.demo) meta.push(`### Demo to use\n${clamp(s.demo, 400)}`);
  if (s.songs) meta.push(`### Song(s) to use\n${clamp(s.songs, 400)}`);
  if (meta.length) {
    inner.push({ type: 14, divider: true, spacing: 1 });
    inner.push({ type: 10, content: meta.join("\n") });
  }
  inner.push({ type: 10, content: `-# Script ${index + 1}/${total}` });

  // No "I posted this" button: tracking lives in the webapp (scrape →
  // transcript match → deliberate link); a self-report only made
  // half-tracked rows.
  const buttons: unknown[] = [];
  if (total > 1 && (opts.paged ?? true)) {
    buttons.push(
      {
        type: 2, style: STYLE.secondary, label: "◀ Prev",
        custom_id: `scrnav:${Math.max(0, index - 1)}`, disabled: index === 0,
      },
      {
        type: 2, style: STYLE.secondary, label: "Next ▶",
        custom_id: `scrnav:${Math.min(total - 1, index + 1)}`, disabled: index === total - 1,
      }
    );
  }
  if (inspo) buttons.push({ type: 2, style: STYLE.link, label: "Inspo video", url: inspo });
  // Note button carries the script id, not the page index, so a note lands on
  // the right script even on a stale message. Notes are internal (never
  // rendered on the card); the bot's modal appends to research_scripts.notes.
  buttons.push({ type: 2, style: STYLE.secondary, label: "📝 Note", custom_id: `scrnote:${s.id}` });
  inner.push({ type: 1, components: buttons });
  // The creator's portal — the send's main CTA. Discord forces link buttons
  // grey (colored styles can't carry a url), so prominence comes from its own
  // row + the green book instead.
  if (opts.viewAllUrl) {
    inner.push({
      type: 1,
      components: [{
        type: 2, style: STYLE.link, label: "View all scripts",
        emoji: { name: "📗" }, url: opts.viewAllUrl,
      }],
    });
  }

  return {
    flags: V2_FLAG,
    components: [
      ...(opts.header ? [{ type: 10, content: opts.header }] : []),
      ...(opts.testMarker ? [{ type: 10, content: opts.testMarker }] : []),
      { type: 17, accent_color: ACCENT, components: inner },
    ],
  };
}
