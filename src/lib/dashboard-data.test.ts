// ---------------------------------------------------------------------------
// Epoch Calibration Dashboard — dataset computation tests (Phase 6)
// ---------------------------------------------------------------------------
//
// Mirrors coverage.test.ts / calibration-factors.test.ts's real-temp-dir
// pattern (mkdtempSync + EPOCH_DATA_DIR override) rather than mocking
// node:fs directly: computeDashboardData() fans out across feedback.ts,
// ledger.ts, coverage.ts, calibration-factors.ts, accuracy-trend.ts, and
// supplementary-data.ts (industry-baseline JSON reads) — a real isolated
// data dir exercises the whole chain instead of requiring a mock for every
// module's fs usage.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { computeDashboardData, computePertBacktest, TIER1_BAND } from "./dashboard-data.js";

let previousDataDir: string | undefined;
let previousMinN: string | undefined;
let previousDedupWindow: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  previousMinN = process.env["EPOCH_MIN_N_FOR_VERDICT"];
  previousDedupWindow = process.env["EPOCH_DEDUP_WINDOW"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-dashboard-data-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
  // Small min-n so a handful of fixture rows can exercise the "gated" vs
  // "ungated" branch without needing 20+ records per group.
  process.env["EPOCH_MIN_N_FOR_VERDICT"] = "2";
  delete process.env["EPOCH_DEDUP_WINDOW"];
});

