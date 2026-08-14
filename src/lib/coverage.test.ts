import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  pertVarianceIntervals,
  empiricalRatioQuantiles,
  empiricalIntervals,
  computeIntervalCoverage,
  MIN_N_FOR_QUANTILES,
} from "./coverage.js";

// ---------------------------------------------------------------------------
// Pure-function math tests (no I/O)
// ---------------------------------------------------------------------------

describe("pertVarianceIntervals", () => {
  it("computes symmetric intervals around the expected value, widening from p50 to p90", () => {
    const intervals = pertVarianceIntervals(10, 2);
    expect(intervals.source).toBe("pert_variance");
    expect(intervals.p50.lower).toBeCloseTo(10 - 0.674 * 2, 2);
    expect(intervals.p50.upper).toBeCloseTo(10 + 0.674 * 2, 2);
    expect(intervals.p80.lower).toBeCloseTo(10 - 1.282 * 2, 2);
    expect(intervals.p80.upper).toBeCloseTo(10 + 1.282 * 2, 2);
    expect(intervals.p90.lower).toBeCloseTo(10 - 1.645 * 2, 2);
    expect(intervals.p90.upper).toBeCloseTo(10 + 1.645 * 2, 2);
    // Wider intervals contain narrower ones.
    expect(intervals.p90.lower).toBeLessThanOrEqual(intervals.p80.lower);
    expect(intervals.p90.upper).toBeGreaterThanOrEqual(intervals.p80.upper);
  });

  it("clamps the lower bound at 0 for a high-variance, low-expected estimate", () => {
    const intervals = pertVarianceIntervals(1, 5);
    expect(intervals.p90.lower).toBe(0);
  });
});

describe("empiricalRatioQuantiles", () => {
  it("returns null below MIN_N_FOR_QUANTILES", () => {
    const ratios = Array.from({ length: MIN_N_FOR_QUANTILES - 1 }, (_, i) => 1 + i * 0.1);
    expect(empiricalRatioQuantiles(ratios)).toBeNull();
  });

  it("computes nearest-rank quantiles at exactly the threshold", () => {
    // 7 ratios, ascending: 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4
    const ratios = [1.1, 0.8, 1.4, 1.0, 1.3, 0.9, 1.2];
    const q = empiricalRatioQuantiles(ratios);
    expect(q).not.toBeNull();
    expect(q?.n).toBe(7);
    // p80 = [quantile(0.10), quantile(0.90)] over the sorted array; nearest-rank
    // index = round(q * (n-1)): idx(0.10)=round(0.6)=1 -> 0.9; idx(0.90)=round(5.4)=5 -> 1.3
    expect(q?.p80).toEqual([0.9, 1.3]);
  });
});

describe("empiricalIntervals", () => {
  it("scales ratio quantiles by the estimated-hours value", () => {
    const quantiles = { n: 7, p50: [0.95, 1.1] as const, p80: [0.9, 1.3] as const, p90: [0.85, 1.4] as const };
    const intervals = empiricalIntervals(10, quantiles);
    expect(intervals.source).toBe("empirical_ratio_quantile");
    expect(intervals.p80).toEqual({ lower: 9, upper: 13 });
    expect(intervals.p90).toEqual({ lower: 8.5, upper: 14 });
  });
});

// ---------------------------------------------------------------------------
// computeIntervalCoverage — synthetic fixture with known quantiles
// ---------------------------------------------------------------------------

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-coverage-test-"));
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

interface FixtureEstimate {
  id: string;
  tool: string;
  taskType: string;
  outputs: Record<string, unknown>;
}

function writeFixture(estimates: FixtureEstimate[], actuals: Array<{ estimateId: string; actualHours: number }>): void {
  const estimateLines = estimates
    .map((e) =>
      JSON.stringify({
        id: e.id,
        tool: e.tool,
        inputs: { task_type: e.taskType },
        outputs: e.outputs,
        estimatedAt: "2026-06-01T00:00:00.000Z",
      }),
    )
    .join("\n");
  const actualLines = actuals
    .map((a) =>
      JSON.stringify({
        estimateId: a.estimateId,
        actualHours: a.actualHours,
        reportedAt: "2026-06-02T00:00:00.000Z",
      }),
    )
    .join("\n");
  writeFileSync(join(tempDataDir, "estimates.jsonl"), `${estimateLines}\n`);
  writeFileSync(join(tempDataDir, "feedback.jsonl"), `${actualLines}\n`);
}

