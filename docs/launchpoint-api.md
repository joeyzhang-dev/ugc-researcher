# Launchpoint API — what it is, what it can replace, and what it can't

_Written 2026-08-27, against Launchpoint Public API v1 (private preview).
Full docs: `docs.launchpointhq.com` (`/llms.txt` for the page index,
`/api-reference/openapi.json` for the spec)._

## Context

Launchpoint (`launchpointhq.com`) is the platform the Folk creator program
actually runs on: contracts, payouts, content review, and post tracking.
Creators authorize their own Instagram accounts to it, so it holds
**first-party metrics a public scrape can never see** — reach, saves, watch
time, skip rate. Joey got us a developer key (`LAUNCHPOINT_API_KEY`).

**The goal (Joey, 2026-08-26): use both.** Launchpoint stays the platform;
this repo becomes the internal management layer on top of its API — easier
creator management, "who's posting, who isn't", how scripts performed,
creators fully synced to their Discord channels and usernames. We are NOT
replacing Launchpoint itself, and we can't fully replace Scrape Creators
either (see the gaps section).

- Base: `https://dashboard.launchpointhq.com/api/v1`, auth header `x-api-key`
- Rate limit: **100 req/min** (fixed window, absolute `x-ratelimit-reset`;
  400/min for approved partners — worth asking for)
- Every response enveloped as `{ data, page?, total?, totalPages? }`
- Timestamps are Unix **milliseconds**
- Read-only key usage by policy in this repo; the two write routes we allow
  ourselves to know about (`POST /posts/export`, `POST /programs/{id}/invite`,
  `POST /messages`) are deliberately absent from `src/lib/launchpoint.ts`

## Full API surface (v1)

| Endpoint | What it returns |
| --- | --- |
| `GET /posts` | Every tracked post, 25–500/page: url, platform, thumbnail, views/likes/comments/shares, **earnings + paid**, contractor, uploadedAt. **In use** (posts sync). |
| `GET /posts/{id}` | One post, richer: description, bookmarks, engagementRate, contract + program + creatorInfo objects, bonuses, lastPaidAt, lastSyncedAt. |
| `GET /posts/{id}/insights` | **First-party IG metrics**: reach, saves, total/avg watch time, skip rate. `status: "no_data"` for non-IG. **In use** (insights sync). |
| `GET /posts/{id}/metrics-history` | Daily snapshots (views/likes/comments/shares/bookmarks + deltas), ~10–31 points per post. **In use** (history sync). |
| `POST /posts/export` | CSV export (creates a file — write route, unused). |
| `GET /analytics/accounts` | Every tracked handle → contractor id/name, totals (posts, views, likes, engagement, earnings, cpm), ghost-handle flag, first/last post date. **In use** (creators + socials sync). |
| `GET /analytics/videos` | Tracked videos with sort/filter (program, platform, creator, date range, minViews, paid) + a summary block. Overlaps `/posts` but adds bookmarks, engagementRate, cpm and server-side filtering. |
| `GET /analytics/kpis` | Program/contract/post/creator counts at a glance. |
| `GET /analytics/overview` | Totals + snapshot deltas, top posts, top creators, platform breakdown. |
| `GET /analytics/leaderboard` | Per-program creator leaderboard; groups cross-posted copies into source videos. |
| `GET /analytics/recruitment` | Daily invite/response outreach counts. |
| `GET /creators` | Creator directory: name, **phone**, profile image, active/inactive, campaigns → contract status + **handles per platform**. Searchable. (Answers `total: 0` on our account today — contracts unused so far; re-check after contracts go live.) |
| `GET /creators/{id}/audience` | **Audience demographics** per handle: countries (US %), ages, genders, cities, sample size. Nothing else we use has this. |
| `GET /creators/collections` | Named creator groups (id, color, creatorIds). |
| `GET /contracts` | Contracts: status lifecycle (pending/active/completed/declined/cancelled), payment type/schedule, platform+handle, start/expiry. |
| `GET /pay-structures` | Per-contract pay model: base rate, CPM/CPC cents, view cap, min threshold, max earnable, platform ratios. |
| `GET /payouts` · `/payouts/stats` · `/payouts/pending` | Wallet activity, statistics, and pending payouts (due dates, overdue flags, delivered vs required posts, Stripe readiness). |
| `GET /conversations` · `GET /conversations/{id}/messages` | Launchpoint's in-app creator DMs (read). |
| `POST /messages` | Send a creator message (write route, unused). |
| `GET /programs` · `POST /programs/{id}/invite` | Program list; create an invite link (write route, unused). |

