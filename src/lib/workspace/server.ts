import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import type { ResearchApp } from "@/lib/types";
import { ALL_APPS, WORKSPACE_COOKIE, type Workspace } from "./index";

/**
 * Which app the UI is currently scoped to. Persisted in a cookie so the choice
 * survives navigation and reloads, and validated against the live app list so a
 * deleted app silently falls back to "all" instead of showing an empty roster.
 *
 * Server-only: kept out of `./index` so client components can import the shared
 * constants without dragging `next/headers` into the browser bundle.
 */
export async function getWorkspace(): Promise<Workspace> {
  const supabase = await createClient();
  const { data } = await supabase.from("research_apps").select("*").order("created_at");
  const apps = (data ?? []) as ResearchApp[];

  const stored = (await cookies()).get(WORKSPACE_COOKIE)?.value;
  const current = stored && apps.some((a) => a.id === stored) ? stored : ALL_APPS;

  return { apps, current, app: apps.find((a) => a.id === current) ?? null };
}
