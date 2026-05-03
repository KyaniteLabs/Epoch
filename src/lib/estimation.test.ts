import { describe, it, expect } from "vitest";
import {
  pertEstimate,
  sprintForecast,
  cocomoEstimate,
  criticalPath,
  monteCarloSim,
} from "./estimation.js";

// ---------------------------------------------------------------------------
// Layer 3: Estimation Algorithms
// ---------------------------------------------------------------------------

describe("pertEstimate", () => {
  it("computes PERT expected value correctly", () => {
    const result = pertEstimate(2, 4, 12, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // E = (2 + 4*4 + 12) / 6 = 30/6 = 5
    expect(result.data.expected).toBe(5);
    expect(result.data.optimistic).toBe(2);
    expect(result.data.mostLikely).toBe(4);
    expect(result.data.pessimistic).toBe(12);
    expect(result.data.unit).toBe("hours");
  });

  it("computes standard deviation correctly", () => {
    const result = pertEstimate(2, 4, 12, "hours");
    if (!result.ok) return;
    // SD = (12-2)/6 = 10/6 ≈ 1.67
    expect(result.data.stdDeviation).toBeCloseTo(1.67, 1);
  });

  it("computes variance correctly", () => {
    const result = pertEstimate(2, 4, 12, "hours");
    if (!result.ok) return;
    expect(result.data.variance).toBeCloseTo(2.78, 1);
  });

  it("computes 95% confidence interval", () => {
    const result = pertEstimate(2, 4, 12, "hours");
    if (!result.ok) return;
    const [lower, upper] = result.data.confidence95;
    expect(lower).toBeCloseTo(5 - 2 * 1.67, 1);
    expect(upper).toBeCloseTo(5 + 2 * 1.67, 1);
  });

  it("computes 99% confidence interval", () => {
    const result = pertEstimate(2, 4, 12, "hours");
    if (!result.ok) return;
    const [lower, upper] = result.data.confidence99;
    expect(lower).toBeCloseTo(5 - 3 * 1.67, 1);
    expect(upper).toBeCloseTo(5 + 3 * 1.67, 1);
  });

  it("returns urgency category based on hours", () => {
    const short = pertEstimate(0.5, 1, 1.5, "hours");
    if (!short.ok) return;
    expect(short.data.urgencyCategory).toBe("short");

    const medium = pertEstimate(4, 8, 16, "hours");
    if (!medium.ok) return;
    expect(medium.data.urgencyCategory).toBe("medium");

    const long = pertEstimate(40, 80, 160, "hours");
    if (!long.ok) return;
    expect(long.data.urgencyCategory).toBe("long");
  });

  it("returns error when optimistic > most_likely", () => {
    const result = pertEstimate(10, 5, 15, "hours");
    expect(result.ok).toBe(false);
  });

  it("returns error when most_likely > pessimistic", () => {
    const result = pertEstimate(5, 15, 10, "hours");
    expect(result.ok).toBe(false);
  });

  it("returns error when optimistic is 0", () => {
    const result = pertEstimate(0, 5, 10, "hours");
    expect(result.ok).toBe(false);
  });

  it("handles equal three-point estimates", () => {
    const result = pertEstimate(5, 5, 5, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.expected).toBe(5);
    expect(result.data.stdDeviation).toBe(0);
  });

  it("converts days to hours for urgency", () => {
    const result = pertEstimate(1, 3, 8, "days");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.unit).toBe("days");
  });

  it("returns low risk when spread ratio < 1.0", () => {
    // (8-4)/4 = 1.0 → actually borderline, use tighter
    const result = pertEstimate(3, 4, 5, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.riskLevel).toBe("low");
  });

  it("returns medium risk when spread ratio is 1.0-2.0", () => {
    // (10-4)/4 = 1.5
    const result = pertEstimate(4, 4, 10, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.riskLevel).toBe("medium");
  });

  it("returns high risk when spread ratio > 2.0", () => {
    // (20-2)/4 = 4.5
    const result = pertEstimate(2, 4, 20, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.riskLevel).toBe("high");
  });

  it("returns low risk for equal estimates (zero spread)", () => {
    const result = pertEstimate(5, 5, 5, "hours");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.riskLevel).toBe("low");
  });
});

