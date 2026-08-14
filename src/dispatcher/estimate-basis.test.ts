// ---------------------------------------------------------------------------
// Ticket 11 (estimate-basis unification) — golden end-to-end tests
// ---------------------------------------------------------------------------
//
// Proves, against a temp EPOCH_DATA_DIR:
//   1. PERT empirical intervals apply ratio quantiles on the SAME basis the
//      ratios were computed on (raw `expected` × unit factor), so a 10h
//      estimate with quantiles [0.6, 1.5] yields 6–15 — not 5.34–13.35
//      (the old behavior multiplied in the ~0.89 correction factor) and not
//      10.8–27 (the old ai_native=0 case at correction factor 1.8).
//   2. The displayed point estimate is the ledger-RECORDED estimate for both
//      pert_estimate (raw expected) and reference_class_estimate
//      (correctedEstimate); adjustedEstimate survives only as a labeled dual
//      field, never as the recorded or interval basis.
//   3. New estimate rows carry basisVersion: 2 (legacy rows are implicitly v1).
//   4. Handler output labels which basis-era population produced an interval.
//
// Ticket: .scratch/epoch-remediation/issues/11-estimate-basis-unification.md
// PRD: .omx/plans/prd-epoch-remediation.md D1.

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TOOL_REGISTRY, dispatch } from "./index.js";
import { extractEstimatedHours } from "../lib/feedback.js";
import { resetLedgerReadCache, getLedgerCacheStatus, ESTIMATES_FILE, ACTUALS_FILE } from "../lib/ledger.js";
import type { ToolResult } from "../types/index.js";

const maybePertHandler = TOOL_REGISTRY.get("pert_estimate")?.handler;
if (!maybePertHandler) throw new Error("pert_estimate handler not registered");
const pertHandler = maybePertHandler;

function callPert(input: Record<string, unknown>): Record<string, unknown> {
  const result = pertHandler(input) as ToolResult<Record<string, unknown>>;
  if (!result.ok) throw new Error(`pert_estimate returned an error: ${result.error.message}`);
  return result.data;
}

interface SeededEstimate {
  id: string;
  tool: string;
  outputs: Record<string, unknown>;
  inputs?: Record<string, unknown>;
  basisVersion?: 1 | 2;
}

function seedLedger(estimates: SeededEstimate[]): void {
  writeFileSync(
    join(tempDataDir, "estimates.jsonl"),
    estimates
      .map((e) =>
        JSON.stringify({
          id: e.id,
          tool: e.tool,
          inputs: e.inputs ?? { task_type: "bugfix" },
          outputs: e.outputs,
          estimatedAt: "2026-06-01T00:00:00.000Z",
          ...(e.basisVersion !== undefined && { basisVersion: e.basisVersion }),
        }),
      )
      .join("\n") + "\n",
    "utf-8",
  );
}

function seedActuals(pairs: Array<{ estimateId: string; actualHours: number }>): void {
  writeFileSync(
    join(tempDataDir, "feedback.jsonl"),
    pairs
      .map((a) => JSON.stringify({ estimateId: a.estimateId, actualHours: a.actualHours, reportedAt: "2026-06-02T00:00:00.000Z" }))
      .join("\n") + "\n",
    "utf-8",
  );
}

/** Seed matched v1 pert_estimate/bugfix pairs at recorded estimate 10h whose actual/estimate ratios yield p80 quantiles exactly [0.6, 1.5]. */
function seedPertQuantiles0607150(): void {
  const ratios = [0.5, 0.6, 0.7, 1.0, 1.3, 1.5, 2.0];
  seedLedger(
    ratios.map((_, i) => ({
      id: `basis-pert-v1-${i}`,
      tool: "pert_estimate",
      outputs: { expected: 10, unit: "hours" },
    })),
  );
  seedActuals(ratios.map((ratio, i) => ({ estimateId: `basis-pert-v1-${i}`, actualHours: ratio * 10 })));
}

/** (O + 4M + P) / 6 = 10 exactly, so the point estimate is a clean 10h (or 10 days). */
const PERT_10 = { optimistic: 2, most_likely: 10, pessimistic: 18 } as const;

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-estimate-basis-test-"));
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

