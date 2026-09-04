import { createClient } from "@/lib/supabase/server";
import { getProfile } from "@/lib/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { readSettings } from "@/lib/scrape-queue";
import {
  INTERVAL_MAX, INTERVAL_MIN, RESULTS_MAX, RESULTS_MIN, STAGGER_MAX, STAGGER_MIN,
  describeSchedule, isRunDue, nextRunAt,
} from "@/lib/scrape-settings";
import { saveScrapeSettings } from "../scrape-actions";
import { assignCoach, removeCoach } from "../coach-actions";
import { listCoachTeams, listTeamCategories } from "@/lib/coach-team";
import { SubmitButton } from "@/components/submit-button";
import { ScrapeAllButton } from "@/components/scrape-all-button";
import { ScheduleFields } from "@/components/schedule-fields";
import { LaunchpointSync } from "@/components/launchpoint-sync";
import { NicheManager, type RenamePreview } from "@/components/niche-manager";
import { readLaunchpointStatus } from "../launchpoint-actions";
import { discordConfigured, listGuildChannels } from "@/lib/discord";
import { liveEmojiBases, planNicheChannelRenames, type LiveEmojiBase } from "@/lib/niche-channel-rename";
import {
  AlertIcon, Badge, Card, CardHead, ClockIcon, DiscordGlyph, Empty, Eyebrow, Field,
  GlassPanel, Lattice, PlusIcon, RefreshIcon, Rise, SlidersIcon, Stat, TagIcon, UsersIcon,
  agButton, agButtonIcon, agHint, agInput, agLabel, agRow, agTable, agTableWrap, agTd, agTh,
} from "@/components/glass";
import { formatDateTime } from "@/lib/format";
import { ALL_APPS } from "@/lib/workspace";
import { getWorkspace } from "@/lib/workspace/server";
import type { ResearchCreator } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The scrape console.
 *
 * Laid out on the blud material system (`src/components/glass.tsx`), ported
 * from folk-web's /admin. The rule that shapes this page: exactly ONE surface
 * floats. The hero is glass and carries the page's whole state — what we
 * track, what is queued, what is broken, and when the next run lands — because
 * those were four separate blocks all describing the same thing. Everything
 * below it sits flat on the canvas behind a single hairline.
 */
