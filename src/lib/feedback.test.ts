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
