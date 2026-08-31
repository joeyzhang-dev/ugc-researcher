import { describe, expect, it } from "vitest";
import { coachForCategory, coachNameFromCategory } from "@/lib/coach-mention";

const WILL = { discordUserId: "1259223336131756144", names: ["Will Wilson", "_willwilson."] };
const LUKE = { discordUserId: "1469792112332640351", names: [null, "Luke", "lukeugc"] };
const JOEY = { discordUserId: "394232308087128066", names: ["joey", "nullerr_"] };
const COACHES = [WILL, LUKE, JOEY];

describe("coachNameFromCategory", () => {
  it("strips the live decoration", () => {
    expect(coachNameFromCategory("Coach: Will's Team")).toBe("will");
    expect(coachNameFromCategory("Coach: Luke's Team")).toBe("luke");
    expect(coachNameFromCategory("🏀 Vincent Team")).toBe("vincent");
  });

  it("returns nothing for a category that names no one", () => {
    expect(coachNameFromCategory("FOLK TEAM")).toBe("folk");
    expect(coachNameFromCategory("")).toBeNull();
    expect(coachNameFromCategory(null)).toBeNull();
  });
});

describe("coachForCategory", () => {
  it("finds the coach the team is named after", () => {
    expect(coachForCategory("Coach: Will's Team", COACHES)).toBe(WILL.discordUserId);
    expect(coachForCategory("Coach: Luke's Team", COACHES)).toBe(LUKE.discordUserId);
  });

  it("pings nobody rather than guessing when two coaches could match", () => {
    // Wrong ping tells one coach another's roster is theirs, every Monday.
    const twoWills = [WILL, { discordUserId: "999", names: ["Will Smith"] }];
    expect(coachForCategory("Coach: Will's Team", twoWills)).toBeNull();
  });

  it("pings nobody when the category names someone who is not a coach", () => {
    expect(coachForCategory("Coach: Vincent's Team", COACHES)).toBeNull();
  });

  it("matches whole words only, never a substring", () => {
    // "will" must not bind to "Willow".
    const willow = [{ discordUserId: "42", names: ["Willow Chen"] }];
    expect(coachForCategory("Coach: Will's Team", willow)).toBeNull();
  });

  it("survives a coach with no nickname set", () => {
    expect(coachForCategory("Coach: Luke's Team", [LUKE])).toBe(LUKE.discordUserId);
  });

  it("returns null for a generic category", () => {
    expect(coachForCategory("FOLK TEAM", COACHES)).toBeNull();
    expect(coachForCategory("Not Creating 🚫", COACHES)).toBeNull();
  });
});
