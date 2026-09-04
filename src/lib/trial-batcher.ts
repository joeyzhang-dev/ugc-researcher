/**
 * Ground truth for trial reels: the Trial Reels Batcher's own publish log.
 *
 * The batcher (~/Developer/trial-reels) is the tool that uploads the ~35
 * near-identical takes a trial is made of. It runs on its OWN Supabase project,
 * and its `publish_jobs` table records a permalink for every reel it actually
 * published — which is the only unambiguous answer to "is this post a trial",
 * because neither Launchpoint nor Instagram exposes one.
 *
 * The join is `publish_jobs.permalink` -> `research_videos.shortcode`, and it
 * is lossless for the accounts the batcher covers: all 994 live permalinks
 * parse, and 552 of them are present here.
 *
 * What it does NOT cover: 442 of those 994 are absent from research_videos,
 * because the profile scrape only pulls the 35 newest reels and a high-volume
 * trial account pushes its own history out of that window. Ground truth spans
 * 7 creators, not the roster — the transcript heuristic remains the only
 * detector for everyone else, which is why `trial_source` records which
 * answered.
 */

import { shortcodeFromUrl } from "@/lib/launchpoint";

export interface PublishJob {
  batch_id?: string | null;
  status?: string | null;
  permalink?: string | null;
}

export interface TrialFlag {
  shortcode: string;
  batchId: string | null;
}

/**
 * The published trials in a page of publish_jobs, one entry per shortcode.
 *
 * Fails closed on anything it cannot read: a job that never published has no
 * post here, and an unparseable permalink is dropped rather than guessed at —
 * a wrong shortcode would flag another creator's real post as a trial and
 * erase it from every figure they are judged on.
 */
export function trialFlagsFromJobs(jobs: PublishJob[]): TrialFlag[] {
  const bySc = new Map<string, TrialFlag>();
  for (const j of jobs) {
    if (j.status !== "done") continue;
    const shortcode = shortcodeFromUrl(j.permalink);
    if (!shortcode) continue;
    // First writer wins: a reel republished under a second batch is still the
    // same post, and the earliest batch is the one that produced it.
    if (!bySc.has(shortcode)) bySc.set(shortcode, { shortcode, batchId: j.batch_id ?? null });
  }
  return [...bySc.values()];
}

/** Whether the batcher project is reachable from this deployment. */
export function batcherConfigured(): boolean {
  return !!(process.env.TRIAL_BATCHER_SUPABASE_URL && process.env.TRIAL_BATCHER_SERVICE_KEY);
}

/**
 * Every published trial the batcher knows about.
 *
 * Read-only, and paged: PostgREST caps a select at db-max-rows and the log
 * only grows. Returns [] when the batcher is not configured, so a deployment
 * without those credentials degrades to the heuristic instead of failing.
 */
export async function fetchPublishedTrials(pageSize = 1000): Promise<TrialFlag[]> {
  if (!batcherConfigured()) return [];
  const base = process.env.TRIAL_BATCHER_SUPABASE_URL!.replace(/\/$/, "");
  const key = process.env.TRIAL_BATCHER_SERVICE_KEY!;
  const out: PublishJob[] = [];
  for (let offset = 0; ; offset += pageSize) {
    const res = await fetch(
      `${base}/rest/v1/publish_jobs?select=batch_id,status,permalink&status=eq.done&limit=${pageSize}&offset=${offset}`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    if (!res.ok) throw new Error(`trial batcher ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const page = (await res.json()) as PublishJob[];
    out.push(...page);
    if (page.length < pageSize) break;
  }
  return trialFlagsFromJobs(out);
}
