/**
 * Launchpoint → research_* sync.
 *
 * Four phases, deliberately separate because their costs differ by two orders
 * of magnitude:
 *
 *   creators   ~2 calls    handle → contractor id, and the missing-creator report
 *   posts      ~6 calls    bulk metrics, earnings, and any post we never scraped
 *   insights   1 per post  first-party IG retention — the expensive one
 *   history    1 per post  daily curves — the other expensive one
 *
 * The first two finish inside one tick. The last two cannot: ~1,500 Instagram
 * posts at the key's 100 requests/minute is close to half an hour, against a
 * 300-second Vercel ceiling. So both walk `launchpoint_synced_at nulls first`
 * and stop at a time budget, which makes the cursor the table itself — no
 * queue, no offset to lose, and a tick that dies mid-pass simply resumes.
 *
 * Everything here is idempotent. Re-running a phase updates the same rows.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Platform } from "@/lib/types";
import {
  fetchAllAccounts,
  fetchAllPosts,
  fetchPostHistory,
  fetchPostInsights,
  hasLaunchpointKey,
  toPlatform,
  type LaunchpointAccount,
  type LaunchpointPost,
} from "@/lib/launchpoint";

/** Leave headroom inside Vercel's 300s cap for the response itself. */
const DEFAULT_BUDGET_MS = 200_000;

/** Do not re-pull a post's insights more often than this. Without a floor the
 *  oldest-first cursor never goes idle — it would just keep rotating through
 *  the whole corpus, burning the rate limit on numbers that have not moved. */
const RESYNC_AFTER_MS = 6 * 60 * 60 * 1000;

/** Batch size for PostgREST writes. Large enough to keep the round trips down,
 *  small enough that one bad row fails a small batch. */
const WRITE_CHUNK = 200;

/**
 * Platforms we will CREATE creator rows for.
 *
 * Instagram only, deliberately. Launchpoint tracks 51 TikTok accounts for the
 * same people, and `research_creators` is keyed on (platform, handle) — so
 * accepting them would add a second row per creator, put all 51 into the
 * scrape queue burning Scrape Creators credits, and fill every roster view
 * with accounts that have no scripts, no sends and no matching behind them.
 * The app's entire workflow — scripts, sends, transcript matching — runs on
 * Instagram reels.
 *
 * This does not stop TikTok data being *linked*: an existing TikTok creator
 * row still gets its `launchpoint_creator_id` stamped. It only stops the sync
 * inventing a roster.
 */
const CREATE_PLATFORMS: readonly Platform[] = ["instagram"];

/**
 * Launchpoint occasionally reports a numeric account id where a handle should
 * be (`27419857611005344`), which comes from a Facebook-linked Instagram
 * account. It is not a handle, cannot be scraped and cannot be joined to
 * anything — creating a creator row for it would produce a permanently failing
 * roster entry.
 */
const isUsableHandle = (handle: string) => handle.length > 0 && !/^\d+$/.test(handle);

type Phase = "creators" | "posts" | "insights" | "history";

interface Budget {
  startedAt: number;
  budgetMs: number;
}

const expired = (b: Budget) => Date.now() - b.startedAt > b.budgetMs;

function chunk<T>(rows: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < rows.length; i += size) out.push(rows.slice(i, i + size));
  return out;
}

async function recordSync(
  admin: SupabaseClient,
  phase: Phase,
  status: "succeeded" | "partial" | "failed",
  detail: string
): Promise<void> {
  await admin
    .from("research_launchpoint_syncs")
    .upsert(
      { phase, last_run_at: new Date().toISOString(), last_status: status, last_detail: detail },
      { onConflict: "phase" }
    );
}

// ===========================================================================
// Phase 1 — creators
// ===========================================================================

export interface CreatorSyncResult {
  linked: number;
  created: number;
  /** Handles Launchpoint tracks that we could not place. Reported, never
   *  auto-merged — see the rename note below. */
  possibleRenames: { launchpointHandle: string; existingHandle: string; contractorId: string }[];
  skipped: number;
  /** Accounts Launchpoint tracks on a platform we do not create rows for
   *  (TikTok), or under an unusable handle. Reported so the coverage gap is
   *  visible rather than silent. */
  notCreated: { handle: string; platform: string; reason: "platform" | "handle" }[];
}

