import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
import { inspoStoragePath } from "@/lib/inspo-media";
import { loadNiches, nicheEmojis, nicheLabel } from "@/lib/niches";
import { NICHE_PALETTE } from "@/app/(app)/scripts/cal";
import { assignScriptNumbers } from "@/app/(app)/scripts/doc";
import { CopyButton } from "@/app/c/copy-button";
import { groupScriptsByWeek, type PortalScript, type PortalWeek } from "@/app/c/portal";

/* The creator portal: everything a creator has been handed, on one compact
   page. Reached only from the "View all scripts" button on their Discord
   card — the /c/<share_token> URL is the credential (middleware already
   treats /c/* as public), so the page renders with the admin client and
   never exposes staff chrome, stats, or notes. */

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ token: string }>;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const data = await load((await params).token);
  return {
    title: data ? `Scripts · @${data.handle}` : "Scripts",
    // Tokenized page: the URL is the credential, so never let it be indexed.
    robots: { index: false, follow: false },
  };
}

/** Already-resolved playable copies for the scripts' inspo links — cheap
 *  lookups only (research pool rows + the deterministic inspo/ bucket paths);
 *  the portal never downloads. Unresolved links fall back to the external
 *  page. */
async function resolveExampleVideos(
  db: ReturnType<typeof createAdminClient>,
  urls: string[]
): Promise<Map<string, string>> {
  const distinct = [...new Set(urls.filter(Boolean))];
  const out = new Map<string, string>();
  if (!distinct.length) return out;

  const clean = (u: string) => u.split("?")[0].replace(/\/$/, "");
  const variants = distinct.flatMap((u) => [clean(u), `${clean(u)}/`]);
  const { data: rows } = await db
    .from("research_videos")
    .select("url, video_url")
    .in("url", variants)
    .not("video_url", "is", null);
  const byClean = new Map(
    (rows ?? [])
      .filter((r) => (r.video_url as string).includes("/storage/v1/object/public/"))
      .map((r) => [clean(r.url as string), r.video_url as string])
  );
  for (const u of distinct) {
    const hit = byClean.get(clean(u));
    if (hit) out.set(u, hit);
  }

  const missing = distinct.filter((u) => !out.has(u));
  if (missing.length) {
    const { data: files } = await db.storage.from("videos").list("inspo", { limit: 1000 });
    const names = new Set((files ?? []).map((f) => f.name));
    for (const u of missing) {
      const path = inspoStoragePath(u);
      if (names.has(path.split("/")[1])) {
        out.set(u, db.storage.from("videos").getPublicUrl(path).data.publicUrl);
      }
    }
  }
  return out;
}

async function load(token: string) {
  // The route pattern admits only [A-Za-z0-9]+ (src/lib/routing.ts); this
  // guard keeps garbage out of the PostgREST filter too.
  if (!/^[A-Za-z0-9]{16,64}$/.test(token)) return null;
  const db = createAdminClient();
  const { data: creator } = await db
    .from("research_creators")
    .select("id, handle, display_name")
    .eq("share_token", token)
    .maybeSingle();
  if (!creator) return null;

  const { data: assignments } = await db
    .from("research_script_assignments")
    .select("script_id")
    .eq("research_creator_id", creator.id);
  const ids = [...new Set((assignments ?? []).map((a) => a.script_id))];

  let scripts: PortalScript[] = [];
  if (ids.length) {
    // Sibling rows too: canonical #N is the script's Doc position within its
    // whole week+niche, not its position among this creator's assignments.
    const [{ data }, { data: siblings }] = await Promise.all([
      db
        .from("research_scripts")
        .select("id, hook, body, niche, inspo_url, demo, songs, created_at")
        .in("id", ids),
      db.from("research_scripts").select("id, niche, created_at"),
    ]);
    const numbers = assignScriptNumbers(
      ((siblings ?? []) as { id: string; niche: string | null; created_at: string }[]).map(
        (s) => ({ id: s.id, niche: s.niche, createdAt: s.created_at })
      )
    );
    scripts = (data ?? []).map((s) => ({
      id: s.id,
      hook: s.hook,
      body: s.body,
      inspoUrl: s.inspo_url,
      demo: s.demo,
      songs: s.songs,
      niche: s.niche,
      createdAt: s.created_at,
      number: numbers.get(s.id) ?? null,
    }));
  }
  const videos = await resolveExampleVideos(
    db,
    scripts.map((s) => s.inspoUrl).filter((u): u is string => u != null)
  );
  return {
    handle: creator.handle,
    displayName: creator.display_name,
    weeks: groupScriptsByWeek(scripts),
    videos,
    // research_niches is staff-read under RLS, but this page already renders
    // with the service-role client (the share token is the credential), so
    // the pills resolve here exactly as they do on /scripts.
    nicheEmojis: nicheEmojis(await loadNiches(db)),
  };
}

