import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(false),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: vi.fn().mockReturnValue("test-uuid-1234"),
}));

vi.mock("node:os", () => ({
  homedir: vi.fn().mockReturnValue("/home/test"),
}));

import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import {
  recordEstimate,
  recordActual,
  getPendingEstimates,
  getCalibrationData,
  batchRecordActuals,
  getFeedbackHealthReport,
  matchEstimatesToActuals,
} from "./feedback.js";

const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockReadFileSync = vi.mocked(readFileSync);

function makeEstimate(overrides: Partial<{ id: string; tool: string; inputs: Record<string, unknown>; outputs: Record<string, unknown> }> = {}): string {
  return JSON.stringify({
    id: "est-1",
    tool: "pert_estimate",
    inputs: { task_type: "feature" },
    outputs: { totalHours: 10 },
    estimatedAt: "2026-05-01T10:00:00.000Z",
    ...overrides,
  });
}

function makeActual(overrides: Partial<{ estimateId: string; actualHours: number }> = {}): string {
  return JSON.stringify({
    estimateId: "est-1",
    actualHours: 12,
    reportedAt: "2026-05-02T10:00:00.000Z",
    ...overrides,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
});

// ---- recordEstimate ----

describe("recordEstimate", () => {
  it("appends an estimate record and returns an id", () => {
    const id = recordEstimate("pert_estimate", { optimistic: 5 }, { expected: 7 });
    expect(id).toBe("test-uuid-1234");
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(mockAppendFileSync.mock.calls[0]![1] as string);
    expect(written.tool).toBe("pert_estimate");
    expect(written.inputs).toEqual({ optimistic: 5 });
    expect(written.outputs).toEqual({ expected: 7 });
    expect(written.id).toBe("test-uuid-1234");
  });

  it("creates data directory if it does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    recordEstimate("tool", {}, {});
    expect(mockMkdirSync).toHaveBeenCalled();
  });
});

// ---- recordActual ----

describe("recordActual", () => {
  it("appends an actual record and returns true", () => {
    const result = recordActual("est-1", 12, "finished early");
    expect(result).toBe(true);
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(mockAppendFileSync.mock.calls[0]![1] as string);
    expect(written.estimateId).toBe("est-1");
    expect(written.actualHours).toBe(12);
    expect(written.notes).toBe("finished early");
  });

  it("omits notes when not provided", () => {
    recordActual("est-1", 8);
    const written = JSON.parse(mockAppendFileSync.mock.calls[0]![1] as string);
    expect(written).not.toHaveProperty("notes");
  });

  it("rejects actuals below minimum threshold (0.25h)", () => {
    expect(recordActual("est-1", 0.1)).toBe(false);
    expect(recordActual("est-2", 0.24)).toBe(false);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});

// ---- getPendingEstimates ----

describe("getPendingEstimates", () => {
  it("returns estimates without matching actuals", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1" }) + "\n" + makeEstimate({ id: "e2" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "e1", actualHours: 5 }) + "\n";
      }
      return "";
    });

    const pending = getPendingEstimates();
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe("e2");
    expect(pending[0]!.hasActual).toBe(false);
  });

  it("returns empty when no estimates exist", () => {
    mockReadFileSync.mockReturnValue("");
    expect(getPendingEstimates()).toEqual([]);
  });

  it("respects the limit parameter", () => {
    const lines = Array.from({ length: 60 }, (_, i) => makeEstimate({ id: `e${i}` })).join("\n") + "\n";
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return lines;
      return "";
    });

    const pending = getPendingEstimates(10);
    expect(pending).toHaveLength(10);
  });
});

// ---- getCalibrationData ----

