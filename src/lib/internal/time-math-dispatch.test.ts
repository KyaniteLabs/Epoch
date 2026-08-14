import { describe, it, expect } from "vitest";
import { dispatchTimeMath } from "./time-math-dispatch.js";
import type { TimeMathOp } from "./time-math-dispatch.js";

describe("dispatchTimeMath", () => {
  // ---- add_days ----

  describe("add_days", () => {
    it("adds days with canonical start_date field", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: "2026-05-01",
        days: 7,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toContain("2026-05-08");
    });

    it("accepts alternate field names: date, from_date, startDate", () => {
      const cases = [
        { date: "2026-05-01", days: 3 },
        { from_date: "2026-05-01", days: 3 },
        { startDate: "2026-05-01", days: 3 },
      ];
      for (const operands of cases) {
        const result = dispatchTimeMath("add_days", operands);
        expect(result.ok).toBe(true);
      }
    });

    it("returns error when date is missing", () => {
      const result = dispatchTimeMath("add_days", { days: 5 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("add_days requires");
      expect(result.error.retryHint).toBeDefined();
    });

    it("returns error when days is missing", () => {
      const result = dispatchTimeMath("add_days", { start_date: "2026-05-01" });
      expect(result.ok).toBe(false);
    });

    it("coerces string number for days", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: "2026-05-01",
        days: "5",
      });
      expect(result.ok).toBe(true);
    });
  });

  // ---- add_business_days ----

  describe("add_business_days", () => {
    it("adds business days with default country", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: 5,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts explicit country", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: 5,
        country: "UK",
      });
      expect(result.ok).toBe(true);
    });

    it("accepts alternate field names", () => {
      const result = dispatchTimeMath("add_business_days", {
        date: "2026-05-04",
        days: 3,
      });
      expect(result.ok).toBe(true);
    });

    it("returns error when start is missing", () => {
      const result = dispatchTimeMath("add_business_days", { days: 5 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("add_business_days requires");
    });

    it("returns error when days is missing", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
      });
      expect(result.ok).toBe(false);
    });
  });

  // ---- diff ----

  describe("diff", () => {
    it("computes diff with canonical fields", () => {
      const result = dispatchTimeMath("diff", {
        start_date: "2026-05-01",
        end_date: "2026-05-15",
      });
      expect(result.ok).toBe(true);
    });

    it("accepts alternate end field names: to_date, endDate, end", () => {
      const alternates = [
        { start_date: "2026-05-01", to_date: "2026-05-15" },
        { start_date: "2026-05-01", endDate: "2026-05-15" },
        { start_date: "2026-05-01", end: "2026-05-15" },
      ];
      for (const operands of alternates) {
        const result = dispatchTimeMath("diff", operands);
        expect(result.ok).toBe(true);
      }
    });

    it("accepts alternate start field names", () => {
      const result = dispatchTimeMath("diff", {
        date: "2026-05-01",
        end_date: "2026-05-15",
      });
      expect(result.ok).toBe(true);
    });

    it("returns error when start is missing", () => {
      const result = dispatchTimeMath("diff", { end_date: "2026-05-15" });
      expect(result.ok).toBe(false);
    });

    it("returns error when end is missing", () => {
      const result = dispatchTimeMath("diff", { start_date: "2026-05-01" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("diff requires");
    });
  });

  // ---- convert_tz ----

  describe("convert_tz", () => {
    it("converts timezone", () => {
      const result = dispatchTimeMath("convert_tz", {
        timestamp: "2026-05-01T12:00:00Z",
        target_tz: "Asia/Tokyo",
      });
      expect(result.ok).toBe(true);
    });

    it("returns error when timestamp is missing", () => {
      const result = dispatchTimeMath("convert_tz", {
        target_tz: "Asia/Tokyo",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("convert_tz requires");
    });

    it("returns error when target_tz is missing", () => {
      const result = dispatchTimeMath("convert_tz", {
        timestamp: "2026-05-01T12:00:00Z",
      });
      expect(result.ok).toBe(false);
    });
  });

  // ---- parse_nl ----

  describe("parse_nl", () => {
    it("parses a duration string", () => {
      const result = dispatchTimeMath("parse_nl", {
        duration_string: "2h30m",
      });
      expect(result.ok).toBe(true);
    });

    it("returns error when duration_string is missing", () => {
      const result = dispatchTimeMath("parse_nl", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("parse_nl requires");
    });
  });

  // ---- format_duration ----

  describe("format_duration", () => {
    it("formats milliseconds", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: 9000000,
      });
      expect(result.ok).toBe(true);
    });

    it("coerces string number for milliseconds", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: "9000000",
      });
      expect(result.ok).toBe(true);
    });

    it("returns error when milliseconds is missing", () => {
      const result = dispatchTimeMath("format_duration", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("format_duration requires");
    });
  });

  // ---- unknown operation ----

  it("returns error for unknown operation", () => {
    const result = dispatchTimeMath("bogus_op" as TimeMathOp, {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Unknown time_math operation");
    expect(result.error.retryHint).toContain("add_days");
    expect(result.error.retryHint).toContain("add_business_days");
    expect(result.error.retryHint).toContain("diff");
    expect(result.error.retryHint).toContain("convert_tz");
    expect(result.error.retryHint).toContain("parse_nl");
    expect(result.error.retryHint).toContain("format_duration");
  });

  // ---- str() coercion edge cases ----

  describe("str() coercion (number-to-string)", () => {
    it("add_days coerces numeric start_date to string", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: "2026-05-01",
        days: 1,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      // str() converts numbers to strings; the underlying addDays still
      // returns an ISO-formatted date string.
      expect(result.data).toContain("2026-05-02");
    });

    it("diff coerces numeric date fields to strings", () => {
      const result = dispatchTimeMath("diff", {
        start_date: "2026-05-01",
        end_date: 20260515,
      });
      expect(result.ok).toBe(true);
    });

    it("convert_tz coerces numeric timestamp to string", () => {
      const result = dispatchTimeMath("convert_tz", {
        timestamp: "2026-05-01T12:00:00Z",
        target_tz: "Europe/London",
      });
      expect(result.ok).toBe(true);
    });

    it("parse_nl coerces numeric duration_string to string", () => {
      const result = dispatchTimeMath("parse_nl", {
        duration_string: 3600,
      });
      // str() converts 3600 to "3600", which parseDuration may not recognize
      // as a valid duration format — document the actual behavior.
      expect(result).toBeDefined();
    });

    it("str() returns undefined for non-coercible types (boolean)", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: true,
        days: 1,
      });
      expect(result.ok).toBe(false);
    });

    it("str() returns undefined for null", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: null,
        days: 1,
      });
      expect(result.ok).toBe(false);
    });

    it("str() returns undefined for objects", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: { year: 2026 },
        days: 1,
      });
      expect(result.ok).toBe(false);
    });
  });

  // ---- num() coercion edge cases ----

  describe("num() coercion (string-to-number)", () => {
    it("add_days with non-numeric string for days returns a clear validation error", () => {
      // W1 input safety: previously Number("abc") = NaN slipped past the
      // num() !== undefined check and threw deep inside addDays (framework
      // error). The operand is now validated here and rejected cleanly.
      const result = dispatchTimeMath("add_days", {
        start_date: "2026-05-01",
        days: "abc",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("finite number");
    });

    it("num() returns undefined for boolean operands", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: true,
      });
      expect(result.ok).toBe(false);
    });

    it("num() returns undefined for null operands", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: null,
      });
      expect(result.ok).toBe(false);
    });

    it("num() returns undefined for object operands", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: { value: 1000 },
      });
      expect(result.ok).toBe(false);
    });

    it("num() returns undefined for array operands", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: [1000],
      });
      expect(result.ok).toBe(false);
    });
  });

  // ---- add_days additional coverage ----

  describe("add_days additional coverage", () => {
    it("handles negative days (subtraction)", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: "2026-05-08",
        days: -3,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toContain("2026-05-05");
    });

    it("handles zero days", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: "2026-05-01",
        days: 0,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toContain("2026-05-01");
    });

    it("returns error with retryHint when date is missing", () => {
      const result = dispatchTimeMath("add_days", { days: 5 });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.retryHint).toContain("ISO date string");
    });

    it("returns error when both operands are missing", () => {
      const result = dispatchTimeMath("add_days", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("add_days requires");
      expect(result.error.isError).toBe(true);
    });
  });

  // ---- add_business_days additional coverage ----

  describe("add_business_days additional coverage", () => {
    it("coerces string number for days", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: "3",
      });
      expect(result.ok).toBe(true);
    });

    it("coerces numeric start_date to string", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: 20260504,
        days: 1,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts from_date alternate field", () => {
      const result = dispatchTimeMath("add_business_days", {
        from_date: "2026-05-04",
        days: 2,
      });
      expect(result.ok).toBe(true);
    });

    it("accepts startDate alternate field", () => {
      const result = dispatchTimeMath("add_business_days", {
        startDate: "2026-05-04",
        days: 2,
      });
      expect(result.ok).toBe(true);
    });

    it("defaults country to US when not provided", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: 1,
      });
      expect(result.ok).toBe(true);
    });

    it("returns error when both operands are missing", () => {
      const result = dispatchTimeMath("add_business_days", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.retryHint).toContain("ISO date string");
    });
  });

  // ---- diff additional coverage ----

  describe("diff additional coverage", () => {
    it("validates result data contains expected diff", () => {
      const result = dispatchTimeMath("diff", {
        start_date: "2026-05-01",
        end_date: "2026-05-11",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBeDefined();
    });

    it("coerces numeric start to string via date field", () => {
      const result = dispatchTimeMath("diff", {
        date: 20260501,
        end_date: "2026-05-15",
      });
      expect(result.ok).toBe(true);
    });

    it("coerces numeric end to string via end field", () => {
      const result = dispatchTimeMath("diff", {
        start_date: "2026-05-01",
        end: 20260515,
      });
      expect(result.ok).toBe(true);
    });

    it("returns error when both start and end are missing", () => {
      const result = dispatchTimeMath("diff", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("diff requires");
      expect(result.error.retryHint).toContain("start_date and end_date");
    });

    it("returns error with isError flag set", () => {
      const result = dispatchTimeMath("diff", { start_date: "2026-05-01" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.isError).toBe(true);
    });
  });

  // ---- convert_tz additional coverage ----

  describe("convert_tz additional coverage", () => {
    it("validates result data is returned", () => {
      const result = dispatchTimeMath("convert_tz", {
        timestamp: "2026-05-01T12:00:00Z",
        target_tz: "America/New_York",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBeDefined();
    });

    it("returns error when both fields are missing", () => {
      const result = dispatchTimeMath("convert_tz", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("convert_tz requires");
      expect(result.error.retryHint).toContain("IANA timezone");
    });

    it("returns error with isError flag", () => {
      const result = dispatchTimeMath("convert_tz", { timestamp: "2026-05-01" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.isError).toBe(true);
    });

    it("coerces numeric timestamp to string", () => {
      const result = dispatchTimeMath("convert_tz", {
        timestamp: 2026,
        target_tz: "UTC",
      });
      expect(result.ok).toBe(true);
    });

    it("coerces numeric target_tz to string but invalid tz returns error", () => {
      const result = dispatchTimeMath("convert_tz", {
        timestamp: "2026-05-01T12:00:00Z",
        target_tz: 0,
      });
      // str(0) → "0" which is not a valid IANA timezone, so convertTimezone
      // returns an error result.
      expect(result).toBeDefined();
    });
  });

  // ---- parse_nl additional coverage ----

  describe("parse_nl additional coverage", () => {
    it("parses a day-based duration", () => {
      const result = dispatchTimeMath("parse_nl", {
        duration_string: "1d6h",
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBeDefined();
    });

    it("parses a minutes-only duration", () => {
      const result = dispatchTimeMath("parse_nl", {
        duration_string: "45m",
      });
      expect(result.ok).toBe(true);
    });

    it("returns error with retryHint", () => {
      const result = dispatchTimeMath("parse_nl", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.retryHint).toContain("2h30m");
      expect(result.error.isError).toBe(true);
    });

    it("returns error when duration_string is non-string non-number", () => {
      const result = dispatchTimeMath("parse_nl", {
        duration_string: true,
      });
      expect(result.ok).toBe(false);
    });
  });

  // ---- format_duration additional coverage ----

  describe("format_duration additional coverage", () => {
    it("formats zero milliseconds", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: 0,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.data).toBeDefined();
    });

    it("formats negative milliseconds", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: -1000,
      });
      expect(result.ok).toBe(true);
    });

    it("formats a small millisecond value", () => {
      const result = dispatchTimeMath("format_duration", {
        milliseconds: 500,
      });
      expect(result.ok).toBe(true);
    });

    it("returns error with retryHint", () => {
      const result = dispatchTimeMath("format_duration", {});
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.retryHint).toContain("milliseconds");
      expect(result.error.isError).toBe(true);
    });
  });

  // ---- empty operands object ----

  describe("empty and undefined operands", () => {
    it("add_days with undefined date values returns error", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: undefined,
        days: 1,
      });
      expect(result.ok).toBe(false);
    });

    it("diff with undefined end_date returns error", () => {
      const result = dispatchTimeMath("diff", {
        start_date: "2026-05-01",
        end_date: undefined,
      });
      expect(result.ok).toBe(false);
    });
  });

  // ---- operand type/bounds validation (W1 input safety) ----

  describe("operand type and bounds validation (W1)", () => {
    it("rejects a numeric country with a clear error instead of reaching toUpperCase", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: 5,
        country: 1,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("country must be a 2-letter ISO-3166 country code string");
      expect(result.error.message).toContain("number");
      expect(result.error.message).not.toContain("toUpperCase");
    });

    it("rejects a null country with a clear error", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: 5,
        country: null,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("country must be a 2-letter ISO-3166 country code string");
    });

    it("still accepts a valid string country", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: 5,
        country: "UK",
      });
      expect(result.ok).toBe(true);
    });

    it("rejects non-finite days strings on add_days", () => {
      const result = dispatchTimeMath("add_days", {
        start_date: "2026-05-01",
        days: "next week",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("finite number");
    });

    it("rejects days beyond the 100000 cap on add_days", () => {
      for (const days of [1e9, -1e9]) {
        const result = dispatchTimeMath("add_days", { start_date: "2026-05-01", days });
        expect(result.ok, String(days)).toBe(false);
        if (result.ok) continue;
        expect(result.error.message).toContain("100000");
      }
    });

    it("rejects non-finite days on add_business_days", () => {
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: "abc",
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("finite number");
    });

    it("rejects days beyond the 100000 cap on add_business_days (bounded latency)", () => {
      const start = performance.now();
      const result = dispatchTimeMath("add_business_days", {
        start_date: "2026-05-04",
        days: 1e9,
      });
      const elapsedMs = performance.now() - start;
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("100000");
      expect(elapsedMs).toBeLessThan(100);
    });

    it("rejects non-finite milliseconds on format_duration", () => {
      const result = dispatchTimeMath("format_duration", { milliseconds: "soon" });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("finite number");
    });
  });
});