describe("computeIntervalCoverage — synthetic fixture", () => {
  it("returns zero/null coverage with no data", () => {
    writeFixture([], []);
    const report = computeIntervalCoverage();
    expect(report.n).toBe(0);
    expect(report.p80CoverageRate).toBeNull();
    expect(report.targetP80Coverage).toBe(0.8);
  });

  it("computes exact coverage math on a known fixture (pert_variance + empirical_ratio_quantile)", () => {
    // --- pert_estimate rows, task_type "feature": expected=10, stdDeviation=2 ---
    // p80 interval = [10 - 1.282*2, 10 + 1.282*2] = [7.436, 12.564]
    const pertEstimates: FixtureEstimate[] = [
      { id: "coverage-fixture-pert-1", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, stdDeviation: 2, unit: "hours" } },
      { id: "coverage-fixture-pert-2", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, stdDeviation: 2, unit: "hours" } },
    ];
    const pertActuals = [
      { estimateId: "coverage-fixture-pert-1", actualHours: 9 }, // within [7.436, 12.564] -> hit
      { estimateId: "coverage-fixture-pert-2", actualHours: 20 }, // outside -> miss
    ];

    // --- reference_class_estimate rows, task_type "testing": estimatedHours=10 for each ---
    // ratios: 0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4 (7 records, >= MIN_N_FOR_QUANTILES)
    // p80 ratio interval = [0.9, 1.3] -> absolute interval [9, 13]
    // actual hours = ratio * 10 => 8,9,10,11,12,13,14; within [9,13]: 9,10,11,12,13 = 5 hits, 8 and 14 miss
    const ratioTaskType = "testing";
    const refEstimates: FixtureEstimate[] = Array.from({ length: 7 }, (_, i) => ({
      id: `coverage-fixture-ref-${i}`,
      tool: "reference_class_estimate",
      taskType: ratioTaskType,
      outputs: { correctedEstimate: 10 },
    }));
    const ratios = [0.8, 0.9, 1.0, 1.1, 1.2, 1.3, 1.4];
    const refActuals = refEstimates.map((e, i) => ({ estimateId: e.id, actualHours: (ratios[i] ?? 1) * 10 }));

    writeFixture([...pertEstimates, ...refEstimates], [...pertActuals, ...refActuals]);

    const report = computeIntervalCoverage();

    expect(report.n).toBe(9); // 2 pert + 7 ref
    expect(report.p80CoverageRate).toBeCloseTo(6 / 9, 3); // 1 pert hit + 5 ref hits = 6

    expect(report.byTaskType["feature"]).toEqual({ n: 2, p80CoverageRate: 0.5, method: "pert_variance" });
    expect(report.byTaskType[ratioTaskType]?.n).toBe(7);
    expect(report.byTaskType[ratioTaskType]?.method).toBe("empirical_ratio_quantile");
    expect(report.byTaskType[ratioTaskType]?.p80CoverageRate).toBeCloseTo(5 / 7, 3);
  });

  it("reports insufficient_data for a task_type below MIN_N_FOR_QUANTILES on a non-pert tool", () => {
    const estimates: FixtureEstimate[] = Array.from({ length: MIN_N_FOR_QUANTILES - 1 }, (_, i) => ({
      id: `coverage-fixture-thin-${i}`,
      tool: "cocomo_estimate",
      taskType: "design",
      outputs: { totalHours: 10 },
    }));
    const actuals = estimates.map((e) => ({ estimateId: e.id, actualHours: 10 }));
    writeFixture(estimates, actuals);

    const report = computeIntervalCoverage();
    // Every pair is skipped (no predictable interval) — not scored, not fabricated.
    expect(report.n).toBe(0);
    expect(report.byTaskType["design"]).toEqual({ n: 0, p80CoverageRate: null, method: "insufficient_data" });
  });

  // -------------------------------------------------------------------------
  // Unit normalization (ticket 12): PERT rows recorded in days/weeks/months
  // must have expected/stdDeviation converted to hours (8/40/160 table) before
  // being compared against hours-denominated actuals.
  // -------------------------------------------------------------------------

  it("golden fixture: 2-day estimate (expected=2, σ=0.33) vs actualHours=16 flips miss→hit", () => {
    writeFixture(
      [{ id: "coverage-golden-days", tool: "pert_estimate", taskType: "feature", outputs: { expected: 2, stdDeviation: 0.33, unit: "days" } }],
      [{ estimateId: "coverage-golden-days", actualHours: 16 }],
    );

    const report = computeIntervalCoverage();

    // Converted with the shared ingest table: expected = 2d × 8h = 16h,
    // σ = 0.33d × 8h = 2.64h → p80 = 16 ± 1.282×2.64 = [12.62, 19.38] → 16 is a hit.
    // Without conversion the interval would be [1.58, 2.42] and 16h would score as a miss.
    expect(report.n).toBe(1);
    expect(report.p80CoverageRate).toBe(1);
    expect(report.byTaskType["feature"]).toEqual({ n: 1, p80CoverageRate: 1, method: "pert_variance" });
  });

  it("mixed-unit fixture matches hand-computed coverage (hours/days/weeks/months)", () => {
    const estimates: FixtureEstimate[] = [
      // hours row: p80 = 10 ± 1.282×2 = [7.44, 12.56]; actual 10 → hit
      { id: "coverage-mixed-hours", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, stdDeviation: 2, unit: "hours" } },
      // days row: 2d = 16h, σ 0.25d = 2h → p80 = [13.44, 18.56]; actual 16 → hit
      { id: "coverage-mixed-days", tool: "pert_estimate", taskType: "feature", outputs: { expected: 2, stdDeviation: 0.25, unit: "days" } },
      // weeks row: 1w = 40h, σ 0.1w = 4h → p80 = [34.87, 45.13]; actual 45 → hit
      { id: "coverage-mixed-weeks", tool: "pert_estimate", taskType: "feature", outputs: { expected: 1, stdDeviation: 0.1, unit: "weeks" } },
      // months row: 0.5mo = 80h, σ 0.05mo = 8h → p80 = [69.74, 90.26]; actual 100 → miss
      { id: "coverage-mixed-months", tool: "pert_estimate", taskType: "feature", outputs: { expected: 0.5, stdDeviation: 0.05, unit: "months" } },
    ];
    const actuals = [
      { estimateId: "coverage-mixed-hours", actualHours: 10 },
      { estimateId: "coverage-mixed-days", actualHours: 16 },
      { estimateId: "coverage-mixed-weeks", actualHours: 45 },
      { estimateId: "coverage-mixed-months", actualHours: 100 },
    ];
    writeFixture(estimates, actuals);

    const report = computeIntervalCoverage();

    // Hand-computed: 3 hits of 4 scored pairs → 0.75, all via pert_variance.
    expect(report.n).toBe(4);
    expect(report.p80CoverageRate).toBeCloseTo(0.75, 3);
    expect(report.byTaskType["feature"]).toEqual({ n: 4, p80CoverageRate: 0.75, method: "pert_variance" });
  });

  it("a pert row with an unrecognized unit falls back to the empirical path instead of a unit-corrupted interval", () => {
    writeFixture(
      [
        { id: "coverage-bad-unit", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, stdDeviation: 2, unit: "fortnights" } },
      ],
      [{ estimateId: "coverage-bad-unit", actualHours: 10 }],
    );

    const report = computeIntervalCoverage();

    // The row is unusable end-to-end: extractEstimatedHours() refuses the
    // unrecognized unit (null estimated hours → the pair never loads), so
    // nothing is scored and no "feature" entry is fabricated.
    expect(report.n).toBe(0);
    expect(report.p80CoverageRate).toBeNull();
    expect(report.byTaskType["feature"]).toBeUndefined();
  });
});