/**
 * Stamp `launchpoint_creator_id` onto the creators we already have, and create
 * rows for the ones we are missing.
 *
 * The subtle case is a rename. Launchpoint tracks handles like `lockinwithvick`
 * while our roster still says `vicklockedin`; those may be the same person who
 * changed their Instagram handle, or two genuinely different accounts. A
 * contractor id that already belongs to one of our creators under a *different*
 * handle is exactly that ambiguity, and it is not resolvable from the data —
 * so it is reported rather than guessed at, the same call `resolveScriptMatches`
 * makes when two scripts score too close to separate. Auto-merging here would
 * silently move one creator's posts onto another creator's row.
 */
export async function syncLaunchpointCreators(
  admin: SupabaseClient,
  accounts?: LaunchpointAccount[]
): Promise<CreatorSyncResult> {
  const all = accounts ?? (await fetchAllAccounts());

  const { data: existing, error } = await admin
    .from("research_creators")
    .select("id, handle, platform, kind, launchpoint_creator_id");
  if (error) throw new Error(`reading research_creators: ${error.message}`);

  const byKey = new Map<string, (typeof existing)[number]>();
  const byContractor = new Map<string, (typeof existing)[number][]>();
  for (const row of existing ?? []) {
    byKey.set(`${row.platform}:${row.handle.toLowerCase().replace(/^@/, "")}`, row);
    if (row.launchpoint_creator_id) {
      const list = byContractor.get(row.launchpoint_creator_id) ?? [];
      list.push(row);
      byContractor.set(row.launchpoint_creator_id, list);
    }
  }

  const result: CreatorSyncResult = {
    linked: 0,
    created: 0,
    possibleRenames: [],
    skipped: 0,
    notCreated: [],
  };
  const links: { id: string; launchpoint_creator_id: string }[] = [];
  const creates: Record<string, unknown>[] = [];

  for (const account of all) {
    const platform = toPlatform(account.platform);
    if (!platform || !account.handle || !account.contractorId) {
      result.skipped++;
      continue;
    }
    const match = byKey.get(`${platform}:${account.handle}`);
    if (match) {
      if (match.launchpoint_creator_id !== account.contractorId) {
        links.push({ id: match.id, launchpoint_creator_id: account.contractorId });
      }
      result.linked++;
      continue;
    }
    // Unknown handle, and we are about to consider creating one. Both gates
    // below report rather than silently dropping.
    if (!CREATE_PLATFORMS.includes(platform)) {
      result.notCreated.push({ handle: account.handle, platform, reason: "platform" });
      continue;
    }
    if (!isUsableHandle(account.handle)) {
      result.notCreated.push({ handle: account.handle, platform, reason: "handle" });
      continue;
    }
    // If this contractor already has a row under another handle on the same
    // platform, it is a rename candidate — flag, skip.
    const sameContractor = (byContractor.get(account.contractorId) ?? []).filter(
      (r) => r.platform === platform
    );
    if (sameContractor.length > 0) {
      result.possibleRenames.push({
        launchpointHandle: account.handle,
        existingHandle: sameContractor[0].handle,
        contractorId: account.contractorId,
      });
      continue;
    }
    creates.push({
      platform,
      handle: account.handle,
      kind: "roster",
      display_name: account.contractorName,
      profile_url:
        platform === "instagram"
          ? `https://www.instagram.com/${account.handle}/`
          : `https://www.tiktok.com/@${account.handle}`,
      // 'pending' puts them in the normal scrape path; nothing here fabricates
      // follower counts or a scrape timestamp we did not earn.
      status: "pending",
      launchpoint_creator_id: account.contractorId,
      notes: "Added from Launchpoint tracked accounts.",
    });
  }

  // One update per row: these are per-id patches, not a bulk upsert, and there
  // are at most a few dozen on a first run and none on later ones.
  for (const row of links) {
    const { error: e } = await admin
      .from("research_creators")
      .update({ launchpoint_creator_id: row.launchpoint_creator_id })
      .eq("id", row.id);
    if (e) throw new Error(`linking creator ${row.id}: ${e.message}`);
  }
  for (const batch of chunk(creates, WRITE_CHUNK)) {
    const { error: e } = await admin.from("research_creators").insert(batch);
    if (e) throw new Error(`creating creators: ${e.message}`);
    result.created += batch.length;
  }

  await recordSync(
    admin,
    "creators",
    "succeeded",
    `${result.linked} linked, ${result.created} created, ${result.possibleRenames.length} rename candidates, ` +
      `${result.notCreated.length} not created`
  );
  return result;
}

