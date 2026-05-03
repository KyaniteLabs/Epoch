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
});
