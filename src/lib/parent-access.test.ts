import { describe, expect, it } from "vitest";
import { formatParentBirthday, isValidParentBirthday } from "./parent-access";

describe("parent access birthday", () => {
  it("formats six digits as MM/DD/YY", () => {
    expect(formatParentBirthday("071590")).toBe("07/15/90");
    expect(formatParentBirthday("07-15-1990")).toBe("07/15/19");
  });

  it("accepts real calendar dates in the required format", () => {
    expect(isValidParentBirthday("07/15/90")).toBe(true);
    expect(isValidParentBirthday("02/29/24")).toBe(true);
  });

  it("rejects malformed and impossible dates", () => {
    expect(isValidParentBirthday("6/23/87")).toBe(false);
    expect(isValidParentBirthday("02/29/23")).toBe(false);
    expect(isValidParentBirthday("13/01/87")).toBe(false);
  });
});
