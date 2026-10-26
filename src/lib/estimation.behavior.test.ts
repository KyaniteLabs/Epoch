/**
 * Behaviour pins for the core estimators, written from a mutation-testing
 * baseline (Stryker, 2026-10-25): 70.4% of mutants in estimation.ts survived
 * the existing suite despite >80% line coverage. Each expectation below is
 * computed by hand from the documented formulas, so a changed constant,
 * operator, boundary or error contract fails a test.
 */
import { describe, it, expect } from "vitest";
import {
  pertEstimate,
  sprintForecast,
  cocomoEstimate,
  criticalPath,
} from "./estimation.js";

const nominalCocomo = {
  reasoningComplexity: 1,
  contextCompleteness: 1,
  transformationImpact: 1,
  iterativeCycles: 1,
  humanOversight: 1,
};

describe("unit conversion (via PERT urgency, which buckets hours)", () => {
  // urgency: < 2h short, <= 48h medium, otherwise long.
  it.each([
    ["hours", 1, "short"], // 1h
    ["days", 5, "medium"], // 40h; ×8 per day (÷8 would be 0.6h, short)
    ["days", 7, "long"], // 56h
    ["weeks", 1, "medium"], // 40h; ×40 per week (a fall-through to months would be 160h)
    ["months", 1, "long"], // 160h; ÷160 would be short
  ] as const)("%s × %d → %s", (unit, value, urgency) => {
    const r = pertEstimate(value, value, value, unit);
    expect(r.ok && r.data.urgencyCategory).toBe(urgency);
  });
});

describe("pertEstimate intervals", () => {
  it("states exact 95%/99% intervals for a narrow estimate", () => {
    // E = (4 + 20 + 6)/6 = 5; sd = 2/6.
    const r = pertEstimate(4, 5, 6, "hours");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.confidence95).toEqual([4.33, 5.67]);
    expect(r.data.confidence99).toEqual([4, 6]);
    expect(r.data.humanReadable).toBe(
      "Expected: 5 hours. 95% confidence: 4.33 to 5.67 hours. 99% confidence: 4 to 6 hours.",
    );
  });

  it("clamps both lower bounds at zero for a wide estimate", () => {
    // E = 105/6 = 17.5; sd = 99/6 = 16.5; E - 2sd and E - 3sd are negative.
    const r = pertEstimate(1, 1, 100, "days");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.confidence95).toEqual([0, 50.5]);
    expect(r.data.confidence99).toEqual([0, 67]);
    expect(r.data.humanReadable).toBe(
      "Expected: 17.5 days. 95% confidence: 0 to 50.5 days. 99% confidence: 0 to 67 days.",
    );
  });

  it("rejects a non-finite result instead of returning Infinity", () => {
    const r = pertEstimate(1, 1, Number.POSITIVE_INFINITY, "hours");
    expect(r).toEqual({
      ok: false,
      error: {
        isError: true,
        message: "Computation produced invalid result.",
        retryHint: "Ensure all inputs are finite numbers and optimistic <= mostLikely <= pessimistic.",
      },
    });
  });

  it("returns the full error contract for out-of-order inputs", () => {
    const r = pertEstimate(5, 4, 6, "hours");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({
      isError: true,
      message:
        "PERT values must satisfy 0 < optimistic <= most_likely <= pessimistic. Got optimistic=5, most_likely=4, pessimistic=6.",
      retryHint: "Provide three positive estimates where optimistic is smallest and pessimistic is largest.",
    });
  });
});

