import Link from "next/link";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin } from "@/lib/auth";
import { resolveOpenAssignments } from "@/lib/jobs/match-scripts";
import { computeLifts, type VideoLift } from "@/lib/research";
import { suggestMatches, MATCH_AUTO_MIN } from "@/lib/scripts";
import type { ResearchVideo } from "@/lib/types";
import { linkAssignmentVideo } from "../actions";
import { runAutoMatch } from "../match-actions";
import { SubmitButton } from "@/components/submit-button";
import { Avatar, Card, EmptyState, PageHeader, buttonClass } from "@/components/ui";
import { ResearchVideoTile } from "@/components/research-video-tile";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * The pairs the matcher would not link on its own.
 *
 * Candidates are recomputed from transcripts on every load rather than stored,
 * so this queue drains as you work it: confirming one side of a contested pair
 * claims that video, and the rival's claim disappears on the next render.
 */
export default async function MatchReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; status?: string }>;
}) {
  await requireAdmin();
  const { error, status } = await searchParams;
  const db = createAdminClient();
  const ctx = await resolveOpenAssignments(db);

  // Lift per creator, over their whole library — the tiles show it.
  const byCreator = new Map<string, ResearchVideo[]>();
  for (const v of ctx.videoById.values()) {
    (byCreator.get(v.research_creator_id) ??
      byCreator.set(v.research_creator_id, []).get(v.research_creator_id)!).push(v);
  }
  const liftById = new Map<string, VideoLift>();
  for (const vids of byCreator.values()) {
    for (const row of computeLifts(vids)) liftById.set(row.video.id, row);
  }

  const taken = new Set(
    [...ctx.assignmentById.values()]
      .map((a) => a.research_video_id)
      .filter((id): id is string => !!id)
  );

  // Show every plausible candidate, not just the one the resolver picked —
  // the whole reason these are here is that the top pick is not obvious.
  const items = ctx.review.map((m) => {
    const a = ctx.assignmentById.get(m.assignmentId)!;
    const script = ctx.scriptById.get(m.scriptId)!;
    const pool = (byCreator.get(m.creatorId) ?? []).filter(
      (v) => v.transcript_text && !taken.has(v.id)
    );
    return {
      match: m,
      assignment: a,
      script,
      creator: ctx.creatorById.get(m.creatorId),
      candidates: suggestMatches([script.hook, script.body].filter(Boolean).join(" "), pool, {
        limit: 3,
      }),
    };
  });

  const contested = items.filter((i) => i.match.reason === "contested");
  const weak = items.filter((i) => i.match.reason === "low-confidence");
  // Every reason needs a home on this page, or a match the resolver deliberately
  // held back would vanish from the only queue that can settle it.
  const backdated = items.filter((i) => i.match.reason === "posted-before-send");

  return (
    <div className="space-y-6">
      <PageHeader
        title="Match review"
        subtitle="Posts the matcher found but would not link without you."
        action={
          <form action={runAutoMatch}>
            <SubmitButton pendingLabel="Matching…" className={buttonClass}>
              Run matcher
            </SubmitButton>
          </form>
        }
      />

      {error && (
        <p className="rounded-lg bg-danger/[0.08] px-3 py-2 text-sm text-danger">{error}</p>
      )}
      {status && (
        <p className="rounded-lg bg-success/[0.08] px-3 py-2 text-sm text-success">{status}</p>
      )}

      <Section
        title="Needs your call"
        note={`Two or more scripts match the same post closely enough that picking one automatically could swap them. Confirming one frees the rest.`}
        items={contested}
        liftById={liftById}
        empty="Nothing contested — every remaining match is unambiguous."
      />

      <Section
        title="Posted before the script went out"
        note="The wording matches, but this post already existed when the script was sent — so the script cannot have produced it. Usually a recycled script or a stale assignment. Confirm only if you know the history."
        items={backdated}
        liftById={liftById}
        empty="Nothing backdated."
      />

      <Section
        title="Weak guesses"
        note={`Below ${Math.round(MATCH_AUTO_MIN * 100)}% of the script's wording showed up. Usually this creator simply has not posted it yet — leave it and it will link itself when they do.`}
        items={weak}
        liftById={liftById}
        empty="No weak guesses outstanding."
      />
    </div>
  );
}

