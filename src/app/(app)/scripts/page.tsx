import Link from "next/link";
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
import {
  Card, EmptyState, KpiCard, PageHeader, StatusBadge,
  inputClass, labelClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatCompact, formatDate } from "@/lib/format";
import { ResearchScoreChip } from "@/components/research-panel";
import { NicheCombobox } from "@/components/niche-combobox";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";

export const dynamic = "force-dynamic";

const STATUS_TABS = [
  ["", "All"],
  ["Active", "Active"],
  ["Draft", "Draft"],
  ["Archived", "Archived"],
] as const;

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
}

/** Scripts we wrote for our own creators, ranked by how they actually did. */
export default async function ScriptsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; status?: string; niche?: string }>;
}) {
  const { error, status: statusFilter, niche: nicheFilter } = await searchParams;
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
  const scripts = inWorkspace
    .filter((s) => !statusFilter || s.status === statusFilter)
    .filter((s) => !nicheFilter || s.niche === nicheFilter);

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

  const perf = summarizeScripts(scripts, assignments, videosByCreator);
  const creatorById = new Map(creators.map((c) => [c.id, c]));

  const totalPosts = perf.reduce((s, p) => s + p.posts, 0);
  const totalPending = perf.reduce((s, p) => s + p.pending, 0);
  const bestScript = perf.find((p) => p.medianScore != null) ?? null;

  // Niches already in use, so the field suggests instead of inviting typos.
  const knownNiches = [
    ...new Set(
      [
        ...allScripts.map((s) => s.niche),
        ...memberships.map((m) => m.niche),
      ].filter((n): n is string => !!n)
    ),
  ].sort();

  const nichesInView = [
    ...new Set(inWorkspace.map((s) => s.niche).filter((n): n is string => !!n)),
  ].sort();

  const hrefWith = (over: { status?: string | null; niche?: string | null }) => {
    const sp = new URLSearchParams();
    if (statusFilter) sp.set("status", statusFilter);
    if (nicheFilter) sp.set("niche", nicheFilter);
    for (const [k, v] of Object.entries(over)) {
      if (v == null) sp.delete(k);
      else sp.set(k, v);
    }
    const qs = sp.toString();
    return `/scripts${qs ? `?${qs}` : ""}`;
  };

  const scopedCreators = creators.filter((c) =>
    !appFilter
      ? true
      : memberships.some((m) => m.app_id === appFilter && m.research_creator_id === c.id)
  );

  return (
    <>
      <PageHeader title="Scripts" />
      <p className="-mt-4 mb-5 max-w-3xl text-sm text-neutral-500">
        Scripts we hand to our own creators, and how each one actually performed. Ranked by{" "}
        <em>lift</em> rather than views — a script is only good if it makes the creator who ran it
        beat their own baseline, which raw view counts would hide behind whoever has the biggest
        following.
        {app && (
          <>
            {" "}
            Scoped to <span className="font-medium text-neutral-700">{app.name}</span>.
          </>
        )}
      </p>

      {error && (
        <p className="mb-4 rounded-lg border border-red-200 bg-red-50 p-2.5 text-sm text-red-700">
          {error}
        </p>
      )}

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Scripts" value={String(inWorkspace.length)} icon="badge" />
        <KpiCard label="Posts measured" value={String(totalPosts)} icon="play" tone="emerald" />
        <KpiCard
          label="Awaiting a post"
          value={String(totalPending)}
          icon="clock"
          tone={totalPending ? "amber" : "neutral"}
        />
        <KpiCard
          label="Best median score"
          value={bestScript?.medianScore?.toFixed(1) ?? "—"}
          sub={bestScript?.script.title}
          icon="trend"
          tone="violet"
        />
      </div>

      <Card title="Write a script">
        <form action={createScript} className="space-y-3">
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
          <div className="overflow-hidden rounded-xl border border-neutral-200">
            <div className="border-b border-neutral-200 bg-neutral-50 px-3 py-2">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wide text-neutral-500">
                Hook
              </span>
              <input
                name="hook"
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
                rows={7}
                placeholder="Everything after the hook. This is what gets matched against the transcript of what they actually posted."
                className="w-full resize-y border-0 bg-transparent p-0 text-sm leading-relaxed text-neutral-800 outline-none placeholder:text-neutral-400"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <label className="min-w-44 flex-1">
              <span className={labelClass}>Niche</span>
              <NicheCombobox options={knownNiches} />
            </label>
            <label className="min-w-36">
              <span className={labelClass}>App</span>
              <select name="appId" className={inputClass} defaultValue={appFilter ?? ""}>
                <option value="">— none —</option>
                {apps.map((a: ResearchApp) => (
                  <option key={a.id} value={a.id}>{a.name}</option>
                ))}
              </select>
            </label>
            <label className="min-w-32">
              <span className={labelClass}>Status</span>
              <select name="status" className={inputClass} defaultValue="Active">
                {["Active", "Draft", "Archived"].map((s) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </label>
            <SubmitButton pendingLabel="Saving…">Create script</SubmitButton>
          </div>
        </form>
      </Card>

      <div className="mt-5">
        <Card
          title="All scripts"
          action={
            <span className="flex flex-wrap items-center gap-1 text-xs">
              {nichesInView.length > 0 && (
                <>
                  {nichesInView.map((n) => (
                    <Link
                      key={n}
                      href={hrefWith({ niche: nicheFilter === n ? null : n })}
                      className={`rounded-md px-2 py-1 transition-colors ${
                        nicheFilter === n
                          ? "bg-violet-600 font-medium text-white"
                          : "text-violet-700 hover:bg-violet-50"
                      }`}
                    >
                      {n}
                    </Link>
                  ))}
                  <span className="mx-1 h-4 w-px bg-neutral-200" />
                </>
              )}
              {STATUS_TABS.map(([value, label]) => (
                <Link
                  key={label}
                  href={hrefWith({ status: value || null })}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    (statusFilter ?? "") === value
                      ? "bg-neutral-900 font-medium text-white"
                      : "text-neutral-500 hover:text-neutral-900"
                  }`}
                >
                  {label}
                </Link>
              ))}
            </span>
          }
        >
          {perf.length === 0 ? (
            <EmptyState
              message={
                allScripts.length === 0
                  ? "No scripts yet — write one above, hand it to a creator, then link the video they post."
                  : "No scripts match these filters in the current workspace."
              }
            />
          ) : (
            <div className={tableWrap}>
              <table className={table}>
                <thead>
                  <tr>
                    <th className={th}>Script</th>
                    <th className={th}>Score</th>
                    <th className={th}>Lift</th>
                    <th className={th}>Views</th>
                    <th className={th}>Ran by</th>
                    <th className={th}>Best post</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {perf.map((p) => (
                    <tr key={p.script.id} className={trHover}>
                      <td className={`${td} max-w-96`}>
                        <Link href={`/scripts/${p.script.id}`} className="group block">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate font-medium text-neutral-900 group-hover:underline">
                              {p.script.title}
                            </span>
                            {p.script.niche && (
                              <span className="shrink-0 rounded bg-violet-50 px-1.5 py-0.5 text-[10px] font-medium text-violet-700">
                                {p.script.niche}
                              </span>
                            )}
                            {p.script.status !== "Active" && (
                              <StatusBadge status={p.script.status} />
                            )}
                          </span>
                          {p.script.hook && (
                            <span className="mt-0.5 block truncate text-xs text-neutral-400">
                              “{p.script.hook}”
                            </span>
                          )}
                        </Link>
                      </td>
                      <td className={td}>
                        <ResearchScoreChip score={p.medianScore} />
                      </td>
                      <td className={`${td} tabular-nums`}>{fmtLift(p.medianLift)}</td>
                      <td className={`${td} tabular-nums`}>{formatCompact(p.medianViews)}</td>
                      <td className={`${td} whitespace-nowrap tabular-nums`}>
                        <span className="font-medium">{p.posts}</span>
                        <span className="text-neutral-400">
                          /{p.creators} creator{p.creators === 1 ? "" : "s"}
                        </span>
                        {p.pending > 0 && (
                          <span className="ml-1.5 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
                            {p.pending} waiting
                          </span>
                        )}
                      </td>
                      <td className={`${td} max-w-56`}>
                        {p.best ? (
                          <span className="flex items-center gap-2">
                            <ResearchScoreChip score={p.best.score} />
                            <span className="min-w-0 truncate text-xs text-neutral-500">
                              @{creatorById.get(p.best.video.research_creator_id)?.handle ?? "—"}
                              {" · "}
                              {formatDate(p.best.video.posted_at)}
                            </span>
                          </span>
                        ) : (
                          <span className="text-xs text-neutral-400">no posts yet</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {scopedCreators.length === 0 && (
            <p className="mt-3 text-xs text-neutral-400">
              No roster creators in this workspace yet — add them on Our creators before assigning.
            </p>
          )}
        </Card>
      </div>
    </>
  );
}