// ===========================================================================
// Phase 2 — posts
// ===========================================================================

export interface PostSyncResult {
  matched: number;
  inserted: number;
  /** Launchpoint posts whose creator we still cannot resolve. Normal on the
   *  first pass for anyone flagged as a rename candidate above. */
  unresolvedCreator: number;
  /** Non-Instagram/TikTok posts (YouTube, Facebook) — out of the app's model. */
  unsupportedPlatform: number;
}

/**
 * Attach every Launchpoint post to our own row, and ingest the ones we never
 * scraped.
 *
 * The join is the Instagram shortcode, which both sides already carry — so a
 * post scraped months before Launchpoint was connected still lines up, with no
 * id-mapping table and no backfill ordering to get right.
 *
 * Newly ingested posts land with `transcript_status: 'pending'`, which is the
 * point: the Fly transcription worker picks them up on its next 60-second poll
 * and they arrive complete, transcript and all, without a scrape.
 */
export async function syncLaunchpointPosts(
  admin: SupabaseClient,
  posts?: LaunchpointPost[]
): Promise<PostSyncResult> {
  const all = posts ?? (await fetchAllPosts());
  const result: PostSyncResult = {
    matched: 0,
    inserted: 0,
    unresolvedCreator: 0,
    unsupportedPlatform: 0,
  };

  const { data: creators, error: cErr } = await admin
    .from("research_creators")
    .select("id, platform, launchpoint_creator_id")
    .not("launchpoint_creator_id", "is", null);
  if (cErr) throw new Error(`reading creators: ${cErr.message}`);
  const creatorByContractor = new Map<string, string>();
  for (const c of creators ?? []) {
    creatorByContractor.set(`${c.launchpoint_creator_id}:${c.platform}`, c.id);
  }

  const { data: videos, error: vErr } = await admin
    .from("research_videos")
    .select("id, shortcode")
    .not("shortcode", "is", null);
  if (vErr) throw new Error(`reading videos: ${vErr.message}`);
  const videoByShortcode = new Map<string, string>();
  for (const v of videos ?? []) if (v.shortcode) videoByShortcode.set(v.shortcode, v.id);

  const updates: { id: string; patch: Record<string, unknown> }[] = [];
  const inserts: Record<string, unknown>[] = [];
  const seenShortcodes = new Set<string>();

  for (const post of all) {
    const platform = toPlatform(post.platform);
    if (!platform) {
      result.unsupportedPlatform++;
      continue;
    }
    // Only Instagram carries a shortcode we can join on; TikTok posts are
    // matched by external id elsewhere and are out of scope for this pass.
    if (platform !== "instagram" || !post.shortcode) continue;
    // Launchpoint can hold two rows for one reel (a cross-post group). First
    // one wins; a second would collide on the partial unique index anyway.
    if (seenShortcodes.has(post.shortcode)) continue;
    seenShortcodes.add(post.shortcode);

    const shared = {
      launchpoint_post_id: post.id,
      launchpoint_title: post.title,
      earnings_usd: post.earnings,
      paid: post.paid,
    };

    const existingId = videoByShortcode.get(post.shortcode);
    if (existingId) {
      updates.push({ id: existingId, patch: shared });
      result.matched++;
      continue;
    }

    const creatorId = post.creatorId
      ? creatorByContractor.get(`${post.creatorId}:instagram`)
      : undefined;
    if (!creatorId) {
      result.unresolvedCreator++;
      continue;
    }
    inserts.push({
      ...shared,
      research_creator_id: creatorId,
      url: post.url,
      shortcode: post.shortcode,
      posted_at: post.uploadedAt,
      view_count: post.views,
      like_count: post.likes,
      comment_count: post.comments,
      share_count: post.shares,
      thumbnail_url: post.thumbnail,
      // Hands the row to the Fly transcription worker on its next poll.
      transcript_status: "pending",
    });
  }

  for (const u of updates) {
    const { error } = await admin.from("research_videos").update(u.patch).eq("id", u.id);
    if (error) throw new Error(`updating video ${u.id}: ${error.message}`);
  }
  for (const batch of chunk(inserts, WRITE_CHUNK)) {
    const { error } = await admin.from("research_videos").insert(batch);
    if (error) throw new Error(`inserting videos: ${error.message}`);
    result.inserted += batch.length;
  }

  await recordSync(
    admin,
    "posts",
    "succeeded",
    `${result.matched} matched, ${result.inserted} ingested, ${result.unresolvedCreator} unresolved`
  );
  return result;
}

