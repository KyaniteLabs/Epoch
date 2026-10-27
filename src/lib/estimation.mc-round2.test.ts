/**
 * Mutation round 2 (L6 focus item 2b): pin monteCarloSim, seededRandom,
 * triangularSample, computeSprintConfidence and computePertRiskLevel.
 *
 * Every expectation is derived by hand from the formulas in estimation.ts —
 * with a FIXED seed, seededRandom is a deterministic LCG (Lehmer, modulus
 * 2^31−1, multiplier 16807), so exact sample sequences, percentiles and
 * overrun statistics are computable offline. The two private classifiers are
 * exercised through their exported callers.
 */
import { describe, expect, it } from "vitest";
import {
  monteCarloSim,
  percentileIndex,
  pertEstimate,
  sprintForecast,
} from "./estimation.js";
import type { MonteCarloTask } from "../types/index.js";

// ---------------------------------------------------------------------------
// seededRandom / triangularSample via a degenerate task: optimistic ==
// mostLikely == pessimistic makes triangularSample return the mode for every
// draw regardless of rng — pinning the max===min short-circuit exactly.
// ---------------------------------------------------------------------------
const TASK = (o: number, m: number, p: number, name = "t"): MonteCarloTask => ({
  name,
  optimistic: o,
  mostLikely: m,
  pessimistic: p,
});

describe("percentileIndex (ceil-rank contract)", () => {
  it("n=20 p95 stays strictly below the max", () => {
    expect(percentileIndex(20, 0.95)).toBe(18);
  });
  it("n=1000 median lands on the 500th order statistic", () => {
    expect(percentileIndex(1000, 0.5)).toBe(499);
  });
  it("clamps at both ends", () => {
    expect(percentileIndex(0, 0.5)).toBe(0);
    expect(percentileIndex(1, 0.5)).toBe(0);
    expect(percentileIndex(10, 0)).toBe(0);
    expect(percentileIndex(10, 1)).toBe(9);
  });
});

describe("monteCarloSim: deterministic-seed exact values", () => {
  it("a degenerate (5,5,5) task is constant 5 regardless of seed", () => {
    const r = monteCarloSim([TASK(5, 5, 5)], 100, 7);
    expect(r.p10).toBe("5");
    expect(r.p50).toBe("5");
    expect(r.p80).toBe("5");
    expect(r.p95).toBe("5");
    expect(r.estimatedHours).toBe(40); // 5 days * 8h
    expect(r.estimatedCost).toBe(2000000); // 40h * 50,000 per hour
    expect(r.converged).toBe(true); // both checkpoint medians are 5
    expect(r.criticalPathProbability).toBeNull(); // no target
    expect(r.riskEvents).toEqual([]); // sampled == expected*1.5? 5 > 7.5? no
    expect(r.humanReadable).toContain("Median (p50): 5 days");
    expect(r.humanReadable).not.toContain("criticalPathProbability");
  });

  it("two degenerate tasks add linearly", () => {
    const r = monteCarloSim([TASK(2, 2, 2, "a"), TASK(3, 3, 3, "b")], 50, 1);
    expect(r.p50).toBe("5");
    expect(r.estimatedHours).toBe(40);
  });

  it("deadline probability is exact against a constant task", () => {
    // 5-day task, target 40h = 5 days: every draw meets it -> 1.0.
    const met = monteCarloSim([TASK(5, 5, 5)], 10, 3, 40);
    expect(met.criticalPathProbability).toBe(1);
    expect(met.humanReadable).toContain("Probability of completing within 40 hours");
    expect(met.humanReadable).toContain("100%");
    // Target 39h = 4.875 days: never met -> 0.0 (still reported, not null).
    const missed = monteCarloSim([TASK(5, 5, 5)], 10, 3, 39);
    expect(missed.criticalPathProbability).toBe(0);
  });

  it("the same seed reproduces byte-identical results; a different seed shifts them", () => {
    const a = monteCarloSim([TASK(1, 3, 8)], 500, 42);
    const b = monteCarloSim([TASK(1, 3, 8)], 500, 42);
    expect(a).toEqual(b);
    const c = monteCarloSim([TASK(1, 3, 8)], 500, 43);
    // p50 may coincide; the FULL result object differing proves the rng wired.
    expect(JSON.stringify(a) !== JSON.stringify(c)).toBe(true);
  });

  it("per-task overrun risk rows carry per-task magnitude, sorted by excess", () => {
    // wide task blows 1.5x PERT often; tight task (3,3,3) never does.
    const r = monteCarloSim([TASK(1, 2, 20, "wide"), TASK(3, 3, 3, "tight")], 400, 9);
    expect(r.riskEvents.length).toBeGreaterThan(0);
    expect(r.riskEvents.at(0)?.description).toContain('"wide"');
    expect(r.riskEvents.some((e) => e.description.includes('"tight"'))).toBe(false);
    // probability is a 2-decimal percentage in [0,1]
    for (const e of [...r.riskEvents] as Array<{ probability: number }>) {
      expect(e.probability).toBeLessThanOrEqual(1);
      expect(e.probability).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(e.probability * 100)).toBe(true);
    }
  });

  it("empty task list is the documented error shape", () => {
    const r = monteCarloSim([], 100, 1);
    expect(r.converged).toBe(false);
    expect(r.estimatedHours).toBe(0);
    expect(r.p50).toBe("0");
    expect(r.criticalPathProbability).toBeNull();
    expect(r.riskEvents).toEqual([
      { description: "Task list must not be empty.", probability: 1, impactDays: 0 },
    ]);
    expect(r.humanReadable).toBe(
      "Error: Provide at least one task for Monte Carlo simulation.",
    );
  });

  it("percentile ordering holds for a skewed task", () => {
    const r = monteCarloSim([TASK(1, 3, 40)], 1000, 11);
    const raw = [r.p10, r.p50, r.p80, r.p95].map((x) => Number(x ?? "0"));
    const [p10, p50, p80, p95] = raw as [number, number, number, number];
    expect(raw.every((n) => Number.isFinite(n))).toBe(true);
    expect(p10).toBeLessThanOrEqual(p50);
    expect(p50).toBeLessThanOrEqual(p80);
    expect(p80).toBeLessThanOrEqual(p95);
    // p95 strictly exceeds p50 for any real spread
    expect(p95).toBeGreaterThan(p50);
    // every percentile is a 2-decimal string
    for (const s of [r.p10, r.p50, r.p80, r.p95]) {
      expect(s).toMatch(/^\d+(\.\d{1,2})?$/);
    }
  });
});

