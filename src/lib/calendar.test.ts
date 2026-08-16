import { describe, it, expect } from "vitest";
import {
  addBusinessDays,
  countBusinessDays,
  isBusinessDay,
  isWithinWorkingHours,
  holidayRegistry,
  getUrgencyCategory,
  astronomicalJpEquinoxDates,
  CALENDAR_VERSION,
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

  it("falls back to weekend-only for unknown country", () => {
    const result = addBusinessDays("2026-05-01", 1, "XX");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.countryCode).toBe("XX");
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

// ---------------------------------------------------------------------------
// W2 calendar-truth goldens (tickets 13/14): official 2024-2027 holiday dates
// and US/UK observed/substitute-day rules, pinned so holiday-set corrections
// can't silently regress.
// ---------------------------------------------------------------------------

describe("JP equinox golden table (NAOJ official dates)", () => {
  // Official Shunbun no Hi / Shubun no Hi dates 2024-2030, verified against
  // the National Astronomical Observatory of Japan (nao.ac.jp/faq/a0301.html).
  const official: Record<number, { shunbun: string; shubun: string }> = {
    2024: { shunbun: "2024-03-20", shubun: "2024-09-22" },
    2025: { shunbun: "2025-03-20", shubun: "2025-09-23" },
    2026: { shunbun: "2026-03-20", shubun: "2026-09-23" },
    2027: { shunbun: "2027-03-21", shubun: "2027-09-23" },
    2028: { shunbun: "2028-03-20", shubun: "2028-09-22" },
    2029: { shunbun: "2029-03-20", shubun: "2029-09-23" },
    2030: { shunbun: "2030-03-20", shubun: "2030-09-23" },
  };

  it("marks the official Shunbun and Shubun dates as JP holidays", () => {
    for (const [year, dates] of Object.entries(official)) {
      const keys = holidayRegistry.holidayDateKeys("JP", Number(year));
      expect(keys.has(dates.shunbun), `Shunbun ${year}`).toBe(true);
      expect(keys.has(dates.shubun), `Shubun ${year}`).toBe(true);
    }
  });

  it("marks the neighboring date non-holidays when the equinox moved", () => {
    // 2027 Shunbun is 3/21 (the old inverted ternary wrongly made 3/20 the
    // holiday for year > 2026); 2028 Shubun is 9/22, not 9/23.
    expect(holidayRegistry.holidayDateKeys("JP", 2027).has("2027-03-20")).toBe(false);
    expect(holidayRegistry.holidayDateKeys("JP", 2028).has("2028-09-23")).toBe(false);
  });

  it("astronomical fallback (Meeus) reproduces every official table entry", () => {
    for (const [year, dates] of Object.entries(official)) {
      const astro = astronomicalJpEquinoxDates(Number(year));
      expect(astro.shunbun.toISOString().slice(0, 10)).toBe(dates.shunbun);
      expect(astro.shubun.toISOString().slice(0, 10)).toBe(dates.shubun);
    }
  });
});

describe("US observed-day rules (5 U.S.C. 6103)", () => {
  it("observes Saturday fixed-date holidays on the preceding Friday (golden 2026/2027)", () => {
    // Jul 4 2026 = Saturday, Juneteenth 2027 = Saturday, Christmas 2027 = Saturday.
    expect(isBusinessDay("2026-07-03", "US")).toBe(false);
    expect(isBusinessDay("2027-06-18", "US")).toBe(false);
    expect(isBusinessDay("2027-12-24", "US")).toBe(false);
  });

  it("observes Sunday fixed-date holidays on the following Monday", () => {
    expect(isBusinessDay("2027-07-05", "US")).toBe(false); // Jul 4 2027 = Sunday
  });

  it("observes a Saturday New Year's Day on the prior year's Dec 31 (cross-year golden 2021/2032)", () => {
    // Jan 1 2022 = Saturday -> observed Friday 2021-12-31; Jan 1 2033 =
    // Saturday -> observed Friday 2032-12-31. Both keys must live in the
    // visited date's own year's set, not only the following year's.
    expect(isBusinessDay("2021-12-31", "US")).toBe(false);
    expect(isBusinessDay("2032-12-31", "US")).toBe(false);
    // The surrounding days are ordinary business days.
    expect(isBusinessDay("2021-12-30", "US")).toBe(true);
    expect(isBusinessDay("2032-12-30", "US")).toBe(true);
  });

  it("does not fabricate observed days for midweek fixed-date holidays", () => {
    expect(isBusinessDay("2026-07-02", "US")).toBe(true);
    expect(isBusinessDay("2026-06-30", "US")).toBe(true);
  });

  it("removed Good Friday from the US federal set (not a federal holiday)", () => {
    // Good Friday 2026 (Easter Sunday is 2026-04-05) is a plain workday in the US…
    expect(isBusinessDay("2026-04-03", "US")).toBe(true);
    // …but remains a bank holiday in the UK and Germany.
    expect(isBusinessDay("2026-04-03", "UK")).toBe(false);
    expect(isBusinessDay("2026-04-03", "DE")).toBe(false);
  });
});

describe("UK substitute-day rules (England & Wales)", () => {
  it("substitutes a Saturday Boxing Day with the next available weekday (golden 2026-12-28)", () => {
    // Christmas 2026 = Friday (holiday), Boxing Day 2026 = Saturday
    // -> substitute bank holiday Monday 2026-12-28.
    expect(isBusinessDay("2026-12-28", "UK")).toBe(false);
    expect(isBusinessDay("2026-12-29", "UK")).toBe(true);
  });

  it("moved the 2025 Early May bank holiday to VE Day (8 May 2025)", () => {
    expect(isBusinessDay("2025-05-08", "UK")).toBe(false);
    expect(isBusinessDay("2025-05-05", "UK")).toBe(true); // 1st Monday, no longer a holiday
  });
});

describe("JP substitute-day rules (furikae kyujitsu)", () => {
  it("substitutes a Sunday Shunbun 2027 with Monday 2027-03-22", () => {
    expect(isBusinessDay("2027-03-22", "JP")).toBe(false);
  });

  it("substitutes Sunday Constitution Day 2026 past stacked Golden Week holidays onto 2026-05-06", () => {
    // 2026-05-03 (Sun) -> 5/4 Greenery and 5/5 Children's are themselves
    // holidays, so the substitute lands on Wednesday 5/6.
    expect(isBusinessDay("2026-05-06", "JP")).toBe(false);
  });

  it("substitutes the Sunday 2024 Autumnal Equinox (9/22) with Monday 9/23", () => {
    expect(isBusinessDay("2024-09-23", "JP")).toBe(false);
  });
});

describe("business-day math on real 2026 holiday weeks", () => {
  it('addBusinessDays("2026-06-29", 4, "US") skips the July 3 observed holiday -> 2026-07-06', () => {
    const result = addBusinessDays("2026-06-29", 4, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.endDate).toBe("2026-07-06");
  });

  it('countBusinessDays("2026-06-29", "2026-07-03", "US") counts 3 (July 3 observed)', () => {
    const result = countBusinessDays("2026-06-29", "2026-07-03", "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.businessDays).toBe(3);
  });
});

describe("holiday-set memoization and version stamp", () => {
  it("computes each (country, year) holiday set once across a multi-year walk", () => {
    holidayRegistry.clearHolidayCache();
    const before = holidayRegistry.holidayComputeCount();
    countBusinessDays("2024-01-01", "2027-12-31", "US"); // 4 distinct years
    const afterFirst = holidayRegistry.holidayComputeCount();
    expect(afterFirst - before).toBe(4);

    // Repeated walks over the same years must be all cache hits.
    countBusinessDays("2024-01-01", "2027-12-31", "US");
    countBusinessDays("2024-01-01", "2027-12-31", "US");
    expect(holidayRegistry.holidayComputeCount()).toBe(afterFirst);
  });

  it("stamps results with the calendar version", () => {
    const add = addBusinessDays("2026-05-01", 1, "US");
    const count = countBusinessDays("2026-05-04", "2026-05-08", "US");
    expect(add.ok && add.data.calendarVersion).toBe(CALENDAR_VERSION);
    expect(count.ok && count.data.calendarVersion).toBe(CALENDAR_VERSION);
  });
});