describe("sprintForecast", () => {
  it("forecasts sprints from velocity history", () => {
    const result = sprintForecast({
      backlogPoints: 100,
      velocityHistory: [20, 25, 22, 23],
      sprintLengthDays: 14,
      hoursPerSprint: 300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.averageVelocity).toBeCloseTo(22.5, 0);
    expect(result.data.requiredSprints).toBeCloseTo(100 / 22.5, 0);
    expect(result.data.completionDays).toBeGreaterThan(0);
  });

  it("calculates pessimistic sprints with variance", () => {
    const result = sprintForecast({
      backlogPoints: 50,
      velocityHistory: [10, 20, 15, 25],
      sprintLengthDays: 14,
      hoursPerSprint: 200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pessimisticSprints).toBeGreaterThan(result.data.requiredSprints);
  });

  it("uses 1.5x fallback with single velocity", () => {
    const result = sprintForecast({
      backlogPoints: 30,
      velocityHistory: [10],
      sprintLengthDays: 14,
      hoursPerSprint: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.pessimisticSprints).toBe(result.data.requiredSprints * 1.5);
  });

  it("returns error for empty velocity history", () => {
    const result = sprintForecast({
      backlogPoints: 50,
      velocityHistory: [],
      sprintLengthDays: 14,
      hoursPerSprint: 300,
    });
    expect(result.ok).toBe(false);
  });

  it("returns error for zero backlog", () => {
    const result = sprintForecast({
      backlogPoints: 0,
      velocityHistory: [10],
      sprintLengthDays: 14,
      hoursPerSprint: 300,
    });
    expect(result.ok).toBe(false);
  });

  it("computes optimistic sprints from velocity variance", () => {
    const result = sprintForecast({
      backlogPoints: 50,
      velocityHistory: [10, 20, 15, 25],
      sprintLengthDays: 14,
      hoursPerSprint: 200,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.optimisticSprints).toBeLessThan(result.data.requiredSprints);
    expect(result.data.optimisticSprints).toBeGreaterThan(0);
  });

  it("optimistic sprints uses 0.75x fallback with single velocity", () => {
    const result = sprintForecast({
      backlogPoints: 30,
      velocityHistory: [10],
      sprintLengthDays: 14,
      hoursPerSprint: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.optimisticSprints).toBeCloseTo(result.data.requiredSprints * 0.75, 0);
  });

  it("returns low confidence with 1-2 sprints", () => {
    const one = sprintForecast({
      backlogPoints: 30, velocityHistory: [10], sprintLengthDays: 14, hoursPerSprint: 100,
    });
    const two = sprintForecast({
      backlogPoints: 30, velocityHistory: [10, 12], sprintLengthDays: 14, hoursPerSprint: 100,
    });
    expect(one.ok).toBe(true);
    expect(two.ok).toBe(true);
    if (!one.ok || !two.ok) return;
    expect(one.data.confidence).toBe("low");
    expect(two.data.confidence).toBe("low");
  });

  it("returns medium confidence with 3-5 sprints and low CV", () => {
    const result = sprintForecast({
      backlogPoints: 100, velocityHistory: [20, 22, 21, 23], sprintLengthDays: 14, hoursPerSprint: 300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confidence).toBe("medium");
    expect(result.data.velocityCv).toBeGreaterThan(0);
    expect(result.data.velocityCv).toBeLessThan(0.3);
  });

  it("returns low confidence with 3-5 sprints and high CV", () => {
    const result = sprintForecast({
      backlogPoints: 100, velocityHistory: [5, 40, 10, 50], sprintLengthDays: 14, hoursPerSprint: 300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confidence).toBe("low");
    expect(result.data.velocityCv).toBeGreaterThan(0.3);
  });

  it("returns high confidence with 6+ sprints and low CV", () => {
    const result = sprintForecast({
      backlogPoints: 100, velocityHistory: [20, 22, 21, 23, 20, 22], sprintLengthDays: 14, hoursPerSprint: 300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confidence).toBe("high");
    expect(result.data.velocityCv).toBeLessThan(0.3);
  });

  it("returns medium confidence with 6+ sprints and moderate CV", () => {
    const result = sprintForecast({
      backlogPoints: 100, velocityHistory: [10, 30, 15, 35, 12, 28], sprintLengthDays: 14, hoursPerSprint: 300,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.confidence).toBe("medium");
    expect(result.data.velocityCv).toBeGreaterThanOrEqual(0.3);
    expect(result.data.velocityCv).toBeLessThan(0.5);
  });

  it("velocityCv is 0 with single velocity", () => {
    const result = sprintForecast({
      backlogPoints: 30, velocityHistory: [10], sprintLengthDays: 14, hoursPerSprint: 100,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.velocityCv).toBe(0);
  });

  it("includes estimatedTokenCost (totalHours × 50000)", () => {
    const result = sprintForecast({
      backlogPoints: 30, velocityHistory: [10, 12, 11], sprintLengthDays: 14, hoursPerSprint: 100,
    });
    if (!result.ok) return;
    expect(result.data.estimatedTokenCost).toBeGreaterThan(0);
    expect(result.data.estimatedTokenCost).toBeCloseTo(result.data.totalHours * 50000, -4);
  });
});

describe("cocomoEstimate", () => {
  it("computes nominal effort for 10 KLOC at default multipliers", () => {
    const result = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.kloc).toBe(10);
    expect(result.data.personMonthsNominal).toBeGreaterThan(0);
    expect(result.data.effortMultipliers.product).toBe(1.0);
    expect(result.data.assumptions.length).toBeGreaterThan(0);
  });

  it("LLM-adjusted is less than nominal", () => {
    const result = cocomoEstimate({
      kloc: 50,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.personMonthsLlmAdjusted).toBeLessThan(result.data.personMonthsNominal);
  });

  it("increases effort with high complexity multipliers", () => {
    const low = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 0.5,
      contextCompleteness: 0.5,
      transformationImpact: 0.5,
      iterativeCycles: 0.5,
      humanOversight: 0.5,
    });
    const high = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 2.0,
      contextCompleteness: 2.0,
      transformationImpact: 2.0,
      iterativeCycles: 2.0,
      humanOversight: 2.0,
    });
    expect(low.ok).toBe(true);
    expect(high.ok).toBe(true);
    if (!low.ok || !high.ok) return;
    expect(high.data.personMonthsNominal).toBeGreaterThan(low.data.personMonthsNominal);
  });

  it("returns error for kloc <= 0", () => {
    const result = cocomoEstimate({
      kloc: 0,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe("KLOC must be positive.");
  });

  it("returns error for extremely large kloc", () => {
    const result = cocomoEstimate({
      kloc: 1e300,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("too large");
  });

  it("computes aiSpeedup as nominal / LLM-adjusted", () => {
    const result = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.aiSpeedup).toBeGreaterThan(1);
    // aiSpeedup should approximate nominal/adjusted (both rounded independently)
    const rawRatio = result.data.personMonthsNominal / result.data.personMonthsLlmAdjusted;
    expect(result.data.aiSpeedup).toBeCloseTo(rawRatio, 0);
  });

  it("returns extreme speedup at default multipliers", () => {
    const result = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 1.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.speedupCategory).toBe("extreme");
    expect(result.data.aiSpeedup).toBeGreaterThanOrEqual(10);
  });

  it("returns significant speedup with very high iterative cycles", () => {
    const result = cocomoEstimate({
      kloc: 10,
      reasoningComplexity: 1.0,
      contextCompleteness: 1.0,
      transformationImpact: 1.0,
      iterativeCycles: 10.0,
      humanOversight: 1.0,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // llmOverhead = 1 + (10-1)*0.15 = 2.35, divisor = max(3, 12/2.35) = 5.11
    expect(result.data.aiSpeedup).toBeGreaterThanOrEqual(5);
    expect(result.data.aiSpeedup).toBeLessThan(10);
    expect(result.data.speedupCategory).toBe("significant");
  });
});

describe("criticalPath", () => {
  it("computes critical path for linear chain", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: [] },
      { name: "B", duration: 5, predecessors: ["A"] },
      { name: "C", duration: 2, predecessors: ["B"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_duration).toBe(10);
    expect(result.data.critical_path).toEqual(["A", "B", "C"]);
  });

  it("identifies parallel tasks with slack", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: [] },
      { name: "B", duration: 5, predecessors: ["A"] },
      { name: "C", duration: 2, predecessors: ["A"] },
      { name: "D", duration: 1, predecessors: ["B", "C"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_duration).toBe(9);
    expect(result.data.critical_path).toContain("A");
    expect(result.data.critical_path).toContain("B");
    // C should have slack
    expect(result.data.slack_per_task["C"]).toBeGreaterThan(0);
  });

  it("returns error for unknown predecessor", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: ["UNKNOWN"] },
    ]);
    expect(result.ok).toBe(false);
  });

  it("returns error for duplicate task names", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: [] },
      { name: "A", duration: 5, predecessors: [] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Duplicate");
  });

  it("returns error for circular dependencies", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: ["B"] },
      { name: "B", duration: 5, predecessors: ["A"] },
    ]);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Circular");
  });

  it("returns error for empty tasks array", () => {
    const result = criticalPath([]);
    expect(result.ok).toBe(false);
  });

  it("handles single task", () => {
    const result = criticalPath([
      { name: "Solo", duration: 7, predecessors: [] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.total_duration).toBe(7);
    expect(result.data.critical_path).toEqual(["Solo"]);
  });

  it("applies merge bias for >2 predecessors", () => {
    const result = criticalPath([
      { name: "A", duration: 2, predecessors: [] },
      { name: "B", duration: 2, predecessors: [] },
      { name: "C", duration: 2, predecessors: [] },
      { name: "D", duration: 3, predecessors: ["A", "B", "C"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.merge_bias_adjustment).toBeGreaterThan(0);
  });

  it("includes estimatedHours (total_duration × 8)", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: [] },
      { name: "B", duration: 5, predecessors: ["A"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.estimatedHours).toBeGreaterThan(0);
    expect(Math.abs(result.data.estimatedHours - result.data.total_duration * 8)).toBeLessThan(1);
  });

  it("includes estimatedTokenCost (50k tokens/hour)", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: [] },
      { name: "B", duration: 5, predecessors: ["A"] },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // total_duration = 8, hours = 64, token cost = 64 * 50000 = 3,200,000
    expect(result.data.estimatedTokenCost).toBeGreaterThan(0);
    expect(result.data.estimatedTokenCost).toBe(result.data.estimatedHours * 50000);
  });

  it("returns error for zero duration task", () => {
    const result = criticalPath([
      { name: "A", duration: 0, predecessors: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.message).toContain("invalid duration");
  });

  it("returns error for negative duration task", () => {
    const result = criticalPath([
      { name: "A", duration: -2, predecessors: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.message).toContain("invalid duration");
  });

  it("returns error for self-referencing predecessor", () => {
    const result = criticalPath([
      { name: "A", duration: 3, predecessors: ["A"] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.message).toContain("itself");
  });

  it("returns error for NaN duration", () => {
    const result = criticalPath([
      { name: "A", duration: NaN, predecessors: [] },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) return;
    expect(result.error.message).toContain("invalid duration");
  });
});

describe("monteCarloSim", () => {
  it("returns deterministic results with seed", () => {
    const tasks = [
      { name: "A", optimistic: 2, mostLikely: 4, pessimistic: 8 },
      { name: "B", optimistic: 1, mostLikely: 3, pessimistic: 7 },
    ];
    const run1 = monteCarloSim(tasks, 1000, 42);
    const run2 = monteCarloSim(tasks, 1000, 42);
    expect(run1.p50).toBe(run2.p50);
    expect(run1.p95).toBe(run2.p95);
  });

  it("produces P50 < P95", () => {
    const result = monteCarloSim([
      { name: "Task", optimistic: 1, mostLikely: 5, pessimistic: 15 },
    ], 5000, 123);
    expect(parseFloat(result.p50)).toBeLessThan(parseFloat(result.p95));
  });

  it("produces P10 < P50 < P80 < P95", () => {
    const result = monteCarloSim([
      { name: "A", optimistic: 2, mostLikely: 5, pessimistic: 12 },
      { name: "B", optimistic: 3, mostLikely: 6, pessimistic: 15 },
    ], 5000, 99);
    const p10 = parseFloat(result.p10);
    const p50 = parseFloat(result.p50);
    const p80 = parseFloat(result.p80);
    const p95 = parseFloat(result.p95);
    expect(p10).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p80);
    expect(p80).toBeLessThanOrEqual(p95);
  });

  it("identifies risk events", () => {
    const result = monteCarloSim([
      { name: "Risky", optimistic: 1, mostLikely: 2, pessimistic: 20 },
    ], 5000, 42);
    expect(result.riskEvents.length).toBeGreaterThan(0);
    expect(result.riskEvents[0]).toHaveProperty("description");
    expect(result.riskEvents[0]).toHaveProperty("probability");
    expect(result.riskEvents[0]).toHaveProperty("impactDays");
  });

  it("criticalPathProbability is between 0 and 1", () => {
    const result = monteCarloSim([
      { name: "T1", optimistic: 1, mostLikely: 3, pessimistic: 8 },
    ], 1000, 7);
    expect(result.criticalPathProbability).toBeGreaterThanOrEqual(0);
    expect(result.criticalPathProbability).toBeLessThanOrEqual(1);
  });

  it("returns error result for invalid task ordering (optimistic > mostLikely)", () => {
    const result = monteCarloSim([
      { name: "Bad", optimistic: 10, mostLikely: 5, pessimistic: 20 },
    ], 1000, 42);
    expect(result.riskEvents.length).toBeGreaterThan(0);
    expect(result.riskEvents[0]!.description).toContain("Invalid estimates");
  });

  it("returns error result for invalid task ordering (mostLikely > pessimistic)", () => {
    const result = monteCarloSim([
      { name: "Bad2", optimistic: 1, mostLikely: 20, pessimistic: 5 },
    ], 1000, 42);
    expect(result.riskEvents.length).toBeGreaterThan(0);
    expect(result.riskEvents[0]!.description).toContain("Invalid estimates");
  });

  it("produces same value for all percentiles with single iteration", () => {
    const result = monteCarloSim([
      { name: "Solo", optimistic: 2, mostLikely: 5, pessimistic: 10 },
    ], 1, 42);
    expect(result.p10).toBe(result.p50);
    expect(result.p50).toBe(result.p95);
  });

  it("returns error result for zero iterations", () => {
    const result = monteCarloSim([
      { name: "Task", optimistic: 1, mostLikely: 3, pessimistic: 8 },
    ], 0, 42);
    expect(result.riskEvents.length).toBeGreaterThan(0);
    expect(result.riskEvents[0]!.description).toContain("Iterations");
  });

  it("includes estimatedHours (p50 days × 8)", () => {
    const result = monteCarloSim([
      { name: "Task", optimistic: 2, mostLikely: 5, pessimistic: 10 },
    ], 1000, 42);
    expect(result.estimatedHours).toBeGreaterThan(0);
    // p50 is a string in days; estimatedHours should be approximately p50 * 8
    const p50Days = parseFloat(result.p50);
    expect(Math.abs(result.estimatedHours - p50Days * 8)).toBeLessThan(1);
  });

  it("includes estimatedCost (estimatedHours × 50000)", () => {
    const result = monteCarloSim([
      { name: "Task", optimistic: 2, mostLikely: 5, pessimistic: 10 },
    ], 1000, 42);
    expect(result.estimatedCost).toBeGreaterThan(0);
    expect(result.estimatedCost).toBeCloseTo(result.estimatedHours * 50000, -3);
  });

  it("reports convergence for high iteration count", () => {
    const result = monteCarloSim([
      { name: "Task", optimistic: 2, mostLikely: 5, pessimistic: 10 },
    ], 50000, 42);
    expect(result.converged).toBe(true);
  });

  it("includes converged field in result", () => {
    const result = monteCarloSim([
      { name: "Task", optimistic: 1, mostLikely: 3, pessimistic: 8 },
    ], 1000, 99);
    expect(typeof result.converged).toBe("boolean");
  });
});

describe("pertEstimate edge cases", () => {
  it("returns error when all three values are in reverse order", () => {
    const result = pertEstimate(15, 10, 5, "hours");
    expect(result.ok).toBe(false);
  });
});
