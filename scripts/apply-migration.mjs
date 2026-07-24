#!/usr/bin/env node
// Apply a SQL migration to the Supabase project via the Management API and
// record it in supabase_migrations.schema_migrations — no supabase CLI needed.
//
//   node scripts/apply-migration.mjs supabase/migrations/20260723120000_add_x.sql
//
// Reads NEXT_PUBLIC_SUPABASE_URL (for the project ref) and
// SUPABASE_ACCESS_TOKEN from .env.local. The version recorded is the leading
// numeric chunk of the filename. NOTE: this project shares its database with
// trace-ugc-tracker (which owns versions 0001–0044+), so new migrations here
// MUST use timestamp versions (YYYYMMDDHHMMSS) to never collide with the
// tracker's sequence. 0001_research.sql is a mirror of the tracker's already
// applied 0027 — reference only, never apply it.

import { readFileSync } from "node:fs";
import { basename, resolve } from "node:path";

const file = process.argv[2];
if (!file) {
  console.error("usage: node scripts/apply-migration.mjs <path-to-sql-file>");
  process.exit(1);
}

// .env.local loader (same zero-config pattern as the worker).
const root = new URL("..", import.meta.url).pathname;
try {
  for (const line of readFileSync(resolve(root, ".env.local"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [key, ...rest] = trimmed.split("=");
    process.env[key.trim()] ??= rest.join("=").trim().replace(/^"|"$/g, "");
  }
} catch {}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const token = process.env.SUPABASE_ACCESS_TOKEN;
if (!url || !token) {
  console.error("missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_ACCESS_TOKEN (.env.local)");
  process.exit(1);
}
const ref = new URL(url).hostname.split(".")[0];

const name = basename(file);
const versionMatch = name.match(/^(\d+)/);
if (!versionMatch) {
  console.error(`cannot derive a version from "${name}" — filename must start with digits`);
  process.exit(1);
}
const version = versionMatch[1];
if (version.length < 14 && name !== "0001_research.sql") {
  console.error(
    `refusing "${name}": short numeric versions collide with trace-ugc-tracker's ` +
      "migration sequence in the shared database. Use YYYYMMDDHHMMSS_name.sql."
  );
  process.exit(1);
}
if (name === "0001_research.sql") {
  console.error("0001_research.sql mirrors the tracker's applied 0027 — never re-apply it.");
  process.exit(1);
}

async function query(sql) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  return res.json();
}

const applied = await query(
  `select 1 from supabase_migrations.schema_migrations where version = '${version}'`
);
if (Array.isArray(applied) && applied.length > 0) {
  console.log(`${name}: version ${version} already recorded — nothing to do`);
  process.exit(0);
}

console.log(`applying ${name} to project ${ref} ...`);
await query(readFileSync(file, "utf8"));
await query(
  `insert into supabase_migrations.schema_migrations (version, name) values ('${version}', '${name.replace(/'/g, "''")}')`
);
console.log(`✓ applied and recorded as version ${version}`);
