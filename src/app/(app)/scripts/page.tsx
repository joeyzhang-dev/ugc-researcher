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
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";

export const dynamic = "force-dynamic";

function fmtLift(n: number | null): string {
  return n == null ? "—" : `${n.toFixed(2)}×`;
}

/** Scripts we wrote for our own creators, ranked by how they actually did. */
export default async function ScriptsPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; status?: string }>;
}) {
  const { error, status: statusFilter } = await searchParams;
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
  const scripts = allScripts
    .filter((s) => !appFilter || s.app_id === appFilter)
    .filter((s) => !statusFilter || s.status === statusFilter);

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
  const scored = perf.filter((p) => p.medianScore != null);
  const bestScript = scored[0] ?? null;

  // Roster creators available in this workspace, for the assign dropdown.
  const inApp = new Set(
    memberships.filter((m) => !appFilter || m.app_id === appFilter).map((m) => m.research_creator_id)
  );
  const scopedCreators = creators.filter((c) => !appFilter || inApp.has(c.id));

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
        <KpiCard label="Scripts" value={String(scripts.length)} icon="badge" />
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
        <form action={createScript} className="grid gap-3 sm:grid-cols-2">
          <label className="sm:col-span-2">
            <span className={labelClass}>Title</span>
            <input name="title" placeholder="e.g. 3 habits that make you unstoppable" className={inputClass} required />
          </label>
          <label>
            <span className={labelClass}>App</span>
            <select name="appId" className={inputClass} defaultValue={appFilter ?? ""}>
              <option value="">— none —</option>
              {apps.map((a: ResearchApp) => (
                <option key={a.id} value={a.id}>{a.name}</option>
              ))}
            </select>
          </label>
          <label>
            <span className={labelClass}>Code (optional)</span>
            <input name="code" placeholder="F12" className={inputClass} />
          </label>
          <label className="sm:col-span-2">
            <span className={labelClass}>Script</span>
            <textarea
              name="body"
              rows={5}
              placeholder="The words the creator should say. This is what gets matched against their transcript."
              className={`${inputClass} resize-y`}
            />
          </label>
          <label>
            <span className={labelClass}>Hook (optional)</span>
            <input name="hook" className={inputClass} />
          </label>
          <label>
            <span className={labelClass}>Angle (optional)</span>
            <input name="angle" className={inputClass} />
          </label>
          <div className="sm:col-span-2">
            <SubmitButton pendingLabel="Saving…">Create script</SubmitButton>
          </div>
        </form>
      </Card>

      <div className="mt-5">
        <Card
          title="All scripts"
          action={
            <span className="flex items-center gap-1 text-xs">
              {[["", "All"], ["Active", "Active"], ["Draft", "Draft"], ["Archived", "Archived"]].map(
                ([value, label]) => (
                  <Link
                    key={label}
                    href={value ? `/scripts?status=${value}` : "/scripts"}
                    className={`rounded-md px-2.5 py-1 transition-colors ${
                      (statusFilter ?? "") === value
                        ? "bg-neutral-900 font-medium text-white"
                        : "text-neutral-500 hover:text-neutral-900"
                    }`}
                  >
                    {label}
                  </Link>
                )
              )}
            </span>
          }
        >
          {perf.length === 0 ? (
            <EmptyState
              message={
                allScripts.length === 0
                  ? "No scripts yet — write one above, assign it to a creator, then link the video they post."
                  : "No scripts match this filter in the current workspace."
              }
            />
          ) : (
            <div className={tableWrap}>
              <table className={table}>
                <thead>
                  <tr>
                    <th className={th}>Script</th>
                    <th className={th}>Status</th>
                    <th className={th}>Creators</th>
                    <th className={th}>Posts</th>
                    <th className={th}>Pending</th>
                    <th className={th}>Median score</th>
                    <th className={th}>Median lift</th>
                    <th className={th}>Median views</th>
                    <th className={th}>Best</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {perf.map((p) => (
                    <tr key={p.script.id} className={trHover}>
                      <td className={`${td} max-w-80`}>
                        <Link
                          href={`/scripts/${p.script.id}`}
                          className="font-medium text-neutral-900 hover:underline"
                        >
                          {p.script.code && (
                            <span className="mr-1.5 rounded bg-neutral-100 px-1.5 py-0.5 text-[11px] font-semibold text-neutral-500">
                              {p.script.code}
                            </span>
                          )}
                          {p.script.title}
                        </Link>
                      </td>
                      <td className={td}>
                        <StatusBadge status={p.script.status} />
                      </td>
                      <td className={`${td} tabular-nums`}>{p.creators}</td>
                      <td className={`${td} tabular-nums font-medium`}>{p.posts}</td>
                      <td className={`${td} tabular-nums text-neutral-500`}>{p.pending || "—"}</td>
                      <td className={td}>
                        <ResearchScoreChip score={p.medianScore} />
                      </td>
                      <td className={`${td} tabular-nums`}>{fmtLift(p.medianLift)}</td>
                      <td className={`${td} tabular-nums`}>{formatCompact(p.medianViews)}</td>
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
