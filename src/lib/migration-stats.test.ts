import { describe, it, expect } from "vitest";
import { computeCleanPairStats } from "./migration-stats.js";
import type { MergedRecord } from "./ledger.js";

function rec(overrides: Partial<MergedRecord> = {}): MergedRecord {
  return {
    id: "e1",
    tool: "pert_estimate",
    inputs: { task_type: "feature" },
    outputs: { expected: 10, unit: "hours" },
    estimatedAt: "2026-06-01T10:00:00.000Z",
    actual: { estimateId: "e1", actualHours: 8, reportedAt: "2026-06-02T10:00:00.000Z" },
    flags: { quarantined: false, orphan: false },
    archived: false,
    ...overrides,
  };
}

describe("computeCleanPairStats", () => {
  it("returns zero/null stats for an empty ledger", () => {
    expect(computeCleanPairStats([])).toEqual({ cleanPairCount: 0, medianActualOverPredicted: null });
  });

  it("counts clean matched pairs and computes the median actual/predicted ratio", () => {
    const merged = [
      rec({ id: "e1", outputs: { expected: 10, unit: "hours" }, actual: { estimateId: "e1", actualHours: 8, reportedAt: "2026-06-02T10:00:00.000Z" } }),
      rec({ id: "e2", outputs: { expected: 10, unit: "hours" }, actual: { estimateId: "e2", actualHours: 12, reportedAt: "2026-06-02T10:00:00.000Z" } }),
    ];
    const stats = computeCleanPairStats(merged);
    expect(stats.cleanPairCount).toBe(2);
    // ratios: 0.8, 1.2 -> median 1.0
    expect(stats.medianActualOverPredicted).toBeCloseTo(1.0, 5);
  });

  it("excludes rows via isExcluded (e.g. below-calibration-threshold)", () => {
    const merged = [rec({ id: "e1", actual: { estimateId: "e1", actualHours: 0.001, reportedAt: "2026-06-02T10:00:00.000Z" } })];
    expect(computeCleanPairStats(merged)).toEqual({ cleanPairCount: 0, medianActualOverPredicted: null });
  });

  it("excludes rows via flags.quarantined even before extraExcludedIds", () => {
    const merged = [rec({ id: "e1", flags: { quarantined: true, orphan: false } })];
    expect(computeCleanPairStats(merged).cleanPairCount).toBe(0);
  });

  it("skips rows with no matched actual", () => {
    const merged = [rec({ id: "e1", actual: undefined })];
    expect(computeCleanPairStats(merged).cleanPairCount).toBe(0);
  });

  it("applies an extra id-exclusion set (dry-run simulation)", () => {
    const merged = [
      rec({ id: "e1" }),
      rec({ id: "e2" }),
    ];
    const stats = computeCleanPairStats(merged, new Set(["e1"]));
    expect(stats.cleanPairCount).toBe(1);
  });

  it("skips rows whose estimated hours cannot be extracted", () => {
    const merged = [rec({ id: "e1", outputs: {} })];
    expect(computeCleanPairStats(merged).cleanPairCount).toBe(0);
  });
});
