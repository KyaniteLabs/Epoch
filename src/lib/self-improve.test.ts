import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies before importing the module under test
vi.mock("./telemetry.js", () => ({
  getTelemetry: vi.fn(),
}));

vi.mock("./feedback.js", () => ({
  getCalibrationData: vi.fn(),
}));

// We mock self-improve's own loadReferenceDb to control what the DB returns.
// But since we can't mock an internal export easily, we'll test the exported
// functions that call loadReferenceDb internally. To control the DB, we mock
// the fs module so readFileSync returns our test data.
vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { readFileSync, writeFileSync } from "node:fs";
import { getCalibrationData } from "./feedback.js";
import { getTelemetry } from "./telemetry.js";
import {
  loadReferenceDb,
  getTaskTypeCorrectionFactor,
  getToolTaskCorrectionFactor,
  getGlobalCorrectionFactor,
  updateReferenceDatabase,
  invalidateReferenceDbCache,
} from "./self-improve.js";
import type { HistoricalRecord } from "./analytics.js";
import { defined } from "../test-support.js";

const mockReadFileSync = vi.mocked(readFileSync);
const mockGetCalibrationData = vi.mocked(getCalibrationData);
const mockGetTelemetry = vi.mocked(getTelemetry);

beforeEach(() => {
  invalidateReferenceDbCache();
});

function makeDb(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: "1.0.0",
    generatedAt: "2026-01-01T00:00:00Z",
    source: "test",
    sampleSize: 100,
    description: "test db",
    toolExecutionBenchmarks: {},
    modelLatencyProfiles: {},
    taskTypeCorrectionFactors: {},
    toolTaskCorrectionFactors: {},
    globalCorrectionFactor: 1.07,
    estimationAccuracy: {
      taskTypes: {},
      correctionFactors: { byTaskType: {}, global: 1.07 },
    },
    tokenTimeCalibration: {},
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: return a minimal valid DB
  mockReadFileSync.mockReturnValue(makeDb());
  mockGetCalibrationData.mockReturnValue([]);
  mockGetTelemetry.mockReturnValue({
    getStats: vi.fn().mockReturnValue([]),
    record: vi.fn(),
    flush: vi.fn(),
    getModelStats: vi.fn().mockReturnValue([]),
    destroy: vi.fn(),
  } as unknown as ReturnType<typeof getTelemetry>);
});

// ---- loadReferenceDb ----

describe("loadReferenceDb", () => {
  it("returns parsed DB when file exists and is valid JSON", () => {
    const db = loadReferenceDb();
    expect(db).not.toBeNull();
    // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
    expect(db!.version).toBe("1.0.0");
  });

  it("returns null when file read throws", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(loadReferenceDb()).toBeNull();
  });

  it("returns null when JSON is malformed", () => {
    mockReadFileSync.mockReturnValue("not json{{{");
    expect(loadReferenceDb()).toBeNull();
  });
});

// ---- getTaskTypeCorrectionFactor ----

describe("getTaskTypeCorrectionFactor", () => {
  it("returns factor from taskTypeCorrectionFactors when present", () => {
    mockReadFileSync.mockReturnValue(
      makeDb({
        taskTypeCorrectionFactors: { feature: 1.45 },
      }),
    );
    expect(getTaskTypeCorrectionFactor("feature")).toBe(1.45);
  });

  it("falls back to estimationAccuracy.correctionFactors.byTaskType", () => {
    mockReadFileSync.mockReturnValue(
      makeDb({
        taskTypeCorrectionFactors: {},
        estimationAccuracy: {
          taskTypes: {},
          correctionFactors: {
            byTaskType: { pert_estimation: 1.29 },
            global: 1.07,
          },
        },
      }),
    );
    // "feature" maps to "pert_estimation" via mapToCanaryKey
    expect(getTaskTypeCorrectionFactor("feature")).toBe(1.29);
  });

  it("falls back to estimationAccuracy.taskTypes correctionFactor", () => {
    mockReadFileSync.mockReturnValue(
      makeDb({
        taskTypeCorrectionFactors: {},
        estimationAccuracy: {
          taskTypes: {
            calendar_calculation: { correctionFactor: 1.35 },
          },
          correctionFactors: { byTaskType: {}, global: 1.07 },
        },
      }),
    );
    // "bugfix" maps to "calendar_calculation"
    expect(getTaskTypeCorrectionFactor("bugfix")).toBe(1.35);
  });

  it("returns default 1.8 when no match found", () => {
    mockReadFileSync.mockReturnValue(makeDb());
    expect(getTaskTypeCorrectionFactor("feature")).toBe(1.8);
  });

  it("returns default 1.8 when DB is null", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(getTaskTypeCorrectionFactor("feature")).toBe(1.8);
  });
});

// ---- getToolTaskCorrectionFactor ----

