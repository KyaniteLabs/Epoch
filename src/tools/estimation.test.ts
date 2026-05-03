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

describe("sprint_forecast edge cases", () => {
  it("rejects empty velocity history at schema level", () => {
    const tool = TOOL_REGISTRY.get("sprint_forecast")!;
    expect(() => tool.handler({
      backlog_points: 50,
      velocity_history: [],
      sprint_length_days: 14,
      hours_per_sprint: 80,
    })).toThrow();
  });

  it("rejects zero backlog at schema level", () => {
    const tool = TOOL_REGISTRY.get("sprint_forecast")!;
    expect(() => tool.handler({
      backlog_points: 0,
      velocity_history: [10, 12],
      sprint_length_days: 14,
      hours_per_sprint: 80,
    })).toThrow();
  });

  it("rejects all-zero velocity at schema level", () => {
    const tool = TOOL_REGISTRY.get("sprint_forecast")!;
    expect(() => tool.handler({
      backlog_points: 50,
      velocity_history: [0, 0, 0],
      sprint_length_days: 14,
      hours_per_sprint: 80,
    })).toThrow();
  });

  it("computes pessimistic sprints with variance", () => {
    const tool = TOOL_REGISTRY.get("sprint_forecast")!;
    const result = tool.handler({
      backlog_points: 100,
      velocity_history: [20, 25, 22, 23, 18],
      sprint_length_days: 14,
      hours_per_sprint: 280,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect((data.pessimisticSprints as number)).toBeGreaterThan(data.requiredSprints as number);
      expect(data.totalHours as number).toBeGreaterThan(0);
      expect(data.completionDays as number).toBeGreaterThan(0);
    }
  });

  it("falls back to 1.5x when only one velocity data point", () => {
    const tool = TOOL_REGISTRY.get("sprint_forecast")!;
    const result = tool.handler({
      backlog_points: 100,
      velocity_history: [25],
      sprint_length_days: 14,
      hours_per_sprint: 200,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      const required = data.requiredSprints as number;
      const pessimistic = data.pessimisticSprints as number;
      expect(pessimistic).toBeCloseTo(required * 1.5, 0);
    }
  });
});

describe("monte_carlo_schedule edge cases", () => {
  it("rejects zero iterations at schema level", () => {
    const tool = TOOL_REGISTRY.get("monte_carlo_schedule")!;
    expect(() => tool.handler({
      tasks: [{ name: "T1", optimistic: 1, most_likely: 3, pessimistic: 8 }],
      iterations: 0,
    })).toThrow();
  });

  it("rejects optimistic > most_likely at schema level", () => {
    const tool = TOOL_REGISTRY.get("monte_carlo_schedule")!;
    expect(() => tool.handler({
      tasks: [{ name: "Bad", optimistic: 10, most_likely: 3, pessimistic: 15 }],
      iterations: 100,
    })).toThrow();
  });

  it("produces deterministic results with same seed", () => {
    const tool = TOOL_REGISTRY.get("monte_carlo_schedule")!;
    const input = {
      tasks: [
        { name: "A", optimistic: 2, most_likely: 5, pessimistic: 10 },
        { name: "B", optimistic: 3, most_likely: 7, pessimistic: 15 },
      ],
      iterations: 500,
      seed: 123,
    };
    const r1 = tool.handler(input);
    const r2 = tool.handler(input);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.data.p50).toBe(r2.data.p50);
      expect(r1.data.p95).toBe(r2.data.p95);
    }
  });

  it("reports risk events for high-variance tasks", () => {
    const tool = TOOL_REGISTRY.get("monte_carlo_schedule")!;
    const result = tool.handler({
      tasks: [
        { name: "Stable", optimistic: 4, most_likely: 5, pessimistic: 6 },
        { name: "Risky", optimistic: 1, most_likely: 5, pessimistic: 30 },
      ],
      iterations: 1000,
      seed: 42,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      const risks = data.riskEvents as Array<{ description: string }>;
      expect(risks.length).toBeGreaterThan(0);
      expect(risks[0]!.description).toContain("Risky");
    }
  });

  it("single task produces valid percentiles", () => {
    const tool = TOOL_REGISTRY.get("monte_carlo_schedule")!;
    const result = tool.handler({
      tasks: [{ name: "Solo", optimistic: 1, most_likely: 2, pessimistic: 5 }],
      iterations: 10000,
      seed: 99,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const p10 = parseFloat(result.data.p10);
      const p50 = parseFloat(result.data.p50);
      const p95 = parseFloat(result.data.p95);
      expect(p10).toBeLessThan(p50);
      expect(p50).toBeLessThan(p95);
      // P50 should be close to most_likely for triangular distribution
      expect(p50).toBeGreaterThan(1.5);
      expect(p50).toBeLessThan(4);
    }
  });
});