// ---------------------------------------------------------------------------
// computeSprintConfidence — exercised via computeSprintForecast's
// confidence field. Table derived by hand from the thresholds:
//   ≤2 sprints → low; 3–5: cv<0.3 medium else low; >5: <0.3 high,
//   <0.5 medium, else low.
// ---------------------------------------------------------------------------
describe("computeSprintConfidence via computeSprintForecast", () => {
  const conf = (history: number[]): string => {
    const out = sprintForecast({
      backlogPoints: 100,
      velocityHistory: history,
      sprintLengthDays: 10,
      hoursPerSprint: 80,
    });
    if (!out.ok) throw new Error("sprintForecast failed");
    return out.data.confidence;
  };
  // history length drives the sprintCount axis; cv drives the band axis.
  // cv is computed then ROUNDED to 2 decimals inside sprintForecast, so pick
  // histories whose cv rounds to the intended side of each threshold.
  it("≤2 sprints of history is always low, whatever the cv", () => {
    expect(conf([9, 11])).toBe("low"); // cv ~0.16
    expect(conf([4, 16])).toBe("low"); // cv ~0.75
    expect(conf([10])).toBe("low"); // single sprint: cv 0, still low
  });

  it("3–5 sprints: medium below cv 0.3, low at/above", () => {
    expect(conf([9.7, 10.3, 9.7])).toBe("medium"); // cv ~0.03
    expect(conf([9, 11, 9, 11, 9])).toBe("medium"); // cv ~0.11
    expect(conf([4, 16, 4])).toBe("low"); // cv ~0.69
  });

  it(">5 sprints: high below 0.3, medium at 0.3–0.5, low above 0.5", () => {
    expect(conf([9, 11, 9, 11, 9, 11])).toBe("high"); // cv ~0.11
    expect(conf([7, 13, 7, 13, 7, 13, 7])).toBe("medium"); // cv ~0.31
    expect(conf([3, 17, 3, 17, 3, 17, 3])).toBe("low"); // cv ~0.76
  });

  // Strict-threshold pins (round-2 survivors): cv is computed then rounded
  // to 2 decimals inside sprintForecast, so construct histories whose cv is
  // EXACTLY 0.30 and exactly 0.50. For mean m and n=2, std = |d| where the
  // values are m±d, so cv = d/m exactly.
  // cv is round(std/mean * 100)/100 with the n-1 denominator. These
  // histories are solved by hand so std/mean is EXACTLY the target cv:
  //   n=3, mean 10, std 3:  devs {-3, 3, 0}         -> cv 0.30
  //   n=6, mean 10, std 3:  devs {±4.5, ±1.5, 0, 0} -> cv 0.30 (SS=45)
  //   n=6, mean 10, std 5:  devs {±7.5, ±2.5, 0, 0} -> cv 0.50 (SS=125)

  it("cv exactly 0.30 in the 3–5 branch is LOW (strict <, not <=)", () => {
    expect(conf([7, 13, 10])).toBe("low");
  });

  it("cv exactly 0.30 beyond 5 sprints is MEDIUM, not high (strict <)", () => {
    expect(conf([5.5, 14.5, 8.5, 11.5, 10, 10])).toBe("medium");
  });

  it("cv exactly 0.50 beyond 5 sprints is LOW, not medium (strict <)", () => {
    expect(conf([2.5, 17.5, 7.5, 12.5, 10, 10])).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// computePertRiskLevel — spread = (pessimistic − optimistic)/mostLikely;
// <1 low, <2 medium, else high. Exported directly.
// ---------------------------------------------------------------------------
describe("computePertRiskLevel boundaries (via pertEstimate.riskLevel)", () => {
  const level = (o: number, m: number, p: number): string => {
    const out = pertEstimate(o, m, p, "hours");
    if (!out.ok) throw new Error("pertEstimate failed");
    return (out.data as unknown as { riskLevel: string }).riskLevel;
  };
  it("spread below 1 is low", () => {
    expect(level(3, 5, 7)).toBe("low"); // spread 0.8
    expect(level(4, 5, 8)).toBe("low"); // 0.8 again, distinct point
  });
  it("spread 1 up to 2 is medium", () => {
    expect(level(3, 5, 8)).toBe("medium"); // 1.0 exactly → medium
    expect(level(2, 5, 9)).toBe("medium"); // 1.4
  });
  it("spread ≥2 is high", () => {
    expect(level(3, 5, 13)).toBe("high"); // 2.0 exactly → high
    expect(level(1, 1, 6)).toBe("high"); // 5.0 (PERT allows o == m)
  });
});