describe("getToolTaskCorrectionFactor", () => {
  it("returns tool-specific factor when present", () => {
    mockReadFileSync.mockReturnValue(
      makeDb({
        toolTaskCorrectionFactors: {
          pert_estimate: { feature: 1.52 },
        },
        taskTypeCorrectionFactors: { feature: 1.8 },
      }),
    );
    expect(getToolTaskCorrectionFactor("pert_estimate", "feature")).toBe(1.52);
  });

  it("falls back to task-type factor when tool has no entry", () => {
    mockReadFileSync.mockReturnValue(
      makeDb({
        toolTaskCorrectionFactors: {},
        taskTypeCorrectionFactors: { feature: 1.45 },
      }),
    );
    expect(getToolTaskCorrectionFactor("pert_estimate", "feature")).toBe(1.45);
  });

  it("falls back to default when both are absent", () => {
    mockReadFileSync.mockReturnValue(makeDb());
    expect(getToolTaskCorrectionFactor("pert_estimate", "feature")).toBe(1.8);
  });

  it("falls back when DB is null", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(getToolTaskCorrectionFactor("pert_estimate", "feature")).toBe(1.8);
  });
});

// ---- getGlobalCorrectionFactor ----

describe("getGlobalCorrectionFactor", () => {
  it("returns globalCorrectionFactor from DB", () => {
    mockReadFileSync.mockReturnValue(
      makeDb({ globalCorrectionFactor: 1.15 }),
    );
    expect(getGlobalCorrectionFactor()).toBe(1.15);
  });

  it("returns default 1.07 when DB is null", () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    expect(getGlobalCorrectionFactor()).toBe(1.07);
  });
});

// ---- updateReferenceDatabase (tests private computation functions) ----