type Item = {
  match: { assignmentId: string; score: number; runnerUp: number };
  script: { id: string; hook: string | null; body: string | null; title: string };
  creator?: { handle: string; avatar_url?: string | null };
  candidates: { video: ResearchVideo; score: number }[];
};

/** The judging is a read: does this transcript say that script? Both sides
 *  fold out in place, because sending the reviewer to two other pages to
 *  answer a yes/no question is how a 147-deep queue got here. */
function FoldedText({ summary, text }: { summary: string; text: string }) {
  return (
    <details className="group/fold">
      <summary className="cursor-pointer select-none text-[11px] font-medium text-neutral-400 transition-colors hover:text-neutral-900">
        {summary}
      </summary>
      <p className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap rounded-lg bg-surface-sunken p-2 text-[11px] leading-relaxed text-neutral-600 ring-1 ring-hairline">
        {text}
      </p>
    </details>
  );
}

const shortDate = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" })
    : "no date";

function Section({
  title,
  note,
  items,
  liftById,
  empty,
}: {
  title: string;
  note: string;
  items: Item[];
  liftById: Map<string, VideoLift>;
  empty: string;
}) {
  return (
    <Card title={title} subtitle={`${items.length} · ${note}`}>
      {items.length === 0 ? (
        <EmptyState message={empty} />
      ) : (
        <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fill,minmax(320px,1fr))]">
          {items.map((i) => (
            <div key={i.match.assignmentId} className="rounded-xl bg-surface p-3 ring-1 ring-hairline">
              <div className="flex items-center gap-2 text-sm font-medium">
                <Avatar name={i.creator?.handle ?? "?"} src={i.creator?.avatar_url} size={24} />
                <span className="truncate">@{i.creator?.handle ?? "unknown"}</span>
              </div>
              <Link
                href={`/scripts/${i.script.id}`}
                className="mt-1 block truncate text-[13px] text-neutral-500 hover:text-neutral-900"
                title={i.script.hook ?? i.script.title}
              >
                {i.script.hook || i.script.title}
              </Link>
              <div className="mt-1.5">
                <FoldedText
                  summary="Read the script"
                  text={[i.script.hook, i.script.body].filter(Boolean).join("\n\n") || "(empty)"}
                />
              </div>

              <div className="mt-2.5 grid gap-x-2 [grid-template-columns:repeat(auto-fill,minmax(110px,1fr))]">
                {i.candidates.map((c) => {
                  const row = liftById.get(c.video.id);
                  return (
                    <div key={c.video.id} className="flex flex-col">
                      {row && <ResearchVideoTile row={row} />}
                      <span className="flex items-center justify-between px-1 py-1 text-[11px]">
                        <span
                          className="rounded-md bg-neutral-500/[0.1] px-1.5 py-0.5 text-[10px] font-bold text-neutral-500 ring-1 ring-inset ring-neutral-500/[0.14]"
                          title="How much of the script's wording shows up in this transcript"
                        >
                          {Math.round(c.score * 100)}%
                        </span>
                        <form action={linkAssignmentVideo.bind(null, i.match.assignmentId)}>
                          <input type="hidden" name="scriptId" value={i.script.id} />
                          <input type="hidden" name="videoId" value={c.video.id} />
                          <button
                            type="submit"
                            className="rounded-md px-2 py-0.5 font-medium text-neutral-600 ring-1 ring-inset ring-hairline transition-colors hover:text-neutral-900 hover:ring-neutral-900/40"
                          >
                            link
                          </button>
                        </form>
                      </span>
                      <div className="px-1 pb-1">
                        <FoldedText
                          summary={`Transcript · ${shortDate(c.video.posted_at)}`}
                          text={c.video.transcript_text ?? "(no transcript)"}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
