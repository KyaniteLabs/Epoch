import { describe, it, expect } from "vitest";
import {
  addBusinessDays,
  countBusinessDays,
  isBusinessDay,
  isWithinWorkingHours,
  holidayRegistry,
  getUrgencyCategory,
} from "./calendar.js";

// ---------------------------------------------------------------------------
// Layer 2: Calendar / Business Day Utilities
// ---------------------------------------------------------------------------

describe("HolidayRegistry", () => {
  it("recognises all 5 supported countries", () => {
    expect(holidayRegistry.hasCountry("US")).toBe(true);
    expect(holidayRegistry.hasCountry("UK")).toBe(true);
    expect(holidayRegistry.hasCountry("FR")).toBe(true);
    expect(holidayRegistry.hasCountry("DE")).toBe(true);
    expect(holidayRegistry.hasCountry("JP")).toBe(true);
  });

  it("rejects unknown countries", () => {
    expect(holidayRegistry.hasCountry("XX")).toBe(false);
  });

  it("returns holiday sets for US 2026", () => {
    const keys = holidayRegistry.holidayDateKeys("US", 2026);
    expect(keys.size).toBeGreaterThan(5);
    expect(keys.has("2026-01-01")).toBe(true); // New Year's Day
    expect(keys.has("2026-12-25")).toBe(true); // Christmas
  });

  it("returns holiday sets for UK 2026", () => {
    const keys = holidayRegistry.holidayDateKeys("UK", 2026);
    expect(keys.size).toBeGreaterThan(3);
    expect(keys.has("2026-12-25")).toBe(true);
  });

  it("returns empty set for unknown country", () => {
    const keys = holidayRegistry.holidayDateKeys("XX", 2026);
    expect(keys.size).toBe(0);
  });

  it("lists supported countries", () => {
    const countries = holidayRegistry.supportedCountries();
    expect(countries).toContain("US");
    expect(countries).toContain("JP");
    expect(countries.length).toBe(5);
  });
});

describe("isBusinessDay", () => {
  it("returns true for a regular Monday", () => {
    expect(isBusinessDay("2026-05-04", "US")).toBe(true); // Monday
  });

  it("returns false for Saturday", () => {
    expect(isBusinessDay("2026-05-02", "US")).toBe(false); // Saturday
  });

  it("returns false for Sunday", () => {
    expect(isBusinessDay("2026-05-03", "US")).toBe(false); // Sunday
  });

  it("returns false for Christmas US", () => {
    expect(isBusinessDay("2026-12-25", "US")).toBe(false);
  });

  it("returns false for Christmas UK", () => {
    expect(isBusinessDay("2026-12-25", "UK")).toBe(false);
  });

  it("returns false for invalid date", () => {
    expect(isBusinessDay("not-a-date", "US")).toBe(false);
  });
});

describe("addBusinessDays", () => {
  it("adds 1 business day over a weekend", () => {
    // 2026-05-01 is a Friday, +1 = Monday 2026-05-04
    const result = addBusinessDays("2026-05-01", 1, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.endDate).toBe("2026-05-04");
  });

  it("adds 5 business days", () => {
    // 2026-05-04 (Monday) + 5 = 2026-05-11 (Monday)
    const result = addBusinessDays("2026-05-04", 5, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.endDate).toBe("2026-05-11");
  });

  it("skips US holidays", () => {
    // 2026-12-24 (Thu) + 1 = skip 25th (Christmas) → 2026-12-28 (Mon)
    const result = addBusinessDays("2026-12-24", 1, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.businessDays).toBe(1);
  });

  it("returns error for invalid start date", () => {
    const result = addBusinessDays("invalid", 1, "US");
    expect(result.ok).toBe(false);
  });

  it("returns error for unsupported country", () => {
    const result = addBusinessDays("2026-05-01", 1, "XX");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Unsupported country");
  });
});

describe("countBusinessDays", () => {
  it("counts business days in a full week", () => {
    // Mon May 4 → Fri May 8 = 4 business days (exclusive start to inclusive end)
    const result = countBusinessDays("2026-05-04", "2026-05-08", "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.businessDays).toBe(4);
  });

  it("counts 0 for same day", () => {
    const result = countBusinessDays("2026-05-04", "2026-05-04", "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.businessDays).toBe(0);
  });

  it("skips weekend days", () => {
    // Fri May 1 → Mon May 4 (exclusive start to inclusive end): Sat, Sun, Mon → 1
    const result = countBusinessDays("2026-05-01", "2026-05-04", "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.businessDays).toBe(1);
  });

  it("returns error for invalid dates", () => {
    const result = countBusinessDays("bad", "2026-05-08", "US");
    expect(result.ok).toBe(false);
  });
});

describe("isWithinWorkingHours", () => {
  it("returns true for 10am on a workday", () => {
    expect(isWithinWorkingHours("2026-05-04T10:00:00Z", "UTC", 9, 17)).toBe(true);
  });

  it("returns false for 8am (before hours)", () => {
    expect(isWithinWorkingHours("2026-05-04T08:00:00Z", "UTC", 9, 17)).toBe(false);
  });

  it("returns false for invalid date", () => {
    expect(isWithinWorkingHours("bad-date", "UTC", 9, 17)).toBe(false);
  });
});

describe("getUrgencyCategory", () => {
  it("returns short for under 2 hours", () => {
    expect(getUrgencyCategory(1)).toBe("short");
    expect(getUrgencyCategory(0.5)).toBe("short");
  });

  it("returns medium for 2-48 hours", () => {
    expect(getUrgencyCategory(2)).toBe("medium");
    expect(getUrgencyCategory(24)).toBe("medium");
    expect(getUrgencyCategory(48)).toBe("medium");
  });

  it("returns long for over 48 hours", () => {
    expect(getUrgencyCategory(49)).toBe("long");
    expect(getUrgencyCategory(200)).toBe("long");
  });
});