describe("updateReferenceDatabase", () => {
  it("computes correction factors from feedback records", async () => {
    // 5 feature records with actual/estimated = [1.2, 1.4, 1.5, 1.6, 1.8]
    // median of sorted = 1.5
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 12, tool: "pert_estimate", completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 14, tool: "pert_estimate", completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 15, tool: "pert_estimate", completedAt: "2026-04-03" },
      { taskType: "feature", estimatedHours: 10, actualHours: 16, tool: "pert_estimate", completedAt: "2026-04-04" },
      { taskType: "feature", estimatedHours: 10, actualHours: 18, tool: "pert_estimate", completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    // The DB should have been written with computed factors
    const { writeFileSync } = await import("node:fs");
    const mockWrite = vi.mocked(writeFileSync);
    expect(mockWrite).toHaveBeenCalled();

    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      mockWrite.mock.calls[0]![1] as string,
    );
    // feature correction factor should be median of [1.2, 1.4, 1.5, 1.6, 1.8] = 1.5
    expect(writtenData.taskTypeCorrectionFactors.feature).toBe(1.5);
  });

  it("computes correction factors from received anonymized telemetry records", async () => {
    mockGetCalibrationData.mockReturnValue([]);
    mockReadFileSync.mockImplementation((path) => {
      const pathText = String(path);
      if (pathText.endsWith("telemetry-records.jsonl")) {
        return [
          // Ticket 19: only explicitly prospective (correction-usage) receiver
          // records train factors — unclassified rows are baseline now.
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 12, ratio: 1.2, date: "2026-04-01", received_at: "2026-04-01T00:00:00.000Z", calibration_provenance: "prospective" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 14, ratio: 1.4, date: "2026-04-02", received_at: "2026-04-02T00:00:00.000Z", calibration_provenance: "prospective" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 16, ratio: 1.6, date: "2026-04-03", received_at: "2026-04-03T00:00:00.000Z", calibration_provenance: "prospective" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 18, ratio: 1.8, date: "2026-04-04", received_at: "2026-04-04T00:00:00.000Z", calibration_provenance: "prospective" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 20, ratio: 2, date: "2026-04-05", received_at: "2026-04-05T00:00:00.000Z", calibration_provenance: "prospective" },
        ].map((record) => JSON.stringify(record)).join("\n");
      }
      return makeDb();
    });

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    expect(writtenData.taskTypeCorrectionFactors.feature).toBe(1.6);
    expect(writtenData.toolTaskCorrectionFactors.reference_class_estimate.feature).toBe(1.6);
    expect(writtenData.complexityCorrectionFactors.feature["3"]).toBe(1.6);
    expect(writtenData.globalCorrectionFactor).toBe(1.6);
  });

  // -------------------------------------------------------------------------
  // Ticket 19 — receiver-record exclusion classification. Stored receiver
  // records must pass the same classification as the reference-db
  // recalculation path: smoke/synthetic provenance, explicit excludes,
  // unclassified (baseline) rows, ratio outliers, and ratio-inconsistent rows
  // never reach correction factors. Quarantined records live in a separate
  // file this loader never reads.
  // -------------------------------------------------------------------------

  it("excludes quarantined, smoke, synthetic, baseline, ratio-outlier, and ratio-inconsistent receiver records from correction factors", async () => {
    mockGetCalibrationData.mockReturnValue([]);
    const prospective = (ratio: number, hours = 10) => ({
      task_type: "feature", complexity: 3, tool: "reference_class_estimate",
      estimated_hours: hours, actual_hours: Math.round(hours * ratio * 100) / 100,
      ratio, date: "2026-04-01", received_at: "2026-04-01T00:00:00.000Z",
      calibration_provenance: "prospective",
    });
    const poison = (overrides: Record<string, unknown> = {}) => ({
      task_type: "bugfix", complexity: 3, tool: "cocomo_estimate",
      estimated_hours: 10, actual_hours: 15, ratio: 1.5, date: "2026-04-01",
      received_at: "2026-04-01T00:00:00.000Z", ...overrides,
    });

    mockReadFileSync.mockImplementation((path) => {
      const pathText = String(path);
      if (pathText.endsWith("telemetry-records.jsonl")) {
        return [
          // Correction-eligible: five prospective feature records (1.2..2.0,
          // median 1.6).
          ...[1.2, 1.4, 1.6, 1.8, 2.0].map((r) => prospective(r)).map((r) => JSON.stringify(r)),
          // Poison rows for task type "bugfix" — if ANY leaked into the
          // correction set, a bugfix factor would be computed.
          JSON.stringify(poison({ tool: "receiver_smoke", calibration_provenance: "prospective" })),
          JSON.stringify(poison({ tool: "receiver_smoke", calibration_provenance: "prospective" })),
          JSON.stringify(poison({ tool: "receiver_smoke", calibration_provenance: "prospective" })),
          JSON.stringify(poison({ calibration_provenance: "synthetic" })),
          JSON.stringify(poison({ calibration_provenance: "synthetic" })),
          JSON.stringify(poison({ calibration_provenance: "synthetic" })),
          JSON.stringify(poison({ calibration_usage: "exclude" })),
          JSON.stringify(poison({ calibration_usage: "exclude" })),
          JSON.stringify(poison({ calibration_usage: "exclude" })),
          // Unclassified legacy receiver row -> baseline usage, not correction.
          JSON.stringify(poison()),
          JSON.stringify(poison()),
          JSON.stringify(poison()),
          // Implied ratio 60x exceeds exclusion.ts MAX_RATIO (ratio_outlier
          // guard) even though the claimed ratio is self-consistent.
          JSON.stringify(poison({ estimated_hours: 10, actual_hours: 600, ratio: 60, calibration_provenance: "prospective" })),
          // Claimed ratio lies about the hours (actual/estimated = 6 but
          // ratio says 1.5) -> receive-time consistency guard drops it.
          JSON.stringify(poison({ estimated_hours: 10, actual_hours: 60, ratio: 1.5, calibration_provenance: "prospective" })),
          JSON.stringify(poison({ estimated_hours: 10, actual_hours: 60, ratio: 1.5, calibration_provenance: "prospective" })),
        ].join("\n");
      }
      if (pathText.endsWith("telemetry-quarantine.jsonl")) {
        // Quarantined records must never be read by this loader at all.
        return [
          JSON.stringify({ task_type: "migration", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 12, ratio: 1.2, date: "2026-04-01", received_at: "2026-04-01T00:00:00.000Z", calibration_provenance: "prospective", quarantine_reason: "untrusted_integrity_only_source" }),
          JSON.stringify({ task_type: "migration", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 14, ratio: 1.4, date: "2026-04-02", received_at: "2026-04-02T00:00:00.000Z", calibration_provenance: "prospective", quarantine_reason: "untrusted_integrity_only_source" }),
          JSON.stringify({ task_type: "migration", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 16, ratio: 1.6, date: "2026-04-03", received_at: "2026-04-03T00:00:00.000Z", calibration_provenance: "prospective", quarantine_reason: "untrusted_integrity_only_source" }),
        ].join("\n");
      }
      return makeDb();
    });

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // Only the five prospective feature records trained the factors.
    expect(writtenData.taskTypeCorrectionFactors.feature).toBe(1.6);
    expect(writtenData.globalCorrectionFactor).toBe(1.6);
    // Every poison category is absent from correction factors.
    expect(writtenData.taskTypeCorrectionFactors.bugfix).toBeUndefined();
    expect(writtenData.taskTypeCorrectionFactors.migration).toBeUndefined();
    expect(writtenData.toolTaskCorrectionFactors.receiver_smoke).toBeUndefined();
    expect(writtenData.toolTaskCorrectionFactors.cocomo_estimate).toBeUndefined();
  });

  it("computes global correction from all records", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 15, tool: "pert", completedAt: "2026-04-01" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 10, tool: "cocomo", completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 8, actualHours: 8, tool: "pert", completedAt: "2026-04-03" },
      { taskType: "bugfix", estimatedHours: 4, actualHours: 6, tool: "pert", completedAt: "2026-04-04" },
      { taskType: "refactor", estimatedHours: 20, actualHours: 30, tool: "cocomo", completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // Global = median of [1.5, 2.0, 1.0, 1.5, 1.5] sorted = [1.0, 1.5, 1.5, 1.5, 2.0] = 1.5
    expect(writtenData.globalCorrectionFactor).toBe(1.5);
  });

  it("skips computation when fewer than 5 feedback records", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 12, tool: "pert", completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 14, tool: "pert", completedAt: "2026-04-02" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // Should keep the original globalCorrectionFactor since < 5 records
    expect(writtenData.globalCorrectionFactor).toBe(1.07);
    expect(writtenData.taskTypeCorrectionFactors).toEqual({});
  });

  it("computes tool-specific factors with minimum 3 samples and clamps to [0.1, 3.0]", async () => {
    const records: HistoricalRecord[] = [
      // pert_estimate + feature: 3 records, ratios = [1.2, 1.4, 1.6] → median = 1.4
      { taskType: "feature", estimatedHours: 10, actualHours: 12, tool: "pert_estimate", completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 14, tool: "pert_estimate", completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 16, tool: "pert_estimate", completedAt: "2026-04-03" },
      // cocomo_estimate + bugfix: only 2 records → skipped (< 3 minimum)
      { taskType: "bugfix", estimatedHours: 5, actualHours: 10, tool: "cocomo_estimate", completedAt: "2026-04-04" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 8, tool: "cocomo_estimate", completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // pert_estimate should have feature: 1.4
    expect(writtenData.toolTaskCorrectionFactors.pert_estimate.feature).toBe(1.4);
    // cocomo_estimate has no task types with >= 3 samples, so it's an empty object
    expect(writtenData.toolTaskCorrectionFactors.cocomo_estimate).toEqual({});
  });

  it("handles even-length median correctly", async () => {
    // 4 records for "feature": ratios = [1.2, 1.4, 1.6, 1.8] → median = (1.4 + 1.6) / 2 = 1.5
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 12, tool: "pert", completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 14, tool: "pert", completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 16, tool: "pert", completedAt: "2026-04-03" },
      { taskType: "feature", estimatedHours: 10, actualHours: 18, tool: "pert", completedAt: "2026-04-04" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 5, tool: "pert", completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    expect(writtenData.taskTypeCorrectionFactors.feature).toBe(1.5);
  });

  it("does nothing when DB cannot be loaded", async () => {
    mockReadFileSync.mockImplementation(() => {
      throw new Error("ENOENT");
    });
    // Should not throw
    await updateReferenceDatabase();
    const { writeFileSync } = await import("node:fs");
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it("merges telemetry stats into existing benchmarks", async () => {
    mockReadFileSync.mockReturnValue(
      makeDb({
        toolExecutionBenchmarks: {
          "test-tool": {
            p50_ms: 100,
            p95_ms: 500,
            mean_ms: 200,
            stddev_ms: 50,
            min_ms: 50,
            max_ms: 800,
            sampleCount: 10,
          },
        },
      }),
    );
    mockGetTelemetry.mockReturnValue({
      getStats: vi.fn().mockReturnValue([
        {
          tool: "test-tool",
          p50Ms: 120,
          p95Ms: 600,
          meanMs: 250,
          callCount: 10,
        },
      ]),
      record: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ReturnType<typeof getTelemetry>);
    mockGetCalibrationData.mockReturnValue([]);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // Weighted average: existing weight=10/20=0.5, new weight=10/20=0.5
    // p50 = (100*0.5 + 120*0.5) = 110
    expect(writtenData.toolExecutionBenchmarks["test-tool"].p50_ms).toBe(110);
    expect(writtenData.toolExecutionBenchmarks["test-tool"].sampleCount).toBe(20);
  });

  it("creates new benchmark entry when tool not in DB", async () => {
    mockGetTelemetry.mockReturnValue({
      getStats: vi.fn().mockReturnValue([
        {
          tool: "new-tool",
          p50Ms: 50,
          p95Ms: 200,
          meanMs: 80,
          callCount: 5,
        },
      ]),
      record: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ReturnType<typeof getTelemetry>);
    mockGetCalibrationData.mockReturnValue([]);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    expect(writtenData.toolExecutionBenchmarks["new-tool"]).toBeDefined();
    expect(writtenData.toolExecutionBenchmarks["new-tool"].p50_ms).toBe(50);
    expect(writtenData.toolExecutionBenchmarks["new-tool"].sampleCount).toBe(5);
  });

  it("skips records with estimatedHours <= 0 in correction computation", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 0, actualHours: 5, completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 15, completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: -5, actualHours: 10, completedAt: "2026-04-03" },
      { taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-04-04" },
      { taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // Valid ratios: 1.5, 2.0, 1.0 -> sorted: 1.0, 1.5, 2.0 -> median 1.5
    expect(writtenData.taskTypeCorrectionFactors.feature).toBe(1.5);
  });

  it("clamps tool correction factor to 3.0 max", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 50, tool: "slow-tool", completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 60, tool: "slow-tool", completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 35, tool: "slow-tool", completedAt: "2026-04-03" },
      // Need 2 more records to reach 5 minimum
      { taskType: "bugfix", estimatedHours: 5, actualHours: 6, tool: "fast-tool", completedAt: "2026-04-04" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 7, tool: "fast-tool", completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // slow-tool / feature ratios: 5.0, 6.0, 3.5 -> sorted: 3.5, 5.0, 6.0 -> median 5.0 -> clamped 3.0
    expect(writtenData.toolTaskCorrectionFactors["slow-tool"].feature).toBe(3.0);
  });

  it("clamps tool correction factor to 0.1 min", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 2, tool: "fast-tool", completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 1, tool: "fast-tool", completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 3, tool: "fast-tool", completedAt: "2026-04-03" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 6, tool: "other", completedAt: "2026-04-04" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 7, tool: "other", completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // fast-tool / feature ratios: 0.2, 0.1, 0.3 -> sorted: 0.1, 0.2, 0.3 -> median 0.2 -> clamped 0.2 (within 0.1 floor)
    expect(writtenData.toolTaskCorrectionFactors["fast-tool"].feature).toBe(0.2);
  });

  it("uses 'unknown' as tool when record has no tool field", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 12, completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 14, completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 16, completedAt: "2026-04-03" },
      { taskType: "feature", estimatedHours: 10, actualHours: 18, completedAt: "2026-04-04" },
      { taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    expect(writtenData.toolTaskCorrectionFactors.unknown).toBeDefined();
    // ratios: 1.2, 1.4, 1.6, 1.8, 2.0 -> sorted median = 1.6
    expect(writtenData.toolTaskCorrectionFactors.unknown.feature).toBe(1.6);
  });

  it("computes complexity-aware correction factors when complexity is present", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "feature", estimatedHours: 10, actualHours: 3, complexity: 1, completedAt: "2026-04-01" },
      { taskType: "feature", estimatedHours: 10, actualHours: 4, complexity: 1, completedAt: "2026-04-02" },
      { taskType: "feature", estimatedHours: 10, actualHours: 2, complexity: 1, completedAt: "2026-04-03" },
      { taskType: "feature", estimatedHours: 10, actualHours: 8, complexity: 5, completedAt: "2026-04-04" },
      { taskType: "feature", estimatedHours: 10, actualHours: 7, complexity: 5, completedAt: "2026-04-05" },
      { taskType: "feature", estimatedHours: 10, actualHours: 9, complexity: 5, completedAt: "2026-04-06" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    expect(writtenData.complexityCorrectionFactors).toBeDefined();
    expect(writtenData.complexityCorrectionFactors.feature).toBeDefined();
    expect(writtenData.complexityCorrectionFactors.feature[1]).toBe(0.3); // median(0.3, 0.4, 0.2) = 0.3
    expect(writtenData.complexityCorrectionFactors.feature[5]).toBe(0.8); // median(0.8, 0.7, 0.9) = 0.8
  });

  it("skips complexity factors with fewer than 3 records", async () => {
    const records: HistoricalRecord[] = [
      { taskType: "bugfix", estimatedHours: 5, actualHours: 2, complexity: 3, completedAt: "2026-04-01" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 3, complexity: 3, completedAt: "2026-04-02" },
      // Only 2 records for complexity 3 — below minimum of 3
      { taskType: "bugfix", estimatedHours: 5, actualHours: 4, completedAt: "2026-04-03" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 5, completedAt: "2026-04-04" },
      { taskType: "bugfix", estimatedHours: 5, actualHours: 6, completedAt: "2026-04-05" },
    ];
    mockGetCalibrationData.mockReturnValue(records);

    await updateReferenceDatabase();

    const { writeFileSync } = await import("node:fs");
    const writtenData = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // complexity 3 should not appear (only 2 records)
    expect(writtenData.complexityCorrectionFactors.bugfix?.[3]).toBeUndefined();
  });
});

