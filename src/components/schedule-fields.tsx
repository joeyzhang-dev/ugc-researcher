"use client";

import { useState } from "react";
import { INTERVAL_MAX, INTERVAL_MIN, type ScrapeSettings } from "@/lib/scrape-settings";
import { agHint, agInput, agLabel } from "@/components/glass";

/**
 * Automatic-scrape toggle plus the schedule inputs. Client-side only so the
 * irrelevant mode's fields can collapse as you switch; both are still submitted
 * with the same form so the unused mode keeps its stored value.
 */
export function ScheduleFields({ settings }: { settings: ScrapeSettings }) {
  const [enabled, setEnabled] = useState(settings.auto_scrape_enabled);
  const [mode, setMode] = useState(settings.schedule_mode);

  return (
    <div className="space-y-4">
      <label className="flex items-start gap-2.5">
        <input
          type="checkbox"
          name="autoScrape"
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
          className="mt-[3px] h-3.5 w-3.5 rounded-[4px] accent-[var(--ag-ink)]"
        />
        <span>
          <span className="block text-[13.5px] font-medium text-[var(--ag-ink)]">
            Scrape automatically
          </span>
          <span className="mt-0.5 block text-[11.5px] text-[var(--ag-ink-4)]">
            Keeps every creator&apos;s reels and metrics fresh on a schedule.
          </span>
        </span>
      </label>

      <div
        className={`space-y-4 border-l border-[var(--ag-hairline)] pl-4 transition-opacity duration-[260ms] ease-[cubic-bezier(0.32,0.72,0,1)] ${
          enabled ? "opacity-100" : "pointer-events-none opacity-40"
        }`}
      >
        <fieldset>
          <legend className={agLabel}>Schedule</legend>
          <div className="mt-2 flex flex-wrap gap-2">
            <label className="ag-press ag-glass-thin inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-medium text-[var(--ag-ink-2)]">
              <input
                type="radio"
                name="scheduleMode"
                value="interval"
                checked={mode === "interval"}
                onChange={() => setMode("interval")}
                className="h-3.5 w-3.5 accent-[var(--ag-ink)]"
              />
              Every N hours
            </label>
            <label className="ag-press ag-glass-thin inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-medium text-[var(--ag-ink-2)]">
              <input
                type="radio"
                name="scheduleMode"
                value="time_of_day"
                checked={mode === "time_of_day"}
                onChange={() => setMode("time_of_day")}
                className="h-3.5 w-3.5 accent-[var(--ag-ink)]"
              />
              At a time of day
            </label>
          </div>
        </fieldset>

        {mode === "interval" ? (
          <label className="block max-w-xs">
            <span className={agLabel}>Hours between runs</span>
            <input
              type="number"
              name="intervalHours"
              defaultValue={settings.interval_hours}
              min={INTERVAL_MIN}
              max={INTERVAL_MAX}
              className={`${agInput} mt-2`}
            />
            <span className={agHint}>
              Counted from the end of the last run, so a laptop that was asleep just runs late
              rather than skipping.
            </span>
          </label>
        ) : (
          <label className="block max-w-xs">
            <span className={agLabel}>Run at</span>
            <input
              type="time"
              name="timeOfDay"
              defaultValue={settings.time_of_day}
              className={`${agInput} mt-2`}
            />
            <span className={agHint}>
              Local time. A slot missed while the machine was off stays due until it actually
              runs.
            </span>
          </label>
        )}

        {/* Preserve the hidden mode's stored value so switching back doesn't
            silently reset it to the column default. */}
        {mode === "interval" ? (
          <input type="hidden" name="timeOfDay" value={settings.time_of_day} />
        ) : (
          <input type="hidden" name="intervalHours" value={settings.interval_hours} />
        )}
      </div>
    </div>
  );
}
