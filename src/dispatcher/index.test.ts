import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/feedback.js", () => ({
  recordEstimate: vi.fn(() => "test-estimate-id"),
  recordActual: vi.fn(() => true),
  getPendingEstimates: vi.fn(() => []),
  batchRecordActuals: vi.fn(() => ({ total: 0, succeeded: 0, failed: 0, errors: [] })),
  getFeedbackHealthReport: vi.fn(() => ({
    totalEstimates: 0, totalActuals: 0, matchRate: 0,
    byTool: {}, byTaskType: {},
    selfImprovement: { readyTypes: [], callsUntilUpdate: 100 },
  })),
  getCalibrationData: vi.fn(() => []),
  matchEstimatesToActuals: vi.fn(() => []),
}));

vi.mock("../lib/telemetry.js", () => ({
  getTelemetry: vi.fn(() => ({
    record: vi.fn(),
    getStats: vi.fn(() => []),
  })),
}));

vi.mock("../lib/self-improve.js", () => ({
  notifyToolCall: vi.fn(),
  getGlobalCorrectionFactor: vi.fn(() => 1.07),
  updateReferenceDatabase: vi.fn(() => Promise.resolve()),
}));

import { dispatch, listTools } from "./index.js";
import { TOOL_REGISTRY } from "./tool-registry.js";

describe("dispatch", () => {
  it("returns error for unknown tool", async () => {
    const result = await dispatch("nonexistent_tool_xyz", {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
      expect(result.error.message).toContain("Unknown tool");
    }
  });

  it("returns error for invalid input (Zod validation)", async () => {
    const result = await dispatch("pert_estimate", {
      optimistic: "not-a-number",
      most_likely: 5,
      pessimistic: 10,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.isError).toBe(true);
    }
  });

  it("dispatches pert_estimate with feedbackToken", async () => {
    const result = await dispatch("pert_estimate", {
      optimistic: 2,
      most_likely: 5,
      pessimistic: 10,
      unit: "hours",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("expected", 5.33);
      expect(result.data).toHaveProperty("feedbackToken", "test-estimate-id");
    }
  });

  it("dispatches critical_path successfully", async () => {
    const result = await dispatch("critical_path", {
      tasks: [{ name: "A", duration: 3, predecessors: [] }],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.data as Record<string, unknown>).total_duration).toBe(3);
  });

  it("dispatches temporal tools without feedbackToken", async () => {
    const result = await dispatch("get_current_time", { timezone: "UTC" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("iso");
      expect(result.data).not.toHaveProperty("feedbackToken");
    }
  });

  it("listTools returns all registered tools", () => {
    const tools = listTools();
    expect(tools.length).toBe(TOOL_REGISTRY.size);
    for (const tool of tools) {
      expect(TOOL_REGISTRY.has(tool.name)).toBe(true);
      expect(tool.description.length).toBeGreaterThan(0);
    }
  });
});
