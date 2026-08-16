import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { batchRecordActuals, getBatchAppendWriteCallCount, getFeedbackHealthReport, recordEstimate } from "./feedback.js";
import {
  ACTUALS_FILE,
  ESTIMATES_FILE,
  getLedgerCacheStatus,
  getLedgerLockAcquisitionCounts,
  ledgerWriteLockPath,
  resetLedgerReadCache,
  type ActualRecord,
} from "./ledger.js";
import { assertEstimateWritten, defined } from "../test-support.js";

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-feedback-batch-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
  // Ticket 22: parse/lock-acquisition counters are process-global — reset the
  // read-cache instrumentation so per-test assertions are absolute (the lock
  // counter is never reset; those assertions use before/after deltas).
  resetLedgerReadCache();
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env["EPOCH_DATA_DIR"];
  } else {
    process.env["EPOCH_DATA_DIR"] = previousDataDir;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});


// ---------------------------------------------------------------------------
// Feedback Batch + Health Report — Tests
// ---------------------------------------------------------------------------

describe("batchRecordActuals", () => {
  const ts = Date.now();
  it("records all entries successfully", () => {
    const result = batchRecordActuals([
      // "fixture-batch-" (not "fb-batch-"): exclusion.ts's SYNTHETIC_ID_PREFIXES
      // now includes "fb-batch-" (verified 2026-07-10 live-ledger leakage
      // prefix — see src/lib/migrations/flag-test-fixture-rows.ts), so this
      // positive-case fixture id must not collide with it.
      { estimateId: `fixture-batch-001-${ts}`, actualHours: 4.0, notes: "Quick fix" },
      { estimateId: `fixture-batch-002-${ts}`, actualHours: 12.5, notes: "Took longer" },
      { estimateId: `fixture-batch-003-${ts}`, actualHours: 8.0 },
    ]);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles single entry", () => {
    const result = batchRecordActuals([
      { estimateId: `fixture-single-001-${ts}`, actualHours: 6.0 },
    ]);
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it("respects max 500 entries (caller responsibility)", () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      estimateId: `fixture-max-${i}-${ts}`,
      actualHours: i + 1,
    }));
    const result = batchRecordActuals(entries);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
  });

  it("rejects synthetic estimate IDs", () => {
    const result = batchRecordActuals([
      { estimateId: `test-should-reject-${ts}`, actualHours: 4.0 },
      { estimateId: `batch-test-should-reject-${ts}`, actualHours: 8.0 },
      { estimateId: `seed-should-reject-${ts}`, actualHours: 2.0 },
    ]);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(3);
    expect(result.errors).toHaveLength(3);
    for (const err of result.errors) {
      expect(err).toContain("Failed to record");
    }
  });

  it("per-entry errors carry the failure reason string (ticket 04 batch contract)", () => {
    const result = batchRecordActuals([
      { estimateId: `seed-reason-${ts}`, actualHours: 4.0 },
      { estimateId: `test-reason-${ts}`, actualHours: 8.0 },
    ]);
    expect(result.succeeded).toBe(0);
    expect(result.errors).toHaveLength(2);
    for (const err of result.errors) {
      expect(err).toContain("(reason: synthetic_id)");
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket 22 — batchRecordActuals single-pass.
//
// The batch used to route every entry through recordActualDetailed: k locks,
// k×2 ledger reads (re-parsed per entry — each append invalidated the read
// cache), k appends. These tests pin the single-pass bounds instrumented via
// ledger.ts's parse/lock-acquisition counters and feedback.ts's batched-write
// counter, plus the per-entry semantics that must survive the rewrite
// (intra-batch dedupe, claim-on-success-only, reason precedence).
// ---------------------------------------------------------------------------

describe("batchRecordActuals single-pass (ticket 22)", () => {
  const ts = Date.now();

  function estimatesPath(): string {
    return join(tempDataDir, ESTIMATES_FILE);
  }
  function actualsPath(): string {
    return join(tempDataDir, ACTUALS_FILE);
  }
  function parsesOf(path: string): number {
    return getLedgerCacheStatus().get(path)?.parses ?? 0;
  }
  function lockAcquisitionsOf(path: string): number {
    return getLedgerLockAcquisitionCounts().get(path) ?? 0;
  }

  /** Seed estimate rows directly (external writer shape); also forces exactly one estimates parse. */
  function seedEstimates(rows: Array<{ id: string; tool?: string; expectedHours?: number }>): void {
    const lines = rows.map((r) => JSON.stringify({
      id: r.id,
      tool: r.tool ?? "pert_estimate",
      inputs: { task_type: "feature" },
      outputs: { expected: r.expectedHours ?? 5, unit: "hours" },
      estimatedAt: new Date().toISOString(),
    }));
    appendFileSync(estimatesPath(), lines.join("\n") + "\n", "utf-8");
  }

  /** Seed actual rows directly; also forces exactly one actuals parse. */
  function seedActuals(rows: Array<{ estimateId: string; actualHours: number }>): void {
    const lines = rows.map((r) => JSON.stringify({
      estimateId: r.estimateId,
      actualHours: r.actualHours,
      reportedAt: new Date().toISOString(),
    }));
    appendFileSync(actualsPath(), lines.join("\n") + "\n", "utf-8");
  }

  function readActualRows(): ActualRecord[] {
    try {
      return readFileSync(actualsPath(), "utf-8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as ActualRecord);
    } catch {
      return [];
    }
  }

  it("a 50-entry batch costs ≤2 file reads total, exactly ONE lock acquisition, and ONE batched append", () => {
    const k = 50;
    const ids = Array.from({ length: k }, (_, i) => `perf-single-pass-${ts}-${i}`);
    seedEstimates([...ids.map((id) => ({ id })), { id: `perf-seed-estimate-${ts}` }]);
    seedActuals([{ estimateId: `perf-seed-actual-${ts}`, actualHours: 1 }]);

    const lockPath = ledgerWriteLockPath(ACTUALS_FILE);
    const lockBefore = lockAcquisitionsOf(lockPath);
    const appendsBefore = getBatchAppendWriteCallCount();

    const result = batchRecordActuals(ids.map((id, i) => ({ estimateId: id, actualHours: 1 + (i % 8) })));

    expect(result).toEqual({ total: k, succeeded: k, failed: 0, errors: [] });
    // Ticket acceptance: ≤2 file reads for the whole batch — one parse per
    // ledger, independent of k (the old path re-parsed per entry).
    expect(parsesOf(estimatesPath())).toBe(1);
    expect(parsesOf(actualsPath())).toBe(1);
    // One lock for the whole batch, one joined-line append.
    expect(lockAcquisitionsOf(lockPath) - lockBefore).toBe(1);
    expect(getBatchAppendWriteCallCount() - appendsBefore).toBe(1);
    // Every successful entry landed (plus the seeded unrelated row).
    expect(readActualRows()).toHaveLength(k + 1);
  });

  it("a second entry for an estimateId the batch itself records is a duplicate (in-memory batch dedupe)", () => {
    seedEstimates([{ id: `perf-intra-1-${ts}` }]);
    const id = `perf-intra-1-${ts}`;

    const result = batchRecordActuals([
      { estimateId: id, actualHours: 4 },
      { estimateId: id, actualHours: 7 },
    ]);

    expect(result.total).toBe(2);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(defined(result.errors[0])).toContain("(reason: duplicate)");
    const rows = readActualRows().filter((r) => r.estimateId === id);
    expect(rows).toHaveLength(1);
    expect(defined(rows[0]).actualHours).toBe(4); // first entry wins, exactly like the sequential loop
  });

  it("a failed earlier entry does NOT claim its estimateId — a later same-id entry still records", () => {
    seedEstimates([{ id: `perf-claim-1-${ts}` }]);
    const id = `perf-claim-1-${ts}`;

    const result = batchRecordActuals([
      { estimateId: id, actualHours: 0 }, // below_threshold — never claims
      { estimateId: id, actualHours: 5 },
    ]);

    expect(result.succeeded).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(defined(result.errors[0])).toContain("(reason: below_threshold)");
    const rows = readActualRows().filter((r) => r.estimateId === id);
    expect(rows).toHaveLength(1);
    expect(defined(rows[0]).actualHours).toBe(5);
  });

  it("two entries for an unknown-tool estimate are BOTH unknown_tool — a rejected entry never claims", () => {
    seedEstimates([{ id: `perf-unknown-1-${ts}`, tool: "bogus_external_tool" }]);
    const id = `perf-unknown-1-${ts}`;

    const result = batchRecordActuals([
      { estimateId: id, actualHours: 4 },
      { estimateId: id, actualHours: 6 },
    ]);

    expect(result.succeeded).toBe(0);
    expect(result.errors).toHaveLength(2);
    for (const err of result.errors) {
      expect(err).toContain("(reason: unknown_tool)");
    }
    expect(readActualRows()).toHaveLength(0);
  });

  it("an entry matching an actual already on disk is a duplicate and nothing is appended", () => {
    const id = `perf-dup-1-${ts}`;
    seedEstimates([{ id }]);
    seedActuals([{ estimateId: id, actualHours: 3 }]);

    const appendsBefore = getBatchAppendWriteCallCount();
    const result = batchRecordActuals([{ estimateId: id, actualHours: 9 }]);

    expect(result.failed).toBe(1);
    expect(defined(result.errors[0])).toContain("(reason: duplicate)");
    const rows = readActualRows().filter((r) => r.estimateId === id);
    expect(rows).toHaveLength(1); // the seeded 3h row — untouched
    expect(defined(rows[0]).actualHours).toBe(3);
    expect(getBatchAppendWriteCallCount() - appendsBefore).toBe(0);
  });

  it("a batch with no recordable entries takes NO lock and reads NO file (phase-1 rejections are I/O-free)", () => {
    const lockPath = ledgerWriteLockPath(ACTUALS_FILE);
    const lockBefore = lockAcquisitionsOf(lockPath);
    const parsesBefore = parsesOf(estimatesPath()) + parsesOf(actualsPath());
    const appendsBefore = getBatchAppendWriteCallCount();

    const result = batchRecordActuals([
      { estimateId: `seed-no-io-${ts}`, actualHours: 4 }, // synthetic_id
      { estimateId: `perf-no-io-${ts}`, actualHours: 0 }, // below_threshold
    ]);

    expect(result).toMatchObject({ total: 2, succeeded: 0, failed: 2 });
    expect(lockAcquisitionsOf(lockPath) - lockBefore).toBe(0);
    expect(parsesOf(estimatesPath()) + parsesOf(actualsPath()) - parsesBefore).toBe(0);
    expect(getBatchAppendWriteCallCount() - appendsBefore).toBe(0);
  });

  it("auto_wallclock out-of-bounds is rejected per-entry inside the batch (shared write-time gate)", () => {
    const outOfBounds = `perf-wall-1-${ts}`;
    const sane = `perf-wall-2-${ts}`;
    seedEstimates([{ id: outOfBounds, expectedHours: 5 }, { id: sane, expectedHours: 5 }]);

    const result = batchRecordActuals([
      { estimateId: outOfBounds, actualHours: 100, calibrationProvenance: "auto_wallclock" }, // > AUTO_WALLCLOCK_MAX_HOURS (12)
      { estimateId: sane, actualHours: 6, calibrationProvenance: "auto_wallclock" }, // ratio 1.2 — sane
    ]);

    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(defined(result.errors[0])).toContain("(reason: auto_wallclock_out_of_bounds)");
    const rows = readActualRows();
    expect(rows.filter((r) => r.estimateId === outOfBounds)).toHaveLength(0);
    expect(rows.filter((r) => r.estimateId === sane)).toHaveLength(1);
  });

  it("unit-suspect flagging is preserved through the batched write", () => {
    const id = `perf-unit-1-${ts}`;
    seedEstimates([{ id, expectedHours: 5 }]);

    const result = batchRecordActuals([{ estimateId: id, actualHours: 100 }]); // 20x — ratio > UNIT_SUSPECT_RATIO

    expect(result.succeeded).toBe(1);
    const rows = readActualRows().filter((r) => r.estimateId === id);
    expect(rows).toHaveLength(1);
    expect((defined(rows[0]) as unknown as Record<string, unknown>)["unitSuspect"]).toBe(true);
  });
});

describe("getFeedbackHealthReport", () => {
  it("returns valid report structure", () => {
    const report = getFeedbackHealthReport();
    expect(typeof report.totalEstimates).toBe("number");
    expect(typeof report.totalActuals).toBe("number");
    expect(typeof report.matchRate).toBe("number");
    expect(report.matchRate).toBeGreaterThanOrEqual(0);
    expect(report.matchRate).toBeLessThanOrEqual(100);
    expect(report.byTool).toBeDefined();
    expect(report.byTaskType).toBeDefined();
    expect(report.selfImprovement).toBeDefined();
    expect(Array.isArray(report.selfImprovement.readyTypes)).toBe(true);
    expect(typeof report.selfImprovement.callsUntilUpdate).toBe("number");
  });

  it("byTool has entries for tools with estimates", () => {
    const report = getFeedbackHealthReport();
    // Previous test runs will have recorded estimates
    if (report.totalEstimates > 0) {
      const toolKeys = Object.keys(report.byTool);
      expect(toolKeys.length).toBeGreaterThan(0);
      for (const [, data] of Object.entries(report.byTool)) {
        expect(data.estimates).toBeGreaterThan(0);
        expect(typeof data.actuals).toBe("number");
      }
    }
  });

  it("matchRate is between 0 and 100", () => {
    const report = getFeedbackHealthReport();
    expect(report.matchRate).toBeGreaterThanOrEqual(0);
    expect(report.matchRate).toBeLessThanOrEqual(100);
    // When there are no estimates, matchRate must be 0
    if (report.totalEstimates === 0) {
      expect(report.matchRate).toBe(0);
    }
  });

  it("counts only actuals that match known estimates in matchRate", () => {
    const estimateId = recordEstimate(
      "pert_estimate",
      { task_type: "feature" },
      { estimated_hours: 4 },
      "unit-test",
    );
    assertEstimateWritten(estimateId);
    batchRecordActuals([
      { estimateId, actualHours: 5 },
      { estimateId: `external-estimate-${Date.now()}`, actualHours: 3 },
    ]);

    const report = getFeedbackHealthReport();

    expect(report.totalEstimates).toBe(1);
    expect(report.totalActuals).toBe(2);
    expect(report.matchRate).toBe(100);
  });

  it("selfImprovement tracks ready types", () => {
    const report = getFeedbackHealthReport();
    // readyTypes contains task types with 5+ matched records
    for (const type of report.selfImprovement.readyTypes) {
      const typeData = report.byTaskType[type];
      expect(typeData).toBeDefined();
      expect(defined(typeData).actuals).toBeGreaterThanOrEqual(5);
    }
  });
});
