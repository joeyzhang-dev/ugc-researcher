/**
 * The creator's own card, for `/my-stats`.
 *
 * Same data as the coach's card, deliberately different shape. A coach is
 * triaging a roster; a creator is reading about themselves, and the thing that
 * changes behaviour is not a verdict — it is a gap they can close this week.
 * So the hero is a progress bar against quota, the trend is framed against
 * their own best rather than against other people, and the one sentence at the
 * bottom always ends in something to do.
 *
 * Three rules this layout keeps:
 *
 *  - No red for a person. The coach's card marks a creator `bad`; here a short
 *    week is amber and phrased as distance-to-go. The same fact motivates when
 *    framed as a gap and demoralises when framed as a grade.
 *  - Their own best is the benchmark, never the roster's. Comparing someone to
 *    a teammate who spiked is discouraging and not actionable.
 *  - Money is shown as earned, not as CPM alone. CPM is the program's
 *    efficiency; earnings are theirs.
 */

import type { CreatorStatsRow } from "@/lib/jobs/creator-stats";
import type { Coaching } from "@/lib/creator-coaching";
import { QUOTA_POSTS_PER_WEEK, SPIKE_VIEWS, type PostRef, type Window } from "@/lib/performance";
import { formatCompact, formatUsd } from "@/lib/format";
import { CARD, CPM_BAND_COLOR, CPM_BAND_LABEL, PlatformMark, cpmBand } from "@/lib/card-chrome";

export const MY_CARD_WIDTH = 1200;
export const MY_CARD_HEIGHT = 940;

const TONE: Record<Coaching["tone"], string> = {
  good: CARD.good,
  warn: CARD.warn,
  // Even the "bad" tone renders amber on this card: see the no-red rule above.
  bad: CARD.warn,
  neutral: CARD.accent,
};

const monthDay = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });

/** Quota progress, as a bar that fills.
 *
 * The track is a FIXED width and the fill is clamped to it. An earlier version
 * appended an "overflow" segment past the track for creators beyond target,
 * which ran off the card and collided with the tile beside it — 16 posts
 * against a 7 quota is 229%, and there is no room for that. Beating the target
 * is said in words instead, which is also the part worth reading.
 */
function QuotaBar({ posts }: { posts: number }) {
  const W = 560;
  const hit = posts >= QUOTA_POSTS_PER_WEEK;
  const filled = Math.min(posts / QUOTA_POSTS_PER_WEEK, 1) * W;
  return (
    <div style={{ display: "flex", flexDirection: "column", width: W }}>
      <div style={{ display: "flex", alignItems: "flex-end" }}>
        <div style={{ display: "flex", fontSize: 68, color: hit ? CARD.good : CARD.warn }}>{posts}</div>
        <div style={{ display: "flex", fontSize: 26, color: CARD.dim, marginLeft: 10, marginBottom: 12 }}>
          / {QUOTA_POSTS_PER_WEEK} posts this week
        </div>
      </div>
      <div
        style={{
          display: "flex",
          width: W,
          height: 20,
          backgroundColor: CARD.panel,
          borderRadius: 10,
          marginTop: 10,
        }}
      >
        <div
          style={{
            display: "flex",
            width: filled,
            height: 20,
            backgroundColor: hit ? CARD.good : CARD.warn,
            borderRadius: 10,
          }}
        />
      </div>
      <div style={{ display: "flex", fontSize: 16, color: CARD.faint, marginTop: 8 }}>
        {hit
          ? posts > QUOTA_POSTS_PER_WEEK
            ? `target hit — ${posts - QUOTA_POSTS_PER_WEEK} past it`
            : "target hit"
          : `${QUOTA_POSTS_PER_WEEK - posts} more to hit your target`}
      </div>
    </div>
  );
}

