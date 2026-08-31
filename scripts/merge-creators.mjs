#!/usr/bin/env node
// Merge two research_creators rows that are the same person under different
// handles, then archive the one that loses.
//
//   node scripts/merge-creators.mjs --from dresdistrict --into morrismotivatesyou
//   node scripts/merge-creators.mjs --from dresdistrict --into morrismotivatesyou --apply
//
// --keep-videos leaves the losing row's posts behind. Use it when the two rows
// are DIFFERENT accounts belonging to one person rather than one account
// renamed — the posts are then genuinely separate feeds and must not be fused.
//
// Dry run by default: it prints every row it would move and every collision it
// would refuse to force, and changes nothing. Add --apply to write.
//
// Why this is a script and not a job: Launchpoint renames are reported, never
// merged automatically (see CLAUDE.md "Launchpoint"). Deciding which handle
// survives is a human call — the resolver's own rule for a too-close pair —
// and getting it wrong moves one creator's videos onto another creator's row.
//
// What it does NOT do: delete anything. The losing row keeps its identity and
// is archived, so the merge is reversible by hand if the wrong direction was
// picked.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = new URL("..", import.meta.url).pathname;
try {
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] ??= rest.join("=").trim().replace(/^"|"$/g, "");
  }
} catch {}

const SUPA = process.env.NEXT_PUBLIC_SUPABASE_URL;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPA || !KEY) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY (.env.local)");
  process.exit(1);
}

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const FROM = (argOf("--from") ?? "").replace(/^@/, "").toLowerCase();
const INTO = (argOf("--into") ?? "").replace(/^@/, "").toLowerCase();
const APPLY = args.includes("--apply");
// Leave the losing row's videos where they are.
//
// The merge was written for a RENAME, where both rows are the same account and
// the posts are the same person's feed. Noah-andre turned out not to be that
// (2026-08-31): @dresdistrict and @morrismotivatesyou are two live Instagram
// accounts with different account ids, 60,526 followers against 42, and zero
// shared shortcodes. His program work is on one of them; the other is his
// personal account. Moving those posts across would invent a feed that never
// existed and distort every average computed from it.
const KEEP_VIDEOS = args.includes("--keep-videos");

if (!FROM || !INTO) {
  console.error("usage: merge-creators.mjs --from <losing-handle> --into <surviving-handle> [--apply]");
  process.exit(1);
}
if (FROM === INTO) {
  console.error("--from and --into are the same handle");
  process.exit(1);
}

