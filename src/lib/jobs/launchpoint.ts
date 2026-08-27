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
import { creatorNameFromChannel } from "@/lib/discord-channels";
import {
  fetchAllAccounts,
  fetchAllContractors,
  nameKey,
  pickPrimaryAccount,
  profileUrl,
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

/** Curves move once a day at most, so they are re-pulled far less often than
 *  insights. */
const HISTORY_RESYNC_AFTER_MS = 20 * 60 * 60 * 1000;

/**
 * Only posts this recent are queued for transcription on ingest.
 *
 * Transcription is the most expensive thing this app does — a media fetch plus
 * a Whisper call per video — and its whole purpose is matching a post back to
 * the script that produced it. Scripts are handed out and posted within days,
 * so a reel from four months ago has no open assignment waiting for it and the
 * transcript answers nothing.
 *
 * Older posts keep everything that does not need the audio: view counts,
 * retention, daily curves, earnings. They are marked 'skipped' rather than
 * 'pending' so the worker never picks them up, and rather than left null so it
 * is visible that the decision was deliberate.
 *
 * There is a second reason the old tail is not worth chasing: creators delete
 * posts. A live check of the failures found them all returning 404 from
 * Instagram — the media is simply gone, and the older the post the likelier
 * that is.
 */
const TRANSCRIBE_WINDOW_DAYS = 30;

/**
 * How many posts to have in flight at once during the drain phases.
 *
 * Each post costs two round trips — one Launchpoint read, one Supabase write —
 * and serially that came out at roughly 18 posts/minute against a key allowed
 * 90. The limit was latency, not the rate limit. Overlapping the waits lets the
 * pacer become the constraint again, which is the whole point of having one.
 *
 * Safe because `pace()` in the client is a single shared rolling window keyed
 * to the API key, not the caller: six workers cannot collectively exceed the
 * per-minute ceiling any more than one could. Kept modest so a burst of
 * failures stays legible and Supabase is not hammered in parallel.
 */
const DRAIN_CONCURRENCY = 6;

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

type Phase = "creators" | "posts" | "insights" | "history" | "socials" | "discord";

interface Budget {
  startedAt: number;
  budgetMs: number;
}

const expired = (b: Budget) => Date.now() - b.startedAt > b.budgetMs;

/**
 * Read every row of a table, a page at a time.
 *
 * PostgREST caps a select at the project's `db-max-rows` (1,000 by default),
 * silently — it returns a short list, not an error. `syncLaunchpointPosts`
 * builds its shortcode → video map from research_videos, which is already past
 * 2,000 rows, so an unpaged read left every video after the first 1,000
 * invisible: those posts looked new, got re-inserted, and collided on
 * research_videos_url_key. A dry run against in-memory rows cannot catch this;
 * only a real read can.
 */
type RowFilter =
  | { kind: "notNull"; column: string }
  | { kind: "eq"; column: string; value: string }
  | { kind: "nullOrOlderThan"; column: string; cutoff: string };

async function readAllRows<T>(
  admin: SupabaseClient,
  table: string,
  columns: string,
  filters: RowFilter[] = []
): Promise<T[]> {
  const PAGE = 1000;
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    // Rebuilt per page: a PostgrestFilterBuilder is single-use.
    let query = admin.from(table).select(columns);
    for (const f of filters) {
      if (f.kind === "notNull") query = query.not(f.column, "is", null);
      else if (f.kind === "eq") query = query.eq(f.column, f.value);
      else query = query.or(`${f.column}.is.null,${f.column}.lt.${f.cutoff}`);
    }
    const { data, error } = await query.range(from, from + PAGE - 1);
    if (error) throw new Error(`reading ${table}: ${error.message}`);
    const batch = (data ?? []) as T[];
    out.push(...batch);
    if (batch.length < PAGE) return out;
  }
}

/**
 * Run `worker` over `items` with a bounded number in flight, stopping early
 * when `shouldStop` goes true. Workers pull from a shared cursor rather than
 * being handed fixed slices, so one slow post cannot leave a worker idle while
 * others still have a queue.
 */
