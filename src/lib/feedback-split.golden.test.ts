/**
 * Characterization golden for the feedback split (L6 focus item 2).
 * Captured BEFORE the split on main; the split must keep every snapshot
 * byte-identical. Fixtures are hand-derived from the record shapes in
 * ledger.ts; expectations are frozen snapshots (JSON.stringify with sorted
 * keys), NOT derived post-hoc from the implementation under test.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ESTIMATE_UNIT_TO_HOURS,
  extractEstimatedHours,
  getFeedbackHealthReport,
  matchEstimatesToActuals,
  recordEstimate,
  recordActualDetailed,
  recordToolCall,
  getPendingEstimates,
  getCalibrationData,
  type EstimateRecord,
  type ActualRecord,
} from "./feedback.js";

let dataDir: string;

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "feedback-golden-"));
  process.env.EPOCH_DATA_DIR = dataDir;
});

afterAll(() => {
  delete process.env.EPOCH_DATA_DIR;
  rmSync(dataDir, { recursive: true, force: true });
});

const stable = (value: unknown): string =>
  JSON.stringify(value, (_k, v) => (v && typeof v === "object" && !Array.isArray(v)
    ? Object.keys(v).sort().reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = (v as Record<string, unknown>)[key];
        return acc;
      }, {})
    : v));

describe("pure conversion golden", () => {
  it("ESTIMATE_UNIT_TO_HOURS mapping (exported conversion authority)", () => {
    expect(stable(ESTIMATE_UNIT_TO_HOURS)).toBe(
      stable({ hours: 1, days: 8, weeks: 40, months: 160 }),
    );
  });

  it("extractEstimatedHours from outputs shapes", () => {
    expect(stable([
      extractEstimatedHours({ totalHours: 3 }),
      extractEstimatedHours({ estimatedHours: 2.5 }),
      extractEstimatedHours({ estimatedMinutes: 120 }),
      extractEstimatedHours({ estimatedSeconds: 3600 }),
      extractEstimatedHours({ expected: 2, unit: "days" }),
      extractEstimatedHours({ expected: 2, unit: "parsec" }),
      extractEstimatedHours({ personMonthsLlmAdjusted: 1 }),
      extractEstimatedHours({ total_duration: 3 }),
      extractEstimatedHours({}),
    ])).toBe(stable([3, 2.5, 2, 1, 16, null, 160, 24, null]));
  });
});

describe("matcher golden (in-memory fixtures)", () => {
  const est = (id: string, over: Partial<EstimateRecord> = {}): EstimateRecord => ({
    id,
    tool: "pert_estimate",
    inputs: { task: "golden" },
    outputs: { totalHours: 4 },
    estimatedAt: "2026-01-02T00:00:00Z",
    ...over,
  } as EstimateRecord);
  const act = (id: string, hours: number, over: Partial<ActualRecord> = {}): ActualRecord => ({
    estimateId: id,
    actualHours: hours,
    reportedAt: "2026-01-10T00:00:00Z",
    ...over,
  } as ActualRecord);

  it("join, exclude and classify a mixed fixture set", () => {
    const estimates = [
      est("e1"),
      est("e2", { outputs: { totalHours: 1 } }),
      est("e3", { tool: "unknown-tool" }),
      est("e4", { outputs: { totalHours: 2 }, estimatedAt: "2025-12-01T00:00:00Z" }),
    ];
    const actuals = [
      act("e1", 6),
      act("e2", 0.01), // suspect unit ratio
      act("e3", 4),
      act("e4", 8, { reportedAt: "2026-01-03T00:00:00Z" }), // before estimate
      act("missing", 3),
    ];
    const matched = matchEstimatesToActuals(estimates, actuals);
    expect(stable(matched)).toMatchSnapshot();
  });
});

describe("live-ledger golden (tmp data dir)", () => {
  it("record → pending → actual → calibration chain", () => {
    const estimateId = recordEstimate("pert_estimate", { task: "golden" }, { totalHours: 5 });
    expect(typeof estimateId).toBe("string");
    const id = estimateId as string;
    recordToolCall("wait_bound", { task: "golden" }, { count: 12 });

    const pending = getPendingEstimates();
    expect(pending.length).toBe(1);
    expect(stable({
      tool: pending.at(0)?.tool,
      outputs: pending.at(0)?.outputs,
      hasActual: pending.at(0)?.hasActual,
    })).toBe(stable({ tool: "pert_estimate", outputs: { totalHours: 5 }, hasActual: false }));

    const res = recordActualDetailed(id, 10, "notes", "hours");
    expect(stable({ ok: res.ok })).toBe(stable({ ok: true }));

    const after = getPendingEstimates();
    expect(after.length).toBe(0);

    const cal = getCalibrationData();
    expect(stable(cal.map((r) => ({
      tool: r.tool,
      estimatedHours: r.estimatedHours,
      actualHours: r.actualHours,
      calibrationUsage: r.calibrationUsage,
    })))).toMatchSnapshot();

    const health = getFeedbackHealthReport();
    expect(stable({
      totalEstimates: health.totalEstimates,
      totalActuals: health.totalActuals,
      matchRate: health.matchRate,
    })).toBe(stable({ totalEstimates: 1, totalActuals: 1, matchRate: 100 }));
  });

  it("unknown-id actuals are ACCEPTED today (dangling join) — characterization", () => {
    // evaluateActualForWrite only rejects unknown TOOL when a matched estimate
    // exists; an estimateId matching nothing has no guard, so the write lands
    // as a dangling actual. Frozen as-is: the split must preserve even this
    // wart until the owner rules on it.
    const res = recordActualDetailed("no-such-id", 1, undefined, "hours");
    expect(stable({ ok: res.ok })).toBe(stable({ ok: true }));
    const health = getFeedbackHealthReport();
    expect(health.totalActuals).toBeGreaterThanOrEqual(1);
  });

  it("a second actual for the same estimate is refused as duplicate", () => {
    const id2 = recordEstimate("cocomo_estimate", { task: "dup" }, { totalHours: 2 }) as string;
    const first = recordActualDetailed(id2, 4, undefined, "hours");
    expect(stable({ ok: first.ok })).toBe(stable({ ok: true }));
    const second = recordActualDetailed(id2, 8, undefined, "hours");
    expect(stable(second)).toBe(stable({ ok: false, reason: "duplicate" }));
  });
});
