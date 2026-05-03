import { describe, it, expect, vi } from "vitest";

vi.mock("../lib/feedback.js", () => ({
  recordActual: vi.fn(() => true),
  recordActualDetailed: vi.fn(() => ({ ok: true })),
  getPendingEstimates: vi.fn(() => []),
}));

import { TOOL_REGISTRY } from "../dispatcher/tool-registry.js";

// ---------------------------------------------------------------------------
// Tool Registry Tests — Feedback (record_actual, get_pending_estimates)
// ---------------------------------------------------------------------------

describe("feedback tools via registry", () => {
  it("registers 2 feedback tools", () => {
    expect(TOOL_REGISTRY.has("record_actual")).toBe(true);
    expect(TOOL_REGISTRY.has("get_pending_estimates")).toBe(true);
  });

  // ---- record_actual ----

  it("record_actual returns recorded true on success", () => {
    const tool = TOOL_REGISTRY.get("record_actual")!;
    const result = tool.handler({
      estimate_id: "abc-123",
      actual_hours: 5.5,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("recorded", true);
      expect(result.data).toHaveProperty("estimate_id", "abc-123");
      expect(result.data).toHaveProperty("actual_hours", 5.5);
      expect((result.data as Record<string, unknown>).message).toBeDefined();
    }
  });

  it("record_actual passes optional notes", () => {
    const tool = TOOL_REGISTRY.get("record_actual")!;
    const result = tool.handler({
      estimate_id: "xyz-789",
      actual_hours: 3,
      notes: "Scope creep added extra work",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("recorded", true);
      expect(result.data).toHaveProperty("estimate_id", "xyz-789");
    }
  });

  it("record_actual returns error when lib returns false", async () => {
    const { recordActualDetailed } = await import("../lib/feedback.js");
    vi.mocked(recordActualDetailed).mockReturnValueOnce({ ok: false, reason: "duplicate" });

    const tool = TOOL_REGISTRY.get("record_actual")!;
    const result = tool.handler({
      estimate_id: "fail-case",
      actual_hours: 1,
    });
    expect(result.ok).toBe(false);
  });

  it("record_actual returns specific error for duplicate", async () => {
    const { recordActualDetailed } = await import("../lib/feedback.js");
    vi.mocked(recordActualDetailed).mockReturnValueOnce({ ok: false, reason: "duplicate" });

    const tool = TOOL_REGISTRY.get("record_actual")!;
    const result = tool.handler({
      estimate_id: "dup-case",
      actual_hours: 2,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("already exists");
    }
  });

  it("record_actual returns specific error for below threshold", async () => {
    const { recordActualDetailed } = await import("../lib/feedback.js");
    vi.mocked(recordActualDetailed).mockReturnValueOnce({ ok: false, reason: "below_threshold" });

    const tool = TOOL_REGISTRY.get("record_actual")!;
    const result = tool.handler({
      estimate_id: "small-case",
      actual_hours: 0.1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("minimum threshold");
    }
  });

  // ---- get_pending_estimates ----

  it("get_pending_estimates returns empty list", () => {
    const tool = TOOL_REGISTRY.get("get_pending_estimates")!;
    const result = tool.handler({ limit: 20 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("count", 0);
      expect(result.data).toHaveProperty("estimates", []);
    }
  });

  it("get_pending_estimates returns pending estimates", async () => {
    const { getPendingEstimates } = await import("../lib/feedback.js");
    vi.mocked(getPendingEstimates).mockReturnValueOnce([
      { id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2025-01-01T00:00:00Z", hasActual: false },
      { id: "e2", tool: "cocomo_estimate", inputs: {}, outputs: {}, estimatedAt: "2025-01-02T00:00:00Z", hasActual: false },
    ]);

    const tool = TOOL_REGISTRY.get("get_pending_estimates")!;
    const result = tool.handler({ limit: 10 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("count", 2);
      const estimates = (result.data as Record<string, unknown>).estimates as Array<Record<string, unknown>>;
      expect(estimates[0]!.id).toBe("e1");
      expect(estimates[1]!.id).toBe("e2");
    }
  });

  it("get_pending_estimates uses default limit", async () => {
    const { getPendingEstimates } = await import("../lib/feedback.js");
    vi.mocked(getPendingEstimates).mockImplementationOnce((limit?: number) => {
      expect(limit).toBe(20);
      return [];
    });

    const tool = TOOL_REGISTRY.get("get_pending_estimates")!;
    tool.handler({ limit: 20 });
  });
});
