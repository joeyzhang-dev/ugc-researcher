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
  Avatar, Card, EmptyState, KpiCard, PageHeader, StatusBadge,
  inputClass, labelClass, secondaryButtonClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { ResearchScoreChip } from "@/components/research-panel";
import { Thumb } from "@/components/hover-video";
import { getWorkspace } from "@/lib/workspace/server";

export const dynamic = "force-dynamic";

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
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
          "id, research_creator_id, url, shortcode, caption, posted_at, view_count, like_count, comment_count, share_count, thumbnail_url, video_url, transcript_status, transcript_text, format_category"
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
  const unassigned = creators.filter(
    (c) => !assignments.some((a) => a.research_creator_id === c.id)
  );

  const medianScore = median(
    posted.map((r) => r.linked!.score).filter((n): n is number => n != null)
  );
  const medianLift = median(
    posted.map((r) => r.linked!.lift).filter((n): n is number => n != null)
  );

  return (
    <>
      <PageHeader
        title={script.title}
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

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Handed to" value={String(assignments.length)} icon="users" />
        <KpiCard label="Posted" value={String(posted.length)} icon="play" tone="emerald" />
        <KpiCard
          label="Median score"
          value={medianScore?.toFixed(1) ?? "—"}
          sub={medianLift != null ? `${medianLift.toFixed(2)}× lift` : undefined}
          icon="trend"
          tone="violet"
        />
        <KpiCard
          label="Total views"
          value={formatCompact(posted.reduce((s, r) => s + (r.linked!.video.view_count ?? 0), 0))}
          icon="eye"
          tone="sky"
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1fr_1.25fr]">
        <Card title="The script">
          <form action={updateScript.bind(null, script.id)} className="space-y-3">
            <label className="block">
              <span className={labelClass}>Title</span>
              <input name="title" defaultValue={script.title} className={inputClass} required />
            </label>

            {/* Hook sits above the body in one frame — it is the opening line,
                not a separate piece of metadata. */}
            <div className="overflow-hidden rounded-xl border border-neutral-200">
              <div className="border-b border-neutral-200 bg-neutral-50 px-3 py-2">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Hook
                </span>
                <input
                  name="hook"
                  defaultValue={script.hook ?? ""}
                  placeholder="The first line out of their mouth"
                  className="w-full border-0 bg-transparent p-0 text-sm font-semibold text-neutral-900 outline-none placeholder:font-normal placeholder:text-neutral-400"
                />
              </div>
              <div className="px-3 py-2">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                  Script
                </span>
                <textarea
                  name="body"
                  rows={14}
                  defaultValue={script.body ?? ""}
                  placeholder="Everything after the hook. This is what gets matched against the transcript of what they actually posted."
                  className="w-full resize-y border-0 bg-transparent p-0 text-sm leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-400"
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <label>
                <span className={labelClass}>Niche</span>
                <input
                  name="niche"
                  list="script-niches"
                  defaultValue={script.niche ?? ""}
                  className={inputClass}
                />
              </label>
              <label>
                <span className={labelClass}>App</span>
                <select name="appId" className={inputClass} defaultValue={script.app_id ?? ""}>
                  <option value="">— none —</option>
                  {apps.map((a: ResearchApp) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </label>
              <label>
                <span className={labelClass}>Status</span>
                <select name="status" className={inputClass} defaultValue={script.status}>
                  {["Active", "Draft", "Archived"].map((s) => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </label>
            </div>
            <label className="block">
              <span className={labelClass}>Notes</span>
              <textarea
                name="notes"
                rows={2}
                defaultValue={script.notes ?? ""}
                className={`${inputClass} resize-y`}
              />
            </label>
            <datalist id="script-niches">
              {knownNiches.map((n) => (
                <option key={n} value={n} />
              ))}
            </datalist>
            <SubmitButton pendingLabel="Saving…">Save script</SubmitButton>
          </form>
        </Card>

        <div className="space-y-4">
          <Card title="Hand it to a creator">
            {unassigned.length === 0 ? (
              <EmptyState message="Every roster creator already has this script." />
            ) : (
              <form action={assignScript.bind(null, script.id)} className="flex items-end gap-2">
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
            )}
          </Card>

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
            ) : (
              <div className="space-y-2.5">
                {rows.map(({ a, creator, linked, pool, suggestions }) => (
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

                    {linked ? (
                      <div className="mt-2.5 flex items-center gap-2.5">
                        <Thumb
                          src={linked.video.thumbnail_url}
                          className="h-14 w-10 shrink-0 rounded-md"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <ResearchScoreChip score={linked.score} />
                            <span className="text-xs tabular-nums text-neutral-500">
                              {fmtLift(linked.lift)} · {formatCompact(linked.video.view_count)} views
                              {" · "}
                              {formatDate(linked.video.posted_at)}
                            </span>
                          </span>
                          <span className="mt-1 block truncate text-xs text-neutral-500">
                            {linked.video.caption?.split("\n")[0] || linked.video.shortcode}
                          </span>
                        </span>
                        <span className="flex shrink-0 flex-col items-end gap-1">
                          <a
                            href={linked.video.url}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs text-neutral-400 hover:text-neutral-700"
                          >
                            open ↗
                          </a>
                          <form action={linkAssignmentVideo.bind(null, a.id)}>
                            <input type="hidden" name="scriptId" value={script.id} />
                            <input type="hidden" name="videoId" value="" />
                            <button
                              type="submit"
                              className="text-xs text-neutral-400 hover:text-red-600"
                            >
                              unlink
                            </button>
                          </form>
                        </span>
                      </div>
                    ) : (
                      <div className="mt-2.5 space-y-2">
                        {suggestions.length > 0 && (
                          <div>
                            <p className="mb-1 text-[11px] font-semibold text-neutral-500">
                              Likely matches from their transcripts
                            </p>
                            <div className="space-y-1">
                              {suggestions.map((s) => (
                                <form
                                  key={s.video.id}
                                  action={linkAssignmentVideo.bind(null, a.id)}
                                  className="flex items-center gap-2"
                                >
                                  <input type="hidden" name="scriptId" value={script.id} />
                                  <input type="hidden" name="videoId" value={s.video.id} />
                                  <span
                                    className={`w-10 shrink-0 rounded px-1 py-0.5 text-center text-[10px] font-bold ${
                                      s.score >= 0.6
                                        ? "bg-emerald-50 text-emerald-700"
                                        : "bg-neutral-100 text-neutral-500"
                                    }`}
                                  >
                                    {Math.round(s.score * 100)}%
                                  </span>
                                  <span className="min-w-0 flex-1 truncate text-xs text-neutral-600">
                                    {s.video.caption?.split("\n")[0] || s.video.shortcode}
                                  </span>
                                  <button
                                    type="submit"
                                    className="shrink-0 rounded-md border border-neutral-200 px-2 py-0.5 text-[11px] font-medium text-neutral-600 hover:border-neutral-900 hover:text-neutral-900"
                                  >
                                    link
                                  </button>
                                </form>
                              ))}
                            </div>
                          </div>
                        )}
                        <form
                          action={linkAssignmentVideo.bind(null, a.id)}
                          className="flex items-end gap-2"
                        >
                          <input type="hidden" name="scriptId" value={script.id} />
                          <label className="min-w-0 flex-1">
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
                    )}
                  </div>
                ))}
              </div>
            )}
          </Card>
        </div>
      </div>

      {posted.length > 0 && (
        <div className="mt-5">
          <Card title="Posts from this script">
            <div className={tableWrap}>
              <table className={table}>
                <thead>
                  <tr>
                    <th className={th}>Creator</th>
                    <th className={th}>Score</th>
                    <th className={th}>Lift</th>
                    <th className={th}>Views</th>
                    <th className={th}>Posted</th>
                    <th className={th}>Caption</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {posted.map(({ a, creator, linked }) => (
                    <tr key={a.id} className={trHover}>
                      <td className={td}>
                        <Link
                          href={`/research/${a.research_creator_id}`}
                          className="font-medium text-neutral-900 hover:underline"
                        >
                          @{creator?.handle}
                        </Link>
                      </td>
                      <td className={td}>
                        <ResearchScoreChip score={linked!.score} />
                      </td>
                      <td className={`${td} tabular-nums`}>{fmtLift(linked!.lift)}</td>
                      <td className={`${td} tabular-nums`}>
                        {formatCompact(linked!.video.view_count)}
                      </td>
                      <td className={td}>{formatDate(linked!.video.posted_at)}</td>
                      <td className={`${td} max-w-80`}>
                        <span className="block truncate text-neutral-500">
                          {linked!.video.caption?.split("\n")[0] || linked!.video.shortcode}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </>
  );
}
