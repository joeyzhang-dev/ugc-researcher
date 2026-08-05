import { createClient } from "@/lib/supabase/server";
import type {
  ResearchApp,
  ResearchAppCreator,
  ResearchCreator,
  ResearchScript,
  ResearchScriptAssignment,
  ResearchVideo,
} from "@/lib/types";
import { summarizeScripts } from "@/lib/scripts";
import { createScript } from "./actions";
import { SubmitButton } from "@/components/submit-button";
import { inputClass } from "@/components/ui";
import { NicheCombobox } from "@/components/niche-combobox";
import { AppSelect } from "@/components/app-select";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";
import { ScriptsExplorer, type ScriptRow } from "./scripts-explorer";
import { calButton, calLabel, card, cardTitle } from "./cal";

export const dynamic = "force-dynamic";

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
          "id, research_creator_id, url, shortcode, caption, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_text, format_category"
        )
        .in("research_creator_id", creatorIds)
    : { data: [] };
  const videos = (videosData ?? []) as ResearchVideo[];
  const videosByCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    (videosByCreator.get(v.research_creator_id) ??
      videosByCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }

  // Perf for the whole workspace once — the explorer filters client-side.
  const perf = summarizeScripts(inWorkspace, assignments, videosByCreator);
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
    medianScore: p.medianScore,
    medianLift: p.medianLift,
    medianViews: p.medianViews,
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

  return (
    <>
      {/* No standing description: it explained the lift ranking once and then
          cost a block of screen on every visit thereafter. The workspace is
          still named, since that one changes what you are looking at. */}
      <h1 className="mb-4 flex items-baseline gap-2 text-[28px] font-semibold tracking-[-0.02em] text-neutral-900">
        Scripts
        {app && (
          <span className="text-sm font-normal text-neutral-400">{app.name}</span>
        )}
      </h1>

      {error && (
        <p className="mb-6 rounded-lg border border-red-200 bg-red-50 px-3.5 py-2.5 text-sm text-red-700">
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
        footnote={
          scopedCreators.length === 0 ? (
            <p className="mt-3 text-xs text-neutral-400">
              No roster creators in this workspace yet — add them on Our creators before assigning.
            </p>
          ) : undefined
        }
        formSlot={
          <details className={`${card} group overflow-visible`}>
            <summary className="flex cursor-pointer list-none items-center gap-2 px-6 py-4 [&::-webkit-details-marker]:hidden">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-neutral-100 text-neutral-600 transition-transform group-open:rotate-45">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                  <path d="M12 5v14M5 12h14" />
                </svg>
              </span>
              <span className={cardTitle}>Create script</span>
            </summary>
            <form action={createScript} className="space-y-4 px-6 pb-6">
              <label className="block">
                <span className={calLabel}>Title</span>
                <input
                  name="title"
                  placeholder="What this script is, for your own reference"
                  className={inputClass}
                  required
                />
              </label>

              {/* Hook and body share one frame: the hook IS the opening line, so
                  writing them apart invites a script that does not start with it. */}
              <div className="overflow-hidden rounded-lg border border-neutral-200">
                <div className="border-b border-neutral-200 bg-[#f8f9fa] px-3.5 py-2.5">
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

              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-44 flex-1">
                  <span className={calLabel}>Niche</span>
                  <NicheCombobox options={knownNiches} />
                </label>
                <label className="min-w-44">
                  <span className={calLabel}>App</span>
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
                  <span className={calLabel}>Status</span>
                  <select name="status" className={inputClass} defaultValue="Active">
                    {["Active", "Draft", "Archived"].map((s) => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                </label>
                <SubmitButton pendingLabel="Saving…" className={calButton}>
                  Create script
                </SubmitButton>
              </div>
            </form>
          </details>
        }
      />
    </>
  );
}