describe("sprintForecast arithmetic", () => {
  it("derives hours, spread and completion from the velocity history", () => {
    // avg 20 → 5 sprints; 40h/sprint ÷ 20 pts = 2 h/pt → 200h.
    // sample sd = sqrt(((-10)² + 0 + 10²)/2) = 10 → pessimistic 100/10 = 10,
    // optimistic 100/30 = 3.3; cv = 10/20 = 0.5; 5 sprints × 10 days = 50.
    const r = sprintForecast({
      backlogPoints: 100,
      velocityHistory: [10, 20, 30],
      sprintLengthDays: 10,
      hoursPerSprint: 40,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.requiredSprints).toBe(5);
    expect(r.data.hoursPerPoint).toBe(2);
    expect(r.data.totalHours).toBe(200);
    expect(r.data.pessimisticSprints).toBe(10);
    expect(r.data.optimisticSprints).toBe(3.3);
    expect(r.data.velocityCv).toBe(0.5);
    expect(r.data.completionDays).toBe(50);
  });

  it("floors the pessimistic velocity at 0.1 when spread exceeds the mean", () => {
    // avg 5, sd = sqrt((25 + 25)/1)... = sqrt(50) ≈ 7.07 > avg → divisor 0.1.
    const r = sprintForecast({
      backlogPoints: 10,
      velocityHistory: [0, 10],
      sprintLengthDays: 10,
      hoursPerSprint: 40,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.pessimisticSprints).toBe(100);
  });

  it("accepts a zero-velocity sprint in the history", () => {
    const r = sprintForecast({
      backlogPoints: 20,
      velocityHistory: [0, 20],
      sprintLengthDays: 10,
      hoursPerSprint: 40,
    });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-finite result", () => {
    const r = sprintForecast({
      backlogPoints: 1e308,
      velocityHistory: [1],
      sprintLengthDays: 10,
      hoursPerSprint: 1e308,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({
      isError: true,
      message: "Sprint forecast produced non-finite result. Check inputs for Infinity or extreme values.",
      retryHint: "Use reasonable values for backlog_points, hours_per_sprint, and velocity_history.",
    });
  });

  it.each([
    [{ backlogPoints: 10, velocityHistory: [] }, "velocity_history cannot be empty. Provide at least one sprint's velocity.", "Pass an array of story points completed per past sprint."],
    [{ backlogPoints: 10, velocityHistory: [-1] }, "velocity_history[0] is invalid: -1. Each velocity must be a non-negative finite number.", "Provide non-negative numeric velocity values for each sprint."],
    [{ backlogPoints: 0, velocityHistory: [5] }, "backlog_points must be positive.", "Provide a positive number for backlog_points."],
    [{ backlogPoints: 10, velocityHistory: [0, 0] }, "Average velocity is 0 across 2 sprint(s). Cannot forecast with zero velocity — the backlog will never clear.", "Include sprints with positive velocity, or estimate velocity from team capacity."],
  ])("returns the full error contract (%#)", (input, message, retryHint) => {
    const r = sprintForecast({ sprintLengthDays: 10, hoursPerSprint: 40, ...input });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ isError: true, message, retryHint });
  });
});

describe("cocomoEstimate boundaries", () => {
  it("accepts kloc exactly at the 1e9 ceiling", () => {
    const r = cocomoEstimate({ kloc: 1e9, ...nominalCocomo });
    expect(r.ok).toBe(true);
  });

  it("rejects a non-finite result at the ceiling", () => {
    const r = cocomoEstimate({ kloc: 1e9, ...nominalCocomo, reasoningComplexity: 1e300 });
    expect(r).toEqual({
      ok: false,
      error: {
        isError: true,
        message: "COCOMO computation produced invalid result.",
        retryHint: "Ensure kloc and all rating multipliers are finite positive numbers.",
      },
    });
  });

  // aiSpeedup = max(3, 12 / (1 + (cycles - 1) × 0.15)), rounded to 0.1.
  it.each([
    [1, 12, "extreme"],
    [1 + 0.2 / 0.15, 10, "extreme"], // exactly 10 is not "< 10"
    [1 + 1.4 / 0.15, 5, "significant"], // raw 4.999…; the rounded speedup 5.0 is not "< 5"
    [20, 3.1, "moderate"],
  ])("iterative cycles %d → speedup %d (%s)", (iterativeCycles, aiSpeedup, speedupCategory) => {
    const r = cocomoEstimate({ kloc: 10, ...nominalCocomo, iterativeCycles });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.aiSpeedup).toBe(aiSpeedup);
    expect(r.data.speedupCategory).toBe(speedupCategory);
  });

  it("states its model assumptions", () => {
    const r = cocomoEstimate({ kloc: 10, ...nominalCocomo });
    expect(r.ok && r.data.assumptions).toEqual([
      "Based on COCOMO II Post-Architecture model (A=2.94, B=1.10).",
      "LLM productivity factor derived from empirical agent benchmarks.",
      "Cost drivers scaled for LLM-assisted workflows.",
      "Adjust for your team's actual velocity.",
    ]);
  });

  it.each([
    [0, "KLOC must be positive.", "Provide a positive value for kloc (thousands of lines of code)."],
    [2e9, "KLOC value 2000000000 is too large — computation would overflow.", "Provide a kloc value under 1,000,000,000."],
  ])("returns the full error contract for kloc=%d", (kloc, message, retryHint) => {
    const r = cocomoEstimate({ kloc, ...nominalCocomo });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ isError: true, message, retryHint });
  });
});