const headers = { apikey: KEY, Authorization: `Bearer ${KEY}` };
async function rest(path, init = {}) {
  const res = await fetch(`${SUPA}/rest/v1/${path}`, {
    ...init,
    headers: { ...headers, "Content-Type": "application/json", ...(init.headers || {}) },
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.status === 204 ? null : res.json();
}

const q = (v) => encodeURIComponent(v);

async function creatorByHandle(handle) {
  const rows = await rest(`research_creators?select=*&handle=eq.${q(handle)}`);
  if (rows.length === 0) throw new Error(`no creator with handle @${handle}`);
  if (rows.length > 1) {
    throw new Error(
      `@${handle} matches ${rows.length} rows (platforms: ${rows.map((r) => r.platform).join(", ")}) — this script merges one pair at a time`
    );
  }
  return rows[0];
}

/**
 * Tables that carry a creator id, and the column whose value must stay unique
 * within the surviving creator. A row whose `conflictOn` value already exists
 * on the winner cannot be moved — moving it would violate a unique constraint,
 * so it is reported and left behind rather than forced.
 */
/** Every entry may name its own primary key; `id` is only the common case. */
const LINKED = [
  ...(KEEP_VIDEOS ? [] : [{ table: "research_videos", conflictOn: "url", label: "videos" }]),
  { table: "research_app_creators", conflictOn: "app_id", label: "app memberships" },
  { table: "research_campaign_creators", conflictOn: "campaign_id", label: "campaign memberships" },
  { table: "research_script_assignments", conflictOn: "script_id", label: "script assignments" },
  { table: "research_creator_socials", conflictOn: "platform", label: "social links" },
  // No unique constraint on research_creator_id — every row moves.
  // Keyed on channel_id, not id — assuming `id` here failed mid-merge, after
  // the assignments had already moved.
  { table: "research_discord_channels", conflictOn: null, label: "discord channels", pk: "channel_id" },
  { table: "research_launchpoint_accounts", conflictOn: null, label: "launchpoint accounts" },
];

async function plan(loser, winner) {
  const moves = [];
  for (const link of LINKED) {
    // The primary key is selected AS TEXT, never via `select=*`.
    //
    // Discord ids are bigint snowflakes and JSON.parse turns them into IEEE
    // doubles, which silently rounds them: 1335356398049038400 came back as
    // …038300. That corrupted a creator's discord_user_id on write, and made
    // the channel PATCH filter match zero rows while still returning success,
    // so the script reported "moved 1 discord channels" and moved none.
    const pk = link.pk ?? "id";
    const mine = await rest(
      `${link.table}?select=*,${pk}::text&research_creator_id=eq.${q(loser.id)}`
    );
    if (mine.length === 0) {
      moves.push({ ...link, move: [], blocked: [] });
      continue;
    }
    let blocked = [];
    let move = mine;
    if (link.conflictOn) {
      const theirs = await rest(
        `${link.table}?select=${link.conflictOn}&research_creator_id=eq.${q(winner.id)}`
      );
      const taken = new Set(theirs.map((r) => r[link.conflictOn]));
      move = mine.filter((r) => !taken.has(r[link.conflictOn]));
      blocked = mine.filter((r) => taken.has(r[link.conflictOn]));
    }
    moves.push({ ...link, move, blocked });
  }
  return moves;
}

function describe(c) {
  return `@${c.handle} (${c.platform}, ${c.display_name ?? "no name"}, id ${c.id.slice(0, 8)}…)`;
}

let loser, winner;
try {
  loser = await creatorByHandle(FROM);
  winner = await creatorByHandle(INTO);
} catch (err) {
  // A mistyped handle is the common case; a stack trace helps nobody.
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}

console.log(`merging  ${describe(loser)}`);
console.log(`   into  ${describe(winner)}`);
console.log(APPLY ? "\nMODE: APPLY — this will write.\n" : "\nMODE: dry run — nothing will be written. Add --apply to write.\n");

// Sanity checks the operator should see before writing, not warnings buried in
// a log: a merge in the wrong direction is tedious to undo.
if (loser.launchpoint_creator_id && winner.launchpoint_creator_id &&
    loser.launchpoint_creator_id !== winner.launchpoint_creator_id) {
  console.log("⚠ both rows carry DIFFERENT Launchpoint contractor ids — these may not be the same person.");
}
if (!winner.launchpoint_creator_id && loser.launchpoint_creator_id) {
  console.log("⚠ the surviving row has no Launchpoint link but the losing one does — check the direction.");
}
if (winner.archived_at) console.log("⚠ the surviving row is currently archived.");

const moves = await plan(loser, winner);
let total = 0, totalBlocked = 0;
for (const m of moves) {
  total += m.move.length;
  totalBlocked += m.blocked.length;
  if (m.move.length || m.blocked.length) {
    const blocked = m.blocked.length ? `  (${m.blocked.length} left behind — ${m.conflictOn} already on the survivor)` : "";
    console.log(`  ${String(m.move.length).padStart(4)} ${m.label}${blocked}`);
  }
}
if (total === 0 && totalBlocked === 0) console.log("  (nothing linked to the losing row)");

// Identity the survivor is missing and the loser has. Discord id is uniquely
// indexed, so it must be cleared on the loser before it can land on the winner.
const carry = {};
if (!winner.discord_user_id && loser.discord_user_id) carry.discord_user_id = loser.discord_user_id;
if (!winner.discord_username && loser.discord_username) carry.discord_username = loser.discord_username;
if (!winner.display_name && loser.display_name) carry.display_name = loser.display_name;
if (!winner.launchpoint_creator_id && loser.launchpoint_creator_id) {
  carry.launchpoint_creator_id = loser.launchpoint_creator_id;
}
if (Object.keys(carry).length) {
  console.log(`\n  carry over to the survivor: ${Object.keys(carry).join(", ")}`);
}
console.log(`\n  then archive @${loser.handle} with reason "merged into @${winner.handle}"`);

if (!APPLY) {
  console.log("\ndry run complete — re-run with --apply to write.");
  process.exit(0);
}

// ---- write ----
for (const m of moves) {
  if (m.move.length === 0) continue;
  const pk = m.pk ?? "id";
  const ids = m.move.map((r) => r[pk]);
  // Chunked: a very long id list would overflow the URL.
  for (let i = 0; i < ids.length; i += 50) {
    const slice = ids.slice(i, i + 50);
    await rest(`${m.table}?${pk}=in.(${slice.map(q).join(",")})`, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ research_creator_id: winner.id }),
    });
  }
  console.log(`moved ${m.move.length} ${m.label}`);
}

// Re-read as text: `loser` came from `select=*`, so any snowflake on it has
// already been through a double and cannot be trusted for a write.
if (carry.discord_user_id) {
  const [exact] = await rest(
    `research_creators?select=discord_user_id::text&id=eq.${q(loser.id)}`
  );
  carry.discord_user_id = exact?.discord_user_id ?? carry.discord_user_id;
}

if (carry.discord_user_id) {
  // Clear first: research_creators_discord_user_idx is unique where not null.
  await rest(`research_creators?id=eq.${q(loser.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify({ discord_user_id: null }),
  });
}
if (Object.keys(carry).length) {
  await rest(`research_creators?id=eq.${q(winner.id)}`, {
    method: "PATCH",
    headers: { Prefer: "return=minimal" },
    body: JSON.stringify(carry),
  });
  console.log(`carried over: ${Object.keys(carry).join(", ")}`);
}

await rest(`research_creators?id=eq.${q(loser.id)}`, {
  method: "PATCH",
  headers: { Prefer: "return=minimal" },
  body: JSON.stringify({
    archived_at: new Date().toISOString(),
    archived_reason: `merged into @${winner.handle}`,
  }),
});
console.log(`archived @${loser.handle}`);
console.log(`\ndone. ${totalBlocked > 0 ? `${totalBlocked} row(s) stayed on the archived row — see above.` : ""}`);
