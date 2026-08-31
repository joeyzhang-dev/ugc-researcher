/**
 * One creator's stats card, rendered by next/og for `/stats`.
 *
 * Shares its visual language with the weekly recap card on purpose — same
 * surface, same bucket colours, same typography — because a coach reads both
 * in the same channel and a second design language would just be noise. What
 * differs is the question: the recap compares people, this one compares a
 * person against their own past, so the trend bars are the centre of gravity
 * and the single week is only their last column.
 *
 * Satori constraints apply (see recap-card.tsx): flexbox only, explicit
 * `display: flex` everywhere, no grid.
 */

import type { CreatorStatsRow } from "@/lib/jobs/creator-stats";
import { QUOTA_POSTS_PER_WEEK, type Bucket, type PostRef, type Window } from "@/lib/performance";
import { bucketForViews } from "@/lib/performance";
import { formatCompact, formatUsd } from "@/lib/format";

const C = {
  bg: "#1a1b1e",
  panel: "#232529",
  line: "#2f3237",
  text: "#f2f3f5",
  dim: "#9aa0a6",
  faint: "#6b7178",
  accent: "#5865f2",
  up: "#3ba55d",
  down: "#ed4245",
} as const;

const BUCKET_COLOR: Record<Bucket, string> = {
  good: "#3ba55d",
  decent: "#e8b339",
  bad: "#ed4245",
};

export const CREATOR_CARD_WIDTH = 1200;
export const CREATOR_CARD_HEIGHT = 900;

const monthDay = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