export default async function CreatorPortalPage({ params }: Props) {
  const data = await load((await params).token);
  if (!data) notFound();
  const { handle, weeks, videos, nicheEmojis: nicheEmojiByName } = data;
  const total = weeks.reduce((n, w) => n + w.scripts.length, 0);

  // Same positional color dealing as the scripts pages: stable per page,
  // distinct until the palette runs out.
  const niches = [...new Set(weeks.flatMap((w) => w.scripts.map((s) => s.niche)))].filter(
    (n): n is string => n != null
  );
  const nicheColor = (niche: string | null) =>
    niche == null ? null : NICHE_PALETTE[niches.indexOf(niche) % NICHE_PALETTE.length];

  return (
    <main className="min-h-dvh bg-canvas">
      <div className="mx-auto w-full max-w-xl px-4 pb-14 pt-8 sm:px-5 sm:pt-10">
        <header className="mb-5">
          <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">
            Folk UGC
          </p>
          <div className="mt-0.5 flex items-baseline justify-between gap-3">
            <h1 className="text-[22px] font-semibold leading-tight tracking-tight text-neutral-900">
              Your scripts
            </h1>
            <p className="text-[13px] text-neutral-500">
              @{handle} · {total}
            </p>
          </div>
        </header>

        {weeks.length === 0 && (
          <div className="rounded-xl bg-surface p-6 text-center ring-1 ring-hairline shadow-ambient">
            <p className="text-[14px] font-medium text-neutral-900">No scripts yet</p>
            <p className="mt-1 text-[13px] leading-relaxed text-neutral-500">
              When a new batch is sent to your Discord channel, it shows up here too.
            </p>
          </div>
        )}

        <div className="space-y-6">
          {weeks.map((week) => (
            <WeekSection
            key={week.key}
            week={week}
            videos={videos}
            nicheColor={nicheColor}
            nicheEmojis={nicheEmojiByName}
          />
          ))}
        </div>

        <footer className="mt-10 text-center text-[12px] text-neutral-400">
          Questions about a script? Ping your coach on Discord.
        </footer>
      </div>
    </main>
  );
}

function WeekSection({
  week,
  videos,
  nicheColor,
  nicheEmojis,
}: {
  week: PortalWeek;
  videos: Map<string, string>;
  nicheColor: (niche: string | null) => (typeof NICHE_PALETTE)[number] | null;
  nicheEmojis: Record<string, string>;
}) {
  return (
    <section>
      <div className="sticky top-0 z-10 -mx-4 mb-2 bg-canvas/85 px-4 py-2 backdrop-blur-sm sm:-mx-5 sm:px-5">
        <div className="flex items-baseline justify-between">
          <h2 className="text-[13px] font-semibold tracking-tight text-neutral-900">{week.label}</h2>
          <span className="text-[12px] tabular-nums text-neutral-400">{week.scripts.length}</span>
        </div>
      </div>
      <div className="space-y-2.5">
        {week.scripts.map((s, i) => (
          <ScriptCard
            key={s.id}
            script={s}
            index={i}
            videoUrl={s.inspoUrl ? videos.get(s.inspoUrl) ?? null : null}
            color={nicheColor(s.niche)}
            nicheEmojis={nicheEmojis}
          />
        ))}
      </div>
    </section>
  );
}

