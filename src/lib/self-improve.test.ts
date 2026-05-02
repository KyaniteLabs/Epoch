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
      mockWrite.mock.calls[0]![1] as string,
    );
    // feature correction factor should be median of [1.2, 1.4, 1.5, 1.6, 1.8] = 1.5
    expect(writtenData.taskTypeCorrectionFactors.feature).toBe(1.5);
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
      vi.mocked(writeFileSync).mock.calls[0]![1] as string,
    );
    // Should keep the original globalCorrectionFactor since < 5 records
    expect(writtenData.globalCorrectionFactor).toBe(1.07);
    expect(writtenData.taskTypeCorrectionFactors).toEqual({});
  });

  it("computes tool-specific factors with minimum 3 samples and clamps to [0.5, 3.0]", async () => {
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
});
