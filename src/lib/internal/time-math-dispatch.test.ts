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
  });
});
