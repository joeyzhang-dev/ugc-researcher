/**
 * The daily card for `/my-day`.
 *
 * Shorter than the weekly on purpose — a daily someone might open every
 * morning has to be readable in about five seconds, so it carries four things
 * and stops: what moved yesterday, where the week stands, what they shipped,
 * and the streak.
 *
 * Pace is the only actionable item on it, so pace is the thing given the
 * hero treatment. The rest is encouragement and evidence.
 */

import type { DailyRecapRow } from "@/lib/jobs/daily-recap";
import { QUOTA_POSTS_PER_WEEK } from "@/lib/performance";
import { formatCompact } from "@/lib/format";
import { CARD, PlatformMark, rangeLabel } from "@/lib/card-chrome";

export const DAILY_CARD_WIDTH = 1200;
export const DAILY_CARD_HEIGHT = 470;

const monthDay = (d: Date): string =>
  d.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const weekday = (d: Date): string =>
  d.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });

function Tile({ label, value, note, color }: { label: string; value: string; note?: string; color?: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", marginRight: 52 }}>
      <div style={{ display: "flex", fontSize: 14, color: CARD.faint, textTransform: "uppercase" }}>
        {label}
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", marginTop: 2 }}>
        <div style={{ display: "flex", fontSize: 40, color: color ?? CARD.text }}>{value}</div>
        {note ? (
          <div style={{ display: "flex", fontSize: 15, color: CARD.dim, marginLeft: 8, marginBottom: 8 }}>
            {note}
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** The week as seven boxes: filled for a day they posted, outlined for a day
 *  still to come, hollow for a day already missed. A week at a glance beats a
 *  ratio, because the shape shows where the gaps actually are. */
function WeekDots({ postedDays, todayIndex }: { postedDays: boolean[]; todayIndex: number }) {
  const labels = ["M", "T", "W", "T", "F", "S", "S"];
  return (
    <div style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", fontSize: 14, color: CARD.faint, textTransform: "uppercase" }}>
        This week
      </div>
      <div style={{ display: "flex", marginTop: 10 }}>
        {labels.map((l, i) => {
          const done = postedDays[i];
          const future = i > todayIndex;
          return (
            <div
              key={i}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", marginRight: 12 }}
            >
              <div
                style={{
                  display: "flex",
                  width: 42,
                  height: 42,
                  borderRadius: 10,
                  backgroundColor: done ? CARD.good : future ? CARD.panel : "#2b2016",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 17,
                  color: done ? "#0f1a12" : future ? CARD.faint : CARD.warn,
                }}
              >
                {l}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function DailyCard({ row }: { row: DailyRecapRow }) {
  const r = row.recap;
  const pace = r.pace;

  // Both come from the recap: deriving them here was how the strip ended up
  // describing last week.
  const postedDays = r.weekPostDays;
  const todayIndex = r.todayIndex;
  const top = r.movers[0];

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        width: DAILY_CARD_WIDTH,
        height: DAILY_CARD_HEIGHT,
        backgroundColor: CARD.bg,
        color: CARD.text,
        fontFamily: "Inter",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", padding: "28px 40px 0 40px" }}>
        {row.avatarUrl ? (
          <img src={row.avatarUrl} width={56} height={56} style={{ borderRadius: 28, objectFit: "cover" }} />
        ) : (
          <div style={{ display: "flex", width: 56, height: 56, borderRadius: 28, backgroundColor: CARD.panel }} />
        )}
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 16 }}>
          <div style={{ display: "flex", fontSize: 27 }}>{row.name}</div>
          <div style={{ display: "flex", fontSize: 16, color: CARD.dim }}>
            {weekday(r.day)}, {monthDay(r.day)}
          </div>
        </div>
        <PlatformMark />
      </div>

      <div style={{ display: "flex", padding: "24px 40px 0 40px" }}>
        <Tile
          label="Views added yesterday"
          value={formatCompact(r.viewsAdded)}
          color={r.viewsAdded > 0 ? CARD.good : undefined}
        />
        <Tile
          label="Posted yesterday"
          value={`${r.postedThatDay.length}`}
          color={r.postedThatDay.length ? CARD.good : CARD.warn}
        />
        <Tile
          label="Streak"
          value={r.streakDays ? `${r.streakDays}d` : "—"}
          note={r.bestStreakDays > r.streakDays ? `best ${r.bestStreakDays}d` : "personal best"}
          color={r.streakDays ? CARD.good : undefined}
        />
        <Tile
          label="Week so far"
          value={`${pace.postsThisWeek}/${QUOTA_POSTS_PER_WEEK}`}
          color={pace.onTrack ? CARD.good : CARD.warn}
        />
      </div>

      <div style={{ display: "flex", height: 1, backgroundColor: CARD.line, margin: "22px 40px" }} />

      <div style={{ display: "flex", alignItems: "flex-start", padding: "0 40px" }}>
        <WeekDots postedDays={postedDays} todayIndex={todayIndex} />
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 64, width: 560 }}>
          <div style={{ display: "flex", fontSize: 14, color: CARD.faint, textTransform: "uppercase" }}>
            Still running
          </div>
          {top ? (
            <div style={{ display: "flex", alignItems: "center", marginTop: 10 }}>
              {top.thumbnail ? (
                <img src={top.thumbnail} width={62} height={78} style={{ borderRadius: 7, objectFit: "cover" }} />
              ) : (
                <div style={{ display: "flex", width: 62, height: 78, borderRadius: 7, backgroundColor: CARD.panel }} />
              )}
              <div style={{ display: "flex", flexDirection: "column", marginLeft: 14 }}>
                <div style={{ display: "flex", fontSize: 26, color: CARD.good }}>
                  +{formatCompact(top.viewsDelta)}
                </div>
                <div style={{ display: "flex", fontSize: 15, color: CARD.dim }}>
                  {formatCompact(top.views)} total
                  {top.postedAt ? ` · posted ${monthDay(new Date(Date.parse(top.postedAt)))}` : ""}
                </div>
              </div>
            </div>
          ) : (
            <div style={{ display: "flex", fontSize: 17, color: CARD.faint, marginTop: 12 }}>
              nothing moved yesterday
            </div>
          )}
        </div>
      </div>

      {/* The one line that says what to do with the rest of the week. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          height: 72,
          padding: "0 40px",
          marginTop: 24,
        }}
      >
        <div
          style={{
            display: "flex",
            width: 5,
            height: 46,
            backgroundColor: pace.onTrack ? CARD.good : CARD.warn,
            borderRadius: 3,
          }}
        />
        <div style={{ display: "flex", fontSize: 19, color: CARD.text, marginLeft: 16, width: 1050 }}>
          {pace.postsThisWeek >= QUOTA_POSTS_PER_WEEK
            ? `Target already hit for ${rangeLabel(pace.week.start, pace.week.end)} — everything from here is upside.`
            : pace.daysLeft === 0
              ? `The week is done at ${pace.postsThisWeek}/${QUOTA_POSTS_PER_WEEK}. Fresh start tomorrow.`
              : `${QUOTA_POSTS_PER_WEEK - pace.postsThisWeek} to go with ${pace.daysLeft} day${pace.daysLeft === 1 ? "" : "s"} left — about ${pace.perDayNeeded} a day gets you there.`}
        </div>
      </div>
    </div>
  );
}