afterEach(() => {
  for (const [key, prev] of [
    ["EPOCH_DATA_DIR", previousDataDir],
    ["EPOCH_MIN_N_FOR_VERDICT", previousMinN],
    ["EPOCH_DEDUP_WINDOW", previousDedupWindow],
  ] as const) {
    if (prev === undefined) delete process.env[key];
    else process.env[key] = prev;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});

interface FixtureEstimate {
  id: string;
  tool: string;
  taskType: string;
  outputs: Record<string, unknown>;
  estimatedAt?: string;
}

interface FixtureActual {
  estimateId: string;
  actualHours: number;
  reportedAt?: string;
}

function writeFile(name: string, lines: unknown[]): void {
  writeFileSync(join(tempDataDir, name), lines.length > 0 ? `${lines.map((l) => JSON.stringify(l)).join("\n")}\n` : "");
}

function writeLedgerFixture(opts: {
  estimates: FixtureEstimate[];
  actuals: FixtureActual[];
  flags?: Array<{ id: string; seq: number; recordedAt: string; quarantined?: boolean; reason?: string; orphan?: boolean }>;
  labels?: Array<{ id: string; seq: number; recordedAt: string; taskLabel: string }>;
  tasktype?: Array<{ id: string; seq: number; recordedAt: string; taskTypeRaw: string; taskTypeNormalized: string }>;
}): void {
  writeFile(
    "estimates.jsonl",
    opts.estimates.map((e) => ({
      id: e.id,
      tool: e.tool,
      inputs: { task_type: e.taskType },
      outputs: e.outputs,
      estimatedAt: e.estimatedAt ?? "2026-06-01T00:00:00.000Z",
    })),
  );
  writeFile(
    "feedback.jsonl",
    opts.actuals.map((a) => ({
      estimateId: a.estimateId,
      actualHours: a.actualHours,
      reportedAt: a.reportedAt ?? "2026-06-02T00:00:00.000Z",
    })),
  );
  if (opts.flags) writeFile("estimates.flags.jsonl", opts.flags);
  if (opts.labels) writeFile("estimates.labels.jsonl", opts.labels);
  if (opts.tasktype) writeFile("estimates.tasktype.jsonl", opts.tasktype);
}

/** computeAccuracyTrend()/getEstimationResearch() reads an industry-baseline JSON off cwd/pkg-relative paths that resolve fine without any file in tempDataDir (supplementary-data.ts falls back to defaults) — no extra fixture needed for that. */

describe("computeDashboardData", () => {
  it("returns a fully-shaped, zeroed dataset on an empty data dir", () => {
    writeLedgerFixture({ estimates: [], actuals: [] });
    const data = computeDashboardData();

    expect(data.dataDir).toBe(tempDataDir);
    expect(data.minNForVerdict).toBe(2);
    expect(data.headline.matchedPairs).toBe(0);
    expect(data.headline.totalEstimates).toBe(0);
    expect(data.byTool).toEqual([]);
    expect(data.byTaskType).toEqual([]);
    expect(data.pert.flagEnabled).toBe(false);
    expect(data.pert.backtest.ok).toBe(false);
    expect(data.coverage.overall.n).toBe(0);
    expect(data.integrity.quarantine.count).toBe(0);
    expect(data.integrity.labels.count).toBe(0);
    expect(data.integrity.orphans.total).toBe(0);
    expect(data.integrity.dedup.enabled).toBe(false);
    expect(new Date(data.generatedAt).toString()).not.toBe("Invalid Date");
  });

  it("computes per-tool / per-task-type medians and min-n gating from matched pairs", () => {
    writeLedgerFixture({
      estimates: [
        { id: "pert-1", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" } },
        { id: "pert-2", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" } },
        { id: "pert-3", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" } },
        { id: "cocomo-1", tool: "cocomo_estimate", taskType: "bugfix", outputs: { totalHours: 5 } },
      ],
      actuals: [
        { estimateId: "pert-1", actualHours: 8 }, // ratio 0.8
        { estimateId: "pert-2", actualHours: 9 }, // ratio 0.9
        { estimateId: "pert-3", actualHours: 11 }, // ratio 1.1
        { estimateId: "cocomo-1", actualHours: 5 }, // ratio 1.0 (single pair, matchedPairs=1 < minN=2 -> gated)
      ],
    });

    const data = computeDashboardData();

    const pertRow = data.byTool.find((r) => r.key === "pert_estimate");
    expect(pertRow).toBeDefined();
    expect(pertRow?.matchedPairs).toBe(3);
    expect(pertRow?.medianActualOverPredicted).toBeCloseTo(0.9, 5);
    expect(pertRow?.minNGated).toBe(false); // 3 >= minN(2)

    const cocomoRow = data.byTool.find((r) => r.key === "cocomo_estimate");
    expect(cocomoRow).toBeDefined();
    expect(cocomoRow?.matchedPairs).toBe(1);
    expect(cocomoRow?.minNGated).toBe(true); // 1 < minN(2)

    const featureRow = data.byTaskType.find((r) => r.key === "feature");
    expect(featureRow?.matchedPairs).toBe(3);
    expect(featureRow?.medianActualOverPredicted).toBeCloseTo(0.9, 5);

    // byTool/byTaskType sorted by matchedPairs descending.
    const matchedCounts = data.byTool.map((r) => r.matchedPairs);
    expect(matchedCounts).toEqual([...matchedCounts].sort((a, b) => b - a));
  });

  it("classifies orphan actuals (unresolved vs known test-fixture-leakage prefixes)", () => {
    writeLedgerFixture({
      estimates: [{ id: "e1", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" } }],
      actuals: [
        { estimateId: "e1", actualHours: 10 },
        { estimateId: "http-test-estimate-123", actualHours: 3 }, // test-fixture leakage
        { estimateId: "fb-batch-999", actualHours: 4 }, // test-fixture leakage
        { estimateId: "some-genuinely-orphaned-id", actualHours: 2 }, // unresolved
      ],
    });

    const data = computeDashboardData();

    expect(data.integrity.orphans.total).toBe(3);
    expect(data.integrity.orphans.testFixtureLeakage).toBe(2);
    expect(data.integrity.orphans.unresolved).toBe(1);
    expect(data.headline.remediationNotes.some((n) => n.includes("3 feedback rows are orphaned"))).toBe(true);
  });

  it("reflects the quarantine, label, and tasktype overlay sidecars in Section 6's counts", () => {
    writeLedgerFixture({
      estimates: [
        { id: "e1", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" } },
        { id: "e2", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" } },
      ],
      actuals: [
        { estimateId: "e1", actualHours: 10 },
        { estimateId: "e2", actualHours: 9 },
      ],
      flags: [{ id: "e1", seq: 1, recordedAt: "2026-06-03T00:00:00.000Z", quarantined: true, reason: "manual_test_flag" }],
      labels: [{ id: "e2", seq: 1, recordedAt: "2026-06-03T00:00:00.000Z", taskLabel: "fix-login-bug" }],
      tasktype: [{ id: "e2", seq: 1, recordedAt: "2026-06-03T00:00:00.000Z", taskTypeRaw: "login-fix", taskTypeNormalized: "bugfix" }],
    });

    const data = computeDashboardData();

    // Section 6 (loadLedgerWithOverlays()-based) sees every overlay record.
    expect(data.integrity.quarantine.count).toBe(1);
    expect(data.integrity.labels.count).toBe(1);
    expect(data.integrity.taskTypeOverlay.count).toBe(1);
  });

  it("documents the known gap: a manual-only quarantine flag (no backfill date signature) is NOT honored by Sections 1-3's matched-pair math", () => {
    // This is a regression guard for a real, currently-live limitation of the
    // codebase (see KNOWN_LIMITATIONS in dashboard-data.ts): feedback.ts's
    // matchEstimatesToActuals() reads the ledger directly and never calls
    // loadLedgerWithOverlays(), so it never sees the overlay-only quarantine
    // flag below (dated outside the 2026-05-05 backfill signature window, so
    // isExcluded()'s own date+ratio check doesn't independently catch it
    // either). If this test starts failing (i.e. matchedPairs drops to 1),
    // that gap has been closed upstream — update KNOWN_LIMITATIONS and this
    // test together rather than treating the new failure as a regression.
    writeLedgerFixture({
      estimates: [
        { id: "e1", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T00:00:00.000Z" },
        { id: "e2", tool: "pert_estimate", taskType: "feature", outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T00:00:00.000Z" },
      ],
      actuals: [
        { estimateId: "e1", actualHours: 10, reportedAt: "2026-06-02T00:00:00.000Z" }, // exact-match ratio, but NOT the 2026-05-05 signature date
        { estimateId: "e2", actualHours: 9, reportedAt: "2026-06-02T00:00:00.000Z" },
      ],
      flags: [{ id: "e1", seq: 1, recordedAt: "2026-06-03T00:00:00.000Z", quarantined: true, reason: "manual_test_flag" }],
    });

    const data = computeDashboardData();

    expect(data.integrity.quarantine.count).toBe(1); // Section 6 sees the flag...
    expect(data.headline.matchedPairs).toBe(2); // ...but Sections 1-3 still count e1 as a matched pair.
    expect(data.knownLimitations.length).toBeGreaterThan(0);
    expect(data.knownLimitations[0]).toContain("loadLedgerWithOverlays()");
  });

  it("reports the PERT learned-correction flag state and dedup config from env", () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "15";
    writeLedgerFixture({ estimates: [], actuals: [] });

    const data = computeDashboardData();

    expect(data.pert.flagEnabled).toBe(false); // EPOCH_PERT_LEARNED_CORRECTION unset -> off
    expect(data.pert.tier1Band).toEqual(TIER1_BAND);
    expect(data.integrity.dedup.enabled).toBe(true);
    expect(data.integrity.dedup.windowMinutes).toBe(15);
    expect(data.integrity.dedup.hitCount).toBe(0); // process-lifetime counter, always 0 in a one-shot report
  });
});

describe("computePertBacktest", () => {
  it("reports ok:false with no matched pert_estimate pairs", () => {
    writeLedgerFixture({ estimates: [], actuals: [] });
    const result = computePertBacktest();
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("no_matched_pert_pairs");
  });

  it("runs an 80/20 chronological backtest and reports MdAPE + median-ratio guards", () => {
    // 5 pert_estimate matched pairs, task_type "feature", chronologically ordered
    // via distinct completedAt timestamps -> split 4 train / 1 test.
    const estimates: FixtureEstimate[] = Array.from({ length: 5 }, (_, i) => ({
      id: `pert-${i}`,
      tool: "pert_estimate",
      taskType: "feature",
      outputs: { expected: 10, unit: "hours" },
      estimatedAt: `2026-06-0${i + 1}T00:00:00.000Z`,
    }));
    const actuals: FixtureActual[] = estimates.map((e, i) => ({
      estimateId: e.id,
      actualHours: 8 + i, // 8,9,10,11,12 -> ratios 0.8..1.2
      reportedAt: `2026-06-0${i + 1}T01:00:00.000Z`,
    }));
    writeLedgerFixture({ estimates, actuals });

    const result = computePertBacktest();
    expect(result.ok).toBe(true);
    expect(result.totalMatchedPairs).toBe(5);
    expect(result.trainPairs).toBe(4);
    expect(result.testPairs).toBe(1);
    expect(result.current.mdapePercent).not.toBeNull();
    expect(result.corrected.mdapePercent).not.toBeNull();
    expect(typeof result.guards.correctedMdapeLeCurrentMdape).toBe("boolean");
    expect(typeof result.guards.tier1BandMet).toBe("boolean");
  });
});