function Tile({ label, value, note, color }: { label: string; value: string; note?: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginRight: 44 }}>
      <div style={{ display: "flex", fontSize: 14, color: CARD.faint, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", marginTop: 2 }}>
        <div style={{ display: "flex", fontSize: 34, color: color ?? CARD.text }}>{value}</div>
        {note ? (
          <div style={{ display: "flex", fontSize: 15, color: CARD.dim, marginLeft: 7, marginBottom: 6 }}>
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Weekly views against their own best week — a personal record to chase, not
 *  a league table to sit at the bottom of. */
function PersonalTrend({
  points,
}: {
  points: { week: Window; posts: number; avgViews: number | null }[];
}) {
  const best = Math.max(...points.map((p) => p.avgViews ?? 0), 1);
  const H = 108;
  const bestIdx = points.findIndex((p) => (p.avgViews ?? 0) === best);
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "0 40px" }}>
      <div style={{ display: "flex", fontSize: 14, color: CARD.faint, textTransform: "uppercase" }}>
        Your avg views — best week {formatCompact(Math.round(best))}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", height: H + 22, marginTop: 12 }}>
        {points.map((p, i) => {
          const v = p.avgViews ?? 0;
          const h = Math.max((v / best) * H, v > 0 ? 4 : 2);
          return (
            <div
              key={i}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 140 }}
            >
              <div
                style={{
                  display: "flex",
                  width: 86,
                  height: h,
                  backgroundColor: i === bestIdx ? CARD.good : CARD.accent,
                  borderRadius: 5,
                }}
              />
            </div>
          );
        })}
      </div>
      <div style={{ display: "flex", marginTop: 6 }}>
        {points.map((p, i) => (
          <div key={i} style={{ display: "flex", flexDirection: "column", alignItems: "center", width: 140 }}>
            <div style={{ display: "flex", fontSize: 13, color: CARD.dim }}>{monthDay(p.week.start)}</div>
            <div style={{ display: "flex", fontSize: 12, color: CARD.faint }}>
              {p.posts ? formatCompact(Math.round(p.avgViews ?? 0)) : "—"}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function BestPosts({ posts }: { posts: { post: PostRef; week: Window }[] }) {
  if (!posts.length) return null;
  return (
    <div style={{ display: "flex", flexDirection: "column", padding: "0 40px" }}>
      <div style={{ display: "flex", fontSize: 14, color: CARD.faint, textTransform: "uppercase" }}>
        Your best posts — do more like these
      </div>
      <div style={{ display: "flex", marginTop: 12 }}>
        {posts.slice(0, 5).map(({ post }, i) => (
          <div key={post.shortcode ?? i} style={{ display: "flex", flexDirection: "column", marginRight: 18 }}>
            {post.thumbnail ? (
              <img src={post.thumbnail} width={88} height={112} style={{ borderRadius: 8, objectFit: "cover" }} />
            ) : (
              <div style={{ display: "flex", width: 88, height: 112, borderRadius: 8, backgroundColor: CARD.panel }} />
            )}
            <div
              style={{
                display: "flex",
                fontSize: 16,
                color: post.views >= SPIKE_VIEWS ? CARD.good : CARD.text,
                marginTop: 6,
              }}
            >
              {formatCompact(post.views)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function MyStatsCard({ row, coaching }: { row: CreatorStatsRow; coaching: Coaching }) {
  const s = row.stats;
  const name = row.launchpointName || row.displayName || row.handle;
  const cpm = s.money.cpm30;
  const band = cpmBand(cpm.cpm);
  const tone = TONE[coaching.tone];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: MY_CARD_WIDTH,
        height: MY_CARD_HEIGHT,
        backgroundColor: CARD.bg,
        color: CARD.text,
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", padding: "30px 40px 0 40px" }}>
        {row.avatarUrl ? (
          <img src={row.avatarUrl} width={64} height={64} style={{ borderRadius: 32, objectFit: "cover" }} />
        ) : (
          <div
            style={{
              display: "flex",
              width: 64,
              height: 64,
              borderRadius: 32,
              backgroundColor: CARD.panel,
              alignItems: "center",
              justifyContent: "center",
              fontSize: 26,
              color: CARD.dim,
            }}
          >
            {name.slice(0, 1).toUpperCase()}
          </div>
        )}
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 18 }}>
          <div style={{ display: "flex", fontSize: 30 }}>{name}</div>
          <div style={{ display: "flex", fontSize: 17, color: CARD.dim }}>
            your week of {monthDay(s.trend[s.trend.length - 1].week.start)}
          </div>
        </div>
        <PlatformMark />
      </div>

      {/* The hero: the gap they can close. */}
      <div style={{ display: "flex", alignItems: "center", padding: "26px 40px 0 40px" }}>
        <QuotaBar posts={s.current.posts} />
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 56 }}>
          <Tile
            label="Avg views"
            value={s.current.posts ? formatCompact(Math.round(s.current.avgViews ?? 0)) : "—"}
          />
          <div style={{ display: "flex", marginTop: 18 }}>
            <Tile label="Earned" value={formatUsd(s.money.earnedUsd)} note="all time" />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", padding: "26px 40px 0 40px" }}>
        <Tile label={`${s.trend.length}-wk posts`} value={`${s.totals.posts}`} />
        <Tile label="Spikes 40k+" value={`${s.totals.spikes}`} color={s.totals.spikes ? CARD.good : undefined} />
        <Tile
          label="Your CPM"
          value={cpm.cpm != null ? formatUsd(cpm.cpm) : cpm.projected != null ? `≈${formatUsd(cpm.projected)}` : "—"}
          note={band ? CPM_BAND_LABEL[band] : cpm.projected != null ? "tracking" : undefined}
          color={band ? CPM_BAND_COLOR[band] : undefined}
        />
        <Tile label="Paid posts" value={`${s.money.paidPosts}`} note={`${Math.max(s.money.unpaidPosts, 0)} pending`} />
      </div>

      <div style={{ display: "flex", height: 1, backgroundColor: CARD.line, margin: "24px 40px" }} />

      <PersonalTrend
        points={s.trend.map((p) => ({ week: p.week, posts: p.read.posts, avgViews: p.read.avgViews }))}
      />

      <div style={{ display: "flex", height: 1, backgroundColor: CARD.line, margin: "22px 40px" }} />

      <BestPosts posts={s.topPosts} />

      {/* The one sentence that always ends in something to do. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 76,
          padding: "0 40px",
          marginTop: 18,
        }}
      >
        <div style={{ display: "flex", width: 5, height: 46, backgroundColor: tone, borderRadius: 3 }} />
        <div style={{ display: "flex", fontSize: 19, color: CARD.text, marginLeft: 16, width: 1050 }}>
          {coaching.creator}
        </div>
      </div>
    </div>
  );
}
