export type Platform = "instagram" | "tiktok";
export const PLATFORMS: Platform[] = ["instagram", "tiktok"];
export const PLATFORM_LABELS: Record<Platform, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
};

export interface Profile {
  id: string;
  email: string | null;
  name: string | null;
  role: "admin" | "viewer" | "creator";
  created_at: string;
}

export type ResearchCreatorStatus = "pending" | "scraping" | "ready" | "failed";

/** 'research' = outside creator we study; 'roster' = one of our own creators. */
export type ResearchCreatorKind = "research" | "roster";

/** A creator profile we scrape — either studied competition or our roster. */
export interface ResearchCreator {
  id: string;
  platform: Platform;
  handle: string;
  kind: ResearchCreatorKind;
  display_name: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  follower_count: number | null;
  status: ResearchCreatorStatus;
  error_message: string | null;
  last_scraped_at: string | null;
  /** Set while the creator is waiting in the bulk scrape queue. */
  scrape_queued_at: string | null;
  /** Roster only: Discord identity, filled by the worker's enrich step.
   *  ⚠ Snowflake bigint — lossy as a JS number via `select *`; cast
   *  `discord_user_id::text` in the query if the exact id ever matters here. */
  discord_user_id: number | null;
  discord_username: string | null;
  /** Launchpoint contractor id (crt_...), stamped by the Launchpoint sync.
   *  Shared across a person's platform rows — one contractor, one id, one row
   *  here per platform+handle. */
  launchpoint_creator_id: string | null;
  /** The creator's real name per Launchpoint ('Sarah Jiang'), synced by the
   *  creators phase. Separate from `display_name` on purpose: that one is
   *  owned by the Instagram scrape and holds their IG persona ('D1 man
   *  hater'). Different facts — one column would make them overwrite each
   *  other every cycle. */
  launchpoint_name: string | null;
  /** Set when we stop working with a creator: hides them from the default
   *  roster and takes them out of bulk scrape enqueues. Nothing is deleted —
   *  their videos, transcripts and Launchpoint history all stay. Distinct from
   *  `status`, which is scrape health, not lifecycle. */
  archived_at: string | null;
  archived_reason: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

export type ResearchTranscriptStatus =
  | "pending"
  | "fetching"
  | "transcribed"
  | "failed"
  | "skipped";

/** One scraped reel of a research creator. Lift is computed, never stored. */
export interface ResearchVideo {
  id: string;
  research_creator_id: string;
  url: string;
  shortcode: string | null;
  external_id: string | null;
  caption: string | null;
  hashtags: string[];
  posted_at: string | null;
  view_count: number | null;
  like_count: number | null;
  comment_count: number | null;
  share_count: number | null;
  duration_seconds: number | null;
  thumbnail_url: string | null;
  video_url: string | null;
  transcript_status: ResearchTranscriptStatus;
  transcript_text: string | null;
  transcript_method: string | null;
  error_message: string | null;
  format_category: string | null;
  /** AI-categorization queue state (null = not queued). Drained by the Copilot
   *  agent — see docs/format-categorization.md. */
  format_llm_status: ResearchFormatLlmStatus | null;
  format_llm_reasoning: string | null;
  /** Provenance of the AI category, e.g. "copilot-cli/claude-opus-4.8". */
  format_llm_model: string | null;
  format_categorized_at: string | null;
  /* --- Launchpoint first-party metrics ------------------------------------
     Filled by the Launchpoint sync, not by a scrape. These come from inside
     the creator's own Instagram account, which is why they exist at all: no
     public scrape can see reach, saves, watch time or skip rate. Null on
     every outside-creator video and on anything not yet synced. */
  launchpoint_post_id: string | null;
  /** Launchpoint's concept name. Mostly the catch-all "Open-ended" — weak
   *  corroboration for a script match, never a substitute for one. */
  launchpoint_title: string | null;
  /** Unique accounts reached. Always <= view_count, which counts replays. */
  reach: number | null;
  saves: number | null;
  avg_watch_time_ms: number | null;
  total_watch_time_ms: number | null;
  /** Percent who skipped, 0-100. Lower is better. */
  skip_rate: number | null;
  earnings_usd: number | null;
  paid: boolean | null;
  /** Insights cursor — last first-party metrics pull. */
  launchpoint_synced_at: string | null;
  /** Daily-curve cursor. Deliberately separate from launchpoint_synced_at:
   *  the two phases cost very different amounts and must be able to run at
   *  different rates without either resetting the other's progress. */
  launchpoint_history_synced_at: string | null;
  raw_metadata: unknown;
  created_at: string;
  updated_at: string;
}

/** One daily snapshot of a post's metrics, mirrored from Launchpoint.
 *  research_videos holds a single overwritten view_count; this is the curve. */
export interface ResearchVideoDailyMetric {
  id: string;
  research_video_id: string;
  /** YYYY-MM-DD, the calendar day Launchpoint stamped. */
  date: string;
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
  bookmarks: number | null;
  /** Upstream's own day-over-day deltas. Stored rather than derived so a gap
   *  in the series cannot turn into a fabricated jump. */
  views_delta: number | null;
  likes_delta: number | null;
  comments_delta: number | null;
  shares_delta: number | null;
  bookmarks_delta: number | null;
  created_at: string;
}

export type LaunchpointSyncPhase =
  | "creators"
  | "socials"
  | "discord"
  | "accounts"
  | "posts"
  | "insights"
  | "history";

/** Per-phase bookkeeping for the Launchpoint sync. */
export interface ResearchLaunchpointSync {
  phase: LaunchpointSyncPhase;
  last_run_at: string | null;
  last_status: "succeeded" | "partial" | "failed" | null;
  last_detail: string | null;
  updated_at: string;
}

/** One tracked handle from Launchpoint's /analytics/accounts — the per-account
 *  activity snapshot (last post, totals, earnings), refreshed each sync tick.
 *  `research_creator_id` is null for handles we hold no creator row for (all
 *  of TikTok, by design). */
export interface ResearchLaunchpointAccount {
  id: string;
  platform: Platform;
  handle: string;
  research_creator_id: string | null;
  contractor_id: string;
  contractor_name: string | null;
  is_ghost_handle: boolean;
  total_posts: number | null;
  total_views: number | null;
  total_likes: number | null;
  total_comments: number | null;
  total_shares: number | null;
  engagement_rate: number | null;
  average_views_per_post: number | null;
  total_earnings: number | null;
  cpm: number | null;
  paid_posts: number | null;
  unpaid_posts: number | null;
  first_post_at: string | null;
  last_post_at: string | null;
  synced_at: string;
  created_at: string;
  updated_at: string;
}

export type ResearchFormatLlmStatus = "pending" | "done" | "failed";

export interface ResearchVideoSegment {
  id: string;
  research_video_id: string;
  position: number;
  start_time: number | null;
  end_time: number | null;
  text: string;
}

/** A product being promoted (Folk today; more apps later). */
export interface ResearchApp {
  id: string;
  name: string;
  notes: string | null;
  /** Workspace logo in the public `thumbnails` bucket; null falls back to initials. */
  logo_url: string | null;
  created_at: string;
}

export interface ResearchCampaign {
  id: string;
  app_id: string;
  name: string;
  status: string;
  notes: string | null;
  created_at: string;
}

/** Roster membership: creator ↔ app, carrying the per-app niche tag. */
export interface ResearchAppCreator {
  id: string;
  app_id: string;
  research_creator_id: string;
  niche: string | null;
  notes: string | null;
  created_at: string;
}

export interface ResearchCampaignCreator {
  id: string;
  campaign_id: string;
  research_creator_id: string;
  created_at: string;
}

export type ResearchScriptStatus = "Draft" | "Active" | "Archived";
export type ResearchAssignmentStatus = "Assigned" | "Posted" | "Skipped";

/** A script we wrote and handed to our own creators. */
export interface ResearchScript {
  id: string;
  /** Scopes the script to an app, like roster membership does. */
  app_id: string | null;
  title: string;
  /** Opening line — the first thing said, and the reason a viewer stays. */
  hook: string | null;
  /** The script as handed over — also what gets matched against transcripts. */
  body: string | null;
  /** Content lane, same vocabulary as a roster creator's per-app niche. */
  niche: string | null;
  /** Link to the video that inspired it — the doc's INSPO VIDEO line. */
  inspo_url: string | null;
  /** What to demo on screen while filming — the doc's DEMO TO USE line. */
  demo: string | null;
  /** Track(s) to run under the video — the doc's SONG(S) TO USE line. */
  songs: string | null;
  notes: string | null;
  status: ResearchScriptStatus;
  created_at: string;
  updated_at: string;
}

/** One script handed to one creator; the video link arrives once they post. */
export interface ResearchScriptAssignment {
  id: string;
  script_id: string;
  research_creator_id: string;
  research_video_id: string | null;
  status: ResearchAssignmentStatus;
  notes: string | null;
  assigned_at: string;
  posted_at: string | null;
  /* --- send tracking (20260818001500_assignment_sends) --------------------
     The assignment row IS the send record. `sent_at` is when the script
     actually reached the creator, which is what post timing should be
     measured against — `assigned_at` is only when the row was created and can
     predate the send by days. */
  discord_channel_id: string | null;
  discord_message_id: string | null;
  sent_at: string | null;
}

/* --- Discord (research_discord_*) ------------------------------------------
   Ingested by worker/discord_pull_worker.py. Discord snowflake ids are bigints
   beyond Number.MAX_SAFE_INTEGER, so every query casts them to ::text and the
   types carry them as strings. */

export type DiscordAuthorRole = "creator" | "coach" | "launchpoint" | "unknown";

/** One tracked coaching-<name> channel, optionally linked to a roster creator. */
export interface ResearchDiscordChannel {
  channel_id: string;
  guild_id: string;
  channel_name: string | null;
  research_creator_id: string | null;
  is_tracked: boolean;
  /** Cleaned content lane from the category ("Finance General"). */
  niche: string | null;
  /** Raw Discord category ("Not Creating 🚫" marks paused creators). */
  category: string | null;
}

export interface ResearchDiscordAttachment {
  id: string | null;
  filename: string | null;
  url: string;
  content_type: string | null;
  size: number | null;
}

export interface ResearchDiscordMessage {
  id: number;
  channel_id: string;
  message_id: string;
  author_discord_user_id: string | null;
  author_role: DiscordAuthorRole;
  is_bot: boolean;
  content: string;
  attachments: ResearchDiscordAttachment[];
  posted_at: string | null;
}

export interface ResearchDiscordUser {
  discord_user_id: string;
  username: string | null;
  global_name: string | null;
  nickname: string | null;
  display_name: string | null;
  is_bot: boolean;
}
