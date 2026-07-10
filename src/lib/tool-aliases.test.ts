import { describe, it, expect } from "vitest";
import { canonicalizeToolName, CANONICAL_TOOL_NAMES } from "./tool-aliases.js";

describe("canonicalizeToolName", () => {
  it("passes through already-canonical tool names unchanged", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      expect(canonicalizeToolName(name)).toBe(name);
    }
  });

  describe("camelCase normalization", () => {
    it.each([
      ["pertEstimate", "pert_estimate"],
      ["cocomoEstimate", "cocomo_estimate"],
      ["sprintForecast", "sprint_forecast"],
      ["criticalPath", "critical_path"],
      ["monteCarloSchedule", "monte_carlo_schedule"],
      ["referenceClassEstimate", "reference_class_estimate"],
      ["calibrateEstimates", "calibrate_estimates"],
      ["tokenTimeBridge", "token_time_bridge"],
      ["tokenCostEstimate", "token_cost_estimate"],
      ["compareModels", "compare_models"],
      ["accuracyTrend", "accuracy_trend"],
      ["scheduleRisk", "schedule_risk"],
      ["cocomoValidate", "cocomo_validate"],
      ["cocomoGroundTruth", "cocomo_ground_truth"],
      ["recordActual", "record_actual"],
      ["getPendingEstimates", "get_pending_estimates"],
      ["batchRecordActuals", "batch_record_actuals"],
      ["feedbackHealth", "feedback_health"],
      ["getCurrentTime", "get_current_time"],
      ["convertTimezone", "convert_timezone"],
      ["parseDuration", "parse_duration"],
      ["addBusinessDays", "add_business_days"],
      ["countBusinessDays", "count_business_days"],
      ["timeMath", "time_math"],
    ])("normalizes %s -> %s", (input, expected) => {
      expect(canonicalizeToolName(input)).toBe(expected);
    });
  });

  describe("explicit alias map", () => {
    it("maps manual_pert_estimate -> pert_estimate", () => {
      expect(canonicalizeToolName("manual_pert_estimate")).toBe("pert_estimate");
    });

    it("maps manual_orchestration_pert -> pert_estimate", () => {
      expect(canonicalizeToolName("manual_orchestration_pert")).toBe("pert_estimate");
    });
  });

  describe("rejection", () => {
    it("rejects raw UUID tool names", () => {
      expect(canonicalizeToolName("550e8400-e29b-41d4-a716-446655440000")).toBeNull();
      expect(canonicalizeToolName("A0B1C2D3-E4F5-6789-ABCD-EF0123456789")).toBeNull();
    });

    it("rejects unknown/unmapped tool names", () => {
      expect(canonicalizeToolName("totally_made_up_tool")).toBeNull();
      expect(canonicalizeToolName("someUnknownWidget")).toBeNull();
    });

    it("rejects empty, whitespace-only, null, and undefined input", () => {
      expect(canonicalizeToolName("")).toBeNull();
      expect(canonicalizeToolName("   ")).toBeNull();
      expect(canonicalizeToolName(null)).toBeNull();
      expect(canonicalizeToolName(undefined)).toBeNull();
    });

    it("rejects a synthetic-id-shaped estimate id mistakenly used as a tool", () => {
      expect(canonicalizeToolName("test-uuid-1234")).toBeNull();
    });
  });

  it("trims surrounding whitespace before matching", () => {
    expect(canonicalizeToolName("  pert_estimate  ")).toBe("pert_estimate");
  });
});