// ===========================================================================
// Phases 3 & 4 — insights and daily history
// ===========================================================================

export interface DrainResult {
  processed: number;
  /** Instagram posts Launchpoint holds no insights for. Rare — the live
   *  sample answered `available` on 40 of 40 — but a fresh post can precede
   *  its own metrics. */
  empty: number;
  failed: number;
  /** Rows still stale when the budget ran out. 0 means the phase is caught up. */
  remaining: number;
}

/** Rows due for a pull: Launchpoint-known Instagram posts, never synced or
 *  stale, oldest first. This ordering IS the resume cursor. */
async function dueForSync(admin: SupabaseClient, limit: number) {
  const cutoff = new Date(Date.now() - RESYNC_AFTER_MS).toISOString();
  const { data, error } = await admin
    .from("research_videos")
    .select("id, launchpoint_post_id, launchpoint_synced_at")
    .not("launchpoint_post_id", "is", null)
    .or(`launchpoint_synced_at.is.null,launchpoint_synced_at.lt.${cutoff}`)
    .order("launchpoint_synced_at", { ascending: true, nullsFirst: true })
    .limit(limit);
  if (error) throw new Error(`reading sync queue: ${error.message}`);
  return data ?? [];
}

async function countDue(admin: SupabaseClient): Promise<number> {
  const cutoff = new Date(Date.now() - RESYNC_AFTER_MS).toISOString();
  const { count, error } = await admin
    .from("research_videos")
    .select("id", { count: "exact", head: true })
    .not("launchpoint_post_id", "is", null)
    .or(`launchpoint_synced_at.is.null,launchpoint_synced_at.lt.${cutoff}`);
  if (error) throw new Error(`counting sync queue: ${error.message}`);
  return count ?? 0;
}

/**
 * Pull first-party insights for as many due posts as the budget allows.
 *
 * `launchpoint_synced_at` is stamped on **every** outcome including an empty
 * one, so a post with no insights does not sit at the head of the queue
 * blocking everything behind it on every tick.
 */
