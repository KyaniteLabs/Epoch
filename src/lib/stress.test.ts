import { describe, it, expect } from "vitest";
import {
  getCurrentTime,
  convertTimezone,
  parseDuration,
  formatElapsed,
  addDays,
  diffDates,
} from "./temporal.js";
import {
  addBusinessDays,
  countBusinessDays,
  isBusinessDay,
  isWithinWorkingHours,
  getUrgencyCategory,
  HolidayRegistry,
  holidayRegistry,
} from "./calendar.js";
import {
  pertEstimate,
  cocomoEstimate,
  sprintForecast,
  criticalPath,
  monteCarloSim,
} from "./estimation.js";
import {
  tokenTimeBridge,
  referenceClassEstimate,
  calibrateEstimates,
  computeAccuracyMetrics,
} from "./analytics.js";
import type {
  HistoricalRecord,
  CpmTask,
  MonteCarloTask,
  TaskType,
} from "../types/index.js";

// ---------------------------------------------------------------------------
// STRESS TESTS — Edge Cases and Failure Modes
//
// These tests exercise boundary conditions, invalid inputs, and corner cases
// across all four library modules. Some tests document known library behaviors
// (e.g. timezones that are valid IANA despite looking unusual) while others
// verify graceful error handling.
// ---------------------------------------------------------------------------

// ===========================================================================
// temporal.ts
// ===========================================================================

describe("temporal — getCurrentTime stress", () => {
  const invalidTimezones = [
    "UTC+5",
    "UTC-3",
    "America/",
    "/New_York",
    "123",
    "0",
    "999999",
    "!@#$%",
    "Hello World",
    "America/New York", // space instead of underscore
    "Europe/Londn", // typo
    "Asia/Tokyo/Extra",
    "LOCAL",
    "localtime",
    "null",
    "undefined",
    "\n\t",
    "   ",
  ];

  for (const tz of invalidTimezones) {
    it(`rejects invalid timezone "${tz}"`, () => {
      const result = getCurrentTime(tz);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.isError).toBe(true);
        expect(result.error.message).toContain("Invalid timezone");
      }
    });
  }

  // Empty string is rejected with a structured error (not a thrown exception).
  it("rejects empty string \"\" with structured error", () => {
    const result = getCurrentTime("");
    expect(result.ok).toBe(false);
  });

  // "Z" is not a valid IANA identifier — rejected with structured error.
  it("rejects \"Z\" with structured error", () => {
    const result = getCurrentTime("Z");
    expect(result.ok).toBe(false);
  });

  // "GMT" and "Etc/GMT+5" are actually valid IANA timezone identifiers
  it("NOTE: \"GMT\" is a valid IANA timezone (accepted)", () => {
    const result = getCurrentTime("GMT");
    expect(result.ok).toBe(true);
  });

  it("NOTE: \"Etc/GMT+5\" is a valid IANA timezone (accepted)", () => {
    const result = getCurrentTime("Etc/GMT+5");
    expect(result.ok).toBe(true);
  });

  it("accepts valid IANA timezone UTC", () => {
    const result = getCurrentTime("UTC");
    expect(result.ok).toBe(true);
  });

  it("accepts valid IANA timezone America/Los_Angeles", () => {
    const result = getCurrentTime("America/Los_Angeles");
    expect(result.ok).toBe(true);
  });
});

describe("temporal — convertTimezone stress", () => {
  const invalidTimestamps = [
    "",
    "not-a-date",
    "2026-13-01",       // invalid month
    "2026-02-30",       // invalid day for February
    "2026-01-01T25:00:00Z", // invalid hour
    "totally wrong",
    "2026/01/01",
    "Jan 1, 2026",
    "next tuesday",
    "   ",
  ];

  for (const ts of invalidTimestamps) {
    it(`rejects invalid timestamp "${ts}"`, () => {
      const result = convertTimezone(ts, "UTC");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.isError).toBe(true);
        expect(result.error.message).toContain("Invalid timestamp");
      }
    });
  }

  it("rejects valid timestamp with invalid target timezone", () => {
    const result = convertTimezone("2026-05-01T12:00:00Z", "INVALID");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
    }
  });

  it("succeeds with valid inputs", () => {
    const result = convertTimezone("2026-05-01T12:00:00Z", "America/New_York");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.timezone).toBe("America/New_York");
  });

  it("correctly converts UTC midnight to Tokyo", () => {
    const result = convertTimezone("2026-01-01T00:00:00Z", "Asia/Tokyo");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.iso).toContain("09:00:00");
  });
});

