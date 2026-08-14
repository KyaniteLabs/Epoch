import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "../dispatcher/tool-registry.js";
import { defined } from "../test-support.js";


// ---------------------------------------------------------------------------
// Tool Registry Tests — Layer 4-5 (Analytics)
// ---------------------------------------------------------------------------

describe("analytics tools via registry", () => {
  it("registers 7 analytics tools", () => {
    const names = [
      "reference_class_estimate",
      "calibrate_estimates",
      "token_time_bridge",
      "token_cost_estimate",
      "compare_models",
      "accuracy_trend",
      "schedule_risk",
    ];
    for (const name of names) {
      expect(TOOL_REGISTRY.has(name)).toBe(true);
    }
  });

  it("reference_class_estimate returns estimate", () => {
    const tool = defined(TOOL_REGISTRY.get("reference_class_estimate"));
    const result = tool.handler({
      task_type: "feature",
      complexity: 3,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.rawEstimate as number).toBeGreaterThan(0);
      expect(data.correctedEstimate as number).toBeGreaterThan(0);
      expect(data.correctionFactor as number).toBeGreaterThan(0);
    }
  });

  it("reference_class_estimate with team_id returns note", () => {
    const tool = defined(TOOL_REGISTRY.get("reference_class_estimate"));
    const result = tool.handler({
      task_type: "bugfix",
      complexity: 2,
      team_id: "team-alpha",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>).note).toBeDefined();
    }
  });

  it("calibrate_estimates returns stub data", () => {
    const tool = defined(TOOL_REGISTRY.get("calibrate_estimates"));
    const result = tool.handler({
      team_id: "team-a",
      period_days: 90,
      minimum_samples: 10,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.correctionFactor as number).toBeGreaterThan(0);
      expect((data.recommendations as unknown[]).length).toBeGreaterThan(0);
    }
  });

  it("token_time_bridge estimates wall-clock time", () => {
    const tool = defined(TOOL_REGISTRY.get("token_time_bridge"));
    const result = tool.handler({
      tokens: 50000,
      model: "claude-sonnet-4-20250514",
      tool_calls: 10,
      reasoning_depth: "deep",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.estimatedSeconds as number).toBeGreaterThan(0);
      expect(data.estimatedMinutes as number).toBeGreaterThan(0);
      // "optimistic" (was "likely"): confidence now reflects data provenance —
      // a curated-table calibration is borrowed, not locally measured
      // telemetry (ticket 15).
      expect(data.confidence).toBe("optimistic");
      expect(data.model).toBe("claude-sonnet-4-20250514");
    }
  });

  it("token_time_bridge handles unknown model", () => {
    const tool = defined(TOOL_REGISTRY.get("token_time_bridge"));
    const result = tool.handler({
      tokens: 1000,
      model: "gpt-4o-mini",
      tool_calls: 0,
      reasoning_depth: "shallow",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>).estimatedSeconds as number).toBeGreaterThan(0);
    }
  });

  it("compare_models returns model comparison", () => {
    const tool = defined(TOOL_REGISTRY.get("compare_models"));
    const result = tool.handler({
      tokens: 50000,
      tool_calls: 5,
      reasoning_depth: "moderate",
      sort_by: "cost",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.models).toBeDefined();
      expect(Array.isArray(data.models)).toBe(true);
      const models = data.models as Array<Record<string, unknown>>;
      expect(models.length).toBeGreaterThan(0);
      expect(models[0]).toHaveProperty("model");
      expect(models[0]).toHaveProperty("estimatedSeconds");
      expect(models[0]).toHaveProperty("estimatedCost");
      expect(models[0]).toHaveProperty("qualityTier");
    }
  });

  it("accuracy_trend returns trend data", () => {
    const tool = defined(TOOL_REGISTRY.get("accuracy_trend"));
    const result = tool.handler({
      window_size: 50,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.overallTrend).toBeDefined();
      expect(data.industryBaselineMape as number).toBeGreaterThan(0);
      expect(data.totalEstimates as number).toBeGreaterThanOrEqual(0);
      expect(data.humanReadable).toBeDefined();
    }
  });

  it("accuracy_trend with team_id returns team data", () => {
    const tool = defined(TOOL_REGISTRY.get("accuracy_trend"));
    const result = tool.handler({
      team_id: "team-bravo",
      window_size: 20,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>).overallTrend).toBeDefined();
    }
  });

  it("schedule_risk returns risk assessment", () => {
    const tool = defined(TOOL_REGISTRY.get("schedule_risk"));
    const result = tool.handler({
      estimated_hours: 40,
      task_type: "feature",
      team_id: "team-alpha",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.riskLevel).toBeDefined();
      const ci = data.confidenceIntervals as Record<string, number>;
      const p50 = ci.p50 as number;
      const p80 = ci.p80 as number;
      const p95 = ci.p95 as number;
      expect(p50).toBeGreaterThan(0);
      expect(p80).toBeGreaterThanOrEqual(p50);
      expect(p95).toBeGreaterThanOrEqual(p80);
      const hist = data.historicalAccuracy as Record<string, unknown>;
      expect(hist.mape as number).toBeGreaterThan(0);
      expect(data.recommendation).toBeDefined();
    }
  });

  it("schedule_risk with minimal inputs returns assessment", () => {
    const tool = defined(TOOL_REGISTRY.get("schedule_risk"));
    const result = tool.handler({
      estimated_hours: 8,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      const ci = data.confidenceIntervals as Record<string, number>;
      expect(ci.p50).toBeGreaterThan(0);
      expect(data.riskLevel).toBeDefined();
    }
  });
});