describe("getCalibrationData", () => {
  it("joins estimates with matching actuals", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate() + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual() + "\n";
      }
      return "";
    });

    const records = getCalibrationData();
    expect(records).toHaveLength(1);
    expect(records[0]!.estimatedHours).toBe(10);
    expect(records[0]!.actualHours).toBe(12);
    expect(records[0]!.taskType).toBe("feature");
  });

  it("filters by taskType", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ inputs: { task_type: "feature" } }) + "\n"
          + makeEstimate({ id: "est-2", inputs: { task_type: "bugfix" } }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual() + "\n" + makeActual({ estimateId: "est-2", actualHours: 3 }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData(undefined, "bugfix");
    expect(records).toHaveLength(1);
    expect(records[0]!.taskType).toBe("bugfix");
  });

  it("filters by tool", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ tool: "pert_estimate" }) + "\n"
          + makeEstimate({ id: "est-2", tool: "cocomo_estimate" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual() + "\n" + makeActual({ estimateId: "est-2" }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData(undefined, undefined, undefined, "cocomo_estimate");
    expect(records).toHaveLength(1);
    expect(records[0]!.tool).toBe("cocomo_estimate");
  });

  it("skips estimates without matching actuals", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeEstimate() + "\n";
      return "";
    });

    expect(getCalibrationData()).toEqual([]);
  });

  it("returns empty when no files exist", () => {
    mockExistsSync.mockReturnValue(false);
    expect(getCalibrationData()).toEqual([]);
  });

  it("filters out actuals under 0.25 hours as seed artifacts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1" }) + "\n" + makeEstimate({ id: "e2" }) + "\n" + makeEstimate({ id: "e3" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return JSON.stringify({ estimateId: "e1", actualHours: 0.1, reportedAt: new Date().toISOString() }) + "\n"
          + JSON.stringify({ estimateId: "e2", actualHours: 0.2, reportedAt: new Date().toISOString() }) + "\n"
          + JSON.stringify({ estimateId: "e3", actualHours: 5, reportedAt: new Date().toISOString() }) + "\n";
      }
      return "";
    });

    const data = getCalibrationData();
    expect(data).toHaveLength(1);
    expect(data[0]!.actualHours).toBe(5);
  });
});

// ---- extractEstimatedHours (tested via getCalibrationData) ----

describe("extractEstimatedHours via getCalibrationData", () => {
  const makeWithOutputs = (outputs: Record<string, unknown>) =>
    makeEstimate({ id: "est-out", outputs });

  const withActual = () => makeActual({ estimateId: "est-out" });

  it("extracts totalHours", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ totalHours: 20 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(20);
  });

  it("extracts estimatedHours", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ estimatedHours: 15 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(15);
  });

  it("extracts estimatedMinutes and converts to hours", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ estimatedMinutes: 120 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(2);
  });

  it("extracts estimatedSeconds and converts to hours", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ estimatedSeconds: 3600 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(1);
  });

  it("extracts expected with unit=days and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ expected: 5, unit: "days" }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(40);
  });

  it("extracts expected with unit=weeks and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ expected: 2, unit: "weeks" }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(80);
  });

  it("extracts expected with unit=months and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ expected: 1, unit: "months" }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(160);
  });

  it("extracts personMonthsLlmAdjusted and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ personMonthsLlmAdjusted: 0.5 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(80);
  });

  it("extracts correctedEstimate directly", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ correctedEstimate: 42 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()[0]!.estimatedHours).toBe(42);
  });

  it("skips records with unrecognized output format", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ somethingElse: 99 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(getCalibrationData()).toEqual([]);
  });
});

// ---- recordActual duplicate rejection ----

describe("recordActual duplicate rejection", () => {
  it("rejects duplicate estimateId", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "est-1" }) + "\n";
      }
      return "";
    });

    const result = recordActual("est-1", 15, "duplicate attempt");
    expect(result).toBe(false);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("accepts new estimateId", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "est-1" }) + "\n";
      }
      return "";
    });

    const result = recordActual("est-2", 8);
    expect(result).toBe(true);
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
  });
});

// ---- batchRecordActuals ----

describe("batchRecordActuals", () => {
  it("records multiple actuals", () => {
    mockReadFileSync.mockReturnValue("");

    const result = batchRecordActuals([
      { estimateId: "a1", actualHours: 5 },
      { estimateId: "a2", actualHours: 10, notes: "done" },
    ]);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.total).toBe(2);
  });

  it("reports failures for duplicates", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "dup" }) + "\n";
      }
      return "";
    });

    const result = batchRecordActuals([
      { estimateId: "dup", actualHours: 5 },
      { estimateId: "new", actualHours: 10 },
    ]);
    expect(result.succeeded).toBe(1);
    expect(result.failed).toBe(1);
    expect(result.errors).toHaveLength(1);
  });

  it("handles empty batch", () => {
    const result = batchRecordActuals([]);
    expect(result.total).toBe(0);
    expect(result.succeeded).toBe(0);
  });
});

