import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { batchRecordActuals, getFeedbackHealthReport, recordEstimate } from "./feedback.js";
import { defined } from "../test-support.js";

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-feedback-batch-test-"));
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


// ---------------------------------------------------------------------------
// Feedback Batch + Health Report — Tests
// ---------------------------------------------------------------------------

describe("batchRecordActuals", () => {
  const ts = Date.now();
  it("records all entries successfully", () => {
    const result = batchRecordActuals([
      { estimateId: `fb-batch-001-${ts}`, actualHours: 4.0, notes: "Quick fix" },
      { estimateId: `fb-batch-002-${ts}`, actualHours: 12.5, notes: "Took longer" },
      { estimateId: `fb-batch-003-${ts}`, actualHours: 8.0 },
    ]);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.errors).toHaveLength(0);
  });

  it("handles single entry", () => {
    const result = batchRecordActuals([
      { estimateId: `fb-single-001-${ts}`, actualHours: 6.0 },
    ]);
    expect(result.total).toBe(1);
    expect(result.succeeded).toBe(1);
  });

  it("respects max 500 entries (caller responsibility)", () => {
    const entries = Array.from({ length: 3 }, (_, i) => ({
      estimateId: `fb-max-${i}-${ts}`,
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