const CHIP =
  "flex w-full cursor-pointer select-none list-none items-center gap-1.5 py-1.5 text-[13px] font-medium text-neutral-500 transition-colors hover:text-neutral-900 [&::-webkit-details-marker]:hidden";

function Chevron() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3 transition-transform group-open:rotate-90"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 4l4 4-4 4" />
    </svg>
  );
}

function ScriptCard({
  script: s,
  index,
  videoUrl,
  color,
  nicheEmojis,
}: {
  script: PortalScript;
  index: number;
  videoUrl: string | null;
  color: (typeof NICHE_PALETTE)[number] | null;
  nicheEmojis: Record<string, string>;
}) {
  const copyText = [s.hook, s.body].filter(Boolean).join("\n\n");
  return (
    <article className="rounded-xl bg-surface px-4 py-3 ring-1 ring-hairline shadow-ambient">
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
            #{s.number ?? index + 1}
          </span>
          {s.niche && color && (
            <span className={`truncate rounded-full px-2 py-0.5 text-[10px] font-medium ${color.row}`}>
              {nicheLabel(s.niche, nicheEmojis)}
            </span>
          )}
        </span>
        {copyText && <CopyButton text={copyText} />}
      </div>

      {s.hook && (
        <h3 className="mt-1 text-[15px] font-semibold leading-snug tracking-tight text-neutral-900">
          {s.hook}
        </h3>
      )}

      <div className="mt-1 divide-y divide-hairline">
        {s.body && (
          <details className="group">
            <summary className={CHIP}>
              <Chevron />
              Read script
            </summary>
            <p className="whitespace-pre-line pb-2 pl-[18px] text-[14px] leading-relaxed text-neutral-800">
              {s.body}
            </p>
          </details>
        )}

        {videoUrl ? (
          <details className="group">
            <summary className={CHIP}>
              <svg viewBox="0 0 16 16" className="size-3 group-open:hidden" fill="currentColor">
                <path d="M5 3.5v9l7.5-4.5L5 3.5z" />
              </svg>
              <span className="hidden group-open:block"><Chevron /></span>
              Example video
              <span className="rounded-full bg-accent/[0.08] px-1.5 py-px text-[10px] font-semibold text-accent">
                watch
              </span>
            </summary>
            {/* preload=none: 20+ cards must not pull video bytes until tapped */}
            <video
              src={videoUrl}
              controls
              playsInline
              preload="none"
              className="mb-2 ml-[18px] aspect-[9/16] w-full max-w-[240px] rounded-lg bg-neutral-950"
            />
          </details>
        ) : (
          s.inspoUrl && (
            <a href={s.inspoUrl} target="_blank" rel="noreferrer" className={CHIP}>
              <svg viewBox="0 0 16 16" className="size-3" fill="currentColor">
                <path d="M5 3.5v9l7.5-4.5L5 3.5z" />
              </svg>
              Example video
              <svg viewBox="0 0 16 16" className="size-2.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4.5 11.5l7-7M6 4.5h5.5V10" />
              </svg>
            </a>
          )
        )}
      </div>

      {(s.demo || s.songs) && (
        <p className="mt-1.5 border-t border-hairline pt-2 text-[12px] leading-relaxed text-neutral-500">
          {s.demo && (
            <>
              <span className="font-medium text-neutral-400">Demo</span> {s.demo}
            </>
          )}
          {s.demo && s.songs && <span className="mx-1.5 text-neutral-300">·</span>}
          {s.songs && (
            <>
              <span className="font-medium text-neutral-400">Song(s)</span> {s.songs}
            </>
          )}
        </p>
      )}
    </article>
  );
}