// ---- getFeedbackHealthReport ----

describe("getFeedbackHealthReport", () => {
  it("returns health report with by-tool and by-task-type MdAPE", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 5, unit: "hours" } }),
          makeEstimate({ id: "e2", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 3, unit: "hours" } }),
          makeEstimate({ id: "e3", tool: "reference_class_estimate", inputs: { task_type: "feature" }, outputs: { correctedEstimate: 8 } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          makeActual({ estimateId: "e1", actualHours: 6 }),
          makeActual({ estimateId: "e2", actualHours: 4 }),
          makeActual({ estimateId: "e3", actualHours: 10 }),
        ].join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    expect(report.totalEstimates).toBe(3);
    expect(report.totalActuals).toBe(3);
    expect(report.matchedPairs).toBe(3);
    expect(report.byTool["pert_estimate"]).toBeDefined();
    expect(report.byTool["pert_estimate"]!.mdape).toBeDefined();
    expect(report.byTool["pert_estimate"]!.matchedPairs).toBe(2);
    expect(report.byTaskType["feature"]).toBeDefined();
    expect(report.byTaskType["feature"]!.mdape).toBeDefined();
    expect(report.byTaskType["feature"]!.matchedPairs).toBe(2);
    expect(report.byTaskType["feature"]!.recommendation).toContain("Only 2 matched pairs");
  });

  it("returns null mape/mdape with fewer than 2 matches", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "e1" }) + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    expect(report.byTool["pert_estimate"]!.mape).toBeNull();
    expect(report.byTool["pert_estimate"]!.mdape).toBeNull();
    expect(report.matchedPairs).toBe(1);
  });

  it("matchedPairs is less than totalActuals when some feedback has no matching estimate", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          makeActual({ estimateId: "e1", actualHours: 5 }),
          makeActual({ estimateId: "orphan-no-match", actualHours: 8 }),
        ].join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    expect(report.totalActuals).toBe(2);
    expect(report.matchedPairs).toBe(1);
  });

  it("dataQuality has recommendation when data is insufficient", () => {
    mockReadFileSync.mockReturnValue("");
    const report = getFeedbackHealthReport();
    expect(report.dataQuality.overallMdape).toBeNull();
    expect(report.dataQuality.outlierRatio).toBe(0);
    expect(report.dataQuality.recommendation).toContain("Insufficient data");
    expect(report.dataQuality.dataCompletenessScore).toBe(0);
  });

  it("dataQuality computes overallMdape and outlierRatio with 5+ records", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 6 }, (_, i) =>
          makeEstimate({ id: `e${i}`, inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          makeActual({ estimateId: "e0", actualHours: 11 }),
          makeActual({ estimateId: "e1", actualHours: 9 }),
          makeActual({ estimateId: "e2", actualHours: 10.5 }),
          makeActual({ estimateId: "e3", actualHours: 12 }),
          makeActual({ estimateId: "e4", actualHours: 500 }), // outlier
          makeActual({ estimateId: "e5", actualHours: 8 }),
        ].join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    expect(report.dataQuality.overallMdape).not.toBeNull();
    expect(report.dataQuality.overallMdape).toBeGreaterThan(0);
    expect(report.dataQuality.outlierRatio).toBeGreaterThan(0);
    expect(report.dataQuality.recommendation).toBeTruthy();
  });

  it("byTool includes recommendation for tools with 0 pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1", tool: "cocomo_estimate" }) + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(report.byTool["cocomo_estimate"]!.recommendation).toContain("No matched pairs");
  });

  it("byTool includes recommendation for tools with 1-2 pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "e1", actualHours: 5 }) + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(report.byTool["pert_estimate"]!.recommendation).toContain("Only 1 matched pair");
    expect(report.byTool["pert_estimate"]!.recommendation).toContain("Need 2 more");
  });

  it("byTool includes recommendation with MdAPE for tools with 3+ pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", outputs: { expected: 10, unit: "hours" } }),
          makeEstimate({ id: "e2", outputs: { expected: 10, unit: "hours" } }),
          makeEstimate({ id: "e3", outputs: { expected: 10, unit: "hours" } }),
          makeEstimate({ id: "e4", outputs: { expected: 10, unit: "hours" } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          makeActual({ estimateId: "e1", actualHours: 12 }),
          makeActual({ estimateId: "e2", actualHours: 8 }),
          makeActual({ estimateId: "e3", actualHours: 11 }),
        ].join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(report.byTool["pert_estimate"]!.recommendation).toContain("Sufficient for calibration");
    expect(report.byTool["pert_estimate"]!.recommendation).toContain("MdAPE:");
  });

  it("byTaskType includes recommendation for types with 0 pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1", inputs: { task_type: "migration" }, outputs: { expected: 5, unit: "hours" } }) + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(report.byTaskType["migration"]!.recommendation).toContain("No matched pairs");
  });

  it("byTaskType includes recommendation with MdAPE for types with 3+ pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", inputs: { task_type: "testing" }, outputs: { expected: 10, unit: "hours" } }),
          makeEstimate({ id: "e2", inputs: { task_type: "testing" }, outputs: { expected: 10, unit: "hours" } }),
          makeEstimate({ id: "e3", inputs: { task_type: "testing" }, outputs: { expected: 10, unit: "hours" } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          makeActual({ estimateId: "e1", actualHours: 12 }),
          makeActual({ estimateId: "e2", actualHours: 8 }),
          makeActual({ estimateId: "e3", actualHours: 11 }),
        ].join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(report.byTaskType["testing"]!.recommendation).toContain("Sufficient for calibration");
    expect(report.byTaskType["testing"]!.recommendation).toContain("MdAPE:");
  });

  it("byTool includes bias field", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { estimatedHours: 10 } }),
          makeEstimate({ id: "e2", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { estimatedHours: 20 } }),
          makeEstimate({ id: "e3", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { estimatedHours: 30 } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          JSON.stringify({ estimateId: "e1", actualHours: 8, reportedAt: "2026-01-10T00:00:00Z" }),
          JSON.stringify({ estimateId: "e2", actualHours: 25, reportedAt: "2026-01-11T00:00:00Z" }),
          JSON.stringify({ estimateId: "e3", actualHours: 28, reportedAt: "2026-01-12T00:00:00Z" }),
        ].join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    // bias = avg(actual - estimated) = avg(-2, 5, -2) = 0.33
    expect(typeof report.byTool["pert_estimate"]!.bias).toBe("number");
    expect(report.byTool["pert_estimate"]!.bias).toBeCloseTo(0.33, 1);
  });

  it("byTaskType includes bias field", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", inputs: { task_type: "bugfix" }, outputs: { estimatedHours: 5 } }),
          makeEstimate({ id: "e2", inputs: { task_type: "bugfix" }, outputs: { estimatedHours: 5 } }),
          makeEstimate({ id: "e3", inputs: { task_type: "bugfix" }, outputs: { estimatedHours: 5 } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          JSON.stringify({ estimateId: "e1", actualHours: 8, reportedAt: "2026-01-10T00:00:00Z" }),
          JSON.stringify({ estimateId: "e2", actualHours: 9, reportedAt: "2026-01-11T00:00:00Z" }),
          JSON.stringify({ estimateId: "e3", actualHours: 7, reportedAt: "2026-01-12T00:00:00Z" }),
        ].join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    // bias = avg(3, 4, 2) = 3 — systematic underestimation
    expect(report.byTaskType["bugfix"]!.bias).toBeGreaterThan(0);
  });

  it("dataCompletenessScore is > 0 with matched pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 6 }, (_, i) =>
          makeEstimate({ id: `e${i}`, inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 6 }, (_, i) =>
          makeActual({ estimateId: `e${i}`, actualHours: 10 + i! })
        ).join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(report.dataQuality.dataCompletenessScore).toBeGreaterThan(0);
    expect(report.dataQuality.dataCompletenessScore).toBeLessThanOrEqual(100);
  });
});

