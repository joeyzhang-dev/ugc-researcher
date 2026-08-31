/**
 * The weekly recap as a rendered graphic.
 *
 * The text digest hit a wall that no amount of markdown fixes: sixteen
 * creators × five facts each is eighty numbers in a column, and Discord's
 * embed fields wrap them into a cramped grey block where nothing is
 * comparable. A chart is comparable — a bar's length answers "who posted"
 * before you read a single digit, and a face answers "who is this" faster
 * than a handle does.
 *
 * Rendered with next/og (Satori), which supports a deliberately small subset
 * of CSS: flexbox only (no grid, no float), every element needs an explicit
 * `display: flex`, and there is no `gap` shorthand collapse to rely on. Keep
 * the styles boring — this is not a place to be clever.
 *
 * Layout is a pure function of the row count so a team of 4 and a team of 20
 * both come out looking deliberate rather than stretched.
 */

import type { PerformanceRow } from "@/lib/jobs/performance";
import { QUOTA_POSTS_PER_WEEK, TOP_POSTS, type Bucket, type PostRef, type Window } from "@/lib/performance";
import { formatCompact } from "@/lib/format";

/** Discord renders media on a dark surface; this matches its dark theme so
 *  the card reads as part of the message rather than a pasted screenshot. */
const IMG = {
  bg: "#1a1b1e",
  panel: "#232529",
  line: "#2f3237",
  text: "#f2f3f5",
  dim: "#9aa0a6",
  faint: "#6b7178",
  accent: "#5865f2",
} as const;

/** Bucket colours, matching the dots the text digest already uses. */
const BUCKET_COLOR: Record<Bucket, string> = {
  good: "#3ba55d",
  decent: "#e8b339",
  bad: "#ed4245",
};

export const CARD_WIDTH = 1200;
const ROW_H = 58;
const HEADER_H = 250;
const FOOTER_H = 92;
const TOP_STRIP_H = 250;

/** Tall enough for the roster, so nothing scrolls or clips. */
export function cardHeight(rowCount: number, topPosts = 0): number {
  return (
    HEADER_H + Math.max(rowCount, 1) * ROW_H + (topPosts > 0 ? TOP_STRIP_H : 0) + FOOTER_H
  );
}

/** How many posts the strip will show. Exported so the route sizes the PNG
 *  with the same number the card lays itself out with — when those two
 *  disagree the surplus renders as a white band under the card. */
export function topPostCount(rows: PerformanceRow[]): number {
  return Math.min(
    rows.reduce((n, r) => n + r.performance.weekly.topPosts.length, 0),
    TOP_POSTS
  );
}

const monthDay = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

export interface RecapCardData {
  coach: string;
  week: Window;
  rows: PerformanceRow[];
}

/** One creator's bar.
 *
 * Scaled to the busiest creator on the team, NOT to the quota. Creators run
 * trial reels, so a real week is 17 posts a day and every bar drawn against a
 * 7-post quota pins to full — the chart would say "everyone is fine" for a
 * team where one person posted 104 and another posted 1. Against the team max
 * the differences are visible, and the quota still shows as a tick so the
 * threshold is not lost.
 */
