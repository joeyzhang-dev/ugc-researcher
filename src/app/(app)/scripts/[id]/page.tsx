import Link from "next/link";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import type {
  ResearchApp,
  ResearchAppCreator,
  ResearchCreator,
  ResearchScript,
  ResearchScriptAssignment,
  ResearchVideo,
} from "@/lib/types";
import { computeLifts, median, type VideoLift } from "@/lib/research";
import { suggestMatches } from "@/lib/scripts";
import {
  assignScript,
  linkAssignmentVideo,
  removeAssignment,
  setAssignmentStatus,
  updateScript,
} from "../actions";
import { SubmitButton } from "@/components/submit-button";
import {
  Avatar, AvatarStack, Card, EmptyState, PageHeader, StatusBadge,
  inputClass, labelClass, secondaryButtonClass,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { ResearchVideoPanel, type PanelSegment } from "@/components/research-panel";
import { ResearchVideoTile } from "@/components/research-video-tile";
import { NicheCombobox } from "@/components/niche-combobox";
import { AppSelect } from "@/components/app-select";
import { getWorkspace } from "@/lib/workspace/server";

export const dynamic = "force-dynamic";

/** One cell of the stat strip: caption over value, sized to its contents. */
function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <span className="flex flex-col justify-center gap-0.5 px-4 py-2">
      <span className="text-[11px] font-medium text-neutral-500">{label}</span>
      {children}
    </span>
  );
}