// ---- matchEstimatesToActuals / extractEstimatedHours ----

describe("matchEstimatesToActuals", () => {
  it("extracts hours from totalHours", () => {
    const estimates = [{ id: "e1", tool: "sprint_forecast", inputs: {}, outputs: { totalHours: 100 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 80, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(100);
  });

  it("extracts hours from estimatedHours", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 24 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 20, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(24);
  });

  it("extracts hours from estimatedMinutes", () => {
    const estimates = [{ id: "e1", tool: "token_time_bridge", inputs: {}, outputs: { estimatedMinutes: 30 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 0.5, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBeCloseTo(0.5, 1);
  });

  it("extracts hours from estimatedSeconds", () => {
    const estimates = [{ id: "e1", tool: "token_time_bridge", inputs: {}, outputs: { estimatedSeconds: 3600 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(1);
  });

  it("extracts hours from expected with unit=days", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { expected: 5, unit: "days" }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 40, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(40);
  });

  it("extracts hours from expected with unit=weeks", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { expected: 2, unit: "weeks" }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 80, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(80);
  });

  it("extracts hours from correctedEstimate", () => {
    const estimates = [{ id: "e1", tool: "reference_class_estimate", inputs: {}, outputs: { correctedEstimate: 15.5 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 12, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(15.5);
  });

  it("extracts hours from total_duration (critical path)", () => {
    const estimates = [{ id: "e1", tool: "critical_path", inputs: {}, outputs: { total_duration: 11, critical_path: ["A", "B"] }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 88, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(88);
  });

  it("extracts hours from personMonthsLlmAdjusted", () => {
    const estimates = [{ id: "e1", tool: "cocomo_estimate", inputs: {}, outputs: { personMonthsLlmAdjusted: 8.2 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1312, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0]!.estimatedHours).toBe(8.2 * 160);
  });

  it("skips estimates with no extractable hours", () => {
    const estimates = [{ id: "e1", tool: "get_current_time", inputs: {}, outputs: { iso: "2026-01-01T00:00:00Z" }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(0);
  });

  it("skips actuals below 0.25 hours", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 5 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 0.1, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(0);
  });

  it("returns empty for unmatched estimateIds", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 5 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "orphan", actualHours: 10, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(0);
  });

  it("filters records with seed- prefixed estimateId", () => {
    const estimates = [{ id: "seed-abc", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "seed-abc", actualHours: 8, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(0);
  });

  it("filters records with 'seed' in notes", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 8, notes: "seed data", reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(0);
  });

  it("filters records with 'synthetic' in notes", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 8, notes: "synthetic baseline", reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(0);
  });

  it("filters records with implausibly low actual/estimate ratio", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 100 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1, reportedAt: "2026-01-10T00:00:00Z" }]; // ratio = 0.01
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(0);
  });

  it("keeps records with reasonable ratio even if small", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 3, reportedAt: "2026-01-10T00:00:00Z" }]; // ratio = 0.3
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
  });

  it("keeps genuine records while filtering seeds in mixed dataset", () => {
    const estimates = [
      { id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" },
      { id: "seed-x", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 5 }, estimatedAt: "2026-01-01T00:00:00Z" },
      { id: "e3", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 8 }, estimatedAt: "2026-01-01T00:00:00Z" },
    ];
    const actuals = [
      { estimateId: "e1", actualHours: 8, reportedAt: "2026-01-10T00:00:00Z" },
      { estimateId: "seed-x", actualHours: 0.5, notes: "seed", reportedAt: "2026-01-10T00:00:00Z" },
      { estimateId: "e3", actualHours: 6, reportedAt: "2026-01-10T00:00:00Z" },
    ];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(2);
    expect(result.map(r => r.estimatedHours)).toEqual([10, 8]);
  });

  it("handles actuals with completedAt instead of reportedAt", () => {
    const estimates = [
      { id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" },
    ];
    const actuals = [
      { estimateId: "e1", actualHours: 8, completedAt: "2026-01-10T00:00:00Z" },
    ];
    const result = matchEstimatesToActuals(estimates as any, actuals as any);
    expect(result).toHaveLength(1);
    expect(result[0].completedAt).toBe("2026-01-10T00:00:00Z");
  });
});