function CreatorRow({ row, index, max }: { row: PerformanceRow; index: number; max: number }) {
  const w = row.performance.weekly;
  const color = row.performance.bucket ? BUCKET_COLOR[row.performance.bucket] : IMG.faint;
  const ratio = max > 0 ? w.posts / max : 0;
  // The real name is what a coach calls them; the IG persona is not.
  const name = row.launchpointName || row.displayName || row.handle;

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        height: ROW_H,
        paddingLeft: 40,
        paddingRight: 40,
        backgroundColor: index % 2 === 0 ? "transparent" : "rgba(255,255,255,0.02)",
      }}
    >
      {/* Face first: recognising a person is faster than parsing a handle. */}
      {row.avatarUrl ? (
        <img
          src={row.avatarUrl}
          width={38}
          height={38}
          style={{ borderRadius: 19, objectFit: "cover" }}
        />
      ) : (
        <div
          style={{
            display: "flex",
            width: 38,
            height: 38,
            borderRadius: 19,
            backgroundColor: IMG.panel,
            alignItems: "center",
            justifyContent: "center",
            color: IMG.dim,
            fontSize: 16,
          }}
        >
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", width: 210, marginLeft: 14 }}>
        <div style={{ display: "flex", fontSize: 19, color: IMG.text }}>
          {name.length > 20 ? `${name.slice(0, 19)}…` : name}
        </div>
        <div style={{ display: "flex", fontSize: 14, color: IMG.faint }}>@{row.handle}</div>
      </div>

      {/* The bar. Its length is the whole point of the graphic. */}
      <div
        style={{
          display: "flex",
          position: "relative",
          width: 420,
          height: 26,
          backgroundColor: IMG.panel,
          borderRadius: 6,
          marginRight: 18,
        }}
      >
        <div
          style={{
            display: "flex",
            width: Math.max(ratio * 420, w.posts > 0 ? 6 : 0),
            height: 26,
            backgroundColor: color,
            borderRadius: 6,
          }}
        />
        {/* Quota tick — the 7-post line, kept visible even though most
            creators clear it many times over. */}
        {max > QUOTA_POSTS_PER_WEEK ? (
          <div
            style={{
              display: "flex",
              position: "absolute",
              left: (QUOTA_POSTS_PER_WEEK / max) * 420,
              top: -3,
              width: 2,
              height: 32,
              backgroundColor: "rgba(255,255,255,0.35)",
            }}
          />
        ) : null}
      </div>

      <div style={{ display: "flex", flexDirection: "column", width: 96 }}>
        <div style={{ display: "flex", fontSize: 20, color: IMG.text }}>
          {w.posts}
          <span style={{ color: IMG.faint, fontSize: 15, marginLeft: 3 }}>/{QUOTA_POSTS_PER_WEEK}</span>
        </div>
        {/* The trial uploads behind those posts — effort the collapse hides
            from the count but a coach should still see. */}
        {w.trialUploads > 0 ? (
          <div style={{ display: "flex", fontSize: 13, color: IMG.faint }}>+{w.trialUploads} trials</div>
        ) : null}
      </div>

      <div style={{ display: "flex", width: 132, fontSize: 19, color: w.posts ? IMG.dim : IMG.faint }}>
        {w.posts ? `${formatCompact(Math.round(w.avgViews ?? 0))} avg` : "didn’t post"}
      </div>

      <div style={{ display: "flex", width: 74, fontSize: 19, color: IMG.dim }}>
        {w.spikes.length ? `🚀 ${w.spikes.length}` : ""}
      </div>
    </div>
  );
}

/** The week's best reels, with their thumbnails. Five, not one: a single
 *  lucky post says nothing, five shows whether the hooks are landing. */
