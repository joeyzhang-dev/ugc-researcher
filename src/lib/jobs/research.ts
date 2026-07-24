import { SupabaseClient } from "@supabase/supabase-js";
import {
  buildDiscoveryInput,
  buildInstagramReelsInput,
  buildProfileDetailsInput,
  canonicalVideoUrl,
  getApifyConfig,
  normalizeItem,
  normalizeProfile,
  runActorSync,
} from "@/lib/apify";
import { detectFormatCategory, extractHashtags } from "@/lib/research";
import { captureImage } from "@/lib/thumbnails";
import type { Platform } from "@/lib/types";

/** Research scrapes go deep — the lift baseline needs history, not just the
 *  newest posts. Apify charges per result, so cap it. */
const DEFAULT_RESULTS_LIMIT = 100;

/** Instagram CDN URLs 403 when hotlinked and expire in days; anything we want
 *  to render must live in our own storage. */
function isStorageUrl(url: string | null | undefined): boolean {
  return !!url && url.includes("/storage/v1/object/public/");
}

export interface ResearchScrapeOptions {
  handle: string;
  platform?: Platform;
  resultsLimit?: number;
  /** Stamp the creator kind ('roster' for our own creators). Omitted = leave
   *  the existing value (or the DB default 'research') untouched. */
  kind?: "research" | "roster";
}

export interface ResearchScrapeResult {
  creatorId: string;
  handle: string;
  scraped: number;
  videos: number;
  created: number;
  updated: number;
  skippedNonVideo: number;
}

/**
 * Scrape an outside creator's profile into research_creators/research_videos.
 * Idempotent: re-running refreshes counts on known URLs (metrics move) and
 * only inserts new ones. New videos default transcript_status='pending' so the
 * local worker picks them up.
 */