async function drainConcurrently<T>(
  items: T[],
  concurrency: number,
  shouldStop: () => boolean,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      if (shouldStop()) return;
      const index = cursor++;
      if (index >= items.length) return;
      await worker(items[index]);
    }
  });
  await Promise.all(runners);
}

/** Whether a post is recent enough to be worth transcribing. A post with no
 *  upload date is treated as out of window: guessing "recent" would queue an
 *  unbounded tail of unknown-age posts. */
export function withinTranscribeWindow(uploadedAt: string | null, now = Date.now()): boolean {
  if (!uploadedAt) return false;
  const posted = new Date(uploadedAt).getTime();
  if (Number.isNaN(posted)) return false;
  return now - posted <= TRANSCRIBE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

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

  type CreatorRow = {
    id: string;
    handle: string;
    platform: string;
    kind: string;
    display_name: string | null;
    launchpoint_creator_id: string | null;
  };
  const existing = await readAllRows<CreatorRow>(
    admin,
    "research_creators",
    "id, handle, platform, kind, display_name, launchpoint_creator_id"
  );

  const byKey = new Map<string, CreatorRow>();
  const byContractor = new Map<string, CreatorRow[]>();
  // Real name -> our rows. This is what catches a handle rename on a creator
  // who never had a contractor id to compare against — the case that let
  // Noah-andre Terry end up as two rows (@dresdistrict and
  // @morrismotivatesyou) with his Discord channel still pointing at the old
  // one. Contractor-id matching alone cannot see it.
  const byDisplayName = new Map<string, CreatorRow[]>();
  for (const row of existing) {
    const nameK = nameKey(row.display_name);
    if (nameK) byDisplayName.set(nameK, [...(byDisplayName.get(nameK) ?? []), row]);
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
    // Second, weaker signal: we already hold a row for someone with this
    // person's real name under a different handle. Still only reported —
    // two creators can share a name — but reported is the whole point, since
    // creating the row silently is what produces a split identity.
    const sameName = (byDisplayName.get(nameKey(account.contractorName)) ?? []).filter(
      (r) => r.platform === platform && !r.launchpoint_creator_id
    );
    if (sameName.length > 0) {
      result.possibleRenames.push({
        launchpointHandle: account.handle,
        existingHandle: sameName[0].handle,
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
// Phase 1b — socials
// ===========================================================================

export interface SocialSyncResult {
  written: number;
  /** Contractors Launchpoint tracks accounts for that we have no creator row
   *  for — normal for anyone not on the roster. */
  unmatched: number;
}

/**
 * Record every platform account Launchpoint knows for each creator.
 *
 * This is the only route by which the app learns a creator's TikTok handle.
 * research_creators is keyed on (platform, handle) and the creator phase
 * deliberately creates Instagram rows only, so a creator's TikTok presence is
 * otherwise invisible here even though Launchpoint has tracked it all along.
 *
 * Socials are written against the *person*, not one platform row: every
 * research_creators row sharing a launchpoint_creator_id gets the full set, so
 * an Instagram creator row carries their TikTok link too. That is what makes
 * the table useful for "where else does this creator post".
 */
export async function syncLaunchpointSocials(
  admin: SupabaseClient,
  accounts?: LaunchpointAccount[]
): Promise<SocialSyncResult> {
  const all = accounts ?? (await fetchAllAccounts());

  const creators = await readAllRows<{ id: string; launchpoint_creator_id: string | null }>(
    admin,
    "research_creators",
    "id, launchpoint_creator_id",
    [{ kind: "notNull", column: "launchpoint_creator_id" }]
  );
  const creatorsByContractor = new Map<string, string[]>();
  for (const c of creators) {
    const key = c.launchpoint_creator_id as string;
    creatorsByContractor.set(key, [...(creatorsByContractor.get(key) ?? []), c.id]);
  }

  // contractor -> platform -> accounts
  const grouped = new Map<string, Map<Platform, LaunchpointAccount[]>>();
  for (const account of all) {
    const platform = toPlatform(account.platform);
    if (!platform || !account.contractorId || !account.handle) continue;
    const byPlatform = grouped.get(account.contractorId) ?? new Map<Platform, LaunchpointAccount[]>();
    byPlatform.set(platform, [...(byPlatform.get(platform) ?? []), account]);
    grouped.set(account.contractorId, byPlatform);
  }

  const rows: Record<string, unknown>[] = [];
  const result: SocialSyncResult = { written: 0, unmatched: 0 };

  for (const [contractorId, byPlatform] of grouped) {
    const creatorIds = creatorsByContractor.get(contractorId);
    if (!creatorIds || creatorIds.length === 0) {
      result.unmatched++;
      continue;
    }
    for (const [platform, candidates] of byPlatform) {
      const primary = pickPrimaryAccount(candidates);
      if (!primary) continue;
      for (const creatorId of creatorIds) {
        rows.push({
          research_creator_id: creatorId,
          platform,
          url: profileUrl(platform, primary.handle),
        });
      }
    }
  }

  for (const batch of chunk(rows, WRITE_CHUNK)) {
    const { error } = await admin
      .from("research_creator_socials")
      .upsert(batch, { onConflict: "research_creator_id,platform" });
    if (error) throw new Error(`writing socials: ${error.message}`);
    result.written += batch.length;
  }

  await recordSync(
    admin,
    "socials",
    "succeeded",
    `${result.written} social links, ${result.unmatched} contractors not on the roster`
  );
  return result;
}

// ===========================================================================
// Phase 1c — Discord channel links
// ===========================================================================

export interface DiscordLinkResult {
  linked: number;
  /** Channels whose name matches more than one contractor, or a contractor we
   *  hold no creator row for. Reported, never guessed at. */
  ambiguous: { channel: string; reason: string }[];
  /** Channels Launchpoint has never heard of — archived, junk, or a creator
   *  who was never put under contract. */
  unknown: string[];
}

/**
 * Decide which contractor a Discord channel belongs to.
 *
 * Exact, unique, normalized-name match only. A channel whose derived name hits
 * two contractors is returned as ambiguous rather than linked: the cost of a
 * wrong link is one creator's posts, scripts and payouts attributed to another
 * person, which is far worse than a channel staying unlinked for a day.
 *
 * Pure, so the matching rule can be tested without Discord or Launchpoint.
 */
export function matchChannelToContractor(
  channelName: string,
  contractors: { contractorId: string; name: string; key: string }[]
): { contractorId: string } | { ambiguous: string } | null {
  const key = nameKey(creatorNameFromChannel(channelName));
  if (!key) return null;
  const hits = contractors.filter((c) => c.key === key);
  if (hits.length === 1) return { contractorId: hits[0].contractorId };
  if (hits.length > 1) {
    return { ambiguous: `matches ${hits.length} contractors: ${hits.map((h) => h.name).join(", ")}` };
  }
  return null;
}

/**
 * Link tracked Discord channels to creators using Launchpoint as the registry.
 *
 * Replaces hand-maintenance, it does not fight it: the pull worker's `discover`
 * explicitly preserves any link already in the database ("a human link must
 * survive re-discovery"), so whatever this writes is respected on the next
 * 15-minute pass rather than overwritten.
 *
 * Only ever fills a blank. An existing link — set here, by /link, or by hand in
 * the UI — is never rewritten, because a person who corrected a bad match
 * should not have to correct it again every hour.
 */
export async function syncLaunchpointDiscordLinks(
  admin: SupabaseClient,
  accounts?: LaunchpointAccount[]
): Promise<DiscordLinkResult> {
  const contractors = await fetchAllContractors(accounts);
  const result: DiscordLinkResult = { linked: 0, ambiguous: [], unknown: [] };

  const channels = await readAllRows<{
    channel_id: string;
    channel_name: string;
    research_creator_id: string | null;
    niche: string | null;
  }>(admin, "research_discord_channels", "channel_id, channel_name, research_creator_id, niche");

  const creators = await readAllRows<{
    id: string;
    platform: string;
    launchpoint_creator_id: string | null;
  }>(admin, "research_creators", "id, platform, launchpoint_creator_id", [
    { kind: "notNull", column: "launchpoint_creator_id" },
  ]);
  // Instagram row wins: it is the one the whole app is keyed on.
  const creatorByContractor = new Map<string, string>();
  for (const c of creators) {
    const key = c.launchpoint_creator_id as string;
    if (c.platform === "instagram" || !creatorByContractor.has(key)) {
      creatorByContractor.set(key, c.id);
    }
  }

  for (const channel of channels) {
    // A niche is what distinguishes a creator channel from a coach or dormant
    // one — same discriminator the send picker uses.
    if (channel.research_creator_id || !channel.niche) continue;

    const match = matchChannelToContractor(channel.channel_name, contractors);
    if (match === null) {
      result.unknown.push(channel.channel_name);
      continue;
    }
    if ("ambiguous" in match) {
      result.ambiguous.push({ channel: channel.channel_name, reason: match.ambiguous });
      continue;
    }
    const creatorId = creatorByContractor.get(match.contractorId);
    if (!creatorId) {
      result.ambiguous.push({
        channel: channel.channel_name,
        reason: "known to Launchpoint but no creator row yet — they have not linked an account",
      });
      continue;
    }
    const { error } = await admin
      .from("research_discord_channels")
      .update({ research_creator_id: creatorId })
      .eq("channel_id", channel.channel_id);
    if (error) throw new Error(`linking ${channel.channel_name}: ${error.message}`);
    result.linked++;
  }

  await recordSync(
    admin,
    "discord",
    "succeeded",
    `${result.linked} channels linked, ${result.ambiguous.length} ambiguous, ${result.unknown.length} unknown to Launchpoint`
  );
  return result;
}

// ===========================================================================
// Phase 2 — posts
// ===========================================================================

export interface PostSyncResult {
  matched: number;
  inserted: number;
  /** Of `inserted`, how many were old enough to skip transcription. */
  insertedSkippedTranscription: number;
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
    insertedSkippedTranscription: 0,
    unresolvedCreator: 0,
    unsupportedPlatform: 0,
  };

  const creators = await readAllRows<{
    id: string;
    platform: string;
    launchpoint_creator_id: string | null;
  }>(admin, "research_creators", "id, platform, launchpoint_creator_id", [
    { kind: "notNull", column: "launchpoint_creator_id" },
  ]);
  const creatorByContractor = new Map<string, string>();
  for (const c of creators) {
    creatorByContractor.set(`${c.launchpoint_creator_id}:${c.platform}`, c.id);
  }

  const videos = await readAllRows<{ id: string; shortcode: string | null }>(
    admin,
    "research_videos",
    "id, shortcode",
    [{ kind: "notNull", column: "shortcode" }]
  );
  const videoByShortcode = new Map<string, string>();
  for (const v of videos) if (v.shortcode) videoByShortcode.set(v.shortcode, v.id);

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
      // 'pending' hands the row to the Fly transcription worker on its next
      // poll; 'skipped' keeps it out of the queue for good.
      transcript_status: withinTranscribeWindow(post.uploadedAt) ? "pending" : "skipped",
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
    result.insertedSkippedTranscription += batch.filter(
      (r) => r.transcript_status === "skipped"
    ).length;
  }

  await recordSync(
    admin,
    "posts",
    "succeeded",
    `${result.matched} matched, ${result.inserted} ingested ` +
      `(${result.insertedSkippedTranscription} too old to transcribe), ` +
      `${result.unresolvedCreator} unresolved`
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
  /** Why the failures failed, deduped. A bare count is undiagnosable — the
   *  first live backfill reported "33 failed" with no way to tell a rate limit
   *  from a broken row. */
  errors: string[];
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
  const result: DrainResult = { processed: 0, empty: 0, failed: 0, errors: [], remaining: 0 };

  // 400 is roughly what a 200-second budget can spend at 100 req/min.
  const queue = await dueForSync(admin, 500);

  await drainConcurrently(queue, DRAIN_CONCURRENCY, () => expired(budget), async (row) => {
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
    } catch (e) {
      result.failed++;
      const message = e instanceof Error ? e.message : String(e);
      if (result.errors.length < 5 && !result.errors.includes(message)) {
        result.errors.push(message);
      }
    }
  });

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
  const result: DrainResult = { processed: 0, empty: 0, failed: 0, errors: [], remaining: 0 };

  // Cursor is `launchpoint_history_synced_at`, NOT "has a row dated today".
  // The latter does not converge: Launchpoint's most recent snapshot for a
  // quiet post can be days old, so it never earns a today-dated row, is never
  // considered fresh, and is re-fetched every pass forever. A live backfill
  // showed `remaining` going UP between passes, which is the tell.
  const cutoff = new Date(Date.now() - HISTORY_RESYNC_AFTER_MS).toISOString();
  const queue = await readAllRows<{ id: string; launchpoint_post_id: string | null }>(
    admin,
    "research_videos",
    "id, launchpoint_post_id",
    [
      { kind: "notNull", column: "launchpoint_post_id" },
      { kind: "nullOrOlderThan", column: "launchpoint_history_synced_at", cutoff },
    ]
  );

  await drainConcurrently(queue, DRAIN_CONCURRENCY, () => expired(budget), async (row) => {
    try {
      const history = await fetchPostHistory(row.launchpoint_post_id as string);
      // Stamp on every outcome, empty included, or a post Launchpoint holds no
      // history for sits at the head of the queue blocking everything behind
      // it on every tick — same rule the insights phase follows.
      const stamp = { launchpoint_history_synced_at: new Date().toISOString() };
      if (history.length === 0) {
        result.empty++;
        await admin.from("research_videos").update(stamp).eq("id", row.id);
        return;
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
      const { error: sErr } = await admin.from("research_videos").update(stamp).eq("id", row.id);
      if (sErr) throw new Error(sErr.message);
      result.processed++;
    } catch (e) {
      result.failed++;
      const message = e instanceof Error ? e.message : String(e);
      if (result.errors.length < 5 && !result.errors.includes(message)) {
        result.errors.push(message);
      }
    }
  });

  // A real count, not a per-pass leftover estimate: re-read how many rows are
  // still stale so `remaining` means the same thing it does for insights.
  const stillDue = await readAllRows<{ id: string }>(admin, "research_videos", "id", [
    { kind: "notNull", column: "launchpoint_post_id" },
    { kind: "nullOrOlderThan", column: "launchpoint_history_synced_at", cutoff },
  ]);
  result.remaining = stillDue.length;
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
  socials?: SocialSyncResult;
  discord?: DiscordLinkResult;
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

  // One accounts fetch, shared: the creator and socials phases read the same
  // endpoint and there is no reason to pay for it twice.
  const accounts = await fetchAllAccounts();
  const creators = await syncLaunchpointCreators(admin, accounts);
  const socials = await syncLaunchpointSocials(admin, accounts);
  const discord = await syncLaunchpointDiscordLinks(admin, accounts);
  const posts = await syncLaunchpointPosts(admin);
  if (opts.metadataOnly) {
    return { creators, socials, discord, posts, remaining: await countDue(admin) };
  }

  const left = () => Math.max(0, budgetMs - (Date.now() - startedAt));
  // Insights first — retention is the reason this integration exists, and the
  // curves are still useful a tick later.
  const insights = await syncLaunchpointInsights(admin, Math.floor(left() * 0.6));
  const history = await syncLaunchpointHistory(admin, left());

  return {
    creators,
    socials,
    discord,
    posts,
    insights,
    history,
    remaining: insights.remaining + history.remaining,
  };
}