function TopPosts({ posts }: { posts: { handle: string; post: PostRef }[] }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "20px 40px 0 40px" }}>
      <div style={{ display: "flex", fontSize: 14, color: IMG.faint, textTransform: "uppercase" }}>
        Top posts this week
      </div>
      <div style={{ display: "flex", marginTop: 12 }}>
        {posts.map(({ handle, post }, i) => (
          <div key={post.shortcode ?? i} style={{ display: "flex", flexDirection: "column", marginRight: 18 }}>
            {post.thumbnail ? (
              <img src={post.thumbnail} width={94} height={118} style={{ borderRadius: 8, objectFit: "cover" }} />
            ) : (
              <div style={{ display: "flex", width: 94, height: 118, borderRadius: 8, backgroundColor: IMG.panel }} />
            )}
            <div style={{ display: "flex", fontSize: 17, color: IMG.text, marginTop: 6 }}>
              {formatCompact(post.views)}
            </div>
            <div style={{ display: "flex", fontSize: 12, color: IMG.faint }}>
              @{handle.length > 13 ? `${handle.slice(0, 12)}…` : handle}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginRight: 56 }}>
      <div style={{ display: "flex", fontSize: 15, color: IMG.faint, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <div style={{ display: "flex", fontSize: 42, color: IMG.text }}>{value}</div>
        {note ? (
          <div style={{ display: "flex", fontSize: 17, color: IMG.dim, marginLeft: 8, marginBottom: 8 }}>
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The whole card. Returned as an element for `new ImageResponse(...)`. */
export function RecapCard({ coach, week, rows }: RecapCardData) {
  const ranked = [...rows].sort(
    (a, b) =>
      b.performance.weekly.posts - a.performance.weekly.posts ||
      (b.performance.weekly.avgViews ?? 0) - (a.performance.weekly.avgViews ?? 0) ||
      a.handle.localeCompare(b.handle)
  );
  const posts = rows.reduce((s, r) => s + r.performance.weekly.posts, 0);
  const views = rows.reduce((s, r) => s + r.performance.weekly.views, 0);
  const quota = rows.length * QUOTA_POSTS_PER_WEEK;
  const hit = rows.filter((r) => !r.performance.weekly.belowQuota).length;
  const silent = rows.filter((r) => r.performance.weekly.posts === 0).length;
  const spikes = rows.reduce((s, r) => s + r.performance.weekly.spikes.length, 0);
  const avgViews = posts > 0 ? views / posts : 0;
  const maxPosts = Math.max(...rows.map((r) => r.performance.weekly.posts), QUOTA_POSTS_PER_WEEK);
  const trials = rows.reduce((s, r) => s + r.performance.weekly.trialUploads, 0);
  // Best five across the whole team, not five from one creator.
  const topPosts = rows
    .flatMap((r) => r.performance.weekly.topPosts.map((post) => ({ handle: r.handle, post })))
    .sort((a, b) => b.post.views - a.post.views)
    .slice(0, TOP_POSTS);
  const pct = quota > 0 ? Math.round((posts / quota) * 100) : 0;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: CARD_WIDTH,
        height: cardHeight(rows.length, topPosts.length),
        backgroundColor: IMG.bg,
        color: IMG.text,
        fontFamily: "Inter",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", flexDirection: "column", padding: "34px 40px 0 40px" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          <div style={{ display: "flex", width: 6, height: 30, backgroundColor: IMG.accent, borderRadius: 3 }} />
          <div style={{ display: "flex", fontSize: 30, marginLeft: 14 }}>{coach}</div>
          <div style={{ display: "flex", fontSize: 20, color: IMG.dim, marginLeft: 16 }}>
            {monthDay(week.start)} – {monthDay(new Date(week.end.getTime() - 1))}
          </div>
        </div>

        <div style={{ display: "flex", marginTop: 26 }}>
          <Stat label="Posts" value={`${posts}`} note={`of ${quota} · ${pct}%`} />
          <Stat label="Avg views / post" value={formatCompact(Math.round(avgViews))} />
          <Stat label="Hit quota" value={`${hit}`} note={`of ${rows.length}`} />
          <Stat label="Spikes 40k+" value={`${spikes}`} />
          <Stat label="Didn’t post" value={`${silent}`} />
          {trials > 0 ? <Stat label="Trial uploads" value={formatCompact(trials)} note="not counted" /> : null}
        </div>
      </div>

      {/* Column key, so the bars need no legend inside every row. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          padding: "18px 40px 8px 40px",
          fontSize: 14,
          color: IMG.faint,
          textTransform: "uppercase",
        }}
      >
        <div style={{ display: "flex", width: 262 }}>Creator</div>
        <div style={{ display: "flex", width: 438 }}>Posts (tick = {QUOTA_POSTS_PER_WEEK}/wk quota)</div>
        <div style={{ display: "flex", width: 96 }} />
        <div style={{ display: "flex", width: 132 }}>Avg views</div>
        <div style={{ display: "flex", width: 74 }}>🚀 40k+</div>
      </div>
      <div style={{ display: "flex", height: 1, backgroundColor: IMG.line, marginLeft: 40, marginRight: 40 }} />

      {ranked.map((row, i) => (
        <CreatorRow key={row.creatorId} row={row} index={i} max={maxPosts} />
      ))}

      {topPosts.length ? <TopPosts posts={topPosts} /> : null}

      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: FOOTER_H,
          padding: "0 40px",
          fontSize: 15,
          color: IMG.faint,
        }}
      >
        <div style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: BUCKET_COLOR.good }} />
        <div style={{ display: "flex", marginLeft: 8, marginRight: 20 }}>on track</div>
        <div style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: BUCKET_COLOR.decent }} />
        <div style={{ display: "flex", marginLeft: 8, marginRight: 20 }}>watch</div>
        <div style={{ display: "flex", width: 12, height: 12, borderRadius: 6, backgroundColor: BUCKET_COLOR.bad }} />
        <div style={{ display: "flex", marginLeft: 8 }}>needs a decision</div>
      </div>
    </div>
  );
}