describe("getComplexityCorrectionFactor", () => {
  it("returns factor when task type and complexity match", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      version: "1.0",
      taskTypeCorrectionFactors: {},
      complexityCorrectionFactors: { feature: { 1: 0.3, 3: 0.7, 5: 0.8 } },
      toolTaskCorrectionFactors: {},
      globalCorrectionFactor: 1.0,
    }));

    const { getComplexityCorrectionFactor, invalidateReferenceDbCache } = await import("./self-improve.js");
    invalidateReferenceDbCache();
    expect(getComplexityCorrectionFactor("feature", 1)).toBe(0.3);
    expect(getComplexityCorrectionFactor("feature", 5)).toBe(0.8);
  });

  it("returns null when complexity not found", async () => {
    const { readFileSync } = await import("node:fs");
    vi.mocked(readFileSync).mockReturnValue(JSON.stringify({
      version: "1.0",
      taskTypeCorrectionFactors: {},
      complexityCorrectionFactors: { feature: { 1: 0.3 } },
      toolTaskCorrectionFactors: {},
      globalCorrectionFactor: 1.0,
    }));

    const { getComplexityCorrectionFactor, invalidateReferenceDbCache } = await import("./self-improve.js");
    invalidateReferenceDbCache();
    expect(getComplexityCorrectionFactor("feature", 9)).toBeNull();
    expect(getComplexityCorrectionFactor("bugfix", 1)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Ticket 21 — self-improvement honesty: per-tool watermarks (only records
// newer than the watermark merge), sampleSize recomputed from merged
// benchmark counts (never `+=`), the 100th-call update deferred off the
// dispatch path, and failures logged instead of swallowed.
// ---------------------------------------------------------------------------

interface FixtureRecord {
  tool: string;
  timestamp: string;
  elapsedMs: number;
}

/**
 * Fake telemetry.getStats honoring the ticket-21 watermark contract: rows
 * aggregate ONLY records strictly newer than sinceByTool[tool] (tools absent
 * from the map are unwatermarked), zero-delta tools are omitted, and each
 * row carries newestTimestamp = the delta's max timestamp. Reads the fixture
 * array live so tests can append records between runs.
 */
function watermarkAwareGetStats(fixture: FixtureRecord[]) {
  return (
    _toolName?: string,
    windowDays?: number,
    sinceByTool?: Record<string, string>,
  ) =>
    [...fixture
      .reduce((groups, record) => {
        const since = sinceByTool?.[record.tool];
        if (since !== undefined && record.timestamp <= since) return groups;
        const arr = groups.get(record.tool) ?? [];
        arr.push(record);
        groups.set(record.tool, arr);
        return groups;
      }, new Map<string, FixtureRecord[]>())
      .entries()]
      .map(([tool, recs]) => {
        const elapsed = recs.map((r) => r.elapsedMs);
        return {
          tool,
          callCount: recs.length,
          successRate: 1,
          p50Ms: elapsed[Math.floor(elapsed.length / 2)] ?? 0,
          p95Ms: elapsed[elapsed.length - 1] ?? 0,
          meanMs: Math.round((elapsed.reduce((a, b) => a + b, 0) / elapsed.length) * 100) / 100,
          windowDays: windowDays ?? 90,
          newestTimestamp: recs.reduce(
            (max, r) => (r.timestamp > max ? r.timestamp : max),
            defined(recs[0]).timestamp,
          ),
        };
      })
      .sort((a, b) => b.callCount - a.callCount);
}

function lastWrittenDb(): Record<string, unknown> {
  const calls = vi.mocked(writeFileSync).mock.calls;
  const last = calls[calls.length - 1];
  return JSON.parse(defined(last)[1] as string) as Record<string, unknown>;
}

function mockTelemetryFixture(fixture: FixtureRecord[]): void {
  mockGetTelemetry.mockReturnValue({
    getStats: vi.fn(watermarkAwareGetStats(fixture)),
    record: vi.fn(),
    flush: vi.fn(),
    destroy: vi.fn(),
  } as unknown as ReturnType<typeof getTelemetry>);
}

describe("updateReferenceDatabase watermarks (ticket 21)", () => {
  it("repeated updates with an unchanged window merge zero new records (sampleCount and watermarks unchanged)", async () => {
    const fixture: FixtureRecord[] = [
      { tool: "tool-a", timestamp: "2026-06-01T00:00:00.000Z", elapsedMs: 100 },
      { tool: "tool-a", timestamp: "2026-06-02T00:00:00.000Z", elapsedMs: 200 },
      { tool: "tool-b", timestamp: "2026-06-03T00:00:00.000Z", elapsedMs: 50 },
    ];
    mockTelemetryFixture(fixture);
    mockReadFileSync.mockReturnValue(
      makeDb({
        generatedAt: "2026-05-01T00:00:00.000Z",
        toolExecutionBenchmarks: {},
      }),
    );

    // Run 1: no watermarks yet — everything in the window is newer than
    // generatedAt, so it all merges once and the watermarks are stamped.
    await updateReferenceDatabase();
    const first = lastWrittenDb();
    const firstBenchmarks = first["toolExecutionBenchmarks"] as Record<
      string,
      { sampleCount: number }
    >;
    expect(defined(firstBenchmarks["tool-a"]).sampleCount).toBe(2);
    expect(defined(firstBenchmarks["tool-b"]).sampleCount).toBe(1);
    expect(first["sampleSize"]).toBe(3);
    expect(first["mergeWatermarks"]).toEqual({
      "tool-a": "2026-06-02T00:00:00.000Z",
      "tool-b": "2026-06-03T00:00:00.000Z",
    });

    // Run 2: the run-1 DB is fed back in; the window is unchanged. This is
    // THE double-count regression: the old code re-merged the whole window
    // (sampleCount 2 -> 4 -> 6 ...) on every daily run.
    mockReadFileSync.mockReturnValue(JSON.stringify(first));
    vi.mocked(writeFileSync).mockClear();
    await updateReferenceDatabase();
    const second = lastWrittenDb();
    expect(second["toolExecutionBenchmarks"]).toEqual(firstBenchmarks);
    expect(second["mergeWatermarks"]).toEqual(first["mergeWatermarks"]);
    expect(second["sampleSize"]).toBe(3);
  });

  it("merges only records newer than the watermark, with incremental weights", async () => {
    const fixture: FixtureRecord[] = [
      { tool: "tool-a", timestamp: "2026-06-01T00:00:00.000Z", elapsedMs: 100 },
      { tool: "tool-a", timestamp: "2026-06-02T00:00:00.000Z", elapsedMs: 200 },
    ];
    mockTelemetryFixture(fixture);
    mockReadFileSync.mockReturnValue(
      makeDb({
        generatedAt: "2026-05-01T00:00:00.000Z",
        toolExecutionBenchmarks: {},
      }),
    );

    await updateReferenceDatabase();
    const first = lastWrittenDb();
    const firstBench = defined((first["toolExecutionBenchmarks"] as Record<string, { p50_ms: number; sampleCount: number }>)["tool-a"]);
    expect(firstBench.sampleCount).toBe(2);
    expect(firstBench.p50_ms).toBe(200);

    // One new record arrives (2026-06-10); the two old ones must NOT merge again.
    fixture.push({ tool: "tool-a", timestamp: "2026-06-10T00:00:00.000Z", elapsedMs: 300 });
    mockReadFileSync.mockReturnValue(JSON.stringify(first));
    await updateReferenceDatabase();
    const second = lastWrittenDb();
    const secondBench = defined((second["toolExecutionBenchmarks"] as Record<string, { p50_ms: number; sampleCount: number }>)["tool-a"]);

    // Existing 2 samples (p50 200) weighted 2/3 + 1 new sample (p50 300)
    // weighted 1/3 -> 233.33, sampleCount 3 (not 5).
    expect(secondBench.sampleCount).toBe(3);
    expect(secondBench.p50_ms).toBe(233.33);
    expect((second["mergeWatermarks"] as Record<string, string>)["tool-a"]).toBe("2026-06-10T00:00:00.000Z");
    expect(second["sampleSize"]).toBe(3);
  });

  it("recomputes sampleSize from the merged benchmark counts instead of accumulating", async () => {
    const fixture: FixtureRecord[] = [
      ...Array.from({ length: 10 }, (_, i) => ({
        tool: "tool-a",
        timestamp: `2026-06-${String(i + 11).padStart(2, "0")}T00:00:00.000Z`,
        elapsedMs: 100,
      })),
      ...Array.from({ length: 5 }, (_, i) => ({
        tool: "tool-c",
        timestamp: `2026-06-${String(i + 11).padStart(2, "0")}T00:00:00.000Z`,
        elapsedMs: 80,
      })),
    ];
    mockTelemetryFixture(fixture);
    // The shipped-style DB: a phantom inflated sampleSize (100) next to a
    // benchmark that only ever saw 10 samples.
    mockReadFileSync.mockReturnValue(
      makeDb({
        generatedAt: "2026-06-01T00:00:00.000Z",
        sampleSize: 100,
        toolExecutionBenchmarks: {
          "tool-a": { p50_ms: 90, p95_ms: 120, mean_ms: 95, stddev_ms: 5, min_ms: 80, max_ms: 130, sampleCount: 10 },
        },
      }),
    );

    await updateReferenceDatabase();

    const written = lastWrittenDb();
    const benchmarks = written["toolExecutionBenchmarks"] as Record<string, { sampleCount: number }>;
    // tool-a: 10 existing + 10 delta; tool-c: 5 brand-new samples.
    expect(defined(benchmarks["tool-a"]).sampleCount).toBe(20);
    expect(defined(benchmarks["tool-c"]).sampleCount).toBe(5);
    // Honest total = 20 + 5. The old code produced 100 + 10 + 10 + 5 = 125.
    expect(written["sampleSize"]).toBe(25);
  });

  it("bootstraps a watermarkless DB from generatedAt: records at or before it never re-merge", async () => {
    const fixture: FixtureRecord[] = [
      { tool: "tool-a", timestamp: "2026-06-01T00:00:00.000Z", elapsedMs: 100 },
      { tool: "tool-a", timestamp: "2026-06-02T00:00:00.000Z", elapsedMs: 200 },
    ];
    mockTelemetryFixture(fixture);
    // DB written by the old code: benchmark present, no watermarks, and a
    // generatedAt NEWER than every fixture record — those records were
    // already merged into the 50 counted samples and must not merge again.
    mockReadFileSync.mockReturnValue(
      makeDb({
        generatedAt: "2026-06-15T00:00:00.000Z",
        toolExecutionBenchmarks: {
          "tool-a": { p50_ms: 90, p95_ms: 120, mean_ms: 95, stddev_ms: 5, min_ms: 80, max_ms: 130, sampleCount: 50 },
        },
      }),
    );

    await updateReferenceDatabase();

    const written = lastWrittenDb();
    const benchmarks = written["toolExecutionBenchmarks"] as Record<string, { sampleCount: number }>;
    expect(defined(benchmarks["tool-a"]).sampleCount).toBe(50);
    expect(written["sampleSize"]).toBe(50);
    expect(written["mergeWatermarks"]).toEqual({ "tool-a": "2026-06-15T00:00:00.000Z" });
  });

  it("new tools (absent from the DB) still merge their full window", async () => {
    const fixture: FixtureRecord[] = [
      { tool: "brand-new-tool", timestamp: "2026-06-01T00:00:00.000Z", elapsedMs: 40 },
      { tool: "brand-new-tool", timestamp: "2026-06-02T00:00:00.000Z", elapsedMs: 60 },
    ];
    mockTelemetryFixture(fixture);
    mockReadFileSync.mockReturnValue(
      makeDb({ generatedAt: "2026-05-01T00:00:00.000Z", toolExecutionBenchmarks: {} }),
    );

    await updateReferenceDatabase();

    const written = lastWrittenDb();
    const benchmarks = written["toolExecutionBenchmarks"] as Record<string, { sampleCount: number; p50_ms: number }>;
    expect(defined(benchmarks["brand-new-tool"]).sampleCount).toBe(2);
    expect(defined(benchmarks["brand-new-tool"]).p50_ms).toBe(60);
    expect(written["sampleSize"]).toBe(2);
  });
});

describe("notifyToolCall (ticket 21: off the request path)", () => {
  it("defers the 100th-call update: notify latency excludes the update, which runs on the next immediate tick", async () => {
    vi.resetModules();

    // A forced direct update busy-waits ~120ms inside getStats — the cost the
    // old code paid inline on the 100th dispatch. hrtime is not faked.
    const forcedUpdateMs = 120;
    const busyWait = (ms: number): void => {
      const end = Date.now() + ms;
      while (Date.now() < end) { /* spin */ }
    };
    const getStatsImpl = vi.fn(() => {
      busyWait(forcedUpdateMs);
      return [];
    });
    mockGetTelemetry.mockReturnValue({
      getStats: getStatsImpl,
      record: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ReturnType<typeof getTelemetry>);
    mockReadFileSync.mockReturnValue(makeDb());

    const mod = await import("./self-improve.js");

    // Measure a forced update (what the old 100th call paid inline).
    const forcedStart = process.hrtime.bigint();
    await mod.updateReferenceDatabase();
    const forcedNs = Number(process.hrtime.bigint() - forcedStart);
    expect(getStatsImpl).toHaveBeenCalledTimes(1);
    // Sanity floor (Date.now() is ms-quantized, so allow slack): the forced
    // update really did pay the busy-wait.
    expect(forcedNs).toBeGreaterThan(100_000_000);

    // The 100th notifyToolCall must return without starting the update.
    const notifyStart = process.hrtime.bigint();
    for (let i = 0; i < 100; i++) mod.notifyToolCall();
    const notifyNs = Number(process.hrtime.bigint() - notifyStart);

    expect(getStatsImpl).toHaveBeenCalledTimes(1); // update not started inline
    // Dispatch latency must be >10x smaller than a forced update.
    expect(notifyNs).toBeLessThan(forcedNs / 10);

    // The deferred update runs after the dispatch turn (setImmediate).
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    expect(getStatsImpl).toHaveBeenCalledTimes(2);
    expect(vi.mocked(writeFileSync)).toHaveBeenCalled();
  });

  it("does not schedule a second update while one is running", async () => {
    vi.resetModules();
    let inFlight = false;
    const getStatsImpl = vi.fn(() => {
      expect(inFlight).toBe(false); // no overlapping update may start
      inFlight = true;
      busyWaitMs(30);
      inFlight = false;
      return [];
    });
    function busyWaitMs(ms: number): void {
      const end = Date.now() + ms;
      while (Date.now() < end) { /* spin */ }
    }
    mockGetTelemetry.mockReturnValue({
      getStats: getStatsImpl,
      record: vi.fn(),
      flush: vi.fn(),
      destroy: vi.fn(),
    } as unknown as ReturnType<typeof getTelemetry>);
    mockReadFileSync.mockReturnValue(makeDb());

    const mod = await import("./self-improve.js");
    for (let i = 0; i < 100; i++) mod.notifyToolCall();
    // Second burst while the first update is still pending: the isUpdating
    // flag must suppress it (and the 24h gate holds after lastUpdateAt moves).
    for (let i = 0; i < 200; i++) mod.notifyToolCall();
    await new Promise<void>((resolve) => setImmediate(() => resolve()));
    await mod.updateReferenceDatabase(); // direct call is always allowed
    expect(getStatsImpl).toHaveBeenCalledTimes(2);
  });

  it("logs a failed update with context instead of swallowing it", async () => {
    vi.resetModules();
    process.env["EPOCH_DEBUG"] = "1";
    const stderrWrite = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    mockReadFileSync.mockReturnValue(makeDb());
    // The DB write fails (e.g. read-only fs): updateReferenceDatabase rejects.
    vi.mocked(writeFileSync).mockImplementationOnce(() => {
      throw new Error("EACCES: read-only file system");
    });

    try {
      const mod = await import("./self-improve.js");
      for (let i = 0; i < 100; i++) mod.notifyToolCall();
      // Let the deferred update run and its rejection surface.
      await new Promise<void>((resolve) => setImmediate(() => resolve()));

      const logged = stderrWrite.mock.calls.map((c) => String(c[0])).join("");
      expect(logged).toContain("[epoch:self-improve.update]");
      expect(logged).toContain("EACCES");
    } finally {
      stderrWrite.mockRestore();
      delete process.env["EPOCH_DEBUG"];
    }
  });
});