function Stat({
  label,
  value,
  note,
  color,
}: {
  label: string;
  value: string;
  note?: string;
  color?: string;
}) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginRight: 48 }}>
      <div style={{ display: "flex", fontSize: 14, color: C.faint, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", marginTop: 2 }}>
        <div style={{ display: "flex", fontSize: 36, color: color ?? C.text }}>{value}</div>
        {note ? (
          <div style={{ display: "flex", fontSize: 15, color: C.dim, marginLeft: 7, marginBottom: 7 }}>
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The eight-week trend. Bar height is posts; the quota line runs across it so
 *  "did they clear 7" stays readable without a number per bar. */
function Trend({ points }: { points: { week: Window; posts: number; avgViews: number | null }[] }) {
  const max = Math.max(...points.map((p) => p.posts), QUOTA_POSTS_PER_WEEK);
  const H = 150;
  // The count sits above its bar, so the row has to be taller than the tallest
  // bar or the busiest week — the one you most want to read — loses its label
  // off the top.
  const LABEL_H = 28;
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "0 40px" }}>
      <div style={{ display: "flex", fontSize: 14, color: C.faint, textTransform: "uppercase" }}>
        Last {points.length} weeks — posts per week
      </div>

      <div style={{ display: "flex", position: "relative", height: H + LABEL_H, marginTop: 10 }}>
        {/* Quota line, drawn behind the bars. */}
        <div
          style={{
            display: "flex",
            position: "absolute",
            left: 0,
            right: 0,
            bottom: (QUOTA_POSTS_PER_WEEK / max) * H,
            height: 1,
            backgroundColor: "rgba(255,255,255,0.18)",
          }}
        />
        {points.map((p, i) => {
          const h = max > 0 ? Math.max((p.posts / max) * H, p.posts > 0 ? 4 : 2) : 2;
          const color = p.posts === 0 ? C.line : BUCKET_COLOR[bucketForViews(p.avgViews) ?? "decent"];
          return (
            <div
              key={i}
              style={{
                display: "flex",
                flexDirection: "column",
                justifyContent: "flex-end",
                alignItems: "center",
                width: 140,
              }}
            >
              <div style={{ display: "flex", fontSize: 17, color: C.text, marginBottom: 5 }}>
                {p.posts}
              </div>
              <div
                style={{ display: "flex", width: 84, height: h, backgroundColor: color, borderRadius: 5 }}
              />
            </div>
          );
        })}
      </div>

      {/* Week labels + that week's average views, under each bar. */}
      <div style={{ display: "flex", marginTop: 8 }}>
        {points.map((p, i) => (
          <div
            key={i}
            style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 140 }}
          >
            <div style={{ display: "flex", fontSize: 14, color: C.dim }}>{monthDay(p.week.start)}</div>
            <div style={{ display: "flex", fontSize: 13, color: C.faint }}>
              {p.posts ? `${formatCompact(Math.round(p.avgViews ?? 0))} avg` : "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function TopPosts({ posts }: { posts: { post: PostRef; week: Window }[] }) {
  if (!posts.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "0 40px" }}>
      <div style={{ display: "flex", fontSize: 14, color: C.faint, textTransform: "uppercase" }}>
        Best posts in this window
      </div>
      <div style={{ display: "flex", marginTop: 12 }}>
        {posts.map(({ post, week }, i) => (
          <div
            key={post.shortcode ?? i}
            style={{ display: "flex", flexDirection: "column", marginRight: 20 }}
          >
            {post.thumbnail ? (
              <img src={post.thumbnail} width={96} height={122} style={{ borderRadius: 8, objectFit: "cover" }} />
            ) : (
              <div style={{ display: "flex", width: 96, height: 122, borderRadius: 8, backgroundColor: C.panel }} />
            )}
            <div style={{ display: "flex", fontSize: 17, color: C.text, marginTop: 6 }}>
              {formatCompact(post.views)}
            </div>
            <div style={{ display: "flex", fontSize: 12, color: C.faint }}>{monthDay(week.start)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CreatorCard({ row }: { row: CreatorStatsRow }) {
  const s = row.stats;
  const name = row.launchpointName || row.displayName || row.handle;
  const cpm = s.money.cpm30;
  const bucket = bucketForViews(s.current.avgViews ?? null);

  // Direction on the 30-day CPM: only when both reads are real. A projection
  // moving is not the same fact and must not wear the same arrow.
  const d = s.money.delta;
  const cpmNote =
    d && !cpm.lowSample && !s.money.cpm30Prev.lowSample && Math.abs(d.usd) >= 0.005
      ? `${d.usd < 0 ? "▼" : "▲"}${formatUsd(Math.abs(d.usd))}`
      : undefined;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: CREATOR_CARD_WIDTH,
        height: CREATOR_CARD_HEIGHT,
        backgroundColor: C.bg,
        color: C.text,
        fontFamily: "Inter",
      }}
    >
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", padding: "32px 40px 0 40px" }}>
        {row.avatarUrl ? (
          <img src={row.avatarUrl} width={76} height={76} style={{ borderRadius: 38, objectFit: "cover" }} />
        ) : (
          <div
            style={{
              display: "flex",
              width: 76,
              height: 76,
              borderRadius: 38,
              backgroundColor: C.panel,
              alignItems: "center",
              justifyContent: "center",
              fontSize: 30,
              color: C.dim,
            }}
          >
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 20 }}>
          <div style={{ display: "flex", alignItems: "center" }}>
            <div style={{ display: "flex", fontSize: 34 }}>{name}</div>
            {bucket ? (
              <div
                style={{
                  display: "flex",
                  width: 13,
                  height: 13,
                  borderRadius: 7,
                  backgroundColor: BUCKET_COLOR[bucket],
                  marginLeft: 14,
                }}
              />
            ) : null}
          </div>
          <div style={{ display: "flex", fontSize: 18, color: C.dim, marginTop: 2 }}>
            @{row.handle}
            {row.coach ? <span style={{ marginLeft: 12 }}>· {row.coach}</span> : null}
            {row.niche ? <span style={{ marginLeft: 12 }}>· {row.niche}</span> : null}
            {row.archivedAt ? (
              <span style={{ marginLeft: 12, color: C.down }}>· archived</span>
            ) : null}
          </div>
        </div>
      </div>

      {/* This week */}
      <div style={{ display: "flex", padding: "26px 40px 0 40px" }}>
        <Stat
          label="This week"
          value={`${s.current.posts}`}
          note={`/${QUOTA_POSTS_PER_WEEK} posts`}
          color={bucket ? BUCKET_COLOR[bucket] : undefined}
        />
        <Stat
          label="Avg views"
          value={s.current.posts ? formatCompact(Math.round(s.current.avgViews ?? 0)) : "—"}
        />
        <Stat label={`${s.trend.length}-wk posts`} value={`${s.totals.posts}`} />
        <Stat
          label={`${s.trend.length}-wk avg views`}
          value={s.totals.posts ? formatCompact(Math.round(s.totals.views / s.totals.posts)) : "—"}
        />
        <Stat label="Spikes 40k+" value={`${s.totals.spikes}`} />
        {s.totals.trialUploads > 0 ? (
          <Stat label="Trial uploads" value={formatCompact(s.totals.trialUploads)} note="not counted" />
        ) : null}
      </div>

      <div style={{ display: "flex", height: 1, backgroundColor: C.line, margin: "24px 40px" }} />

      {/* Money */}
      <div style={{ display: "flex", padding: "0 40px" }}>
        <Stat
          label="30d CPM"
          value={cpm.cpm != null ? formatUsd(cpm.cpm) : cpm.projected != null ? `≈${formatUsd(cpm.projected)}` : "—"}
          note={cpmNote ?? (cpm.cpm == null && cpm.projected != null ? "projected" : undefined)}
          color={cpmNote ? (d && d.usd < 0 ? C.up : C.down) : undefined}
        />
        <Stat label="Earned" value={formatUsd(s.money.earnedUsd)} note="all time" />
        <Stat label="Paid posts" value={`${s.money.paidPosts}`} />
        <Stat label="Awaiting payout" value={`${Math.max(s.money.unpaidPosts, 0)}`} note="~3wk lag" />
        {cpm.lowSample ? <Stat label="Sample" value={`${cpm.paidPosts}`} note="low" /> : null}
      </div>

      <div style={{ display: "flex", height: 1, backgroundColor: C.line, margin: "24px 40px" }} />

      <Trend
        points={s.trend.map((p) => ({
          week: p.week,
          posts: p.read.posts,
          avgViews: p.read.avgViews,
        }))}
      />

      <div style={{ display: "flex", height: 1, backgroundColor: C.line, margin: "24px 40px" }} />

      <TopPosts posts={s.topPosts} />
    </div>
  );
}