export async function syncLaunchpointInsights(
  admin: SupabaseClient,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<DrainResult> {
  const budget: Budget = { startedAt: Date.now(), budgetMs };
  const result: DrainResult = { processed: 0, empty: 0, failed: 0, remaining: 0 };

  // 400 is roughly what a 200-second budget can spend at 100 req/min.
  const queue = await dueForSync(admin, 500);

  for (const row of queue) {
    if (expired(budget)) break;
    try {
      const insights = await fetchPostInsights(row.launchpoint_post_id as string);
      const patch: Record<string, unknown> = { launchpoint_synced_at: new Date().toISOString() };
      if (insights.available) {
        patch.reach = insights.reach;
        patch.saves = insights.saves;
        patch.avg_watch_time_ms = insights.avgWatchTimeMs;
        patch.total_watch_time_ms = insights.totalWatchTimeMs;
        patch.skip_rate = insights.skipRate;
        // Launchpoint's own view/like/comment/share counts are first-party and
        // fresher than the last public scrape, so they win where present.
        if (insights.views != null) patch.view_count = insights.views;
        if (insights.likes != null) patch.like_count = insights.likes;
        if (insights.comments != null) patch.comment_count = insights.comments;
        if (insights.shares != null) patch.share_count = insights.shares;
        result.processed++;
      } else {
        result.empty++;
      }
      const { error } = await admin.from("research_videos").update(patch).eq("id", row.id);
      if (error) throw new Error(error.message);
    } catch {
      result.failed++;
    }
  }

  result.remaining = await countDue(admin);
  await recordSync(
    admin,
    "insights",
    result.failed > 0 && result.processed === 0 ? "failed" : result.remaining > 0 ? "partial" : "succeeded",
    `${result.processed} synced, ${result.empty} empty, ${result.failed} failed, ${result.remaining} left`
  );
  return result;
}

/**
 * Pull daily metric curves for as many due posts as the budget allows.
 *
 * Deliberately does NOT share the `launchpoint_synced_at` cursor with the
 * insights phase — that column is the insights cursor. History uses the
 * presence of a recent row in research_video_metrics_daily instead, so the two
 * phases can run at different rates without either resetting the other's
 * progress.
 */
export async function syncLaunchpointHistory(
  admin: SupabaseClient,
  budgetMs = DEFAULT_BUDGET_MS
): Promise<DrainResult> {
  const budget: Budget = { startedAt: Date.now(), budgetMs };
  const result: DrainResult = { processed: 0, empty: 0, failed: 0, remaining: 0 };

  const { data: candidates, error } = await admin
    .from("research_videos")
    .select("id, launchpoint_post_id")
    .not("launchpoint_post_id", "is", null)
    .limit(4000);
  if (error) throw new Error(`reading history candidates: ${error.message}`);

  // A post whose curve already reaches today needs nothing. One query for the
  // whole set beats a per-post existence check.
  const today = new Date().toISOString().slice(0, 10);
  const { data: fresh, error: fErr } = await admin
    .from("research_video_metrics_daily")
    .select("research_video_id")
    .eq("date", today);
  if (fErr) throw new Error(`reading fresh curves: ${fErr.message}`);
  const upToDate = new Set((fresh ?? []).map((r) => r.research_video_id));

  const queue = (candidates ?? []).filter((c) => !upToDate.has(c.id));

  for (const row of queue) {
    if (expired(budget)) break;
    try {
      const history = await fetchPostHistory(row.launchpoint_post_id as string);
      if (history.length === 0) {
        result.empty++;
        continue;
      }
      const rows = history.map((h) => ({
        research_video_id: row.id,
        date: h.date,
        views: h.views,
        likes: h.likes,
        comments: h.comments,
        shares: h.shares,
        bookmarks: h.bookmarks,
        views_delta: h.viewsDelta,
        likes_delta: h.likesDelta,
        comments_delta: h.commentsDelta,
        shares_delta: h.sharesDelta,
        bookmarks_delta: h.bookmarksDelta,
      }));
      const { error: uErr } = await admin
        .from("research_video_metrics_daily")
        .upsert(rows, { onConflict: "research_video_id,date" });
      if (uErr) throw new Error(uErr.message);
      result.processed++;
    } catch {
      result.failed++;
    }
  }

  result.remaining = Math.max(0, queue.length - result.processed - result.empty - result.failed);
  await recordSync(
    admin,
    "history",
    result.failed > 0 && result.processed === 0 ? "failed" : result.remaining > 0 ? "partial" : "succeeded",
    `${result.processed} curves, ${result.empty} empty, ${result.failed} failed, ${result.remaining} left`
  );
  return result;
}

// ===========================================================================
// Orchestrator
// ===========================================================================

export interface LaunchpointSyncResult {
  skipped?: string;
  creators?: CreatorSyncResult;
  posts?: PostSyncResult;
  insights?: DrainResult;
  history?: DrainResult;
  /** Total still-stale rows across the two drain phases — the caller repeats
   *  until this is 0, exactly like scrapeAll's `remaining`. */
  remaining: number;
}

/**
 * One pass of the full sync.
 *
 * `metadataOnly` runs just the two cheap phases, which is what an hourly cron
 * wants when it is sharing its budget with a scrape. The default runs all
 * four and splits the remaining budget between insights and history.
 */
export async function syncLaunchpoint(
  admin: SupabaseClient,
  opts: { budgetMs?: number; metadataOnly?: boolean } = {}
): Promise<LaunchpointSyncResult> {
  if (!hasLaunchpointKey()) {
    return { skipped: "LAUNCHPOINT_API_KEY is not set", remaining: 0 };
  }
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const startedAt = Date.now();

  const creators = await syncLaunchpointCreators(admin);
  const posts = await syncLaunchpointPosts(admin);
  if (opts.metadataOnly) {
    return { creators, posts, remaining: await countDue(admin) };
  }

  const left = () => Math.max(0, budgetMs - (Date.now() - startedAt));
  // Insights first — retention is the reason this integration exists, and the
  // curves are still useful a tick later.
  const insights = await syncLaunchpointInsights(admin, Math.floor(left() * 0.6));
  const history = await syncLaunchpointHistory(admin, left());

  return {
    creators,
    posts,
    insights,
    history,
    remaining: insights.remaining + history.remaining,
  };
}