## What Scrape Creators does today, and what Launchpoint replaces

Every remaining `api.scrapecreators.com` call site, and the verdict:

| Use | Where | Replaceable? |
| --- | --- | --- |
| Post discovery + public metrics for **roster** creators | `src/lib/jobs/research.ts` via `scrapecreators.ts` | **Yes — already replaced.** The posts sync ingests every Launchpoint-tracked post (with earnings), and insights overwrite scraped counts with fresher first-party ones. Scraping remains only a fallback and the sole source of captions + follower counts. |
| Post discovery for **research** creators (outside the campaign) | same | **No.** The API is company-scoped: only our program's creators and posts exist in it. This is the one feature Joey already called out as irreplaceable. |
| Profile scrape: **follower counts**, bio, display name | same | **No.** No endpoint returns follower counts — `/analytics/accounts` has post/view totals only. Keep scraping for follower-based lift math. |
| **Media download URL** for transcription | `worker/transcribe_worker.py` (fallback after yt-dlp) | **No.** The platform downloads videos internally but the public API exposes only `thumbnail` — no media file or CDN URL on any route. |
| Inspo video fetch by URL (script cards, web + bot) | `src/lib/inspo-media.ts`, `worker/discord_bot/script_pager.py` | **No.** Inspo posts are arbitrary (mostly outside creators), and there's no lookup-by-URL route anyway. |

So the split is clean: **Launchpoint owns everything about our own
campaign's posts and people; Scrape Creators keeps outside-creator research,
follower counts, and media bytes.**

## Already integrated (2026-08-26)

`src/lib/launchpoint.ts` (client: fixed-window rate limiter driven by the
server's own headers, retry with reset hints) + `src/lib/jobs/launchpoint.ts`
(four-phase budget-bounded sync: creators → socials → posts → insights +
history), running inside the hourly Vercel cron. Join key is the Instagram
shortcode; renames are reported, never auto-merged. See the **Launchpoint**
section of `CLAUDE.md` for the operational footguns.

## Not yet used — the "manage creators from our tool" backlog

Ordered by how directly each serves Joey's stated goals:

1. **"Who's posting, who isn't"** — `/analytics/accounts` already carries
   `lastPostDate`, `engagementRate`, `averageViewsPerPost`, earnings and cpm
   per handle; we currently persist only identity fields. Surfacing the rest
   on the roster gives the inactivity view with zero extra API calls.
2. **Contract + payout visibility** — `/contracts`, `/payouts/pending`
   (delivered vs required posts, overdue flags, Stripe readiness),
   `/pay-structures`. Would put "is this creator paid up / delivering" next
   to their scripts and posts.
3. **Discord auto-linking** — the API has no Discord ids (see gaps), but
   contractor names are already the source of channel names
   (`✝️first-last`), and handles come per contractor. Matching
   `contractorName` against channel names could auto-bind
   channel ↔ creator ↔ handles, replacing most manual `/link` usage.
4. **Audience demographics** — `/creators/{id}/audience` (US %, ages,
   genders) is a capability nothing else gives us; useful for script
   targeting and brand reporting.
5. **Onboarding** — `POST /programs/{id}/invite` could let the bot's
   `/onboard` hand out a program invite link in the same message.
6. **Messaging** — `/conversations` + `POST /messages` reach creators who
   ignore Discord. Write route; needs a deliberate decision before use.
7. **Dashboard numbers** — `/analytics/overview`, `/kpis`, `/leaderboard`
   could back `/overview` tiles without recomputing from our own tables
   (leaderboard's cross-post grouping is something we don't model at all).

## Gaps — what to ask the Launchpoint team for

- **Discord ids on creators.** Joey believes they can provide them; the
  current `/creators` response has phone + social handles but nothing
  Discord. This would make creator ↔ Discord sync exact instead of
  name-matched.
- **Follower counts** per tracked account (they must have them for
  authorized accounts) — would end profile scraping for roster creators.
- **Media/CDN URLs** on posts — they already download videos; exposing the
  file would end Scrape Creators + yt-dlp for roster post transcription.
- **Partner rate limit** (400/min) — the insights/history backfill is
  rate-limit-bound at 100/min.
- Post **captions** in `/posts` (`title` is the concept name, mostly
  "Open-ended") — captions currently come only from scrapes.