export async function runResearchScrape(
  supabase: SupabaseClient,
  options: ResearchScrapeOptions
): Promise<ResearchScrapeResult> {
  const platform = options.platform ?? "instagram";
  const handle = options.handle.replace(/^@/, "").trim().toLowerCase();
  if (!handle) throw new Error("handle is required");
  const resultsLimit = Math.min(Math.max(options.resultsLimit ?? DEFAULT_RESULTS_LIMIT, 1), 200);

  const profileUrl =
    platform === "instagram"
      ? `https://www.instagram.com/${handle}/`
      : `https://www.tiktok.com/@${handle}`;

  // Upsert the creator row first so a failed scrape is visible in the UI.
  const { data: creator, error: upsertError } = await supabase
    .from("research_creators")
    .upsert(
      {
        platform,
        handle,
        profile_url: profileUrl,
        status: "scraping",
        error_message: null,
        ...(options.kind ? { kind: options.kind } : {}),
      },
      { onConflict: "platform,handle" }
    )
    .select()
    .single();
  if (upsertError || !creator) {
    throw new Error(`Could not upsert research creator: ${upsertError?.message}`);
  }

  try {
    const config = getApifyConfig(platform);

    // Profile details (followers, avatar, display name) — cheap one-item run.
    // Best-effort: never fail the scrape over bio data.
    let followerCount: number | null = null;
    let avatarUrl: string | null = null;
    let displayName: string | null = null;
    try {
      const profileItems = await runActorSync(config, buildProfileDetailsInput(platform, [handle]));
      const raw = profileItems[0];
      if (raw) {
        const profile = normalizeProfile(platform, raw);
        followerCount = profile.followersCount;
        if (profile.profilePicUrl) {
          // Copy off the CDN — the raw URL 403s when hotlinked from our app.
          avatarUrl = await captureImage(
            supabase,
            `research/avatars/${creator.id}`,
            profile.profilePicUrl
          );
        }
        const fullName = raw["fullName"] ?? raw["full_name"] ?? raw["nickname"];
        displayName = typeof fullName === "string" && fullName.length > 0 ? fullName : null;
      }
    } catch {
      // fall through — post scrape still runs
    }

    // Reels only. A grid ("posts") scrape returns photos/carousels we discard
    // anyway, misses Reels-only accounts entirely, and costs an extra Apify run
    // per creator. TikTok's profile scrape is already all-video.
    const rawItems = await runActorSync(
      config,
      platform === "instagram"
        ? buildInstagramReelsInput([handle], resultsLimit)
        : buildDiscoveryInput(platform, [handle], resultsLimit)
    );

    let videos = 0;
    let created = 0;
    let updated = 0;
    let skippedNonVideo = 0;
    const seen = new Set<string>();
    // Thumbnail capture is deferred and parallelized after the row upserts.
    const thumbnailTasks: { rowId: string; cdnUrl: string }[] = [];

    for (const rawItem of rawItems) {
      const item = normalizeItem(platform, rawItem);
      // Profile scrapes can drag in tagged/related posts — keep only the owner's.
      if (item.ownerUsername && item.ownerUsername.toLowerCase() !== handle) continue;
      if (!item.url) continue;
      if (!item.isVideo) {
        skippedNonVideo++;
        continue;
      }
      const url = canonicalVideoUrl(item.url);
      if (seen.has(url)) continue;
      seen.add(url);
      videos++;

      const row = {
        research_creator_id: creator.id,
        url,
        shortcode: item.shortcode,
        external_id: item.externalId,
        caption: item.caption,
        hashtags: extractHashtags(item.caption),
        posted_at: item.postedAt,
        view_count: item.viewCount,
        like_count: item.likeCount,
        comment_count: item.commentCount,
        share_count: item.shareCount,
        thumbnail_url: item.thumbnailUrl,
        video_url: item.videoUrl,
        raw_metadata: item.raw,
        updated_at: new Date().toISOString(),
      };

      const { data: existing } = await supabase
        .from("research_videos")
        .select("id, video_url, thumbnail_url")
        .eq("url", url)
        .maybeSingle();

      if (existing) {
        // Refresh metrics/caption but never clobber transcript/format fields —
        // or captured storage copies (the worker uploads playable video there).
        if (isStorageUrl(existing.video_url)) delete (row as Record<string, unknown>).video_url;
        if (isStorageUrl(existing.thumbnail_url)) {
          delete (row as Record<string, unknown>).thumbnail_url;
        } else if (item.thumbnailUrl) {
          thumbnailTasks.push({ rowId: existing.id, cdnUrl: item.thumbnailUrl });
        }
        const { error } = await supabase.from("research_videos").update(row).eq("id", existing.id);
        if (error) throw new Error(error.message);
        updated++;
      } else {
        // Caption-only detection at insert; the transcript-aware pass
        // (runFormatCategorization) refines it once transcripts land.
        const { data: inserted, error } = await supabase
          .from("research_videos")
          .insert({ ...row, format_category: detectFormatCategory(item.caption) })
          .select("id")
          .single();
        if (error) throw new Error(error.message);
        created++;
        if (inserted && item.thumbnailUrl) {
          thumbnailTasks.push({ rowId: inserted.id, cdnUrl: item.thumbnailUrl });
        }
      }
    }

    // Copy thumbnails off the expiring, hotlink-blocked CDN into storage.
    // Best-effort in parallel batches; failures just keep the CDN URL.
    const BATCH = 8;
    for (let i = 0; i < thumbnailTasks.length; i += BATCH) {
      await Promise.all(
        thumbnailTasks.slice(i, i + BATCH).map(async ({ rowId, cdnUrl }) => {
          const stored = await captureImage(supabase, `research/videos/${rowId}`, cdnUrl);
          if (stored) {
            await supabase
              .from("research_videos")
              .update({ thumbnail_url: stored })
              .eq("id", rowId);
          }
        })
      );
    }

    await supabase
      .from("research_creators")
      .update({
        status: "ready",
        error_message: null,
        last_scraped_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...(followerCount != null ? { follower_count: followerCount } : {}),
        ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
        ...(displayName ? { display_name: displayName } : {}),
      })
      .eq("id", creator.id);

    return {
      creatorId: creator.id,
      handle,
      scraped: rawItems.length,
      videos,
      created,
      updated,
      skippedNonVideo,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("research_creators")
      .update({ status: "failed", error_message: message.slice(0, 500) })
      .eq("id", creator.id);
    throw error;
  }
}

export interface CategorizationResult {
  examined: number;
  categorized: number;
  changed: number;
}

/**
 * Transcript-aware format pass: re-run detectFormatCategory over a creator's
 * videos (or all research videos) now that transcripts exist. Detection only
 * overwrites with a non-null result, so a category never regresses to null.
 */
export async function runFormatCategorization(
  supabase: SupabaseClient,
  creatorId?: string
): Promise<CategorizationResult> {
  let query = supabase
    .from("research_videos")
    .select("id, caption, transcript_text, format_category");
  if (creatorId) query = query.eq("research_creator_id", creatorId);
  const { data, error } = await query;
  if (error) throw new Error(error.message);

  let categorized = 0;
  let changed = 0;
  for (const v of data ?? []) {
    const detected = detectFormatCategory(v.caption, v.transcript_text);
    if (!detected) continue;
    categorized++;
    if (detected === v.format_category) continue;
    const { error: updateError } = await supabase
      .from("research_videos")
      .update({ format_category: detected, updated_at: new Date().toISOString() })
      .eq("id", v.id);
    if (updateError) throw new Error(updateError.message);
    changed++;
  }
  return { examined: (data ?? []).length, categorized, changed };
}
