import { describe, it, expect } from "vitest";
import { tokenCostEstimate, compareModels } from "./cost.js";

// ---------------------------------------------------------------------------
// Cost Estimation Tests
// ---------------------------------------------------------------------------

describe("tokenCostEstimate", () => {
  it("estimates cost for a known model", () => {
    const result = tokenCostEstimate({
      tokens: 10000,
      model: "claude-sonnet-4-20250514",
      toolCalls: 2,
      reasoningDepth: "moderate",
    });

    expect(result.estimatedCost).toBeGreaterThan(0);
    expect(result.costBreakdown.inputCost).toBeGreaterThanOrEqual(0);
    expect(result.costBreakdown.outputCost).toBeGreaterThanOrEqual(0);
    expect(result.costBreakdown.toolCallOverheadCost).toBeGreaterThanOrEqual(0);
    expect(result.estimatedSeconds).toBeGreaterThan(0);
    expect(result.tokens).toBe(10000);
    expect(result.model).toBe("claude-sonnet-4-20250514");
    expect(result.humanReadable).toContain("claude-sonnet-4-20250514");
    expect(result.humanReadable).toContain("moderate");
  });

  it("estimates cost with fallback for unknown model", () => {
    const result = tokenCostEstimate({
      tokens: 10000,
      model: "unknown-model",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    // Fallback rates should still produce a cost
    expect(result.estimatedCost).toBeGreaterThan(0);
    expect(result.costBreakdown.inputCost).toBeGreaterThan(0);
    expect(result.costBreakdown.outputCost).toBeGreaterThan(0);
  });

  it("more tokens cost more", () => {
    const small = tokenCostEstimate({
      tokens: 1000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    const large = tokenCostEstimate({
      tokens: 10000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    expect(large.estimatedCost).toBeGreaterThan(small.estimatedCost);
  });

  it("tool calls add overhead cost", () => {
    const noTools = tokenCostEstimate({
      tokens: 5000,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });

    const withTools = tokenCostEstimate({
      tokens: 5000,
      model: "gpt-4o",
      toolCalls: 10,
      reasoningDepth: "shallow",
    });

    expect(withTools.estimatedCost).toBeGreaterThan(noTools.estimatedCost);
    expect(withTools.costBreakdown.toolCallOverheadCost).toBeGreaterThan(
      noTools.costBreakdown.toolCallOverheadCost,
    );
  });

  it("cost breakdown sums correctly", () => {
    const result = tokenCostEstimate({
      tokens: 10000,
      model: "claude-sonnet-4-20250514",
      toolCalls: 5,
      reasoningDepth: "deep",
    });

    const sum =
      result.costBreakdown.inputCost +
      result.costBreakdown.outputCost +
      result.costBreakdown.toolCallOverheadCost;

    expect(Math.abs(sum - result.estimatedCost)).toBeLessThan(0.01);
  });

  it("zero tokens produces zero cost", () => {
    const result = tokenCostEstimate({
      tokens: 0,
      model: "gpt-4o",
      toolCalls: 0,
      reasoningDepth: "shallow",
    });
    expect(result.estimatedCost).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Model Comparison Tests
// ---------------------------------------------------------------------------

describe("compareModels", () => {
  it("returns comparison for all models", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 3,
      reasoningDepth: "moderate",
    });

    expect(result.models.length).toBeGreaterThanOrEqual(12);
    expect(result.tokens).toBe(10000);
  });

  it("sorts by cost by default", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 2,
      reasoningDepth: "moderate",
    });

    for (let i = 1; i < result.models.length; i++) {
      const prev = result.models[i - 1]!;
      const curr = result.models[i]!;
      // Models with 0 cost go last
      if (prev.estimatedCost === 0) {
        expect(curr.estimatedCost).toBe(0);
      } else if (curr.estimatedCost !== 0) {
        expect(curr.estimatedCost).toBeGreaterThanOrEqual(prev.estimatedCost);
      }
    }
  });

  it("sorts by time when requested", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 2,
      reasoningDepth: "moderate",
      sortBy: "time",
    });

    expect(result.sortBy).toBe("time");

    for (let i = 1; i < result.models.length; i++) {
      expect(result.models[i]!.estimatedSeconds).toBeGreaterThanOrEqual(
        result.models[i - 1]!.estimatedSeconds,
      );
    }
  });

  it("each entry has required fields", () => {
    const result = compareModels({
      tokens: 5000,
      toolCalls: 1,
      reasoningDepth: "shallow",
    });

    for (const entry of result.models) {
      expect(entry.model).toBeTruthy();
      expect(typeof entry.estimatedSeconds).toBe("number");
      expect(typeof entry.estimatedMinutes).toBe("number");
      expect(typeof entry.estimatedCost).toBe("number");
      expect(typeof entry.qualityTier).toBe("string");
      expect(typeof entry.tokensPerSecond).toBe("number");
      expect(entry.tokensPerSecond).toBeGreaterThan(0);
    }
  });

  it("quality tiers are assigned", () => {
    const result = compareModels({
      tokens: 10000,
      toolCalls: 0,
      reasoningDepth: "moderate",
    });

    const tiers = new Set(result.models.map((e) => e!.qualityTier));

    expect(tiers.has("fast")).toBe(true);
    expect(tiers.has("standard")).toBe(true);
    expect(tiers.has("premium")).toBe(true);
  });

  it("human-readable output is a formatted table", () => {
    const result = compareModels({
      tokens: 10000, toolCalls: 0, reasoningDepth: "shallow",
    });
    expect(result.humanReadable).toContain("Model");
    expect(result.humanReadable).toContain("Time (min)");
    expect(result.humanReadable).toContain("Cost ($)");
    expect(result.humanReadable).toContain("Tier");
    // Should have at least 12 data rows + 2 header rows
    const lines = result.humanReadable.split("\n");
    expect(lines.length).toBeGreaterThanOrEqual(14);
  });

  it("premium model costs more than fast model", () => {
    const premium = tokenCostEstimate({
      tokens: 100000, model: "claude-opus-4-20250514", toolCalls: 0, reasoningDepth: "moderate",
    });
    const fast = tokenCostEstimate({
      tokens: 100000, model: "gemini-2.0-flash", toolCalls: 0, reasoningDepth: "moderate",
    });
    expect(premium.estimatedCost).toBeGreaterThan(fast.estimatedCost);
  });

  it("inherits urgency and confidence from time bridge", () => {
    const result = tokenCostEstimate({
      tokens: 25000, model: "gpt-4o-mini", toolCalls: 1, reasoningDepth: "shallow",
    });
    expect(["short", "medium", "long"]).toContain(result.urgency);
    expect(["likely", "optimistic", "pessimistic"]).toContain(result.confidence);
  });
});