function readEstimateRows(): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(tempDataDir, "estimates.jsonl"), "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

describe("pert_estimate — same-basis empirical intervals (ticket 11)", () => {
  it("golden: 10h estimate with ratio quantiles [0.6, 1.5] → P80 interval 6–15, not 5.34–13.35", () => {
    seedPertQuantiles0607150();
    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix" });

    expect(data["expected"]).toBe(10);
    const interval = data["interval"] as { source: string; p80: { lower: number; upper: number } };
    expect(interval.source).toBe("empirical_ratio_quantile");
    expect(interval.p80).toEqual({ lower: 6, upper: 15 });
    // The old, basis-mismatched behavior multiplied the quantiles by the
    // adjustedEstimate (10 × 0.89 = 8.9), producing 5.34–13.35.
    expect(interval.p80.lower).not.toBeCloseTo(5.34, 2);
    expect(interval.p80.upper).not.toBeCloseTo(13.35, 2);
  });

  it("golden: ai_native=0 (correction factor 1.8) leaves the interval unbiased — still 6–15, not 10.8–27", () => {
    seedPertQuantiles0607150();
    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix", ai_native: 0 });

    // The profile correction still applies to adjustedEstimate (dual field)...
    const adjusted = data["adjustedEstimate"] as number;
    expect(adjusted).toBeCloseTo(10 * 1.8, 2);
    // ...but the interval stays on the ledger-recorded basis.
    const interval = data["interval"] as { p80: { lower: number; upper: number } };
    expect(interval.p80).toEqual({ lower: 6, upper: 15 });
    expect(interval.p80.lower).not.toBeCloseTo(10.8, 2);
    expect(interval.p80.upper).not.toBeCloseTo(27, 2);
  });

  it("golden: the interval follows the recorded basis across units — 10 days stays consistent in the caller's unit", () => {
    seedPertQuantiles0607150();
    const data = callPert({ ...PERT_10, unit: "days", task_type: "bugfix" });

    expect(data["expected"]).toBe(10);
    const interval = data["interval"] as { p80: { lower: number; upper: number } };
    // Recorded basis = 10 days = 80 hours; 80 × [0.6, 1.5] = [48, 120] hours,
    // rendered back in the caller's unit: [6, 15] days.
    expect(interval.p80).toEqual({ lower: 6, upper: 15 });
    expect(data["humanReadable"]).toContain("6–15 days");
  });

  it("displayed point estimate == ledger-recorded estimate (raw expected), with adjustedEstimate kept as a labeled dual field", () => {
    seedPertQuantiles0607150();
    // ai_native=0 pins the correction factor at exactly 1.8 (human anchor),
    // so the dual bases are guaranteed distinct in this test.
    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix", ai_native: 0 });

    const humanReadable = data["humanReadable"] as string;
    expect(humanReadable).toContain("point estimate 10 hours");
    expect(humanReadable).toContain("ledger-recorded basis");
    expect(data["adjustedEstimate"]).toBe(18);
    // The adjusted value is mentioned only as the labeled secondary basis...
    expect(humanReadable).toContain("adjustedEstimate 18");
    // ...never as the headline point estimate.
    expect(humanReadable).not.toContain("point estimate 18");
    expect(typeof data["basisNote"]).toBe("string");
  });

  it("labels which basis-era population produced the interval (v1 fallback below 30 v2 pairs)", () => {
    seedPertQuantiles0607150();
    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix" });
    expect(data["intervalPopulation"]).toBe('basis-v1 pert_estimate "bugfix" matched pairs (n=7)');
  });

  it("switches the population label to v2 once 30 stamped pairs exist", () => {
    const ratios = [0.5, 0.6, 0.7, 1.0, 1.3, 1.5, 2.0];
    seedLedger([
      ...ratios.map((_, i) => ({ id: `basis-pert-v1-${i}`, tool: "pert_estimate", outputs: { expected: 10, unit: "hours" } })),
      ...Array.from({ length: 30 }, (_, i) => ({
        id: `basis-pert-v2-${i}`,
        tool: "pert_estimate",
        outputs: { expected: 10, unit: "hours" },
        basisVersion: 2 as const,
      })),
    ]);
    seedActuals([
      ...ratios.map((ratio, i) => ({ estimateId: `basis-pert-v1-${i}`, actualHours: ratio * 10 })),
      ...Array.from({ length: 30 }, (_, i) => ({ estimateId: `basis-pert-v2-${i}`, actualHours: 10 })),
    ]);

    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix" });
    expect(data["intervalPopulation"]).toBe('basis-v2 pert_estimate "bugfix" matched pairs (n=30)');
    const interval = data["interval"] as { p80: { lower: number; upper: number } };
    // The v2 population's ratios are all 1.0 → interval collapses onto the recorded estimate.
    expect(interval.p80).toEqual({ lower: 10, upper: 10 });
  });
});

