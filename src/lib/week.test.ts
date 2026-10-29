import { describe, expect, it } from "vitest";
import { addDays, currentWeekStart, dateForDay, dateFromKey, dateKey, weekLabel } from "./week";

describe("date-only weekly planning", () => {
  it("finds the local Monday without converting through UTC", () => {
    expect(currentWeekStart(new Date(2026, 9, 29, 23, 30))).toBe("2026-10-26");
  });

  it("crosses month and year boundaries", () => {
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });

  it("round-trips a local calendar date", () => {
    expect(dateKey(dateFromKey("2026-03-09"))).toBe("2026-03-09");
    expect(dateKey(dateForDay("Sunday", "2026-03-02"))).toBe("2026-03-08");
  });

  it("labels the supplied week instead of the current week", () => {
    expect(weekLabel("2026-12-28")).toContain("Jan 3");
  });
});
