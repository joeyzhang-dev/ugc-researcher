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

/** Outside creator under study on the Research page (not a campaign creator). */
export interface ResearchCreator {
  id: string;
  platform: Platform;
  handle: string;
  display_name: string | null;
  profile_url: string | null;
  avatar_url: string | null;
  follower_count: number | null;
  status: ResearchCreatorStatus;
  error_message: string | null;
  last_scraped_at: string | null;
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
