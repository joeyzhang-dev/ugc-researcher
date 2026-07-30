import type { SupabaseClient } from "@supabase/supabase-js";
import { runResearchScrape } from "@/lib/jobs/research";
import {
  DEFAULT_SCRAPE_SETTINGS,
  type ScrapeRunStatus,
  type ScrapeSettings,
} from "@/lib/scrape-settings";
import type { Platform, ResearchCreatorKind } from "@/lib/types";

/**
 * Scrape queue mechanics, shared by the server actions and the jobs API so the
 * UI button and any future scheduled trigger go through identical logic.
 */

/** Which creators a bulk enqueue covers. */
export interface EnqueueScope {
  kinds: ResearchCreatorKind[];
  /** Roster only: restrict to creators in this app (workspace scoping). */
  appId?: string | null;
  /** Skip creators scraped within this many hours. */
  skipScrapedWithinHours?: number;
}

export async function readSettings(supabase: SupabaseClient): Promise<ScrapeSettings> {
  const { data } = await supabase.from("research_settings").select("*").eq("id", true).maybeSingle();
  // The migration seeds the singleton, but defaults keep the UI usable even if
  // the row is missing rather than throwing on every page load.
  return { ...DEFAULT_SCRAPE_SETTINGS, ...(data ?? {}) } as ScrapeSettings;
}

export async function writeSettings(
  supabase: SupabaseClient,
  patch: Partial<ScrapeSettings>
): Promise<void> {
  const { error } = await supabase
    .from("research_settings")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq("id", true);
  if (error) throw new Error(error.message);
}

/** Resolve which creator ids a scope covers. */
export async function creatorsInScope(
  supabase: SupabaseClient,
  scope: EnqueueScope
): Promise<{ id: string; last_scraped_at: string | null; kind: ResearchCreatorKind }[]> {
  if (scope.kinds.length === 0) return [];

  const { data, error } = await supabase
    .from("research_creators")
    .select("id, kind, last_scraped_at")
    .in("kind", scope.kinds);
  if (error) throw new Error(error.message);

  let rows = (data ?? []) as { id: string; kind: ResearchCreatorKind; last_scraped_at: string | null }[];

  // Workspace scoping applies to the roster only — research creators aren't
  // owned by an app, so they're never filtered out by it.
  if (scope.appId) {
    const { data: memberships } = await supabase
      .from("research_app_creators")
      .select("research_creator_id")
      .eq("app_id", scope.appId);
    const inApp = new Set((memberships ?? []).map((m) => m.research_creator_id as string));
    rows = rows.filter((r) => r.kind !== "roster" || inApp.has(r.id));
  }

  if (scope.skipScrapedWithinHours != null) {
    const cutoff = Date.now() - scope.skipScrapedWithinHours * 60 * 60 * 1000;
    rows = rows.filter(
      (r) => !r.last_scraped_at || new Date(r.last_scraped_at).getTime() < cutoff
    );
  }
  return rows;
}

/** Mark every creator in scope as queued. Returns how many were newly added. */
export async function enqueueCreators(
  supabase: SupabaseClient,
  scope: EnqueueScope
): Promise<number> {
  const rows = await creatorsInScope(supabase, scope);
  if (rows.length === 0) return 0;

  const { data, error } = await supabase
    .from("research_creators")
    .update({ scrape_queued_at: new Date().toISOString() })
    .in("id", rows.map((r) => r.id))
    // Preserve the original position of anything already waiting.
    .is("scrape_queued_at", null)
    .select("id");
  if (error) throw new Error(error.message);
  return (data ?? []).length;
}

export interface DrainResult {
  remaining: number;
  handle: string | null;
  ok: boolean;
  error: string | null;
  staggerSeconds: number;
}

/**
 * Scrape the oldest queued creator and clear its queue marker.
 *
 * The marker is cleared BEFORE the scrape runs so a creator that throws can't
 * wedge the queue by being picked again on every call.
 */
export async function drainOneQueued(supabase: SupabaseClient): Promise<DrainResult> {
  const settings = await readSettings(supabase);
  const { data: next } = await supabase
    .from("research_creators")
    .select("id, handle, platform")
    .not("scrape_queued_at", "is", null)
    .order("scrape_queued_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!next) {
    return { remaining: 0, handle: null, ok: true, error: null, staggerSeconds: 0 };
  }

  await supabase
    .from("research_creators")
    .update({ scrape_queued_at: null })
    .eq("id", next.id as string);

  let ok = true;
  let error: string | null = null;
  try {
    await runResearchScrape(supabase, {
      handle: next.handle as string,
      platform: next.platform as Platform,
      resultsLimit: settings.results_limit,
    });
  } catch (e) {
    ok = false;
    error = e instanceof Error ? e.message : String(e);
  }

  const { count } = await supabase
    .from("research_creators")
    .select("id", { count: "exact", head: true })
    .not("scrape_queued_at", "is", null);

  return {
    remaining: count ?? 0,
    handle: next.handle as string,
    ok,
    error,
    staggerSeconds: settings.stagger_seconds,
  };
}

/** Record the outcome of a completed bulk run. */
export async function recordRun(
  supabase: SupabaseClient,
  status: ScrapeRunStatus,
  summary: string
): Promise<void> {
  await writeSettings(supabase, {
    last_run_at: new Date().toISOString(),
    last_run_status: status,
    last_run_summary: summary,
  });
}
