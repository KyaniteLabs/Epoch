import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY } from "../dispatcher/tool-registry.js";

// ---------------------------------------------------------------------------
// Tool Registry Tests — Layer 3 (Estimation)
// ---------------------------------------------------------------------------

describe("estimation tools via registry", () => {
  it("registers 6 estimation tools", () => {
    const names = [
      "pert_estimate",
      "cocomo_estimate",
      "sprint_forecast",
      "critical_path",
      "monte_carlo_schedule",
      "cocomo_validate",
    ];
    for (const name of names) {
      expect(TOOL_REGISTRY.has(name)).toBe(true);
    }
  });

  it("pert_estimate computes PERT correctly", () => {
    const tool = TOOL_REGISTRY.get("pert_estimate")!;
    const result = tool.handler({
      optimistic: 2,
      most_likely: 4,
      pessimistic: 12,
      unit: "hours",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("expected", 5);
      expect(result.data).toHaveProperty("unit", "hours");
    }
  });

  it("pert_estimate returns error for invalid inputs", () => {
    const tool = TOOL_REGISTRY.get("pert_estimate")!;
    const result = tool.handler({
      optimistic: 10,
      most_likely: 5,
      pessimistic: 15,
      unit: "hours",
    });
    expect(result.ok).toBe(false);
  });

  it("cocomo_estimate returns effort estimates", () => {
    const tool = TOOL_REGISTRY.get("cocomo_estimate")!;
    const result = tool.handler({
      kloc: 10,
      reasoning_complexity: 1.0,
      context_completeness: 1.0,
      transformation_impact: 1.0,
      iterative_cycles: 1.0,
      human_oversight: 1.0,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("personMonthsNominal");
      expect(result.data).toHaveProperty("personMonthsLlmAdjusted");
      expect(result.data).toHaveProperty("effortMultipliers");
      const data = result.data as Record<string, unknown>;
      expect(data.personMonthsNominal as number).toBeGreaterThan(0);
      expect(data.personMonthsLlmAdjusted as number).toBeGreaterThan(0);
    }
  });

  it("sprint_forecast returns sprint data", () => {
    const tool = TOOL_REGISTRY.get("sprint_forecast")!;
    const result = tool.handler({
      backlog_points: 100,
      velocity_history: [20, 25, 22, 23],
      sprint_length_days: 14,
      hours_per_sprint: 300,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.averageVelocity).toBeDefined();
      expect(data.requiredSprints as number).toBeGreaterThan(0);
      expect(data.completionDays as number).toBeGreaterThan(0);
    }
  });

  it("critical_path computes path", () => {
    const tool = TOOL_REGISTRY.get("critical_path")!;
    const result = tool.handler({
      tasks: [
        { name: "A", duration: 3, predecessors: [] },
        { name: "B", duration: 5, predecessors: ["A"] },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toHaveProperty("total_duration", 8);
      expect(result.data).toHaveProperty("critical_path", ["A", "B"]);
    }
  });

  it("monte_carlo_schedule returns percentiles", () => {
    const tool = TOOL_REGISTRY.get("monte_carlo_schedule")!;
    const result = tool.handler({
      tasks: [
        { name: "T1", optimistic: 1, most_likely: 3, pessimistic: 8 },
      ],
      iterations: 1000,
      seed: 42,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.p10).toBeDefined();
      expect(data.p50).toBeDefined();
      expect(data.p95).toBeDefined();
      expect(parseFloat(data.p10 as string)).toBeLessThan(parseFloat(data.p95 as string));
    }
  });

  it("cocomo_validate returns validation report", () => {
    const tool = TOOL_REGISTRY.get("cocomo_validate")!;
    const result = tool.handler({});
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.projectsEvaluated as number).toBeGreaterThan(0);
      expect(data.mape as number).toBeGreaterThan(0);
      expect(data.byProjectType).toBeDefined();
      expect(data.recommendedAdjustments).toBeDefined();
      expect(data.humanReadable).toBeDefined();
    }
  });

  it("cocomo_validate with dataset_filter filters results", () => {
    const tool = TOOL_REGISTRY.get("cocomo_validate")!;
    const result = tool.handler({
      dataset_filter: ["NASA93"],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data.projectsEvaluated as number).toBeGreaterThan(0);
    }
  });
});