describe("criticalPath merge bias and slack", () => {
  it("applies a 5% merge bias per predecessor beyond two", () => {
    // D has 3 predecessors → duration 10 × 1.05 = 10.5, starting after C (4).
    const r = criticalPath([
      { name: "A", duration: 2, predecessors: [] },
      { name: "B", duration: 3, predecessors: [] },
      { name: "C", duration: 4, predecessors: [] },
      { name: "D", duration: 10, predecessors: ["A", "B", "C"] },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total_duration).toBe(14.5);
    expect(r.data.merge_bias_adjustment).toBe(0.05);
    expect(r.data.slack_per_task).toEqual({ A: 2, B: 1, C: 0, D: 0 });
    expect(r.data.critical_path).toEqual(["C", "D"]);
    expect(r.data.estimatedHours).toBe(116);
  });

  it("scales the merge bias with each extra predecessor (four → 10%)", () => {
    // E has 4 predecessors → 5 × 1.10 = 5.5 after the longest (D, 4) → 9.5.
    const r = criticalPath([
      { name: "A", duration: 1, predecessors: [] },
      { name: "B", duration: 2, predecessors: [] },
      { name: "C", duration: 3, predecessors: [] },
      { name: "D", duration: 4, predecessors: [] },
      { name: "E", duration: 5, predecessors: ["A", "B", "C", "D"] },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total_duration).toBe(9.5);
    expect(r.data.merge_bias_adjustment).toBe(0.1);
    expect(r.data.slack_per_task).toEqual({ A: 3, B: 2, C: 1, D: 0, E: 0 });
  });

  it("applies no merge bias at exactly two predecessors", () => {
    const r = criticalPath([
      { name: "A", duration: 2, predecessors: [] },
      { name: "B", duration: 3, predecessors: [] },
      { name: "E", duration: 5, predecessors: ["A", "B"] },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.total_duration).toBe(8);
    expect(r.data.merge_bias_adjustment).toBe(0);
  });

  it("treats slack of exactly 0.01 as critical", () => {
    const r = criticalPath([
      { name: "A", duration: 1, predecessors: [] },
      { name: "B", duration: 1.01, predecessors: [] },
      { name: "C", duration: 1, predecessors: ["A", "B"] },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.slack_per_task.A).toBe(0.01);
    expect(r.data.critical_path).toEqual(["A", "B", "C"]);
  });

  it.each([
    [[], "Task list must not be empty.", "Provide at least one task for critical path analysis."],
    [[{ name: "A", duration: 1, predecessors: [] }, { name: "A", duration: 2, predecessors: [] }], 'Duplicate task name: "A".', "Each task must have a unique name."],
    [[{ name: "A", duration: 0, predecessors: [] }], 'Task "A" has invalid duration: 0.', "Each task must have a positive, finite duration."],
    [[{ name: "A", duration: 1, predecessors: ["A"] }], 'Task "A" references itself as a predecessor.', "Remove self-references from predecessor lists."],
    [[{ name: "A", duration: 1, predecessors: ["Z"] }], 'Unknown predecessor "Z" in task "A".', "Ensure all predecessor names match task names exactly."],
    [[{ name: "A", duration: 1, predecessors: ["B"] }, { name: "B", duration: 1, predecessors: ["A"] }], "Circular dependency detected in task graph.", "Remove cycles from task predecessor chains."],
  ])("returns the full error contract (%#)", (tasks, message, retryHint) => {
    const r = criticalPath(tasks);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toEqual({ isError: true, message, retryHint });
  });
});
