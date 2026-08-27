# Launchpoint work log — what changed, why, and what it does in practice

_For Joey. Running summary of the Launchpoint-powered changes, newest first.
The API itself (every endpoint, what's replaceable, what to ask the LP team
for) is mapped separately in [launchpoint-api.md](./launchpoint-api.md)._

The goal, in your words: don't replace Launchpoint — use its API as the data
source and make the internal tool the place where creators are actually
managed. "I constantly have to go to their IG, look at their posts, check
who's posting who isn't, how scripts performed."

---

## 2026-08-28 — Script matching: diagnosis of the 883 open assignments

Before building anything for "how scripts performed", we measured what
actually stands between the current 33% match coverage (428 of 1,311
assignments linked) and better. Ran the repo's own scorer over every open
assignment. Result — **the pipeline is fine; the gap is real behavior**:

| Count | Bucket | Meaning |
| --- | --- | --- |
| 441 (50%) | Transcribed posts exist in the window, **none resembles the script** (<0.25) | Creator got the script and posted something else — the honest "script wasn't used" signal |
| 171 (19%) | Creator posted **nothing** in the window | Genuinely didn't deliver |
| 147 (17%) | Sitting in **/scripts/review** (92 low-confidence, 48 contested, 7 backdated) | The only human-actionable backlog — each needs one click |
| 124 (14%) | Every window post **already claimed** by another script | Over-assignment: more scripts handed out than posts made |
| 0 | Blocked on transcription | The requeue mechanism works — nothing is stuck in the queue |

Read: **~70% of handed-out scripts never became a post.** That is not a
matching bug, it's the delivery-rate picture Joey has been checking Instagram
by hand to see — just at the script level.

**Cheapest coverage win available today:** click through the 147 pairs in
`/scripts/review`. No code needed.

**Proposed next build — "Script delivery":** per-creator "scripts received →
posts delivered" on the roster, per-script "closed vs went stale" on the
script page, and (product decision needed) an auto-`Expired` status for
assignments older than N days with no post, so the open count stops growing
forever.

---

## 2026-08-28 — "Who's posting, who isn't" (branch `launchpoint-account-stats`)

### What was added

**1. The sync now keeps the per-account activity data it was throwing away.**
The hourly sync already fetched `/analytics/accounts` (for the creators +
socials phases) but only used the identity fields. The payload also carries,
per tracked handle: **last post date**, total posts/views/likes/comments/
shares, engagement rate, average views per post, **earnings, cpm**, paid/
unpaid post counts. All of that now lands in a new table,
`research_launchpoint_accounts` (one row per platform+handle, upserted every
tick), via a new `accounts` sync phase. **Zero extra API calls** — it shares
the accounts fetch that already happens.

- Live numbers from the first run: **106 accounts stored, 54 linked to
  creator rows** (the unlinked rest is TikTok, by design — we only create
  Instagram creator rows).
- Migration `20260827120000_launchpoint_accounts.sql`, applied to
  bludgc-research.

**2. The "Needs attention" card on /overview now tells the truth about
TikTok.** `staleCreators` merges Launchpoint's freshest last-post date per
*person* (joined `contractor_id` ↔ `launchpoint_creator_id`, so any of the
person's accounts counts) with the video-derived date — freshest wins. Before
this, "quiet" meant "no *Instagram* post we ingested": someone posting on
TikTok all week still showed up as needing a nudge, because TikTok posts are
never ingested as videos at all.

**3. /creators shows "Last post: date · platform" in each row's fold-out.**
Next to "Last scraped". This didn't exist in any form — the roster only knew
when *we* last scraped someone, not when *they* last posted. The platform
label matters: it can say `tiktok` even though the app tracks no TikTok
posts, because Launchpoint sees the whole person.

**4. The /settings Launchpoint widget now shows all seven phases.** It listed
four (creators, posts, insights, history); `socials` and your new `discord`
phase were running invisibly, and `accounts` joined them. Now every phase has
its status row.

### What it did in practice, day one

- **It already cleared a false "quiet" creator.** `@notamrinn` sat in the
  nudge list as "never posted" — Launchpoint knows that person posted
  *yesterday* from `@amrinrants` (their working handle). One less Instagram
  profile to go check by hand. The remaining 37 in the list are genuinely
  quiet.
- The effect is deliberately small on Instagram — IG posts already flow in
  hourly through the posts sync, so IG recency was mostly right. The merge
  pays off exactly where the old signal was blind: TikTok-only activity,
  posts that haven't synced yet, and renamed/unmatched handles like Amrin's.
- The stored earnings/engagement/cpm per handle aren't surfaced anywhere yet
  — they're in the table waiting for a roster view that wants them (e.g. a
  "views per post vs what we pay them" column).

### Ops notes

- The `accounts` phase is **non-fatal**: if the table is missing (code
  deployed before the migration), the sync records the failure and the
  posts/insights/history phases still run.
- Found and fixed along the way: local `.env.local` pointed at the **old
  shared Supabase project** — the standalone fork lives at
  `yvbvcblqjlfhhvatijng` (bludgc-research). Anyone whose local env predates
  the 08-26 cutover has the same problem; the Management API token is the
  tell (403 on every query).

---

## Context: what was already built (for completeness)

- **08-26 (Joey):** the integration itself — client with server-driven rate
  limiting, four-phase sync (creators, posts, insights, history) inside the
  hourly cron. Posts join on Instagram shortcode; first-party retention
  (reach, saves, watch time, skip rate) overwrites scraped counts; daily
  metric curves stored per post. Standalone Supabase fork.
- **08-27 (Joey):** `socials` phase (every handle per person, the only source
  of TikTok handles) and the `discord` phase — channels auto-link to creators
  through Launchpoint contractor names instead of a hand-typed dict.

## Where this is going (agreed plan)

1. ~~Who's posting, who isn't~~ — **done, this entry.**
2. ~~Discord auto-linking~~ — **done by Joey (discord phase).**
3. **Script performance** — next: the script page shows the posts it
   produced with their views + retention. Matching already exists; retention
   already syncs; they just aren't joined on one screen.
4. Contracts + payouts visibility — waiting until contracts go live on the
   LP account (today `GET /creators` and `/contracts` answer `total: 0`).
5. Asks for the Launchpoint team: Discord ids on creators, follower counts,
   media/CDN URLs on posts, 400/min partner rate limit. Each one retires a
   piece of Scrape Creators.