export default async function SettingsPage({
  searchParams,
}: {
  // A channel rename is previewed before it runs, and the pair being previewed
  // rides the URL so the confirm step is a plain reload rather than client
  // state — the plan the admin confirms is then recomputed from live Discord,
  // never from something the browser held onto.
  searchParams: Promise<{ renameFrom?: string; renameTo?: string; coach?: string }>;
}) {
  const { renameFrom, renameTo, coach: coachNotice } = await searchParams;
  const profile = await getProfile();
  const isAdmin = profile?.role === "admin";
  const supabase = await createClient();
  const admin = createAdminClient();
  const settings = await readSettings(admin);
  const [coachTeams, teamCategories] = isAdmin
    ? await Promise.all([listCoachTeams(admin), listTeamCategories(admin)])
    : [[], []];
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
  const launchpoint = await readLaunchpointStatus();

  const { data: nicheRows } = await supabase
    .from("research_niches")
    .select("id, name, emoji, discord_role_id::text, is_active")
    .order("name");
  const nicheList = ((nicheRows ?? []) as {
    id: string; name: string; emoji: string | null; discord_role_id: string | null; is_active: boolean;
  }[]).map((r) => ({
    id: r.id,
    name: r.name,
    emoji: r.emoji,
    discordRoleId: r.discord_role_id,
    isActive: r.is_active,
  }));

  const { data: nicheChannelRows } = await supabase
    .from("research_discord_channels")
    .select("niche");
  const channelCounts = new Map<string, number>();
  for (const r of (nicheChannelRows ?? []) as { niche: string | null }[]) {
    if (r.niche) channelCounts.set(r.niche, (channelCounts.get(r.niche) ?? 0) + 1);
  }

  // The emoji actually on live Discord channels, and whether a niche still
  // claims each one. Read from Discord rather than from nicheList on purpose:
  // the state that needs a control is the one where they disagree — an emoji
  // edited in the table above leaves its old channels behind, unclassifiable
  // and silently skipped by discover, and a control keyed on the niche's
  // stored emoji vanishes at exactly that moment.
  //
  // A Discord outage or an unset guild id must leave the rest of /settings
  // working, so failure degrades to an explicit "not reachable" note.
  let liveBases: LiveEmojiBase[] = [];
  let renamePreview: RenamePreview | null = null;
  let discordReachable = false;
  if (discordConfigured() && process.env.DISCORD_GUILD_ID) {
    try {
      const guildChannels = await listGuildChannels(process.env.DISCORD_GUILD_ID);
      discordReachable = true;
      liveBases = liveEmojiBases(guildChannels, nicheList);
      if (renameFrom && renameTo) {
        renamePreview = {
          fromEmoji: renameFrom,
          toEmoji: renameTo,
          steps: planNicheChannelRenames(guildChannels, renameFrom, renameTo),
        };
      }
    } catch {
      // discordReachable stays false; the manager says so instead of showing
      // an empty list that reads like "no channels have an emoji".
    }
  }

  const staleFirst = creators
    .filter((c) => settings.scrape_research || c.kind !== "research")
    .filter((c) => settings.scrape_roster || c.kind !== "roster")
    .slice(0, 10);

  return (
    // Full-bleed inside the app shell's padded <main>, so the console reads as
    // its own room rather than a card floating on the old canvas.
    <div className="ag -mx-8 -my-7 min-h-[100dvh] bg-[var(--ag-canvas)] px-8 pb-16 pt-7">
      <div className="mx-auto w-full max-w-[1280px] space-y-3">
        {/* ── The one floating surface ─────────────────────────────────── */}
        <Rise>
          <GlassPanel tone="thick" radius={30} innerClassName="p-4 sm:p-5">
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0">
                <Eyebrow>Console</Eyebrow>
                <h1 className="mt-2.5 text-[26px] font-semibold leading-[1.05] tracking-[-0.025em] text-[var(--ag-ink)]">
                  Settings
                </h1>
                <p className="mt-2 max-w-[58ch] text-[13px] leading-relaxed text-[var(--ag-ink-2)]">
                  How creator profiles get re-scraped. A scrape re-pulls recent reels and
                  their metrics for every creator, which is what keeps lift scores current.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Badge
                  status={settings.auto_scrape_enabled ? "Active" : "Paused"}
                  tone={settings.auto_scrape_enabled ? "positive" : "warn"}
                />
              </div>
            </div>

            {/* Four figures that belong to one another — a lattice, not four
                cards with gaps between them. */}
            <Lattice tone="inset" className="mt-5 grid-cols-2 lg:grid-cols-4">
              <div className="px-3.5 py-3">
                <Stat label="Creators tracked" value={creators.length} />
              </div>
              <div className="px-3.5 py-3">
                <Stat
                  label="Queued to scrape"
                  value={queued.length}
                  sub={queued.length ? "run in progress or paused" : undefined}
                />
              </div>
              <div className="px-3.5 py-3">
                <Stat label="Never scraped" value={neverScraped.length} />
              </div>
              <div className="px-3.5 py-3">
                <Stat label="Last scrape failed" value={failed.length} />
              </div>
            </Lattice>

            {/* Schedule state lives here rather than in its own card: it is the
                same subject as the figures above it. */}
            <dl className="mt-4 grid gap-x-8 gap-y-0 border-t border-[var(--ag-hairline)] pt-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field label="Schedule">{describeSchedule(settings)}</Field>
              <Field label="Next run">
                {settings.auto_scrape_enabled
                  ? due
                    ? "Due now"
                    : formatDateTime(next?.toISOString())
                  : "—"}
              </Field>
              <Field label="Last run">
                {settings.last_run_at ? formatDateTime(settings.last_run_at) : "Never"}
              </Field>
              {settings.last_run_summary ? (
                <Field label="Result">{settings.last_run_summary}</Field>
              ) : null}
            </dl>
          </GlassPanel>
        </Rise>

        {/* ── Configuration + manual run ───────────────────────────────── */}
        <div className="grid gap-3 lg:grid-cols-[1.55fr_1fr]">
          <Rise index={1}>
            <Card innerClassName="p-4 sm:p-5" className="h-full">
              <CardHead
                icon={<SlidersIcon className="h-[15px] w-[15px]" />}
                title="Scrape configuration"
                aside={
                  <span className="text-[11.5px] text-[var(--ag-ink-4)]">
                    Applied on the next scheduled run
                  </span>
                }
              />
              {!isAdmin ? (
                <div className="mt-4">
                  <Empty>Only admins can change scrape settings.</Empty>
                </div>
              ) : (
                <form action={saveScrapeSettings} className="mt-4 space-y-5">
                  <ScheduleFields settings={settings} />

                  <div className="space-y-3 border-t border-[var(--ag-hairline)] pt-5">
                    <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ag-ink-4)]">
                      Volume &amp; pacing
                    </p>
                    <div className="grid gap-4 sm:grid-cols-2">
                      <label className="block">
                        <span className={agLabel}>Reels per creator</span>
                        <input
                          type="number"
                          name="resultsLimit"
                          defaultValue={settings.results_limit}
                          min={RESULTS_MIN}
                          max={RESULTS_MAX}
                          className={`${agInput} mt-2 w-full`}
                        />
                        <span className={agHint}>
                          How many recent reels each scrape pulls ({RESULTS_MIN}–{RESULTS_MAX}).
                        </span>
                      </label>
                      <label className="block">
                        <span className={agLabel}>Pause between creators</span>
                        <input
                          type="number"
                          name="staggerSeconds"
                          defaultValue={settings.stagger_seconds}
                          min={STAGGER_MIN}
                          max={STAGGER_MAX}
                          className={`${agInput} mt-2 w-full`}
                        />
                        <span className={agHint}>
                          Seconds between creators. Scrape Creators bills per request and
                          Instagram rate-limits, so a full pass back-to-back is worth spacing out.
                        </span>
                      </label>
                    </div>
                  </div>

                  <fieldset className="space-y-3 border-t border-[var(--ag-hairline)] pt-5">
                    <legend className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--ag-ink-4)]">
                      Include
                    </legend>
                    <div className="flex flex-wrap gap-2">
                      <label className="ag-press ag-glass-thin inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-medium text-[var(--ag-ink-2)]">
                        <input
                          type="checkbox"
                          name="scrapeResearch"
                          defaultChecked={settings.scrape_research}
                          className="h-3.5 w-3.5 rounded-[4px] accent-[var(--ag-ink)]"
                        />
                        Research creators
                        <span className="tabular-nums text-[var(--ag-ink-4)]">{research.length}</span>
                      </label>
                      <label className="ag-press ag-glass-thin inline-flex cursor-pointer items-center gap-2 rounded-full px-3.5 py-2 text-[12.5px] font-medium text-[var(--ag-ink-2)]">
                        <input
                          type="checkbox"
                          name="scrapeRoster"
                          defaultChecked={settings.scrape_roster}
                          className="h-3.5 w-3.5 rounded-[4px] accent-[var(--ag-ink)]"
                        />
                        Our creators
                        <span className="tabular-nums text-[var(--ag-ink-4)]">{roster.length}</span>
                      </label>
                    </div>
                  </fieldset>

                  <div className="flex flex-wrap items-center gap-3 border-t border-[var(--ag-hairline)] pt-5">
                    <SubmitButton pendingLabel="Saving…" className={`group ${agButton}`}>
                      Save settings
                      <span className={agButtonIcon}>
                        <CheckGlyph />
                      </span>
                    </SubmitButton>
                    <p className="text-[11.5px] text-[var(--ag-ink-4)]">
                      Applies on the next run — this doesn&apos;t start a scrape.
                    </p>
                  </div>
                </form>
              )}
            </Card>
          </Rise>

          <Rise index={2}>
            <Card innerClassName="p-4 sm:p-5" className="h-full">
              <CardHead
                icon={<RefreshIcon className="h-[15px] w-[15px]" />}
                title="Run a scrape now"
              />
              <p className="mt-3 text-[12.5px] leading-relaxed text-[var(--ag-ink-3)]">
                Scrapes every creator in scope, one at a time, with the pause above between
                each. A full pass takes roughly a minute per creator, and doesn&apos;t change
                anything you have saved.
              </p>
              {isAdmin ? (
                <div className="mt-4 flex flex-col gap-2">
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
                </div>
              ) : (
                <div className="mt-4">
                  <Empty>Only admins can start a scrape.</Empty>
                </div>
              )}

              {settings.auto_scrape_enabled ? (
                <p className="mt-5 rounded-[14px] bg-[rgba(224,135,0,0.09)] px-3.5 py-3 text-[11.5px] leading-relaxed text-[#a86200]">
                  The schedule is live, but nothing fires it from this machine. Point a cron at{" "}
                  <code className="font-mono text-[11px]">POST /api/jobs/research</code> with{" "}
                  <code className="font-mono text-[11px]">{'{"action":"scrape-all"}'}</code> — it
                  honours everything above and skips runs that aren&apos;t due.
                </p>
              ) : null}
            </Card>
          </Rise>
        </div>

        {/* ── Niches ───────────────────────────────────────────────────── */}
        <Rise index={3}>
          <Card id="niches" innerClassName="p-4 sm:p-5">
            <CardHead
              icon={<TagIcon className="h-[15px] w-[15px]" />}
              title="Niches"
              aside={
                <span className="text-[11.5px] text-[var(--ag-ink-4)]">
                  {nicheList.filter((n) => n.isActive).length} active
                </span>
              }
            />
            <p className="mt-2 max-w-[86ch] text-[12.5px] leading-relaxed text-[var(--ag-ink-3)]">
              The track vocabulary: the emoji that prefixes a creator&apos;s channel, the niche
              written on their scripts, and the Discord role <code className="font-mono text-[12px]">/onboard</code> grants.
              The workers pick up a change within a minute — no restart.
            </p>
            <div className="mt-4">
              {!isAdmin ? (
                <Empty>Only admins can change niches.</Empty>
              ) : (
                <NicheManager
                  niches={nicheList}
                  channelCounts={channelCounts}
                  liveBases={liveBases}
                  discordReachable={discordReachable}
                  preview={renamePreview}
                />
              )}
            </div>
          </Card>
        </Rise>

        {/* ── Launchpoint ──────────────────────────────────────────────── */}
        <Rise index={4}>
          <Card innerClassName="p-4 sm:p-5">
            <CardHead
              icon={<ClockIcon className="h-[15px] w-[15px]" />}
              title="Launchpoint"
            />
            <p className="mt-2 max-w-[86ch] text-[12.5px] leading-relaxed text-[var(--ag-ink-3)]">
              First-party Instagram metrics — reach, saves, watch time and skip rate — plus daily
              view curves and payout cost. Runs on the hourly cron; this is the manual push.
            </p>
            <div className="mt-4">
              <LaunchpointSync status={launchpoint} />
            </div>
          </Card>
        </Rise>

        {/* ── Queue ────────────────────────────────────────────────────── */}
        <Rise index={5}>
          <Card innerClassName="p-4 sm:p-5">
            <CardHead
              icon={<UsersIcon className="h-[15px] w-[15px]" />}
              title="Oldest scrapes"
              aside={
                <span className="text-[11.5px] text-[var(--ag-ink-4)]">Next in line for a run</span>
              }
            />
            <div className="mt-4">
              {staleFirst.length === 0 ? (
                <Empty>No creators yet.</Empty>
              ) : (
                <div className={agTableWrap}>
                  <table className={agTable}>
                    <thead className="ag-thead">
                      <tr>
                        <th className={agTh}>Creator</th>
                        <th className={agTh}>Pool</th>
                        <th className={agTh}>Status</th>
                        <th className={agTh}>Last scraped</th>
                        <th className={agTh}>Queued</th>
                      </tr>
                    </thead>
                    <tbody>
                      {staleFirst.map((c) => (
                        <tr key={c.id} className={agRow}>
                          <td className={`${agTd} font-mono font-medium text-[var(--ag-ink)]`}>
                            @{c.handle}
                          </td>
                          <td className={agTd}>{c.kind === "research" ? "Research" : "Ours"}</td>
                          <td className={agTd}>
                            <Badge status={c.status} />
                            {c.status === "failed" && c.error_message ? (
                              <span className="ml-2 text-[11.5px] text-[var(--ag-red)]">
                                {c.error_message}
                              </span>
                            ) : null}
                          </td>
                          <td className={agTd}>
                            {c.last_scraped_at ? formatDateTime(c.last_scraped_at) : "Never"}
                          </td>
                          <td className={agTd}>
                            {c.scrape_queued_at ? (
                              <Badge status="Pending" />
                            ) : (
                              <span className="text-[var(--ag-ink-4)]">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </Card>
        </Rise>

        {/* ── Coaches ──────────────────────────────────────────────────── */}
        {isAdmin ? (
          <Rise index={6}>
            <Card id="coaches" innerClassName="p-4 sm:p-5">
              <CardHead
                icon={<DiscordGlyph className="h-[15px] w-[15px]" />}
                title="Coaches"
                aside={
                  <span className="text-[11.5px] text-[var(--ag-ink-4)]">
                    {coachTeams.length} with access
                  </span>
                }
              />
              <p className="mt-2 max-w-[86ch] text-[12.5px] leading-relaxed text-[var(--ag-ink-3)]">
                Coach accounts see one page, <code className="font-mono text-[12px]">/coach</code>,
                with their own team: the creators whose coaching channels sit in that Discord
                category. Not staff — nothing else in this app opens for them.
              </p>

              {coachNotice ? (
                <p className="mt-4 flex items-start gap-2 rounded-[14px] bg-[rgba(229,72,77,0.09)] px-3.5 py-3 text-[12.5px] leading-relaxed text-[#c2333c]">
                  <AlertIcon className="mt-[1px] h-4 w-4 shrink-0" />
                  {coachNotice}
                </p>
              ) : null}

              <div className="mt-4">
                {coachTeams.length === 0 ? (
                  <Empty>No coaches yet.</Empty>
                ) : (
                  <div className={agTableWrap}>
                    <table className={agTable}>
                      <thead className="ag-thead">
                        <tr>
                          <th className={agTh}>Coach</th>
                          <th className={agTh}>Team</th>
                          <th className={agTh}>Discord</th>
                          <th className={agTh} />
                        </tr>
                      </thead>
                      <tbody>
                        {coachTeams.map((c) => (
                          <tr key={c.profile_id} className={agRow}>
                            <td className={agTd}>
                              <span className="font-medium text-[var(--ag-ink)]">
                                {c.name || c.email}
                              </span>
                              {c.name ? (
                                <span className="ml-2 font-mono text-[11px] text-[var(--ag-ink-4)]">
                                  {c.email}
                                </span>
                              ) : null}
                              {c.role !== "coach" ? (
                                <span className="ml-2 text-[11.5px] text-[#a86200]">
                                  role is {c.role}
                                </span>
                              ) : null}
                            </td>
                            <td className={agTd}>{c.category}</td>
                            <td className={`${agTd} font-mono text-[11px] text-[var(--ag-ink-4)]`}>
                              {c.discord_user_id ?? "—"}
                            </td>
                            <td className={`${agTd} text-right`}>
                              <form action={removeCoach}>
                                <input type="hidden" name="profile_id" value={c.profile_id} />
                                <button className="ag-press text-[11.5px] text-[var(--ag-ink-4)] transition-colors hover:text-[var(--ag-red)]">
                                  Remove
                                </button>
                              </form>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>

              <form
                action={assignCoach}
                className="mt-5 grid gap-4 border-t border-[var(--ag-hairline)] pt-5 md:grid-cols-[1.2fr_1fr_0.9fr_auto] md:items-end"
              >
                <div>
                  <label htmlFor="coach-email" className={agLabel}>Email</label>
                  <input
                    id="coach-email"
                    name="email"
                    type="email"
                    required
                    placeholder="will@folk.com"
                    className={`${agInput} mt-2 w-full`}
                  />
                </div>
                <div>
                  <label htmlFor="coach-category" className={agLabel}>Team</label>
                  <select
                    id="coach-category"
                    name="category"
                    required
                    className={`${agInput} mt-2 w-full`}
                    defaultValue=""
                  >
                    <option value="" disabled>Pick a category…</option>
                    {teamCategories.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label htmlFor="coach-discord" className={agLabel}>
                    Discord id <span className="font-normal normal-case tracking-normal text-[var(--ag-ink-4)]">optional</span>
                  </label>
                  <input
                    id="coach-discord"
                    name="discord_user_id"
                    inputMode="numeric"
                    placeholder="snowflake"
                    className={`${agInput} mt-2 w-full font-mono`}
                  />
                </div>
                <SubmitButton pendingLabel="Adding…" className={`group ${agButton}`}>
                  Add coach
                  <span className={agButtonIcon}>
                    <PlusIcon className="h-3.5 w-3.5" />
                  </span>
                </SubmitButton>
              </form>
            </Card>
          </Rise>
        ) : null}
      </div>
    </div>
  );
}

/** The tick inside the save button's trailing circle. */
function CheckGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="h-3 w-3"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  );
}