describe("reference_class_estimate — displayed == recorded (ticket 11)", () => {
  /** Seed 7 matched v1 reference_class_estimate/bugfix rows at correctedEstimate 10h (p80 quantiles [0.6, 1.5]). */
  function seedRefQuantiles0607150(): void {
    const ratios = [0.5, 0.6, 0.7, 1.0, 1.3, 1.5, 2.0];
    seedLedger(
      ratios.map((_, i) => ({
        id: `basis-ref-v1-${i}`,
        tool: "reference_class_estimate",
        outputs: { correctedEstimate: 10 },
      })),
    );
    seedActuals(ratios.map((ratio, i) => ({ estimateId: `basis-ref-v1-${i}`, actualHours: ratio * 10 })));
  }

  it("the interval and humanReadable point estimate are on the ledger-recorded basis (correctedEstimate), not adjustedEstimate", async () => {
    seedRefQuantiles0607150();
    // ai_native=0 pins the developerProfile factor at 1.8 while the seeded
    // rows' median ratio (the data-driven factor) is 1.0 — so the dual bases
    // are guaranteed distinct in this test.
    const result = await dispatch("reference_class_estimate", { task_type: "bugfix", complexity: 3, ai_native: 0 });
    if (!result.ok) throw new Error(`reference_class_estimate failed: ${result.error.message}`);
    const data = result.data as Record<string, unknown>;

    const corrected = data["correctedEstimate"] as number;
    const adjusted = data["adjustedEstimate"] as number;
    expect(adjusted).toBeCloseTo(corrected * 1.8, 1);
    expect(adjusted).not.toBe(corrected);

    // Interval endpoints == quantiles × the SAME value the ledger records.
    const interval = data["interval"] as { source: string; p80: { lower: number; upper: number } };
    expect(interval.source).toBe("empirical_ratio_quantile");
    const round2 = (v: number) => Math.round(v * 100) / 100;
    expect(interval.p80.lower).toBe(round2(corrected * 0.6));
    expect(interval.p80.upper).toBe(round2(corrected * 1.5));

    // Displayed point estimate is correctedEstimate, labeled as the recorded basis.
    const humanReadable = data["humanReadable"] as string;
    expect(humanReadable).toContain(`point estimate ${corrected} hours`);
    expect(humanReadable).toContain("ledger-recorded basis");
    expect(humanReadable).not.toContain(`point estimate ${adjusted} hours`);
    expect(data["intervalPopulation"]).toBe('basis-v1 reference_class_estimate "bugfix" matched pairs (n=7)');
    expect(typeof data["basisNote"]).toBe("string");

    // Recorded == displayed: the row the dispatcher wrote back records exactly
    // the value that was displayed.
    const rows = readEstimateRows().filter((r) => r["tool"] === "reference_class_estimate" && r["basisVersion"] === 2);
    expect(rows).toHaveLength(1);
    const outputs = rows[0]?.["outputs"] as Record<string, unknown>;
    expect(extractEstimatedHours(outputs)).toBe(corrected);
    expect(outputs["correctedEstimate"]).toBe(corrected);
  });
});