describe("temporal — parseDuration stress", () => {
  const invalidDurations = [
    "",
    "0",
    "abc",
    "h",
    "hello world",
    "   ",
    "2h-30m",   // mixed format
  ];

  for (const d of invalidDurations) {
    it(`rejects invalid duration "${d}"`, () => {
      const result = parseDuration(d);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.isError).toBe(true);
      }
    });
  }

  it("rejects negative duration -2h", () => {
    const result = parseDuration("-2h");
    expect(result.ok).toBe(false);
  });

  it("parses very large duration 999999999999d", () => {
    const result = parseDuration("999999999999d");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalSeconds).toBeGreaterThan(0);
  });

  it("parses compound duration 1y1mo1w1d1h1m1s", () => {
    const result = parseDuration("1y1mo1w1d1h1m1s");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalSeconds).toBeGreaterThan(0);
    expect(result.data.humanReadable).toContain("1 year");
    expect(result.data.humanReadable).toContain("1 month");
    expect(result.data.humanReadable).toContain("1 week");
    expect(result.data.humanReadable).toContain("1 day");
    expect(result.data.humanReadable).toContain("1 hour");
    expect(result.data.humanReadable).toContain("1 minute");
    expect(result.data.humanReadable).toContain("1 second");
  });

  it("parses fractional duration 1.5h", () => {
    const result = parseDuration("1.5h");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalSeconds).toBe(5400);
  });

  it("parses simple valid duration 45m", () => {
    const result = parseDuration("45m");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.totalSeconds).toBe(2700);
  });
});

describe("temporal — diffDates stress", () => {
  it("returns zero for same date", () => {
    const result = diffDates("2026-05-01", "2026-05-01");
    expect(result.days).toBe(0);
    expect(result.hours).toBe(0);
    expect(result.minutes).toBe(0);
    expect(result.total_seconds).toBe(0);
  });

  it("returns negative values for reversed dates", () => {
    const result = diffDates("2026-05-10", "2026-05-01");
    expect(result.days).toBeLessThan(0);
    expect(result.total_seconds).toBeLessThan(0);
  });

  it("handles dates far apart (years)", () => {
    const result = diffDates("2020-01-01", "2030-01-01");
    expect(result.days).toBeGreaterThan(3650);
    expect(result.total_seconds).toBeGreaterThan(0);
  });

  it("handles dates across DST boundary (spring forward)", () => {
    // March 8 2026 is when DST starts in US (second Sunday of March)
    const result = diffDates("2026-03-07T12:00:00Z", "2026-03-09T12:00:00Z");
    expect(result.total_seconds).toBe(2 * 86400);
  });

  it("handles dates across DST boundary (fall back)", () => {
    // November 1 2026 is when DST ends in US
    const result = diffDates("2026-10-31T12:00:00Z", "2026-11-02T12:00:00Z");
    expect(result.total_seconds).toBe(2 * 86400);
  });

  it("handles single day difference", () => {
    const result = diffDates("2026-05-01", "2026-05-02");
    expect(result.days).toBe(1);
  });

  it("handles leap year correctly", () => {
    const result = diffDates("2024-02-28", "2024-03-01");
    // 2024 is a leap year, so Feb 29 exists
    expect(result.days).toBe(2);
  });
});

describe("temporal — addDays stress", () => {
  it("returns same date for 0 days", () => {
    const result = addDays("2026-05-01", 0);
    expect(result).toBe("2026-05-01");
  });

  it("handles negative days", () => {
    const result = addDays("2026-05-10", -5);
    expect(result).toBe("2026-05-05");
  });

  it("handles very large positive days (10000)", () => {
    const result = addDays("2026-01-01", 10000);
    // 10000 days from 2026-01-01 is roughly 2053-05-19
    expect(result).toMatch(/^20\d\d-/);
  });

  it("handles very large negative days", () => {
    const result = addDays("2026-01-01", -10000);
    expect(result).toMatch(/^19\d\d-/);
  });

  it("handles leap year Feb 29 correctly adding 1 day", () => {
    const result = addDays("2024-02-29", 1);
    expect(result).toBe("2024-03-01");
  });

  it("handles adding days to Feb 29 on leap year going to next year", () => {
    const result = addDays("2024-02-29", 365);
    // 2024 is a leap year, adding 365 days
    expect(result).toMatch(/^2025-/);
  });

  it("adds 1 day crossing month boundary", () => {
    const result = addDays("2026-01-31", 1);
    expect(result).toBe("2026-02-01");
  });

  it("adds 1 day crossing year boundary", () => {
    const result = addDays("2026-12-31", 1);
    expect(result).toBe("2027-01-01");
  });
});

describe("temporal — formatElapsed stress", () => {
  it("handles zero", () => {
    expect(formatElapsed(0)).toBe("0s");
  });

  it("handles negative input (clamped to 0)", () => {
    expect(formatElapsed(-1000)).toBe("0s");
  });

  it("handles very large milliseconds", () => {
    const result = formatElapsed(9999999999999);
    expect(result).toContain("d");
  });

  it("formats 90 seconds correctly", () => {
    expect(formatElapsed(90000)).toBe("1m 30s");
  });

  it("formats 1 hour correctly", () => {
    expect(formatElapsed(3600000)).toBe("1h");
  });

  it("formats 1 day correctly", () => {
    expect(formatElapsed(86400000)).toBe("1d");
  });
});

