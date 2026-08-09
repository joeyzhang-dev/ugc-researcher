"use client";

import { useState } from "react";
import { INTERVAL_MAX, INTERVAL_MIN, type ScrapeSettings } from "@/lib/scrape-settings";
import { inputClass, labelClass } from "@/components/ui";

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
          className="mt-0.5 h-4 w-4 rounded border-hairline accent-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        />
        <span>
          <span className="block text-sm font-medium text-neutral-900">
            Scrape automatically
          </span>
          <span className="block text-xs text-neutral-400">
            Keeps every creator&apos;s reels and metrics fresh on a schedule.
          </span>
        </span>
      </label>

      <div
        className={`space-y-3 border-l-2 border-hairline pl-4 transition ${
          enabled ? "opacity-100" : "pointer-events-none opacity-40"
        }`}
      >
        <fieldset>
          <legend className={labelClass}>Schedule</legend>
          <div className="mt-1.5 flex flex-wrap gap-4">
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="radio"
                name="scheduleMode"
                value="interval"
                checked={mode === "interval"}
                onChange={() => setMode("interval")}
                className="h-4 w-4 border-hairline accent-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              />
              Every N hours
            </label>
            <label className="flex items-center gap-2 text-sm text-neutral-700">
              <input
                type="radio"
                name="scheduleMode"
                value="time_of_day"
                checked={mode === "time_of_day"}
                onChange={() => setMode("time_of_day")}
                className="h-4 w-4 border-hairline accent-neutral-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
              />
              At a time of day
            </label>
          </div>
        </fieldset>

        {mode === "interval" ? (
          <label className="block max-w-xs">
            <span className={labelClass}>Hours between runs</span>
            <input
              type="number"
              name="intervalHours"
              defaultValue={settings.interval_hours}
              min={INTERVAL_MIN}
              max={INTERVAL_MAX}
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-neutral-400">
              Counted from the end of the last run, so a laptop that was asleep just runs late
              rather than skipping.
            </span>
          </label>
        ) : (
          <label className="block max-w-xs">
            <span className={labelClass}>Run at</span>
            <input
              type="time"
              name="timeOfDay"
              defaultValue={settings.time_of_day}
              className={inputClass}
            />
            <span className="mt-1 block text-xs text-neutral-400">
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
