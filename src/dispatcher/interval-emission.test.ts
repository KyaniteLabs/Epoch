// ---------------------------------------------------------------------------
// S3.1 — calibrated intervals across estimate outputs (golden tests)
// ---------------------------------------------------------------------------
//
// Proves, against a temp EPOCH_DATA_DIR, for cocomo_estimate /
// sprint_forecast / critical_path / token_time_bridge:
//   1. EMPIRICAL PATH (n >= 5): each tool's interval is two-sided
//      (P50/P80/P90 bands), source "empirical_ratio_quantile", scaled by THIS
//      tool's own (task_type, basis-era) ratio population on the
//      ledger-RECORDED basis (the value feedback.ts's extractEstimatedHours
//      reads back), with intervalPopulation naming the population + n and a
//      basisNote present. Golden: ratios [0.5..2.0] (7 pairs) yield a P80 band
//      of estimate x [0.6, 1.5].
//   2. FALLBACK PATH (n < 5, empty ledger): source "variance_fallback",
//      intervalNote present naming the fallback, no intervalPopulation,
//      basisNote still labels the basis.
//   3. ORDERING SANITY (both paths): bands are properly nested
//      (p50 within p80 within p90), lower <= upper, lower >= 0.
//
// And for schedule_risk:
//   4. TWO-SIDED intervals: twoSidedIntervals carries lower bounds per band
//      with source "variance_fallback" + intervalBasisNote; every upper bound
//      equals the legacy confidenceIntervals field byte-for-byte (no silent
//      widening — risk.ts's pre-S3.1 upper-only behavior reproduced exactly).
//
// PRD: .omx/plans/prd-epoch-upgrade.md S3.1 · roadmap #3 · ticket 11 basis rule.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TOOL_REGISTRY } from "./index.js";
import { resetLedgerReadCache } from "../lib/ledger.js";
import { resetIntervalPopulationCache } from "../lib/coverage.js";
import type { ToolResult } from "../types/index.js";

function callTool(tool: string, input: Record<string, unknown>): Record<string, unknown> {
  const handler = TOOL_REGISTRY.get(tool)?.handler;
  if (!handler) throw new Error(`${tool} handler not registered`);
  const result = handler(input) as ToolResult<Record<string, unknown>>;
  if (!result.ok) throw new Error(`${tool} returned an error: ${result.error.message}`);
  return result.data;
}

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-interval-emission-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env["EPOCH_DATA_DIR"];
  } else {
    process.env["EPOCH_DATA_DIR"] = previousDataDir;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});

