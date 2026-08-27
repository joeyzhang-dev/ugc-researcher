import { describe, expect, it } from "vitest";
import { LAUNCHPOINT_VIDEO_COLUMNS, videoSelect, __resetColumnProbe } from "@/lib/video-metrics";

const BASE = "id, url, view_count";

/** Minimal stand-in: answers the probe with whatever error we hand it. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const client = (error: { code: string } | null): any => ({
  from: () => ({
    select: () => ({ limit: async () => ({ data: error ? null : [], error }) }),
  }),
});

describe("videoSelect", () => {
  // The whole point: the app and its schema do not always ship together, and a
  // select naming a column that does not exist is a hard PostgREST 400 that
  // takes the entire page down rather than hiding a few chips.
  it("omits the Launchpoint columns when the migration has not been applied", async () => {
    __resetColumnProbe();
    expect(await videoSelect(client({ code: "42703" }), BASE)).toBe(BASE);
  });

  it("includes them once the columns exist", async () => {
    __resetColumnProbe();
    expect(await videoSelect(client(null), BASE)).toBe(`${BASE}, ${LAUNCHPOINT_VIDEO_COLUMNS}`);
  });

  // A network blip or auth failure is not evidence the column is missing.
  // Caching that as "absent" would strip retention from every page until the
  // process recycled, long after the real problem cleared.
  it("assumes present on any error that is not undefined_column", async () => {
    __resetColumnProbe();
    expect(await videoSelect(client({ code: "PGRST301" }), BASE)).toContain(LAUNCHPOINT_VIDEO_COLUMNS);
  });
});