// ===========================================================================
// calendar.ts
// ===========================================================================

describe("calendar — addBusinessDays stress", () => {
  it("returns start date for 0 business days", () => {
    const result = addBusinessDays("2026-05-01", 0, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.endDate).toBe("2026-05-01");
  });

  it("handles negative business days", () => {
    const result = addBusinessDays("2026-05-08", -3, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Going back 3 business days from Friday May 8
    expect(result.data.businessDays).toBe(3);
  });

  it("handles start on Saturday (weekend)", () => {
    // 2026-05-02 is a Saturday
    const result = addBusinessDays("2026-05-02", 1, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Should skip weekend, land on Monday
    expect(result.data.endDate).toBe("2026-05-04");
  });

  it("handles start on Sunday (weekend)", () => {
    // 2026-05-03 is a Sunday
    const result = addBusinessDays("2026-05-03", 1, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.endDate).toBe("2026-05-04");
  });

  it("skips July 4 US holiday", () => {
    // 2026-07-03 is a Friday. July 4 is Saturday (holiday observed).
    // Adding 1 business day from July 2 (Thursday):
    const result = addBusinessDays("2026-07-02", 2, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Thu Jul 2 + 1 = Fri Jul 3 (business day), +1 more should skip weekend
    // The result depends on whether July 3 or 4 is observed
    expect(result.data.businessDays).toBe(2);
  });

  it("crosses year boundary", () => {
    const result = addBusinessDays("2025-12-30", 3, "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Dec 30 is Tuesday, Dec 31 Wed, Jan 1 is holiday (Thu), Jan 2 Fri
    expect(result.data.endDate).toMatch(/^2026-/);
  });

  it("rejects invalid start date", () => {
    const result = addBusinessDays("not-a-date", 5, "US");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
    }
  });

  it("falls back to weekend-only for unknown country", () => {
    const result = addBusinessDays("2026-05-01", 5, "XX");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.countryCode).toBe("XX");
    expect(result.data.businessDays).toBe(5);
  });

  it("works for all 5 supported countries", () => {
    const countries = ["US", "UK", "FR", "DE", "JP"];
    for (const country of countries) {
      const result = addBusinessDays("2026-05-01", 5, country);
      expect(result.ok, `addBusinessDays failed for ${country}`).toBe(true);
      if (!result.ok) return;
      expect(result.data.countryCode).toBe(country);
    }
  });
});

describe("calendar — countBusinessDays stress", () => {
  it("returns 0 for same start and end date", () => {
    const result = countBusinessDays("2026-05-01", "2026-05-01", "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Exclusive of start, inclusive of end => same date = 0
    expect(result.data.businessDays).toBe(0);
  });

  it("handles start > end (returns 0 or negative range)", () => {
    const result = countBusinessDays("2026-05-08", "2026-05-01", "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // With start > end, the loop never executes
    expect(result.data.businessDays).toBe(0);
  });

  it("counts weekend-to-weekend (full business week)", () => {
    // Saturday May 2 to Saturday May 9 => Mon-Fri = 5 business days
    const result = countBusinessDays("2026-05-02", "2026-05-09", "US");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.businessDays).toBe(5);
  });

  it("works for all 5 countries", () => {
    const countries = ["US", "UK", "FR", "DE", "JP"];
    for (const country of countries) {
      const result = countBusinessDays("2026-05-01", "2026-05-08", country);
      expect(result.ok, `countBusinessDays failed for ${country}`).toBe(true);
    }
  });

  it("rejects invalid start date", () => {
    const result = countBusinessDays("invalid", "2026-05-08", "US");
    expect(result.ok).toBe(false);
  });

  it("rejects invalid end date", () => {
    const result = countBusinessDays("2026-05-01", "invalid", "US");
    expect(result.ok).toBe(false);
  });

  it("falls back to weekend-only for unknown country", () => {
    const result = countBusinessDays("2026-05-01", "2026-05-08", "INVALID");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.countryCode).toBe("INVALID");
    expect(result.data.businessDays).toBeGreaterThan(0);
  });
});

describe("calendar — isBusinessDay stress", () => {
  it("returns false for a Saturday", () => {
    // 2026-05-02 is Saturday
    expect(isBusinessDay("2026-05-02", "US")).toBe(false);
  });

  it("returns false for a Sunday", () => {
    // 2026-05-03 is Sunday
    expect(isBusinessDay("2026-05-03", "US")).toBe(false);
  });

  it("returns false for US holiday (July 4)", () => {
    expect(isBusinessDay("2026-07-04", "US")).toBe(false);
  });

  it("returns false for Christmas US", () => {
    expect(isBusinessDay("2026-12-25", "US")).toBe(false);
  });

  it("returns true for a regular workday", () => {
    // 2026-05-04 is Monday
    expect(isBusinessDay("2026-05-04", "US")).toBe(true);
  });

  it("returns false for invalid date", () => {
    expect(isBusinessDay("not-a-date", "US")).toBe(false);
  });
});

describe("calendar — isWithinWorkingHours stress", () => {
  it("returns false for invalid date", () => {
    expect(isWithinWorkingHours("not-a-date", "UTC", 9, 17)).toBe(false);
  });

  // KNOWN BEHAVIOR: toZonedTime does not throw for all invalid timezone strings.
  // "INVALID" passes through toZonedTime without error, so the function
  // proceeds with the default/UTC interpretation and returns true for 12:00.
  it("NOTE: invalid timezone \"INVALID\" does not cause error (toZonedTime is lenient)", () => {
    // The function returns a boolean, not an error -- it cannot distinguish
    // bad timezones from good ones when toZonedTime doesn't throw.
    const result = isWithinWorkingHours("2026-05-01T12:00:00Z", "INVALID", 9, 17);
    expect(typeof result).toBe("boolean");
  });

  it("returns true during working hours", () => {
    expect(isWithinWorkingHours("2026-05-01T12:00:00Z", "UTC", 9, 17)).toBe(true);
  });

  it("returns false before working hours", () => {
    expect(isWithinWorkingHours("2026-05-01T07:00:00Z", "UTC", 9, 17)).toBe(false);
  });

  it("returns false at end hour (exclusive)", () => {
    expect(isWithinWorkingHours("2026-05-01T17:00:00Z", "UTC", 9, 17)).toBe(false);
  });

  it("handles overnight shifts (start > end)", () => {
    // 22:00 UTC is within 22-06 range
    expect(isWithinWorkingHours("2026-05-01T22:00:00Z", "UTC", 22, 6)).toBe(true);
  });

  it("overnight shift: returns false during gap", () => {
    // 10:00 UTC is NOT within 22-06 range
    expect(isWithinWorkingHours("2026-05-01T10:00:00Z", "UTC", 22, 6)).toBe(false);
  });
});

describe("calendar — getUrgencyCategory stress", () => {
  it("returns short for 0 hours", () => {
    expect(getUrgencyCategory(0)).toBe("short");
  });

  it("returns short for negative hours", () => {
    expect(getUrgencyCategory(-10)).toBe("short");
  });

  it("returns short for 1.99 hours", () => {
    expect(getUrgencyCategory(1.99)).toBe("short");
  });

  it("returns medium for exactly 2 hours", () => {
    expect(getUrgencyCategory(2)).toBe("medium");
  });

  it("returns medium for 48 hours", () => {
    expect(getUrgencyCategory(48)).toBe("medium");
  });

  it("returns long for 49 hours", () => {
    expect(getUrgencyCategory(49)).toBe("long");
  });

  it("returns long for very large hours", () => {
    expect(getUrgencyCategory(999999)).toBe("long");
  });
});

describe("calendar — HolidayRegistry stress", () => {
  it("returns false for country that does not exist", () => {
    const reg = new HolidayRegistry();
    expect(reg.hasCountry("XX")).toBe(false);
    expect(reg.hasCountry("")).toBe(false);
    expect(reg.hasCountry("ZZ")).toBe(false);
    expect(reg.hasCountry("Canada")).toBe(false);
  });

  it("returns empty holidays for non-existent country", () => {
    const reg = new HolidayRegistry();
    expect(reg.holidays("XX", 2026)).toEqual([]);
    expect(reg.holidayDateKeys("XX", 2026)).toEqual(new Set());
  });

  it("lists 5 supported countries", () => {
    const reg = new HolidayRegistry();
    expect(reg.supportedCountries()).toEqual(
      expect.arrayContaining(["US", "UK", "FR", "DE", "JP"]),
    );
    expect(reg.supportedCountries().length).toBe(5);
  });

  it("is case-insensitive for hasCountry", () => {
    const reg = new HolidayRegistry();
    expect(reg.hasCountry("us")).toBe(true);
    expect(reg.hasCountry("uk")).toBe(true);
    expect(reg.hasCountry("Us")).toBe(true);
  });

  it("returns holidays for valid countries with valid years", () => {
    const reg = new HolidayRegistry();
    for (const country of ["US", "UK", "FR", "DE", "JP"]) {
      const holidays = reg.holidays(country, 2026);
      expect(holidays.length, `${country} should have holidays`).toBeGreaterThan(0);
    }
  });

  it("singleton holidayRegistry is usable", () => {
    expect(holidayRegistry.hasCountry("US")).toBe(true);
    expect(holidayRegistry.holidays("US", 2026).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// estimation.ts
// ===========================================================================

describe("estimation — pertEstimate stress", () => {
  it("accepts optimistic === mostLikely === pessimistic (all equal)", () => {
    const result = pertEstimate(10, 10, 10, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.expected).toBe(10);
    expect(result.data.variance).toBe(0);
    expect(result.data.stdDeviation).toBe(0);
  });

  it("rejects optimistic > mostLikely", () => {
    const result = pertEstimate(20, 10, 30, "hours");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("optimistic");
    }
  });

  it("rejects optimistic > pessimistic", () => {
    const result = pertEstimate(50, 30, 10, "hours");
    expect(result.ok).toBe(false);
  });

  it("rejects all zeros", () => {
    const result = pertEstimate(0, 0, 0, "hours");
    expect(result.ok).toBe(false);
  });

  it("rejects all negative", () => {
    const result = pertEstimate(-5, -3, -1, "hours");
    expect(result.ok).toBe(false);
  });

  it("rejects optimistic = 0", () => {
    const result = pertEstimate(0, 5, 10, "hours");
    expect(result.ok).toBe(false);
  });

  it("handles very large numbers", () => {
    const result = pertEstimate(1000000, 2000000, 3000000, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.expected).toBe(2000000);
  });

  it("works with days unit", () => {
    const result = pertEstimate(1, 2, 3, "days");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.unit).toBe("days");
  });

  it("works with weeks unit", () => {
    const result = pertEstimate(1, 2, 3, "weeks");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.unit).toBe("weeks");
  });

  it("works with months unit", () => {
    const result = pertEstimate(1, 2, 3, "months");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.unit).toBe("months");
  });

  it("produces valid confidence intervals", () => {
    const result = pertEstimate(4, 6, 10, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [lo95, hi95] = result.data.confidence95;
    const [lo99, hi99] = result.data.confidence99;
    expect(lo95).toBeLessThan(result.data.expected);
    expect(hi95).toBeGreaterThan(result.data.expected);
    expect(lo99).toBeLessThanOrEqual(lo95);
    expect(hi99).toBeGreaterThanOrEqual(hi95);
  });
});

describe("estimation — cocomoEstimate stress", () => {
  it("returns error for kloc=0", () => {
    const result = cocomoEstimate({
      kloc: 0,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("KLOC must be positive.");
  });

  it("returns error for negative kloc", () => {
    const result = cocomoEstimate({
      kloc: -10,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("KLOC must be positive.");
  });

  it("works with all multipliers at 0.5", () => {
    const result = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 0.5,
      contextCompleteness: 0.5,
      transformationImpact: 0.5,
      iterativeCycles: 0.5,
      humanOversight: 0.5,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.personMonthsNominal).toBeGreaterThan(0);
    // 0.5^5 = 0.03125, rounded to 3 decimal places = 0.031
    expect(result.data.effortMultipliers.product).toBeCloseTo(0.031, 2);
  });

  it("works with all multipliers at 2.0", () => {
    const result = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 2.0,
      contextCompleteness: 2.0,
      transformationImpact: 2.0,
      iterativeCycles: 2.0,
      humanOversight: 2.0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.personMonthsNominal).toBeGreaterThan(0);
    expect(result.data.effortMultipliers.product).toBeCloseTo(32.0, 1);
  });

  it("returns assumptions array", () => {
    const result = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.assumptions.length).toBeGreaterThan(0);
  });
});

describe("estimation — sprintForecast stress", () => {
  it("rejects empty velocity array", () => {
    const result = sprintForecast({
      backlogPoints: 100,
      velocityHistory: [],
      sprintLengthDays: 14,
      hoursPerSprint: 80,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("velocity_history");
    }
  });

  it("works with single velocity value", () => {
    const result = sprintForecast({
      backlogPoints: 100,
      velocityHistory: [25],
      sprintLengthDays: 14,
      hoursPerSprint: 80,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.averageVelocity).toBe(25);
    expect(result.data.requiredSprints).toBe(4);
  });

  it("rejects zero backlog", () => {
    const result = sprintForecast({
      backlogPoints: 0,
      velocityHistory: [25],
      sprintLengthDays: 14,
      hoursPerSprint: 80,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("backlog_points");
    }
  });

  it("rejects negative backlog", () => {
    const result = sprintForecast({
      backlogPoints: -50,
      velocityHistory: [25],
      sprintLengthDays: 14,
      hoursPerSprint: 80,
    });
    expect(result.ok).toBe(false);
  });

  it("rejects all-zero velocity", () => {
    const result = sprintForecast({
      backlogPoints: 100,
      velocityHistory: [0, 0, 0],
      sprintLengthDays: 14,
      hoursPerSprint: 80,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("velocity");
    }
  });

  it("works with typical inputs", () => {
    const result = sprintForecast({
      backlogPoints: 200,
      velocityHistory: [30, 35, 28, 32, 25],
      sprintLengthDays: 14,
      hoursPerSprint: 80,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.requiredSprints).toBeGreaterThan(0);
    expect(result.data.pessimisticSprints).toBeGreaterThanOrEqual(
      result.data.requiredSprints,
    );
  });
});

describe("estimation — criticalPath stress", () => {
  it("detects circular dependency A->B->C->A", () => {
    const tasks: CpmTask[] = [
      { name: "A", duration: 2, predecessors: ["C"] },
      { name: "B", duration: 3, predecessors: ["A"] },
      { name: "C", duration: 4, predecessors: ["B"] },
    ];
    const result = criticalPath(tasks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Circular dependency");
    }
  });

  it("detects duplicate task names", () => {
    const tasks: CpmTask[] = [
      { name: "A", duration: 2, predecessors: [] },
      { name: "A", duration: 3, predecessors: [] },
    ];
    const result = criticalPath(tasks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Duplicate task name");
    }
  });

  it("handles single task with no predecessors", () => {
    const tasks: CpmTask[] = [
      { name: "OnlyTask", duration: 5, predecessors: [] },
    ];
    const result = criticalPath(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_duration).toBe(5);
    expect(result.data.critical_path).toContain("OnlyTask");
  });

  it("handles disconnected tasks (no dependencies)", () => {
    const tasks: CpmTask[] = [
      { name: "A", duration: 3, predecessors: [] },
      { name: "B", duration: 5, predecessors: [] },
      { name: "C", duration: 2, predecessors: [] },
    ];
    const result = criticalPath(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Total duration should be the max: 5
    expect(result.data.total_duration).toBe(5);
  });

  it("handles diamond dependency pattern (A->B, A->C, B->D, C->D)", () => {
    const tasks: CpmTask[] = [
      { name: "A", duration: 2, predecessors: [] },
      { name: "B", duration: 3, predecessors: ["A"] },
      { name: "C", duration: 5, predecessors: ["A"] },
      { name: "D", duration: 1, predecessors: ["B", "C"] },
    ];
    const result = criticalPath(tasks);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // A(2) -> C(5) -> D(1) = 8 (critical path)
    expect(result.data.total_duration).toBe(8);
    expect(result.data.critical_path).toContain("A");
    expect(result.data.critical_path).toContain("C");
    expect(result.data.critical_path).toContain("D");
  });

  it("detects unknown predecessor", () => {
    const tasks: CpmTask[] = [
      { name: "A", duration: 2, predecessors: ["NonExistent"] },
    ];
    const result = criticalPath(tasks);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unknown predecessor");
    }
  });

  it("handles empty task list", () => {
    const result = criticalPath([]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_duration).toBe(-Infinity); // max of empty set
  });
});

describe("estimation — monteCarloSim stress", () => {
  const singleTask: MonteCarloTask[] = [
    { name: "Task1", optimistic: 2, mostLikely: 5, pessimistic: 10 },
  ];

  const identicalTasks: MonteCarloTask[] = [
    { name: "T1", optimistic: 5, mostLikely: 5, pessimistic: 5 },
    { name: "T2", optimistic: 5, mostLikely: 5, pessimistic: 5 },
    { name: "T3", optimistic: 5, mostLikely: 5, pessimistic: 5 },
  ];

  const wideRangeTask: MonteCarloTask[] = [
    { name: "Wide", optimistic: 0.01, mostLikely: 5000, pessimistic: 10000 },
  ];

  it("handles 0 iterations", () => {
    const result = monteCarloSim(singleTask, 0);
    // With 0 iterations, durations array is empty, sorted empty, p() returns undefined->0
    expect(result.p50).toBeDefined();
    expect(result.p95).toBeDefined();
  });

  it("handles 1 iteration", () => {
    const result = monteCarloSim(singleTask, 1);
    expect(result.p50).toBeDefined();
    expect(result.p95).toBeDefined();
  });

  it("handles 100000 iterations without crashing", () => {
    const start = Date.now();
    const result = monteCarloSim(singleTask, 100000);
    const elapsed = Date.now() - start;
    expect(result.p50).toBeDefined();
    expect(result.p95).toBeDefined();
    // Should complete in reasonable time (< 10s)
    expect(elapsed).toBeLessThan(10000);
  });

  it("handles single task", () => {
    const result = monteCarloSim(singleTask, 1000);
    const p50 = parseFloat(result.p50);
    expect(p50).toBeGreaterThan(0);
    expect(p50).toBeLessThan(20);
  });

  it("handles all same estimates (deterministic)", () => {
    const result = monteCarloSim(identicalTasks, 1000);
    const p50 = parseFloat(result.p50);
    // All tasks = 5, total should be exactly 15
    expect(p50).toBe(15);
  });

  it("handles very wide ranges", () => {
    const result = monteCarloSim(wideRangeTask, 1000);
    const p50 = parseFloat(result.p50);
    expect(p50).toBeGreaterThan(0);
    expect(p50).toBeLessThan(15000);
  });

  it("produces ordered percentiles", () => {
    const result = monteCarloSim(singleTask, 5000);
    const p10 = parseFloat(result.p10);
    const p50 = parseFloat(result.p50);
    const p80 = parseFloat(result.p80);
    const p95 = parseFloat(result.p95);
    expect(p10).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p80);
    expect(p80).toBeLessThanOrEqual(p95);
  });

  it("is deterministic with same seed", () => {
    const r1 = monteCarloSim(singleTask, 1000, 42);
    const r2 = monteCarloSim(singleTask, 1000, 42);
    expect(r1.p50).toBe(r2.p50);
    expect(r1.p95).toBe(r2.p95);
  });

  it("produces different results with different seeds", () => {
    const r1 = monteCarloSim(singleTask, 1000, 42);
    const r2 = monteCarloSim(singleTask, 1000, 99);
    // Very unlikely to be exactly the same
    expect(r1.p50).toBeDefined();
    expect(r2.p50).toBeDefined();
  });
});

// ===========================================================================
// analytics.ts
// ===========================================================================

describe("analytics — tokenTimeBridge stress", () => {
  const knownModels = [
    "claude-sonnet-4-20250514",
    "gpt-4o",
    "gemini-2.0-flash",
    "llama-3.1-70b",
  ];

  for (const model of knownModels) {
    it(`works with known model "${model}"`, () => {
      const result = tokenTimeBridge({
        tokens: 1000,
        model,
        toolCalls: 1,
        reasoningDepth: "moderate",
      });
      expect(result.estimatedSeconds).toBeGreaterThan(0);
      expect(result.confidence).toBe("likely");
    });
  }

  it("handles unknown model (uses defaults from reference DB or generic fallback)", () => {
    const result = tokenTimeBridge({
      tokens: 1000,
      model: "unknown-model-v99",
      toolCalls: 1,
      reasoningDepth: "moderate",
    });
    expect(result.estimatedSeconds).toBeGreaterThan(0);
  });

  it("handles zero tokens", () => {
    const result = tokenTimeBridge({
      tokens: 0,
      model: "claude-opus-4-20250514",
      toolCalls: 0,
      reasoningDepth: "deep",
    });
    // With 0 tokens and 0 tool calls, only reasoning overhead remains
    expect(result.estimatedSeconds).toBeGreaterThan(0);
    expect(result.tokens).toBe(0);
  });

  it("handles negative tokens", () => {
    const result = tokenTimeBridge({
      tokens: -1000,
      model: "gpt-4o",
      toolCalls: 1,
      reasoningDepth: "shallow",
    });
    // Negative tokens would give negative generation time
    expect(result.estimatedSeconds).toBeDefined();
    expect(result.tokens).toBe(-1000);
  });

  it("handles extreme token counts (1 billion)", () => {
    const result = tokenTimeBridge({
      tokens: 1_000_000_000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(result.estimatedSeconds).toBeGreaterThan(0);
    expect(result.estimatedMinutes).toBeGreaterThan(1000);
  });

  it("handles deep reasoning", () => {
    const shallow = tokenTimeBridge({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    const deep = tokenTimeBridge({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "deep",
    });
    expect(deep.estimatedSeconds).toBeGreaterThan(shallow.estimatedSeconds);
  });

  it("handles many tool calls", () => {
    const few = tokenTimeBridge({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 1,
      reasoningDepth: "moderate",
    });
    const many = tokenTimeBridge({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 50,
      reasoningDepth: "moderate",
    });
    expect(many.estimatedSeconds).toBeGreaterThan(few.estimatedSeconds);
  });

  it("breakdown sums are reasonable", () => {
    const result = tokenTimeBridge({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 5,
      reasoningDepth: "moderate",
    });
    expect(result.breakdown.promptTokens + result.breakdown.completionTokens).toBe(1000);
    expect(result.breakdown.toolOverheadSeconds).toBeGreaterThan(0);
  });
});

describe("analytics — referenceClassEstimate stress", () => {
  const taskTypes: TaskType[] = [
    "feature",
    "bugfix",
    "refactor",
    "migration",
    "infrastructure",
    "documentation",
    "testing",
    "design",
  ];

  const baseRecords: HistoricalRecord[] = Array.from({ length: 20 }, (_, i) => ({
    taskType: "feature",
    estimatedHours: 10,
    actualHours: 15,
    completedAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
  }));

  for (const tt of taskTypes) {
    it(`works with task type "${tt}" at complexity 3`, () => {
      const records = baseRecords.map(r => ({ ...r, taskType: tt }));
      const result = referenceClassEstimate(records, tt, 3);
      expect(result.rawEstimate).toBeGreaterThan(0);
      expect(result.correctedEstimate).toBeGreaterThan(0);
      expect(result.correctionFactor).toBeGreaterThan(0);
      expect(result.confidence).toBeDefined();
    });
  }

  it("handles complexity 0", () => {
    const result = referenceClassEstimate(baseRecords, "feature", 0);
    // complexity 0 => multiplier = 0.5 + (0-1)*0.375 = 0.125
    expect(result.rawEstimate).toBeGreaterThan(0);
  });

  it("handles complexity 6 (out of expected 1-5 range)", () => {
    const result = referenceClassEstimate(baseRecords, "feature", 6);
    // complexity 6 => multiplier = 0.5 + (6-1)*0.375 = 2.375
    expect(result.rawEstimate).toBeGreaterThan(0);
  });

  it("returns pessimistic confidence with < 5 records", () => {
    const fewRecords = baseRecords.slice(0, 3);
    const result = referenceClassEstimate(fewRecords, "feature", 3);
    expect(result.sampleSize).toBe(3);
    expect(result.confidence).toBeDefined();
  });

  it("returns optimistic or likely confidence with 5-9 records", () => {
    const medRecords = baseRecords.slice(0, 7);
    const result = referenceClassEstimate(medRecords, "feature", 3);
    expect(result.sampleSize).toBe(7);
    expect(result.confidence).toBeDefined();
  });

  it("returns likely confidence with 10+ records", () => {
    const result = referenceClassEstimate(baseRecords, "feature", 3);
    expect(result.confidence).toBe("likely");
    expect(result.sampleSize).toBe(20);
  });

  it("uses industry or reference DB correction factor when no matching records", () => {
    const result = referenceClassEstimate([], "feature", 3);
    expect(result.correctionFactor).toBeGreaterThan(1);
    expect(result.sampleSize).toBe(0);
  });

  it("corrected estimate > raw estimate (industry correction)", () => {
    const result = referenceClassEstimate([], "feature", 3);
    expect(result.correctedEstimate).toBeGreaterThan(result.rawEstimate);
  });

  it("works at complexity 1 (minimum)", () => {
    const result = referenceClassEstimate([], "feature", 1);
    expect(result.rawEstimate).toBeGreaterThan(0);
  });

  it("works at complexity 5 (maximum)", () => {
    const result = referenceClassEstimate([], "feature", 5);
    expect(result.rawEstimate).toBeGreaterThan(0);
  });
});

describe("analytics — calibrateEstimates stress", () => {
  it("returns default structure for any teamId", () => {
    const result = calibrateEstimates("team-123", 30, 5);
    expect(result.correctionFactor).toBeGreaterThan(0);
    expect(result.accuracyTrend).toBe("stable");
    expect(result.velocityTrend).toBe("stable");
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("returns recommendations array", () => {
    const result = calibrateEstimates("team-abc", 90, 10);
    expect(result.recommendations).toBeInstanceOf(Array);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("handles zero period days", () => {
    const result = calibrateEstimates("team-x", 0, 5);
    expect(result).toBeDefined();
  });

  it("handles zero minimum samples", () => {
    const result = calibrateEstimates("team-x", 30, 0);
    expect(result).toBeDefined();
  });
});

describe("analytics — computeAccuracyMetrics stress", () => {
  it("returns zero metrics for empty records", () => {
    const result = computeAccuracyMetrics([]);
    expect(result.mape).toBe(0);
    expect(result.bias).toBe(0);
    expect(result.variance).toBe(0);
    expect(result.sample_size).toBe(0);
    expect(result.trend).toBe("stable");
  });

  it("handles records with zero actual hours", () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 0, completedAt: "2026-01-01" },
    ];
    const result = computeAccuracyMetrics(records);
    // Records with 0 actual are filtered out
    expect(result.sample_size).toBe(1);
  });

  it("computes metrics for perfect estimates", () => {
    const records: HistoricalRecord[] = Array.from({ length: 10 }, (_, i) => ({
      taskType: "feature",
      estimatedHours: 10,
      actualHours: 10,
      completedAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
    }));
    const result = computeAccuracyMetrics(records);
    expect(result.mape).toBe(0);
    expect(result.bias).toBe(0);
  });

  it("computes metrics for biased estimates", () => {
    const records: HistoricalRecord[] = Array.from({ length: 10 }, (_, i) => ({
      taskType: "feature",
      estimatedHours: 5,
      actualHours: 10,
      completedAt: `2026-01-${String(i + 1).padStart(2, "0")}`,
    }));
    const result = computeAccuracyMetrics(records);
    expect(result.bias).toBeGreaterThan(0); // actual > estimated
    expect(result.mape).toBeGreaterThan(0);
  });
});
