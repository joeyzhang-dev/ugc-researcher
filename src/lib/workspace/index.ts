import type { ResearchApp } from "@/lib/types";

/** Sentinel for "don't scope to one app" — Slack has no such view, but the
 *  roster is small enough that seeing every app at once is genuinely useful. */
export const ALL_APPS = "all";

export const WORKSPACE_COOKIE = "workspace";

export type Workspace = {
  apps: ResearchApp[];
  /** Selected app id, or ALL_APPS. */
  current: string;
  /** The selected app row — null when viewing all apps. */
  app: ResearchApp | null;
};

/** Two-letter mark for the workspace tile, e.g. "Folk Agency" -> "FA". */
export function appInitials(name: string): string {
  const parts = name.trim().split(/[\s._-]+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0]![0]! + parts[1]![0]!).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}
