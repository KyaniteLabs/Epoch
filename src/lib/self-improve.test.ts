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

import { readFileSync } from "node:fs";
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
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 12, ratio: 1.2, date: "2026-04-01", received_at: "2026-04-01T00:00:00.000Z" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 14, ratio: 1.4, date: "2026-04-02", received_at: "2026-04-02T00:00:00.000Z" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 16, ratio: 1.6, date: "2026-04-03", received_at: "2026-04-03T00:00:00.000Z" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 18, ratio: 1.8, date: "2026-04-04", received_at: "2026-04-04T00:00:00.000Z" },
          { task_type: "feature", complexity: 3, tool: "reference_class_estimate", estimated_hours: 10, actual_hours: 20, ratio: 2, date: "2026-04-05", received_at: "2026-04-05T00:00:00.000Z" },
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
