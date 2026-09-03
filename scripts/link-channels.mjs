#!/usr/bin/env node
/**
 * Link a Discord channel to a roster creator, the way /link does.
 *
 * Refuses to overwrite an existing link: a human link must survive, and
 * cmd_discover already treats a stored link as authoritative over its own
 * name-matching.
 *
 * Usage: node scripts/link-channels.mjs "🌱lucas-graham=lucasisdialed" ...
 */
import { readFileSync } from "node:fs";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
    })
);
const URL_BASE = `${env.NEXT_PUBLIC_SUPABASE_URL}/rest/v1`;
const H = {
  apikey: env.SUPABASE_SERVICE_ROLE_KEY,
  Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
  "Content-Type": "application/json",
};

const pairs = process.argv.slice(2).map((a) => {
  const [channelName, handle] = a.split("=");
  return { channelName, handle };
});
if (!pairs.length) {
  console.error("usage: node scripts/link-channels.mjs '<channel>=<handle>' ...");
  process.exit(1);
}

for (const { channelName, handle } of pairs) {
  const creators = await (
    await fetch(`${URL_BASE}/research_creators?select=id,handle&handle=eq.${encodeURIComponent(handle)}`, { headers: H })
  ).json();
  if (creators.length !== 1) {
    console.log(`skip ${channelName}: ${creators.length} creators match @${handle}`);
    continue;
  }
  // channel_name is text, so no snowflake casting is needed for the filter —
  // but the PATCH must not touch a channel someone already linked.
  const res = await fetch(
    `${URL_BASE}/research_discord_channels?channel_name=eq.${encodeURIComponent(channelName)}&research_creator_id=is.null`,
    {
      method: "PATCH",
      headers: { ...H, Prefer: "return=representation" },
      body: JSON.stringify({ research_creator_id: creators[0].id }),
    }
  );
  const updated = await res.json();
  console.log(`${channelName} -> @${handle}: ${updated.length} row(s) updated`);
}
