import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readSettings } from "@/lib/scrape-queue";
import {
  INTERVAL_MAX, INTERVAL_MIN, RESULTS_MAX, RESULTS_MIN, STAGGER_MAX, STAGGER_MIN,
  describeSchedule, isRunDue, nextRunAt,
} from "@/lib/scrape-settings";
import { saveScrapeSettings } from "../scrape-actions";
import { SubmitButton } from "@/components/submit-button";
import { ScrapeAllButton } from "@/components/scrape-all-button";
import { ScheduleFields } from "@/components/schedule-fields";
import {
  Card, EmptyState, KpiCard, PageHeader, StatusBadge,
  inputClass, labelClass, table, tableWrap, td, th, trHover,
} from "@/components/ui";
import { formatDateTime } from "@/lib/format";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";
import type { ResearchCreator } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Scraping settings: what gets pulled, how often, and a manual trigger. */
export default async function SettingsPage() {
  const profile = await getProfile();
  const isAdmin = profile?.role === "admin";
  const supabase = await createClient();
  const settings = await readSettings(createAdminClient());
  const workspace = await getWorkspace();
  const appFilter = workspace.current === ALL_APPS ? null : workspace.current;

  const { data: creatorsData } = await supabase
    .from("research_creators")
    .select("id, handle, kind, status, last_scraped_at, scrape_queued_at, error_message")
    .order("last_scraped_at", { ascending: true, nullsFirst: true });
  const creators = (creatorsData ?? []) as ResearchCreator[];

  const queued = creators.filter((c) => c.scrape_queued_at != null);
  const research = creators.filter((c) => c.kind === "research");
  const roster = creators.filter((c) => c.kind === "roster");
  const failed = creators.filter((c) => c.status === "failed");
  const neverScraped = creators.filter((c) => !c.last_scraped_at);

  const next = nextRunAt(settings);
  const due = isRunDue(settings);

  const staleFirst = creators
    .filter((c) => settings.scrape_research || c.kind !== "research")
    .filter((c) => settings.scrape_roster || c.kind !== "roster")
    .slice(0, 10);

  return (
    <>
      <PageHeader title="Settings" />
      <p className="-mt-4 mb-5 max-w-3xl text-sm text-neutral-500">
        How creator profiles get re-scraped. A scrape re-pulls recent reels and their metrics for
        every creator, which is what keeps lift scores current.
      </p>

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Creators tracked" value={String(creators.length)} icon="users" />
        <KpiCard
          label="Queued to scrape"
          value={String(queued.length)}
          sub={queued.length ? "run in progress or paused" : undefined}
          icon="clock"
          tone={queued.length ? "amber" : "neutral"}
        />
        <KpiCard
          label="Never scraped"
          value={String(neverScraped.length)}
          icon="alert"
          tone={neverScraped.length ? "amber" : "neutral"}
        />
        <KpiCard
          label="Last scrape failed"
          value={String(failed.length)}
          icon="alert"
          tone={failed.length ? "red" : "neutral"}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <Card title="Scrape schedule">
          {!isAdmin ? (
            <EmptyState message="Only admins can change scrape settings." />
          ) : (
            <form action={saveScrapeSettings} className="space-y-4">
              <ScheduleFields settings={settings} />

              <div className="grid gap-3 sm:grid-cols-2">
                <label>
                  <span className={labelClass}>Reels per creator</span>
                  <input
                    type="number"
                    name="resultsLimit"
                    defaultValue={settings.results_limit}
                    min={RESULTS_MIN}
                    max={RESULTS_MAX}
                    className={inputClass}
                  />
                  <span className="mt-1 block text-xs text-neutral-400">
                    How many recent reels each scrape pulls ({RESULTS_MIN}–{RESULTS_MAX}).
                  </span>
                </label>
                <label>
                  <span className={labelClass}>Pause between creators</span>
                  <input
                    type="number"
                    name="staggerSeconds"
                    defaultValue={settings.stagger_seconds}
                    min={STAGGER_MIN}
                    max={STAGGER_MAX}
                    className={inputClass}
                  />
                  <span className="mt-1 block text-xs text-neutral-400">
                    Seconds to wait between creators. Apify bills per run and Instagram
                    rate-limits, so a full pass back-to-back is worth spacing out.
                  </span>
                </label>
              </div>

              <fieldset>
                <legend className={labelClass}>Include</legend>
                <div className="mt-1 flex flex-wrap gap-4">
                  <label className="flex items-center gap-2 text-sm text-neutral-700">
                    <input
                      type="checkbox"
                      name="scrapeResearch"
                      defaultChecked={settings.scrape_research}
                      className="h-4 w-4 rounded border-neutral-300"
                    />
                    Research creators ({research.length})
                  </label>
                  <label className="flex items-center gap-2 text-sm text-neutral-700">
                    <input
                      type="checkbox"
                      name="scrapeRoster"
                      defaultChecked={settings.scrape_roster}
                      className="h-4 w-4 rounded border-neutral-300"
                    />
                    Our creators ({roster.length})
                  </label>
                </div>
              </fieldset>

              <SubmitButton pendingLabel="Saving…">Save settings</SubmitButton>
            </form>
          )}
        </Card>

        <div className="space-y-4">
          <Card title="Run now">
            <div className="space-y-3">
              <p className="text-sm text-neutral-500">
                Scrapes every creator in scope, one at a time, with the pause above between each.
                A full pass takes roughly a minute per creator.
              </p>
              {isAdmin ? (
                <>
                  <ScrapeAllButton
                    kinds={["research", "roster"]}
                    queued={queued.length}
                    label="Scrape everything"
                  />
                  <ScrapeAllButton
                    kinds={["roster"]}
                    appId={appFilter}
                    label={
                      appFilter
                        ? `Scrape ${workspace.app?.name ?? "this workspace"} only`
                        : "Scrape our creators only"
                    }
                  />
                </>
              ) : (
                <EmptyState message="Only admins can start a scrape." />
              )}
            </div>
          </Card>

          <Card title="Status">
            <dl className="space-y-2 text-sm">
              <Row label="Automatic scraping">
                <StatusBadge
                  status={settings.auto_scrape_enabled ? "Active" : "Paused"}
                />
              </Row>
              <Row label="Schedule">{describeSchedule(settings)}</Row>
              <Row label="Next run">
                {settings.auto_scrape_enabled
                  ? due
                    ? "Due now"
                    : formatDateTime(next?.toISOString())
                  : "—"}
              </Row>
              <Row label="Last run">
                {settings.last_run_at ? formatDateTime(settings.last_run_at) : "Never"}
              </Row>
              {settings.last_run_summary && (
                <Row label="Result">{settings.last_run_summary}</Row>
              )}
            </dl>

            {settings.auto_scrape_enabled && (
              <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-800">
                This app only runs on your machine, so nothing fires the schedule on its own yet.
                The settings are saved and the schedule is live — point a cron or launchd job at{" "}
                <code className="font-mono">POST /api/jobs/research</code> with{" "}
                <code className="font-mono">{'{"action":"scrape-all"}'}</code> and it will honour
                everything above, skipping runs that aren&apos;t due.
              </p>
            )}
          </Card>
        </div>
      </div>

      <div className="mt-5">
        <Card
          title="Oldest scrapes"
          action={<span className="text-xs text-neutral-400">Next in line for a run</span>}
        >
          {staleFirst.length === 0 ? (
            <EmptyState message="No creators yet." />
          ) : (
            <div className={tableWrap}>
              <table className={table}>
                <thead>
                  <tr>
                    <th className={th}>Creator</th>
                    <th className={th}>Pool</th>
                    <th className={th}>Status</th>
                    <th className={th}>Last scraped</th>
                    <th className={th}>Queued</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {staleFirst.map((c) => (
                    <tr key={c.id} className={trHover}>
                      <td className={`${td} font-medium`}>@{c.handle}</td>
                      <td className={td}>
                        <span className="text-neutral-500">
                          {c.kind === "research" ? "Research" : "Ours"}
                        </span>
                      </td>
                      <td className={td}>
                        <StatusBadge status={c.status} />
                        {c.status === "failed" && c.error_message && (
                          <span className="ml-2 text-xs text-red-600">{c.error_message}</span>
                        )}
                      </td>
                      <td className={td}>
                        {c.last_scraped_at ? formatDateTime(c.last_scraped_at) : "Never"}
                      </td>
                      <td className={td}>
                        {c.scrape_queued_at ? (
                          <StatusBadge status="Pending" />
                        ) : (
                          <span className="text-neutral-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-neutral-500">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-neutral-900">{children}</dd>
    </div>
  );
}
