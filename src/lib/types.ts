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
  raw_metadata: unknown;
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

/** A product being promoted (Trace today; more apps later). */
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
