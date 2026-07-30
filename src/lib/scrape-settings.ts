/**
 * Scrape scheduling settings and the "is a run due?" math.
 *
 * The helpers here are pure so the schedule logic can be unit-tested without a
 * database — every function takes `now` explicitly rather than reading the
 * clock, which is also what keeps the tests from being time-of-day flaky.
 */

export type ScheduleMode = "interval" | "time_of_day";
export type ScrapeRunStatus = "succeeded" | "partial" | "failed";

export interface ScrapeSettings {
  auto_scrape_enabled: boolean;
  schedule_mode: ScheduleMode;
  /** Hours between runs in interval mode (1–168). */
  interval_hours: number;
  /** "HH:MM" local time in time_of_day mode. */
  time_of_day: string;
  /** Reels pulled per creator (1–200). */
  results_limit: number;
  /** Pause between creators during a run (0–300s). */
  stagger_seconds: number;
  scrape_research: boolean;
  scrape_roster: boolean;
  last_run_at: string | null;
  last_run_status: ScrapeRunStatus | null;
  last_run_summary: string | null;
  updated_at?: string;
}

export const DEFAULT_SCRAPE_SETTINGS: ScrapeSettings = {
  auto_scrape_enabled: false,
  schedule_mode: "interval",
  interval_hours: 12,
  time_of_day: "03:00",
  results_limit: 35,
  stagger_seconds: 5,
  scrape_research: true,
  scrape_roster: true,
  last_run_at: null,
  last_run_status: null,
  last_run_summary: null,
};

export const INTERVAL_MIN = 1;
export const INTERVAL_MAX = 168;
export const RESULTS_MIN = 1;
export const RESULTS_MAX = 200;
export const STAGGER_MIN = 0;
export const STAGGER_MAX = 300;

const HOUR_MS = 60 * 60 * 1000;

/** "HH:MM" → minutes past midnight, or null when malformed. */
export function parseTimeOfDay(value: string): number | null {
  const m = /^([01][0-9]|2[0-3]):([0-5][0-9])$/.exec(value.trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/**
 * When the next automatic run is due, or null when automation is off or the
 * schedule can't be resolved.
 *
 * Interval mode counts from the last completed run; with no run yet, a run is
 * due immediately. Time-of-day mode returns today's slot if it hasn't passed,
 * otherwise tomorrow's — and if the machine was asleep through today's slot,
 * that slot stays "due" until a run actually happens, so a missed window isn't
 * silently skipped.
 */
export function nextRunAt(settings: ScrapeSettings, now: Date = new Date()): Date | null {
  if (!settings.auto_scrape_enabled) return null;
  const last = settings.last_run_at ? new Date(settings.last_run_at) : null;
  const lastValid = last && !Number.isNaN(last.getTime()) ? last : null;

  if (settings.schedule_mode === "interval") {
    if (!lastValid) return now;
    return new Date(lastValid.getTime() + settings.interval_hours * HOUR_MS);
  }

  const minutes = parseTimeOfDay(settings.time_of_day);
  if (minutes == null) return null;

  const slotToday = new Date(now);
  slotToday.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);

  // Today's slot has passed but no run has happened since it — still due.
  if (slotToday <= now && (!lastValid || lastValid < slotToday)) return slotToday;
  if (slotToday > now) return slotToday;

  const tomorrow = new Date(slotToday);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return tomorrow;
}

/** Whether an automatic run should fire now. */
export function isRunDue(settings: ScrapeSettings, now: Date = new Date()): boolean {
  const next = nextRunAt(settings, now);
  return next != null && next <= now;
}

/** Human summary of the configured schedule, e.g. "every 12 hours". */
export function describeSchedule(settings: ScrapeSettings): string {
  if (settings.schedule_mode === "time_of_day") return `daily at ${settings.time_of_day}`;
  const h = settings.interval_hours;
  if (h === 24) return "every 24 hours (daily)";
  return `every ${h} hour${h === 1 ? "" : "s"}`;
}

/** Which creator kinds an automatic run covers, given the pool toggles. */
export function enabledKinds(settings: ScrapeSettings): ("research" | "roster")[] {
  const kinds: ("research" | "roster")[] = [];
  if (settings.scrape_research) kinds.push("research");
  if (settings.scrape_roster) kinds.push("roster");
  return kinds;
}

/**
 * Clamp a numeric form field into its allowed range.
 *
 * Guards the empty cases explicitly: `Number(null)` and `Number("")` are both
 * 0, not NaN, so a missing or blank field would otherwise clamp to the minimum
 * instead of keeping the current default.
 */
export function clampInt(raw: unknown, min: number, max: number, fallback: number): number {
  if (raw == null || (typeof raw === "string" && raw.trim() === "")) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
