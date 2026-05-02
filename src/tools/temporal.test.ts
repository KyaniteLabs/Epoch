import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "../dispatcher/tool-registry.js";

// ---------------------------------------------------------------------------
// Tool Registry Tests — Layer 1 & 2 (Temporal + Calendar)
// ---------------------------------------------------------------------------

describe("temporal tools via registry", () => {
  it("registers 6 temporal tools", () => {
    const names = [
      "get_current_time",
      "convert_timezone",
      "parse_duration",
      "time_math",
      "add_business_days",
      "count_business_days",
    ];
    for (const name of names) {
      expect(TOOL_REGISTRY.has(name)).toBe(true);
    }
  });

  it("get_current_time returns valid time data", () => {
    const tool = TOOL_REGISTRY.get("get_current_time")!;
    const result = tool.handler({ timezone: "UTC" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("iso");
      expect(result.data).toHaveProperty("timezone", "UTC");
    }
  });

  it("get_current_time returns error for invalid timezone", () => {
    const tool = TOOL_REGISTRY.get("get_current_time")!;
    const result = tool.handler({ timezone: "Invalid/TZ" });
    expect(result.ok).toBe(false);
  });

  it("convert_timezone converts correctly", () => {
    const tool = TOOL_REGISTRY.get("convert_timezone")!;
    const result = tool.handler({
      timestamp: "2026-05-01T12:00:00Z",
      target_tz: "America/Los_Angeles",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("timezone", "America/Los_Angeles");
    }
  });

  it("parse_duration parses valid durations", () => {
    const tool = TOOL_REGISTRY.get("parse_duration")!;
    const result = tool.handler({ duration_string: "2h30m" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("totalSeconds", 9000);
    }
  });

  it("time_math add_days operation works", () => {
    const tool = TOOL_REGISTRY.get("time_math")!;
    const result = tool.handler({
      operation: "add_days",
      operands: { date: "2026-05-01", days: 5 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Shared dispatch returns the addDays result directly as data
      expect(result.data).toBe("2026-05-06");
    }
  });

  it("time_math diff operation works", () => {
    const tool = TOOL_REGISTRY.get("time_math")!;
    const result = tool.handler({
      operation: "diff",
      operands: { date: "2026-05-01T00:00:00Z", end_date: "2026-05-03T00:00:00Z" },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("total_seconds", 172800);
    }
  });

  it("time_math format_duration works", () => {
    const tool = TOOL_REGISTRY.get("time_math")!;
    const result = tool.handler({
      operation: "format_duration",
      operands: { milliseconds: 3600000 },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Shared dispatch returns the formatElapsed result directly as data
      expect(result.data).toBe("1h");
    }
  });

  it("time_math returns error for missing operands", () => {
    const tool = TOOL_REGISTRY.get("time_math")!;
    const result = tool.handler({
      operation: "add_days",
      operands: {},
    });
    expect(result.ok).toBe(false);
  });

  it("add_business_days returns a result", () => {
    const tool = TOOL_REGISTRY.get("add_business_days")!;
    const result = tool.handler({
      start_date: "2026-05-04",
      days: 5,
      country: "US",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(
        (result.data as Record<string, unknown>).endDate ??
        (result.data as Record<string, unknown>).result,
      ).toBeDefined();
    }
  });

  it("count_business_days returns a result", () => {
    const tool = TOOL_REGISTRY.get("count_business_days")!;
    const result = tool.handler({
      start_date: "2026-05-04",
      end_date: "2026-05-08",
      country: "US",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("businessDays");
    }
  });
});