/** One script: the words, who ran it, and which post each of them produced. */
export default async function ScriptDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  const { apps } = await getWorkspace();

  const [
    { data: scriptData },
    { data: assignmentsData },
    { data: creatorsData },
    { data: membershipsData },
    { data: allScriptsData },
  ] = await Promise.all([
    supabase.from("research_scripts").select("*").eq("id", id).maybeSingle(),
    supabase.from("research_script_assignments").select("*").eq("script_id", id),
    supabase.from("research_creators").select("*").eq("kind", "roster"),
    supabase.from("research_app_creators").select("*"),
    supabase.from("research_scripts").select("niche"),
  ]);

  const script = scriptData as ResearchScript | null;
  if (!script) notFound();

  const assignments = (assignmentsData ?? []) as ResearchScriptAssignment[];
  const creators = (creatorsData ?? []) as ResearchCreator[];
  const memberships = (membershipsData ?? []) as ResearchAppCreator[];
  const creatorById = new Map(creators.map((c) => [c.id, c]));

  const knownNiches = [
    ...new Set(
      [
        ...((allScriptsData ?? []) as { niche: string | null }[]).map((s) => s.niche),
        ...memberships.map((m) => m.niche),
      ].filter((n): n is string => !!n)
    ),
  ].sort();

  // Only the assigned creators' libraries are needed, but the whole library
  // per creator is required — lift is measured against their own baseline.
  const assignedIds = [...new Set(assignments.map((a) => a.research_creator_id))];
  const { data: videosData } = assignedIds.length
    ? await supabase
        .from("research_videos")
        .select(
          "id, research_creator_id, url, shortcode, caption, hashtags, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_method, transcript_text, format_category"
        )
        .in("research_creator_id", assignedIds)
    : { data: [] };
  const videos = (videosData ?? []) as ResearchVideo[];

  const byCreator = new Map<string, ResearchVideo[]>();
  for (const v of videos) {
    (byCreator.get(v.research_creator_id) ??
      byCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }
  const liftById = new Map<string, VideoLift>();
  for (const vids of byCreator.values()) {
    for (const row of computeLifts(vids)) liftById.set(row.video.id, row);
  }

  // Videos already claimed by another script must not be offered again.
  const { data: takenData } = await supabase
    .from("research_script_assignments")
    .select("research_video_id, script_id")
    .not("research_video_id", "is", null);
  const takenElsewhere = new Set(
    ((takenData ?? []) as { research_video_id: string; script_id: string }[])
      .filter((t) => t.script_id !== id)
      .map((t) => t.research_video_id)
  );

  const rows = assignments
    .map((a) => {
      const creator = creatorById.get(a.research_creator_id);
      const linked = a.research_video_id ? liftById.get(a.research_video_id) ?? null : null;
      const pool = (byCreator.get(a.research_creator_id) ?? []).filter(
        (v) => !takenElsewhere.has(v.id)
      );
      // Suggest only while unlinked — once confirmed, the answer is settled.
      // Match on hook + body: the hook is part of what they say.
      const matchText = [script.hook, script.body].filter(Boolean).join(" ");
      const suggestions = a.research_video_id
        ? []
        : suggestMatches(matchText, pool, { limit: 4 });
      return { a, creator, linked, pool, suggestions };
    })
    .sort((x, y) => (y.linked?.lift ?? -1) - (x.linked?.lift ?? -1));

  const posted = rows.filter((r) => r.linked);
  // "Who ran it" manages only the open questions; confirmed posts live in the
  // mosaic below, so showing them here twice was pure duplication.
  const waiting = rows.filter((r) => !r.linked);
  const unassigned = creators.filter(
    (c) => !assignments.some((a) => a.research_creator_id === c.id)
  );

  // Transcript segments for the panel, only for the videos actually on screen —
  // linked posts plus the suggested candidates (their tiles open the panel too).
  const postedVideoIds = [
    ...new Set([
      ...posted.map((r) => r.linked!.video.id),
      ...waiting.flatMap((r) => r.suggestions.map((s) => s.video.id)),
    ]),
  ];
  const { data: segmentsData } = postedVideoIds.length
    ? await supabase
        .from("research_video_segments")
        .select("research_video_id, position, start_time, text")
        .in("research_video_id", postedVideoIds)
        .order("position", { ascending: true })
    : { data: [] };
  const segmentsByVideo: Record<string, PanelSegment[]> = {};
  for (const s of (segmentsData ?? []) as (PanelSegment & { research_video_id: string })[]) {
    (segmentsByVideo[s.research_video_id] ??= []).push({
      position: s.position,
      start_time: s.start_time,
      text: s.text,
    });
  }

  const medianScore = median(
    posted.map((r) => r.linked!.score).filter((n): n is number => n != null)
  );
  const medianLift = median(
    posted.map((r) => r.linked!.lift).filter((n): n is number => n != null)
  );

  return (
    <>
      <PageHeader
        title={script.hook || script.title}
        action={
          <Link href="/scripts" className={secondaryButtonClass}>
            ← All scripts
          </Link>
        }
      />

      <div className="-mt-4 mb-5 flex flex-wrap items-center gap-2 text-sm text-neutral-500">
        <StatusBadge status={script.status} />
        {script.niche && (
          <span className="rounded bg-violet-50 px-1.5 py-0.5 text-[11px] font-medium text-violet-700">
            {script.niche}
          </span>
        )}
        <span>{apps.find((a: ResearchApp) => a.id === script.app_id)?.name ?? "No app"}</span>
        <span>·</span>
        <span>Created {formatDate(script.created_at)}</span>
      </div>

      {/* One content-width strip instead of four cards stretched across the
          page. These are four short numbers; a full-width grid of them spent a
          whole band of screen on whitespace before the script even began.
          inline-flex keeps it exactly as wide as its contents. */}
      <div className="mb-4 inline-flex max-w-full flex-wrap items-stretch divide-x divide-neutral-200 overflow-hidden rounded-xl border border-neutral-200 bg-white">
        <Stat label="Handed to">
          <span className="flex items-center gap-2">
            <span className="text-xl font-semibold tabular-nums text-neutral-900">
              {assignments.length}
            </span>
            {/* Sized to the number beside it: at avatar-chip scale the faces
                were unrecognisable, which defeats showing them at all. */}
            <AvatarStack
              size={26}
              people={rows.map(({ creator }) => ({
                handle: creator?.handle ?? "unknown",
                avatarUrl: creator?.avatar_url,
              }))}
            />
          </span>
        </Stat>
        <Stat label="Posted">
          <span className="text-xl font-semibold tabular-nums text-neutral-900">
            {posted.length}
          </span>
        </Stat>
        <Stat label="Median score">
          <span className="flex items-baseline gap-1.5">
            <span className="text-xl font-semibold tabular-nums text-neutral-900">
              {medianScore?.toFixed(1) ?? "—"}
            </span>
            {medianLift != null && (
              <span className="text-xs tabular-nums text-neutral-400">
                {medianLift.toFixed(2)}×
              </span>
            )}
          </span>
        </Stat>
        <Stat label="Total views">
          <span className="text-xl font-semibold tabular-nums text-neutral-900">
            {formatCompact(posted.reduce((s, r) => s + (r.linked!.video.view_count ?? 0), 0))}
          </span>
        </Stat>
      </div>

      {/* minmax(0,…): a 1fr grid track's implicit min-width is its content, so a
          long single-line (truncated) caption would stretch the whole page
          instead of ellipsizing. Zero min lets truncate actually clip. */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]">
        <Card title="The script">
          {/* Every row of chrome here is a row of script you cannot see, so the
              labels are folded into the controls themselves and the body gets
              the height that buys. */}
          <form action={updateScript.bind(null, script.id)} className="space-y-2.5">
            <div className="flex items-center gap-2">
              <input
                name="title"
                defaultValue={script.title}
                aria-label="Title"
                placeholder="Title"
                required
                className="min-w-0 flex-1 rounded-lg border border-transparent bg-transparent px-2 py-1 text-sm font-medium text-neutral-900 outline-none hover:border-neutral-200 focus:border-neutral-300 focus:bg-white"
              />
              <SubmitButton pendingLabel="Saving…">Save</SubmitButton>
            </div>

            {/* Hook sits above the body in one frame — it is the opening line,
                not a separate piece of metadata. */}
            <div className="overflow-hidden rounded-xl border border-neutral-200">
              <div className="flex items-baseline gap-2 border-b border-neutral-200 bg-neutral-50 px-3 py-1.5">
                <span className="shrink-0 text-[10px] font-semibold uppercase tracking-wide text-neutral-400">
                  Hook
                </span>
                <input
                  name="hook"
                  defaultValue={script.hook ?? ""}
                  placeholder="The first line out of their mouth"
                  className="min-w-0 flex-1 border-0 bg-transparent p-0 text-sm font-semibold text-neutral-900 outline-none placeholder:font-normal placeholder:text-neutral-400"
                />
              </div>
              {/* No "Script" label: the block under the hook can only be the
                  script, and the label cost a line of it. */}
              <textarea
                name="body"
                rows={18}
                defaultValue={script.body ?? ""}
                placeholder="Everything after the hook. This is what gets matched against the transcript of what they actually posted."
                className="block w-full resize-y border-0 bg-transparent px-3 py-2 text-sm leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-400"
              />
            </div>

            {/* Labelled by aria only — three stacked captions cost more height
                than they explain next to a niche chip, an app and a status. */}
            <div className="grid gap-2 sm:grid-cols-3">
              <NicheCombobox options={knownNiches} defaultValue={script.niche ?? ""} />
              <AppSelect
                apps={apps.map((a: ResearchApp) => ({
                  id: a.id,
                  name: a.name,
                  logoUrl: a.logo_url,
                }))}
                defaultValue={script.app_id ?? ""}
              />
              <select
                name="status"
                aria-label="Status"
                className={inputClass}
                defaultValue={script.status}
              >
                {["Active", "Draft", "Archived"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
          </form>
        </Card>

        <div className="space-y-4">
          {posted.length > 0 && (
            /* The videos this script produced, same mosaic as the overview:
               hover plays the stored copy, click opens the transcript panel. */
            <Card title="Posts from this script">
              <div className="grid [grid-template-columns:repeat(auto-fill,minmax(160px,1fr))]">
                {posted.map(({ a, creator, linked }) => (
                  <div key={a.id} className="flex flex-col">
                    <ResearchVideoTile row={linked!} creatorHandle={creator?.handle} showLift />
                    <span className="flex items-center justify-between px-1.5 py-1 text-[11px]">
                      <Link
                        href={`/research/${a.research_creator_id}`}
                        className="truncate font-medium text-neutral-600 hover:text-neutral-900 hover:underline"
                      >
                        @{creator?.handle ?? "unknown"}
                      </Link>
                      <form action={linkAssignmentVideo.bind(null, a.id)} className="shrink-0">
                        <input type="hidden" name="scriptId" value={script.id} />
                        <input type="hidden" name="videoId" value="" />
                        <button type="submit" className="text-neutral-400 hover:text-red-600">
                          unlink
                        </button>
                      </form>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Assignments normally arrive from the Discord import; handing a
              script out by hand is the exception, so it hides behind a small
              disclosure instead of holding a whole card open. */}
          {unassigned.length > 0 && (
            <details className="group">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-xs font-medium text-neutral-400 hover:text-neutral-700 [&::-webkit-details-marker]:hidden">
                <span className="transition-transform group-open:rotate-45">+</span>
                Hand it to another creator
              </summary>
              <form
                action={assignScript.bind(null, script.id)}
                className="mt-2 flex items-end gap-2"
              >
                <label className="flex-1">
                  <span className={labelClass}>Creator</span>
                  <select name="creatorId" className={inputClass} required>
                    {unassigned.map((c) => (
                      <option key={c.id} value={c.id}>@{c.handle}</option>
                    ))}
                  </select>
                </label>
                <SubmitButton pendingLabel="Adding…">Add</SubmitButton>
              </form>
            </details>
          )}
        </div>
      </div>

      {/* Full width, outside the two-column grid: these cards tile, and inside
          the narrow right-hand column they had no room to sit side by side. */}
      <div className="mt-4">
        <Card
          title="Who ran it"
          action={
            !script.body && !script.hook ? (
              <span className="text-xs text-amber-600">
                Write the script to get match suggestions
              </span>
            ) : null
          }
        >
          {rows.length === 0 ? (
            <EmptyState message="Not handed to anyone yet." />
          ) : waiting.length === 0 ? (
            <EmptyState message="Everyone who has this script already posted — see the videos above." />
          ) : (
            <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(290px,1fr))]">
                {waiting.map(({ a, creator, pool, suggestions }) => (
                  <div key={a.id} className="rounded-xl border border-neutral-200 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-2 text-sm font-medium">
                        <Avatar name={creator?.handle ?? "?"} src={creator?.avatar_url} size={24} />
                        <span className="truncate">@{creator?.handle ?? "unknown"}</span>
                      </span>
                      <span className="flex shrink-0 items-center gap-2">
                        <StatusBadge status={a.status} />
                        <form action={removeAssignment.bind(null, a.id, script.id)}>
                          <button
                            type="submit"
                            className="rounded-md px-1.5 text-sm text-neutral-400 hover:bg-neutral-100 hover:text-red-600"
                            title="Remove"
                          >
                            ×
                          </button>
                        </form>
                      </span>
                    </div>

                    <div className="mt-2.5 space-y-2">
                        {suggestions.length > 0 && (
                          <div>
                            <p className="mb-1 text-[11px] font-semibold text-neutral-500">
                              Likely matches — hover to watch, click for the transcript
                            </p>
                            {/* Same tiles as everywhere else: a shortcode means
                                nothing to someone scanning the dashboard, a
                                playing preview answers "is this the one?". */}
                            <div className="grid gap-x-2 [grid-template-columns:repeat(auto-fill,minmax(110px,1fr))]">
                              {suggestions.map((s) => {
                                const liftRow = liftById.get(s.video.id);
                                return (
                                  <div key={s.video.id} className="flex flex-col">
                                    {liftRow && <ResearchVideoTile row={liftRow} />}
                                    <span className="flex items-center justify-between px-1 py-1 text-[11px]">
                                      <span
                                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                                          s.score >= 0.6
                                            ? "bg-emerald-50 text-emerald-700"
                                            : "bg-neutral-100 text-neutral-500"
                                        }`}
                                        title="How much of the script's wording shows up in this transcript"
                                      >
                                        {Math.round(s.score * 100)}%
                                      </span>
                                      <form action={linkAssignmentVideo.bind(null, a.id)}>
                                        <input type="hidden" name="scriptId" value={script.id} />
                                        <input type="hidden" name="videoId" value={s.video.id} />
                                        <button
                                          type="submit"
                                          className="rounded-md border border-neutral-200 px-2 py-0.5 font-medium text-neutral-600 hover:border-neutral-900 hover:text-neutral-900"
                                        >
                                          link
                                        </button>
                                      </form>
                                    </span>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        )}
                        <form
                          action={linkAssignmentVideo.bind(null, a.id)}
                          className="flex flex-wrap items-end gap-2"
                        >
                          <input type="hidden" name="scriptId" value={script.id} />
                          <label className="min-w-0 flex-1 basis-full sm:basis-auto">
                            <span className="mb-1 block text-[11px] text-neutral-400">
                              {suggestions.length > 0
                                ? "or pick manually"
                                : "Link the video they posted"}
                            </span>
                            <select name="videoId" className={`${inputClass} text-xs`} defaultValue="">
                              <option value="">— none —</option>
                              {pool.map((v) => (
                                <option key={v.id} value={v.id}>
                                  {formatDate(v.posted_at)} · {formatCompact(v.view_count)} views ·{" "}
                                  {(v.caption?.split("\n")[0] || v.shortcode || "").slice(0, 60)}
                                </option>
                              ))}
                            </select>
                          </label>
                          <SubmitButton pendingLabel="Linking…" className={secondaryButtonClass}>
                            Link
                          </SubmitButton>
                        </form>
                        {a.status !== "Skipped" && (
                          <form action={setAssignmentStatus.bind(null, a.id, script.id, "Skipped")}>
                            <button
                              type="submit"
                              className="text-[11px] text-neutral-400 hover:text-neutral-700"
                            >
                              mark skipped
                            </button>
                          </form>
                        )}
                      </div>
                  </div>
                ))}
              </div>
            )}
        </Card>
      </div>

      <ResearchVideoPanel segmentsByVideo={segmentsByVideo} />
    </>
  );
}