describe("recordEstimate — basis-version stamp (ticket 11)", () => {
  it("stamps every newly written estimate row with basisVersion: 2", async () => {
    const result = await dispatch("pert_estimate", { ...PERT_10, unit: "hours", task_type: "bugfix" });
    expect(result.ok).toBe(true);

    const rows = readEstimateRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.["basisVersion"]).toBe(2);
  });

  it("legacy unstamped rows read as basis v1 (implicitly) alongside stamped v2 rows", async () => {
    seedPertQuantiles0607150(); // v1 rows: no basisVersion field
    await dispatch("pert_estimate", { ...PERT_10, unit: "hours", task_type: "bugfix" });

    const rows = readEstimateRows();
    const stamped = rows.filter((r) => r["basisVersion"] === 2);
    const unstamped = rows.filter((r) => r["basisVersion"] === undefined);
    expect(stamped).toHaveLength(1);
    expect(unstamped).toHaveLength(7);
  });
});

// ---------------------------------------------------------------------------
// Ticket 17 (ledger read cache) — bounded parse counts on the estimation path
// ---------------------------------------------------------------------------
// A reference_class_estimate dispatch previously parsed estimates.jsonl 3x
// (getCalibrationData's own readLines + its overlayFlagsById load + the
// empirical-interval load), growing linearly with ledger size. Under the
// stat-keyed read cache the parse count per file is bounded at 1 per dispatch
// (all reads precede the dispatch-time append) and <= 2 across two dispatches
// (the append between them legitimately re-parses estimates once via its
// changed stat key). Asserted via the instrumented parse counter — no timing.

describe("ledger read cache — bounded estimation-path parse counts (ticket 17)", () => {
  /** Seed a large matched reference_class_estimate/bugfix ledger (5k rows). */
  function seedLargeLedger(rowCount: number): void {
    const ratios = [0.5, 0.6, 0.7, 1.0, 1.3, 1.5, 2.0];
    seedLedger(
      Array.from({ length: rowCount }, (_, i) => ({
        id: `cache-perf-${i}`,
        tool: "reference_class_estimate",
        outputs: { correctedEstimate: 10 },
      })),
    );
    seedActuals(
      Array.from({ length: rowCount }, (_, i) => ({
        estimateId: `cache-perf-${i}`,
        actualHours: 10 * (ratios[i % ratios.length] ?? 1),
      })),
    );
  }

  function parsesOf(filename: string): number {
    return getLedgerCacheStatus().get(join(tempDataDir, filename))?.parses ?? 0;
  }

  it("a 5k-row reference_class_estimate dispatch parses each ledger file at most once", async () => {
    seedLargeLedger(5000);
    resetLedgerReadCache();

    const started = Date.now();
    const result = await dispatch("reference_class_estimate", { task_type: "bugfix", complexity: 3 });
    const elapsed = Date.now() - started;
    expect(result.ok).toBe(true);

    // Every read inside one dispatch happens before the recordEstimate append,
    // so a stat-validated cache serves all of them from a single parse.
    expect(parsesOf(ESTIMATES_FILE)).toBeLessThanOrEqual(1);
    expect(parsesOf(ACTUALS_FILE)).toBeLessThanOrEqual(1);

    // Smoke only (not a hard assert): report the measured dispatch latency.
    console.log(`[ledger-cache perf] reference_class_estimate over 5k rows: ${elapsed}ms, estimates parsed ${parsesOf(ESTIMATES_FILE)}x, actuals parsed ${parsesOf(ACTUALS_FILE)}x`);
  });

  it("across two dispatches separated by the cache's own append, parses stay bounded at <= 2 per file", async () => {
    seedLargeLedger(5000);
    resetLedgerReadCache();

    await dispatch("reference_class_estimate", { task_type: "bugfix", complexity: 3 });
    // The dispatch appended an estimate row: its size changed, so the next
    // dispatch re-parses estimates.jsonl exactly once more — never 3x+.
    await dispatch("reference_class_estimate", { task_type: "bugfix", complexity: 3 });

    expect(parsesOf(ESTIMATES_FILE)).toBeLessThanOrEqual(2);
    expect(parsesOf(ACTUALS_FILE)).toBeLessThanOrEqual(1);

    // Correctness under the cache: both appended rows are on file.
    const rows = readEstimateRows().filter((r) => r["tool"] === "reference_class_estimate" && r["basisVersion"] === 2);
    expect(rows).toHaveLength(2);
  });
});
