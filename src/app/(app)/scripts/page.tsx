import { createClient } from "@/lib/supabase/server";
import type {
  ResearchApp,
  ResearchAppCreator,
  ResearchCreator,
  ResearchScript,
  ResearchScriptAssignment,
  ResearchVideo,
} from "@/lib/types";
import { resolveScriptMatches, summarizeScripts } from "@/lib/scripts";
import { createScript } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import Link from "next/link";
import { Card, PageHeader, buttonClass, inputClass, labelClass, secondaryButtonClass } from "@/components/ui";
import { NicheCombobox } from "@/components/niche-combobox";
import { AppSelect } from "@/components/app-select";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";
import { ScriptsExplorer, type ScriptRow } from "./scripts-explorer";
import type { SendTarget } from "./send-bar";
import { buildSendTargets, type SendTargetInput } from "@/lib/send-targets";
import { loadViewCurves, videoSelect } from "@/lib/video-metrics";

export const dynamic = "force-dynamic";
// Server actions invoked from this page inherit this budget — a full-batch
// send posts one card per script per creator and can pass a minute easily.
export const maxDuration = 300;

/** Scripts we wrote for our own creators, ranked by how they actually did. */
export default async function ScriptsPage({
  searchParams,
}: {
  searchParams: Promise<{
    error?: string;
    status?: string;
    niche?: string | string[];
    sent?: string | string[];
  }>;
}) {
  const { error, status: statusFilter, niche, sent } = await searchParams;
  // niche/sent repeat in the URL for multi-select: ?niche=A&niche=B is OR'd.
  // Filtering itself happens client-side (ScriptsExplorer); the params only
  // seed the initial state so shared URLs open pre-filtered.
  const toArr = (v: string | string[] | undefined) => (Array.isArray(v) ? v : v ? [v] : []);
  const nicheFilters = toArr(niche);
  const sentFilters = toArr(sent);

  const supabase = await createClient();
  // Falls back to the base column list when the Launchpoint migration has
  // not been applied yet, so a lagging schema hides chips instead of 400ing
  // the whole page.
  const VIDEO_SELECT = await videoSelect(
    supabase,
    "id, research_creator_id, url, shortcode, caption, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_text, format_category"
  );
  const { apps, current, app } = await getWorkspace();
  const appFilter = current === ALL_APPS ? null : current;

  const [
    { data: scriptsData },
    { data: assignmentsData },
    { data: creatorsData },
    { data: membershipsData },
  ] = await Promise.all([
    supabase.from("research_scripts").select("*").order("created_at", { ascending: false }),
    supabase.from("research_script_assignments").select("*"),
    supabase.from("research_creators").select("*").eq("kind", "roster"),
    supabase.from("research_app_creators").select("*"),
  ]);

  const allScripts = (scriptsData ?? []) as ResearchScript[];
  const assignments = (assignmentsData ?? []) as ResearchScriptAssignment[];
  const creators = (creatorsData ?? []) as ResearchCreator[];
  const memberships = (membershipsData ?? []) as ResearchAppCreator[];

  // Scripts follow the workspace, same as the roster does.
  const inWorkspace = allScripts.filter((s) => !appFilter || s.app_id === appFilter);

  // Lift needs each creator's full library, not just their scripted posts.
  const creatorIds = creators.map((c) => c.id);
  const { data: videosData } = creatorIds.length
    ? await supabase
        .from("research_videos")
        .select(
          VIDEO_SELECT
        )
        .in("research_creator_id", creatorIds)
    : { data: [] };
  // Through `unknown`: the select list is built at runtime (the Launchpoint
  // columns are only named when the schema has them), so supabase-js cannot
  // infer a row type from it. The rows are ResearchVideo either way — the
  // Launchpoint fields are simply absent before the migration, and every
  // reader already treats them as nullable.
  const videos = (videosData ?? []) as unknown as ResearchVideo[];
  const videosByCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    (videosByCreator.get(v.research_creator_id) ??
      videosByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  // Perf for the whole workspace once — the explorer filters client-side.
  const perf = summarizeScripts(inWorkspace, assignments, videosByCreator);

  // How many open assignments the matcher cannot settle on its own. Computed
  // from rows already in hand rather than re-fetching — it is pure arithmetic
  // over data this page loads anyway, and it is what makes the review link
  // worth showing at all.
  const needsReview = resolveScriptMatches(
    allScripts,
    assignments,
    videos,
    new Set(assignments.map((a) => a.research_video_id).filter((id): id is string => !!id))
  ).review.length;
  const creatorById = new Map(creators.map((c) => [c.id, c]));

  const rows: ScriptRow[] = perf.map((p) => ({
    id: p.script.id,
    // The hook IS the script's identity — imported scripts have no separate
    // human title, so showing both was pure duplication.
    label: p.script.hook || p.script.title,
    niche: p.script.niche,
    sentDay: p.script.created_at.slice(0, 10),
    createdAt: p.script.created_at,
    status: p.script.status,
    hook: p.script.hook,
    body: p.script.body,
    inspoUrl: p.script.inspo_url,
    demo: p.script.demo,
    songs: p.script.songs,
    medianScore: p.medianScore,
    medianLift: p.medianLift,
    medianViews: p.medianViews,
    medianHoldRate: p.retention.medianHoldRate,
    medianSkipRate: p.retention.medianSkipRate,
    retentionSample: p.retention.sampleSize,
    posts: p.posts,
    creators: p.creators,
    pending: p.pending,
    best: p.best
      ? {
          score: p.best.score,
          handle: creatorById.get(p.best.video.research_creator_id)?.handle ?? "—",
          postedAt: p.best.video.posted_at,
          // Gallery view needs a face, not another row of numbers.
          thumbnailUrl: p.best.video.thumbnail_url,
        }
      : null,
  }));

  // Niches already in use, so the field suggests instead of inviting typos.
  const knownNiches = [
    ...new Set(
      [
        ...allScripts.map((s) => s.niche),
        ...memberships.map((m) => m.niche),
      ].filter((n): n is string => !!n)
    ),
  ].sort();

  // knownNiches (not the filtered view) keys the palette, so a niche keeps
  // its color no matter which filters are engaged.
  const nicheColorIndex = Object.fromEntries(knownNiches.map((n, i) => [n, i]));

  const scopedCreators = creators.filter((c) =>
    !appFilter
      ? true
      : memberships.some((m) => m.app_id === appFilter && m.research_creator_id === c.id)
  );

  // Send targets. EVERY tracked channel is loaded, linked or not: a creator
  // onboarded in Discord has a channel days before they have a handle to link,
  // and building this list from research_creators alone left them out of the
  // picker entirely — which is how a send missed the newest people.
  // Snowflake ids cast to text — they overflow JS numbers otherwise.
  const { data: channelsData } = await supabase
    .from("research_discord_channels")
    .select("channel_id::text, channel_name, research_creator_id, niche")
    .eq("is_tracked", true);
  const sendTargets: SendTarget[] = buildSendTargets({
    appId: appFilter,
    creators,
    memberships,
    channels: (channelsData ?? []) as SendTargetInput["channels"],
  });

  return (
    <>
      {/* No standing description under the title: the owner asked for none — it
          explained the lift ranking once, then cost a band of screen on every
          visit. The workspace still rides the eyebrow, since that is the thing
          that changes what you are looking at. */}
      <PageHeader
        title="Scripts"
        eyebrow={app?.name}
        action={
          <Link href="/scripts/review" className={secondaryButtonClass}>
            Match review{needsReview > 0 ? ` (${needsReview})` : ""}
          </Link>
        }
      />

      {error && (
        <p className="mb-6 rounded-xl bg-danger/[0.08] px-3.5 py-2.5 text-sm text-danger ring-1 ring-inset ring-danger/[0.2]">
          {error}
        </p>
      )}

      <ScriptsExplorer
        rows={rows}
        totalScripts={inWorkspace.length}
        hasAnyScripts={allScripts.length > 0}
        nicheColorIndex={nicheColorIndex}
        initialStatus={statusFilter ?? ""}
        initialNiches={nicheFilters}
        initialSents={sentFilters}
        currentAppId={appFilter}
        sendTargets={sendTargets}
        footnote={
          scopedCreators.length === 0 ? (
            <p className="mt-3 text-xs text-neutral-400">
              No roster creators in this workspace yet — add them on Our creators before assigning.
            </p>
          ) : undefined
        }
        formSlot={
          // Closed, this is a button beside the stats; open, it takes the full
          // row so the form is not squeezed into a flex column.
          <details className="group ml-auto [&[open]]:w-full">
            <summary className={`${buttonClass} w-fit cursor-pointer list-none [&::-webkit-details-marker]:hidden`}>
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="round"
                className="transition-transform group-open:rotate-45"
              >
                <path d="M12 5v14M5 12h14" />
              </svg>
              Create script
            </summary>
            <div className="mt-3">
              <Card>
                <form action={createScript} className="space-y-4">
              <label className="block">
                <span className={labelClass}>Title</span>
                <input
                  name="title"
                  placeholder="What this script is, for your own reference"
                  className={inputClass}
                  required
                />
              </label>

              {/* Hook and body share one frame: the hook IS the opening line, so
                  writing them apart invites a script that does not start with it. */}
              <div className="overflow-hidden rounded-xl bg-surface ring-1 ring-hairline">
                <div className="border-b border-hairline bg-surface-sunken px-3.5 py-2.5">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Hook
                  </span>
                  <input
                    name="hook"
                    placeholder="The first line out of their mouth"
                    className="w-full border-0 bg-transparent p-0 text-sm font-semibold text-neutral-900 outline-none placeholder:font-normal placeholder:text-neutral-400"
                  />
                </div>
                <div className="px-3.5 py-2.5">
                  <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                    Script
                  </span>
                  <textarea
                    name="body"
                    rows={7}
                    placeholder="Everything after the hook. This is what gets matched against the transcript of what they actually posted."
                    className="w-full resize-y border-0 bg-transparent p-0 text-sm leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-400"
                  />
                </div>
              </div>

              {/* The doc's three metadata lines, in the doc's order. */}
              <div className="grid gap-3 sm:grid-cols-3">
                <label>
                  <span className={labelClass}>Inspo video</span>
                  <input name="inspoUrl" placeholder="https://…" className={inputClass} />
                </label>
                <label>
                  <span className={labelClass}>Demo to use</span>
                  <input name="demo" placeholder="e.g. Folk saving you $500" className={inputClass} />
                </label>
                <label>
                  <span className={labelClass}>Song(s) to use</span>
                  <input name="songs" placeholder="Track name or link" className={inputClass} />
                </label>
              </div>

              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-44 flex-1">
                  <span className={labelClass}>Niche</span>
                  <NicheCombobox options={knownNiches} />
                </label>
                <label className="min-w-44">
                  <span className={labelClass}>App</span>
                  <AppSelect
                    apps={apps.map((a: ResearchApp) => ({
                      id: a.id,
                      name: a.name,
                      logoUrl: a.logo_url,
                    }))}
                    defaultValue={appFilter ?? ""}
                  />
                </label>
                <label className="min-w-32">
                  <span className={labelClass}>Status</span>
                  <select name="status" className={inputClass} defaultValue="Active">
                    {["Active", "Draft", "Archived"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <SubmitButton pendingLabel="Saving…">
                  Create script
                </SubmitButton>
              </div>
                </form>
              </Card>
            </div>
          </details>
        }
      />
    </>
  );
}