/** Seed v1 (legacy, unstamped) matched pairs for one tool at recorded estimate 100h, ratios chosen so the P80 band is exactly [0.6, 1.5] x estimate. */
function seedPopulation(tool: string, outputs: Record<string, unknown>, taskType = "bugfix"): void {
  const ratios = [0.5, 0.6, 0.7, 1.0, 1.3, 1.5, 2.0];
  writeFileSync(
    join(tempDataDir, "estimates.jsonl"),
    ratios.map((_, i) => JSON.stringify({
      id: `s31-${tool}-${i}`,
      tool,
      inputs: { task_type: taskType },
      outputs,
      estimatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    })).join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(
    join(tempDataDir, "feedback.jsonl"),
    ratios.map((ratio, i) => JSON.stringify({
      estimateId: `s31-${tool}-${i}`,
      actualHours: ratio * 100,
      reportedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
    })).join("\n") + "\n",
    "utf-8",
  );
  resetLedgerReadCache();
  resetIntervalPopulationCache();
}

interface Band {
  readonly lower: number;
  readonly upper: number;
}

interface IntervalShape {
  readonly p50: Band;
  readonly p80: Band;
  readonly p90: Band;
  readonly source: string;
}

function getInterval(data: Record<string, unknown>): IntervalShape {
  const interval = data["interval"];
  expect(interval).toBeDefined();
  return interval as IntervalShape;
}

/** Bands properly nested (p50 ⊆ p80 ⊆ p90), ordered, clamped at 0. */
function expectSaneOrdering(interval: IntervalShape): void {
  const { p50, p80, p90 } = interval;
  expect(p50.lower).toBeGreaterThanOrEqual(0);
  expect(p50.lower).toBeLessThanOrEqual(p50.upper);
  expect(p80.lower).toBeLessThanOrEqual(p80.upper);
  expect(p90.lower).toBeLessThanOrEqual(p90.upper);
  // Nesting: wider confidence => band contains the narrower one.
  expect(p50.lower).toBeGreaterThanOrEqual(p80.lower);
  expect(p50.upper).toBeLessThanOrEqual(p80.upper);
  expect(p80.lower).toBeGreaterThanOrEqual(p90.lower);
  expect(p80.upper).toBeLessThanOrEqual(p90.upper);
}

function expectEmpiricalLabels(data: Record<string, unknown>, tool: string): void {
  expect(typeof data["basisNote"]).toBe("string");
  expect(data["basisNote"]).toContain("ledger-recorded basis");
  expect(data["intervalNote"]).toBeUndefined();
  const population = data["intervalPopulation"];
  expect(typeof population).toBe("string");
  expect(population).toContain(tool);
  expect(population).toContain("n=7");
}

function expectFallbackLabels(data: Record<string, unknown>, _tool: string): void {
  expect(typeof data["basisNote"]).toBe("string");
  expect(data["basisNote"]).toContain("variance-fallback");
  expect(typeof data["intervalNote"]).toBe("string");
  expect(data["intervalNote"]).toContain("variance-fallback");
  expect(data["intervalPopulation"]).toBeUndefined();
}

// ---------------------------------------------------------------------------
// cocomo_estimate — recorded basis personMonthsLlmAdjusted x 160h
// ---------------------------------------------------------------------------

describe("cocomo_estimate — S3.1 calibrated intervals", () => {
  const COCOMO_INPUT = { kloc: 10, reasoning_complexity: 1.0, context_completeness: 1.0, transformation_impact: 1.0, iterative_cycles: 1.0, human_oversight: 1.0, task_type: "bugfix" };

  it("empirical path: P80 band = personMonthsLlmAdjusted x [0.6, 1.5] from its own ratio population (n=7), labeled", () => {
    seedPopulation("cocomo_estimate", { personMonthsLlmAdjusted: 0.625 }); // recorded basis 100h
    const data = callTool("cocomo_estimate", COCOMO_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("empirical_ratio_quantile");
    expectSaneOrdering(interval);

    // Golden: quantiles [0.6, 1.5] applied to the recorded basis, displayed
    // in the tool's own unit (person-months).
    const pm = data["personMonthsLlmAdjusted"] as number;
    expect(interval.p80.lower).toBeCloseTo(pm * 0.6, 2);
    expect(interval.p80.upper).toBeCloseTo(pm * 1.5, 2);
    expectEmpiricalLabels(data, "cocomo_estimate");
  });

  it("fallback path (empty ledger): variance_fallback source, labeled, sane ordering", () => {
    const data = callTool("cocomo_estimate", COCOMO_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("variance_fallback");
    expectSaneOrdering(interval);
    expectFallbackLabels(data, "cocomo_estimate");
    expect(data["intervalNote"]).toContain("developer-profile");
  });
});

// ---------------------------------------------------------------------------
// sprint_forecast — recorded basis totalHours
// ---------------------------------------------------------------------------

describe("sprint_forecast — S3.1 calibrated intervals", () => {
  const SPRINT_INPUT = { backlog_points: 10, velocity_history: [10], hours_per_sprint: 100, task_type: "bugfix" };

  it("empirical path: P80 band = totalHours x [0.6, 1.5] from its own ratio population (n=7), labeled", () => {
    seedPopulation("sprint_forecast", { totalHours: 100 });
    const data = callTool("sprint_forecast", SPRINT_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("empirical_ratio_quantile");
    expectSaneOrdering(interval);

    const totalHours = data["totalHours"] as number;
    expect(totalHours).toBe(100); // 10 points x (100h / 10 velocity)
    expect(interval.p80.lower).toBeCloseTo(60, 1);
    expect(interval.p80.upper).toBeCloseTo(150, 1);
    expectEmpiricalLabels(data, "sprint_forecast");
  });

  it("fallback path (empty ledger): variance_fallback from the tool's own velocity dispersion, labeled", () => {
    const data = callTool("sprint_forecast", SPRINT_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("variance_fallback");
    expectSaneOrdering(interval);
    expectFallbackLabels(data, "sprint_forecast");
    // Single velocity point => the ±25% single-point prior is named.
    expect(data["intervalNote"]).toContain("single-velocity-point");
  });

  it("fallback with velocity variance names the coefficient of variation", () => {
    const data = callTool("sprint_forecast", { ...SPRINT_INPUT, velocity_history: [8, 10, 12, 14] });

    const interval = getInterval(data);
    expect(interval.source).toBe("variance_fallback");
    expect(data["intervalNote"]).toContain("coefficient of variation");
  });
});

// ---------------------------------------------------------------------------
// critical_path — recorded basis estimatedHours (total_duration x 8)
// ---------------------------------------------------------------------------

describe("critical_path — S3.1 calibrated intervals", () => {
  const CP_INPUT = { tasks: [{ name: "A", duration: 12.5, predecessors: [] }], task_type: "bugfix" };

  it("empirical path: P80 band = estimatedHours x [0.6, 1.5] from its own ratio population (n=7), labeled", () => {
    seedPopulation("critical_path", { estimatedHours: 100 });
    const data = callTool("critical_path", CP_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("empirical_ratio_quantile");
    expectSaneOrdering(interval);

    expect(data["estimatedHours"]).toBe(100); // 12.5 days x 8
    expect(interval.p80.lower).toBeCloseTo(60, 1);
    expect(interval.p80.upper).toBeCloseTo(150, 1);
    expectEmpiricalLabels(data, "critical_path");
  });

  it("fallback path (empty ledger): variance_fallback, labeled, sane ordering", () => {
    const data = callTool("critical_path", CP_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("variance_fallback");
    expectSaneOrdering(interval);
    expectFallbackLabels(data, "critical_path");
  });
});

// ---------------------------------------------------------------------------
// token_time_bridge — recorded basis estimatedMinutes / 60
// ---------------------------------------------------------------------------

describe("token_time_bridge — S3.1 calibrated intervals", () => {
  const TTB_INPUT = { tokens: 60_000, model: "claude-3.5-haiku-20241022", tool_calls: 0, reasoning_depth: "moderate", task_type: "bugfix" };

  it("empirical path: P80 band = estimatedMinutes x [0.6, 1.5] from its own ratio population (n=7), labeled; humanReadable leads with the interval", () => {
    // Recorded basis for token_time_bridge is estimatedMinutes / 60, so a
    // 6000-minute row records 100h and pairs with the ratio x 100h actuals.
    seedPopulation("token_time_bridge", { estimatedMinutes: 6000 }, "bugfix");
    const data = callTool("token_time_bridge", TTB_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("empirical_ratio_quantile");
    expectSaneOrdering(interval);

    const minutes = data["estimatedMinutes"] as number;
    expect(interval.p80.lower).toBeCloseTo(minutes * 0.6, 1);
    expect(interval.p80.upper).toBeCloseTo(minutes * 1.5, 1);
    expectEmpiricalLabels(data, "token_time_bridge");

    const humanReadable = data["humanReadable"] as string;
    expect(humanReadable.startsWith("Expected ")).toBe(true);
    expect(humanReadable).toContain("80% confidence interval");
    expect(humanReadable).toContain("Interval calibrated from");
  });

  it("fallback path (empty ledger): variance_fallback, labeled, sane ordering", () => {
    const data = callTool("token_time_bridge", TTB_INPUT);

    const interval = getInterval(data);
    expect(interval.source).toBe("variance_fallback");
    expectSaneOrdering(interval);
    expectFallbackLabels(data, "token_time_bridge");
    expect(data["intervalNote"]).toContain("developer-profile");
  });
});

// ---------------------------------------------------------------------------
// schedule_risk — two-sided intervals (risk.ts:55-57 fix)
// ---------------------------------------------------------------------------

describe("schedule_risk — S3.1 two-sided intervals", () => {
  const RISK_INPUT = { estimated_hours: 100 };

  it("emits twoSidedIntervals with lower bounds, variance_fallback source, and intervalBasisNote", () => {
    const data = callTool("schedule_risk", RISK_INPUT);

    const twoSided = data["twoSidedIntervals"] as { p50: Band; p80: Band; p95: Band; source: string };
    expect(twoSided).toBeDefined();
    expect(twoSided.source).toBe("variance_fallback");
    expect(typeof data["intervalBasisNote"]).toBe("string");

    // Two-sided: strictly meaningful lower bounds below the uppers.
    expect(twoSided.p50.lower).toBeLessThan(twoSided.p50.upper);
    expect(twoSided.p80.lower).toBeLessThan(twoSided.p80.upper);
    expect(twoSided.p95.lower).toBeLessThan(twoSided.p95.upper);
    // Nesting: p50 within p80 within p95, clamped at 0.
    expect(twoSided.p50.lower).toBeGreaterThanOrEqual(twoSided.p80.lower);
    expect(twoSided.p95.lower).toBeLessThanOrEqual(twoSided.p80.lower);
    expect(twoSided.p50.upper).toBeLessThanOrEqual(twoSided.p80.upper);
    expect(twoSided.p95.upper).toBeGreaterThanOrEqual(twoSided.p80.upper);
  });

  it("upper bounds are byte-identical to the legacy upper-only fields (no silent widening)", () => {
    const data = callTool("schedule_risk", RISK_INPUT);

    const legacy = data["confidenceIntervals"] as { p50: number; p80: number; p95: number };
    const twoSided = data["twoSidedIntervals"] as { p50: Band; p80: Band; p95: Band };

    expect(twoSided.p50.upper).toBe(legacy.p50);
    expect(twoSided.p80.upper).toBe(legacy.p80);
    expect(twoSided.p95.upper).toBe(legacy.p95);

    // And the legacy values themselves still equal the pre-S3.1 formula
    // (risk.ts:55-57): E x (1 + z x cappedMdape/100), empty-ledger profile
    // fallback cappedMdape.
    const cappedMdape = data["cappedMdape"] as number;
    const expectedP80 = Math.round(100 * (1 + 0.842 * cappedMdape / 100) * 10) / 10;
    const expectedP95 = Math.round(100 * (1 + 1.645 * cappedMdape / 100) * 10) / 10;
    expect(legacy.p80).toBe(expectedP80);
    expect(legacy.p95).toBe(expectedP95);
  });

  it("humanReadable surfaces the two-sided P80 span", () => {
    const data = callTool("schedule_risk", RISK_INPUT);
    const twoSided = data["twoSidedIntervals"] as { p80: Band };
    const humanReadable = data["humanReadable"] as string;
    expect(humanReadable).toContain(`Two-sided P80 span: ${twoSided.p80.lower}–${twoSided.p80.upper}h`);
  });
});

// ---------------------------------------------------------------------------
// Population isolation — a tool never borrows another tool's population
// ---------------------------------------------------------------------------

describe("S3.1 population isolation", () => {
  it("a populated cocomo_estimate cell does not leak intervals to sprint_forecast (never pooled across tools)", () => {
    seedPopulation("cocomo_estimate", { personMonthsLlmAdjusted: 0.625 });
    const sprint = callTool("sprint_forecast", { backlog_points: 10, velocity_history: [10], hours_per_sprint: 100, task_type: "bugfix" });

    const interval = getInterval(sprint);
    expect(interval.source).toBe("variance_fallback");
    expectFallbackLabels(sprint, "sprint_forecast");
  });

  it("an omitted task_type queries the ingest-fallback bucket (feature for cocomo_estimate)", () => {
    seedPopulation("cocomo_estimate", { personMonthsLlmAdjusted: 0.625 }, "feature");
    const data = callTool("cocomo_estimate", { kloc: 10 });

    const interval = getInterval(data);
    expect(interval.source).toBe("empirical_ratio_quantile");
    expect(data["intervalPopulation"]).toContain('"feature"');
  });
});
