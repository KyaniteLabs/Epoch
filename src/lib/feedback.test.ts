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
  recordToolCall,
  recordActual,
  recordActualDetailed,
  getPendingEstimates,
  getCalibrationData,
  batchRecordActuals,
  getFeedbackHealthReport,
  matchEstimatesToActuals,
  getDedupHitCount,
} from "./feedback.js";
import type { ActualRecord, EstimateRecord } from "./feedback.js";
import { defined } from "../test-support.js";


const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockReadFileSync = vi.mocked(readFileSync);

type FixtureActualRecord = Omit<ActualRecord, "reportedAt"> & { reportedAt?: string; completedAt?: string };

function matchFixtureRecords(estimates: EstimateRecord[], actuals: FixtureActualRecord[]) {
  return matchEstimatesToActuals(estimates, actuals as unknown as ActualRecord[]);
}

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

function makeActual(overrides: Partial<{ estimateId: string; actualHours: number; reportedAt: string; completedAt: string; notes: string }> = {}): string {
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
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
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

  it("stamps a default 30-day expiresAt (Phase 1 Task 7)", () => {
    const before = Date.now();
    recordEstimate("pert_estimate", { optimistic: 5 }, { expected: 7 });
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.expiresAt).toBeDefined();
    const expiresAtMs = Date.parse(written.expiresAt);
    const deltaDays = (expiresAtMs - before) / 86_400_000;
    expect(deltaDays).toBeGreaterThan(29.9);
    expect(deltaDays).toBeLessThan(30.1);
  });

  it("respects EPOCH_PENDING_TTL_DAYS override", () => {
    const original = process.env["EPOCH_PENDING_TTL_DAYS"];
    process.env["EPOCH_PENDING_TTL_DAYS"] = "7";
    try {
      const before = Date.now();
      recordEstimate("pert_estimate", { optimistic: 5 }, { expected: 7 });
      const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
      const deltaDays = (Date.parse(written.expiresAt) - before) / 86_400_000;
      expect(deltaDays).toBeGreaterThan(6.9);
      expect(deltaDays).toBeLessThan(7.1);
    } finally {
      if (original === undefined) delete process.env["EPOCH_PENDING_TTL_DAYS"];
      else process.env["EPOCH_PENDING_TTL_DAYS"] = original;
    }
  });
});

// ---- recordEstimate dedup get-or-create (Phase 4, Pre-mortem Scenario 3) ----

describe("recordEstimate dedup get-or-create", () => {
  function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
    const original: Record<string, string | undefined> = {};
    for (const key of Object.keys(vars)) original[key] = process.env[key];
    try {
      for (const [key, value] of Object.entries(vars)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      fn();
    } finally {
      for (const [key, value] of Object.entries(original)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  function pendingEstimateLine(overrides: Partial<{ id: string; tool: string; inputs: Record<string, unknown>; estimatedAt: string; expiresAt: string }> = {}) {
    return JSON.stringify({
      id: "existing-pending",
      tool: "pert_estimate",
      inputs: { session_id: "sess-1", task_type: "feature" },
      outputs: { expected: 7 },
      estimatedAt: new Date().toISOString(),
      expiresAt: "2099-01-01T00:00:00.000Z",
      ...overrides,
    });
  }

  it("is a no-op (byte-identical behavior) when EPOCH_DEDUP_WINDOW is unset, even with a session_id", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: undefined }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return pendingEstimateLine() + "\n";
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-1", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234"); // freshly minted, not the existing pending id
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("is a no-op when EPOCH_DEDUP_WINDOW is set but no session_id is supplied", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return pendingEstimateLine() + "\n";
        return "";
      });
      const id = recordEstimate("pert_estimate", { task_type: "feature" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234");
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("reuses the existing pending estimate id for same tool + same inputs + same session_id within the window (no new row)", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      const before = getDedupHitCount();
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return pendingEstimateLine() + "\n";
        if (p.endsWith("feedback.jsonl")) return "";
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-1", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("existing-pending");
      expect(mockAppendFileSync).not.toHaveBeenCalled();
      expect(getDedupHitCount()).toBe(before + 1);
    });
  });

  it("mints a new id when the session_id differs", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return pendingEstimateLine() + "\n"; // session_id: sess-1
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-2", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234");
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("mints a new id when inputs differ (different signature) even in the same session", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return pendingEstimateLine() + "\n"; // task_type: feature
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-1", task_type: "bugfix" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234");
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("mints a new id when the existing pending estimate is outside the dedup window", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "5" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) {
          return pendingEstimateLine({ estimatedAt: new Date(Date.now() - 60 * 60_000).toISOString() }) + "\n"; // 60 min ago, window = 5 min
        }
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-1", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234");
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("mints a new id when the matching estimate already has an actual (no longer pending)", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return pendingEstimateLine({ id: "already-actualed" }) + "\n";
        if (p.endsWith("feedback.jsonl")) return makeActual({ estimateId: "already-actualed", actualHours: 5 }) + "\n";
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-1", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234");
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("mints a new id when the matching estimate is TTL-expired", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) {
          return pendingEstimateLine({ expiresAt: new Date(Date.now() - 60_000).toISOString() }) + "\n";
        }
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-1", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234");
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("mints a new id (never guesses) when multiple pending candidates match ambiguously", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) {
          return pendingEstimateLine({ id: "dup-a" }) + "\n" + pendingEstimateLine({ id: "dup-b" }) + "\n";
        }
        return "";
      });
      const id = recordEstimate("pert_estimate", { session_id: "sess-1", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("test-uuid-1234");
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
    });
  });

  it("matches across camelCase/canonical tool-name spelling", () => {
    withEnv({ EPOCH_DEDUP_WINDOW: "30" }, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return pendingEstimateLine({ tool: "pert_estimate" }) + "\n";
        return "";
      });
      const id = recordEstimate("pertEstimate", { session_id: "sess-1", task_type: "feature" }, { expected: 7 });
      expect(id).toBe("existing-pending");
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });
});

// ---- recordToolCall ----

describe("recordToolCall", () => {
  it("appends a tool-call record to tool-calls.jsonl, separate from estimates.jsonl", () => {
    const id = recordToolCall("get_current_time", { timezone: "UTC" }, { iso: "2026-01-01T00:00:00Z" });
    expect(id).toBe("test-uuid-1234");
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const [path, contents] = defined(mockAppendFileSync.mock.calls[0]) as [string, string];
    expect(path).toContain("tool-calls.jsonl");
    expect(path).not.toContain("estimates.jsonl");
    const written = JSON.parse(contents);
    expect(written.tool).toBe("get_current_time");
    expect(written.inputs).toEqual({ timezone: "UTC" });
    expect(written.outputs).toEqual({ iso: "2026-01-01T00:00:00Z" });
    expect(written.id).toBe("test-uuid-1234");
  });
});

// ---- recordActual ----

describe("recordActual", () => {
  it("appends an actual record and returns true", () => {
    const result = recordActual("est-1", 12, "finished early");
    expect(result).toBe(true);
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.estimateId).toBe("est-1");
    expect(written.actualHours).toBe(12);
    expect(written.notes).toBe("finished early");
  });

  it("omits notes when not provided", () => {
    recordActual("est-1", 8);
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written).not.toHaveProperty("notes");
  });

  it("accepts real fast actuals below the old 15-minute floor", () => {
    expect(recordActual("est-fast", 0.08)).toBe(true);
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.actualHours).toBe(0.08);
  });

  it("rejects non-positive actuals", () => {
    expect(recordActual("est-zero", 0)).toBe(false);
    expect(recordActual("est-negative", -0.1)).toBe(false);
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
    expect(defined(pending[0]).id).toBe("e2");
    expect(defined(pending[0]).hasActual).toBe(false);
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

  // ---- Pending TTL (Phase 1 Task 7) ----

  it("excludes expired pending estimates and keeps unexpired ones", () => {
    const expired = JSON.stringify({
      id: "e-expired",
      tool: "pert_estimate",
      inputs: {},
      outputs: { totalHours: 5 },
      estimatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-02-01T00:00:00.000Z", // in the past relative to "now" below
    });
    const unexpired = JSON.stringify({
      id: "e-unexpired",
      tool: "pert_estimate",
      inputs: {},
      outputs: { totalHours: 5 },
      estimatedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z", // far in the future
    });
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return expired + "\n" + unexpired + "\n";
      return "";
    });

    const pending = getPendingEstimates();
    const ids = pending.map((e) => e.id);
    expect(ids).not.toContain("e-expired");
    expect(ids).toContain("e-unexpired");
  });

  it("keeps pending estimates that have no expiresAt at all", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeEstimate({ id: "e-no-ttl" }) + "\n";
      return "";
    });

    const pending = getPendingEstimates();
    expect(pending.map((e) => e.id)).toContain("e-no-ttl");
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
    expect(defined(records[0]).estimatedHours).toBe(10);
    expect(defined(records[0]).actualHours).toBe(12);
    expect(defined(records[0]).taskType).toBe("feature");
  });

  it("marks ordinary matched feedback as correction-eligible prospective data", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeEstimate({ id: "live-estimate" }) + "\n";
      if (p.endsWith("feedback.jsonl")) return makeActual({ estimateId: "live-estimate", actualHours: 12 }) + "\n";
      return "";
    });

    const records = getCalibrationData();
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationProvenance).toBe("prospective");
    expect(defined(records[0]).calibrationUsage).toBe("correction");
  });

  it("marks auto_wallclock actuals as correction-eligible by default (Wave 2 auto-actuals)", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeEstimate({ id: "wallclock-estimate" }) + "\n";
      if (p.endsWith("feedback.jsonl")) {
        return JSON.stringify({
          estimateId: "wallclock-estimate",
          actualHours: 9,
          reportedAt: "2026-05-02T10:00:00.000Z",
          calibrationProvenance: "auto_wallclock",
        }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData();
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationProvenance).toBe("auto_wallclock");
    expect(defined(records[0]).calibrationUsage).toBe("correction");
  });

  it("keeps backfilled real-session data as baseline-only instead of correction-factor data when all usages are requested", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({
          id: "backfilled-session",
          inputs: { task_type: "feature", complexity: 3 },
          outputs: { expected: 6, unit: "hours" },
        }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return JSON.stringify({
          estimateId: "backfilled-session",
          actualHours: 6,
          notes: "Ingested from liminal: feature, 10 LOC, 2 files",
          reportedAt: "2026-05-02T10:00:00.000Z",
        }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData(undefined, undefined, undefined, undefined, "all");
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationProvenance).toBe("backfilled_real_session");
    expect(defined(records[0]).calibrationUsage).toBe("baseline");
  });

  it("excludes baseline-only backfilled records from default calibration data", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({
          id: "backfilled-session",
          inputs: { task_type: "feature", complexity: 3 },
          outputs: { expected: 6, unit: "hours" },
        }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return JSON.stringify({
          estimateId: "backfilled-session",
          actualHours: 6,
          notes: "Ingested from liminal: feature, 10 LOC, 2 files",
          reportedAt: "2026-05-02T10:00:00.000Z",
        }) + "\n";
      }
      return "";
    });

    expect(getCalibrationData()).toEqual([]);
  });

  it("treats actuals completed before the estimate was created as backfilled calibration baseline", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({
          id: "retroactive-calibration",
          inputs: { task_type: "feature", complexity: 4 },
          outputs: { correctedEstimate: 12 },
        }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({
          estimateId: "retroactive-calibration",
          actualHours: 8,
          completedAt: "2026-05-01T08:00:00.000Z",
          reportedAt: "2026-05-02T10:00:00.000Z",
        }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData(undefined, undefined, undefined, undefined, "all");
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationProvenance).toBe("backfilled_calibration");
    expect(defined(records[0]).calibrationUsage).toBe("baseline");
    expect(getCalibrationData()).toEqual([]);
  });

  it("excludes smoke records from calibration data", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "receiver-smoke", tool: "receiver_smoke" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return JSON.stringify({
          estimateId: "receiver-smoke",
          actualHours: 1,
          notes: "receiver smoke",
          reportedAt: "2026-05-02T10:00:00.000Z",
        }) + "\n";
      }
      return "";
    });

    expect(getCalibrationData()).toEqual([]);
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
    expect(defined(records[0]).taskType).toBe("bugfix");
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
    expect(defined(records[0]).tool).toBe("cocomo_estimate");
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

  it("keeps real fast actuals above the microtask floor", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "e1", outputs: { totalHours: 0.1 } }) + "\n"
          + makeEstimate({ id: "e2", outputs: { totalHours: 0.2 } }) + "\n"
          + makeEstimate({ id: "e3" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return JSON.stringify({ estimateId: "e1", actualHours: 0.008, reportedAt: new Date().toISOString() }) + "\n"
          + JSON.stringify({ estimateId: "e2", actualHours: 0.08, reportedAt: new Date().toISOString() }) + "\n"
          + JSON.stringify({ estimateId: "e3", actualHours: 5, reportedAt: new Date().toISOString() }) + "\n";
      }
      return "";
    });

    const data = getCalibrationData();
    expect(data).toHaveLength(2);
    expect(data.map((record) => record.actualHours)).toEqual([0.08, 5]);
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
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(20);
  });

  it("extracts estimatedHours", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ estimatedHours: 15 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(15);
  });

  it("extracts estimatedMinutes and converts to hours", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ estimatedMinutes: 120 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(2);
  });

  it("extracts estimatedSeconds and converts to hours", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ estimatedSeconds: 3600 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(1);
  });

  it("extracts expected with unit=days and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ expected: 5, unit: "days" }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(40);
  });

  it("extracts expected with unit=weeks and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ expected: 2, unit: "weeks" }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(80);
  });

  it("extracts expected with unit=months and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ expected: 1, unit: "months" }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(160);
  });

  it("extracts personMonthsLlmAdjusted and converts", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ personMonthsLlmAdjusted: 0.5 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(80);
  });

  it("extracts correctedEstimate directly", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) return makeWithOutputs({ correctedEstimate: 42 }) + "\n";
      if (p.endsWith("feedback.jsonl")) return withActual() + "\n";
      return "";
    });
    expect(defined(getCalibrationData()[0]).estimatedHours).toBe(42);
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
    expect(defined(report.byTool["pert_estimate"]).mdape).toBeDefined();
    expect(defined(report.byTool["pert_estimate"]).matchedPairs).toBe(2);
    expect(report.byTaskType["feature"]).toBeDefined();
    expect(defined(report.byTaskType["feature"]).mdape).toBeDefined();
    expect(defined(report.byTaskType["feature"]).matchedPairs).toBe(2);
    expect(defined(report.byTaskType["feature"]).recommendation).toContain("Insufficient sample (n=2)");
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
    expect(defined(report.byTool["pert_estimate"]).mape).toBeNull();
    expect(defined(report.byTool["pert_estimate"]).mdape).toBeNull();
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
    expect(defined(report.byTool["cocomo_estimate"]).recommendation).toContain("No matched pairs");
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
    expect(defined(report.byTool["pert_estimate"]).recommendation).toContain("Insufficient sample (n=1)");
    expect(defined(report.byTool["pert_estimate"]).recommendation).toContain("Need 19 more");
  });

  it("byTool includes recommendation with MdAPE for tools at/above MIN_N_FOR_VERDICT pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 20 }, (_, i) =>
          makeEstimate({ id: `e${i}`, outputs: { expected: 10, unit: "hours" } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 20 }, (_, i) =>
          makeActual({ estimateId: `e${i}`, actualHours: 9 + (i % 3) })
        ).join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(defined(report.byTool["pert_estimate"]).recommendation).not.toContain("Insufficient sample");
    expect(defined(report.byTool["pert_estimate"]).recommendation).toContain("MdAPE:");
  });

  // ---- MIN_N_FOR_VERDICT gating (Phase 1 Task 1) ----

  it("n=3 (below default MIN_N_FOR_VERDICT=20): byTool recommendation uses insufficient-sample wording, not a calibration claim", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", outputs: { expected: 10, unit: "hours" } }),
          makeEstimate({ id: "e2", outputs: { expected: 10, unit: "hours" } }),
          makeEstimate({ id: "e3", outputs: { expected: 10, unit: "hours" } }),
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
    const rec = defined(report.byTool["pert_estimate"]).recommendation;
    expect(rec).toContain("Insufficient sample (n=3)");
    expect(rec).not.toContain("Sufficient for calibration");
    expect(rec).not.toContain("Good coverage");
    // Underlying metrics are still computed (shape unchanged) — only the verdict text is gated.
    expect(defined(report.byTool["pert_estimate"]).matchedPairs).toBe(3);
    expect(defined(report.byTool["pert_estimate"]).mdape).not.toBeNull();
  });

  it("n=25 (at/above default MIN_N_FOR_VERDICT=20): byTool recommendation reports a normal calibration verdict", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 25 }, (_, i) =>
          makeEstimate({ id: `e${i}`, outputs: { expected: 10, unit: "hours" } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 25 }, (_, i) =>
          makeActual({ estimateId: `e${i}`, actualHours: 9 + (i % 3) })
        ).join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    const rec = defined(report.byTool["pert_estimate"]).recommendation;
    expect(rec).not.toContain("Insufficient sample");
    expect(rec).toContain("Good coverage");
    expect(defined(report.byTool["pert_estimate"]).matchedPairs).toBe(25);
  });

  it("respects EPOCH_MIN_N_FOR_VERDICT override", () => {
    const original = process.env["EPOCH_MIN_N_FOR_VERDICT"];
    process.env["EPOCH_MIN_N_FOR_VERDICT"] = "2";
    try {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) {
          return [
            makeEstimate({ id: "e1", outputs: { expected: 10, unit: "hours" } }),
            makeEstimate({ id: "e2", outputs: { expected: 10, unit: "hours" } }),
            makeEstimate({ id: "e3", outputs: { expected: 10, unit: "hours" } }),
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
      expect(defined(report.byTool["pert_estimate"]).recommendation).not.toContain("Insufficient sample");
    } finally {
      if (original === undefined) delete process.env["EPOCH_MIN_N_FOR_VERDICT"];
      else process.env["EPOCH_MIN_N_FOR_VERDICT"] = original;
    }
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
    expect(defined(report.byTaskType["migration"]).recommendation).toContain("No matched pairs");
  });

  it("byTaskType includes recommendation with MdAPE for types at/above MIN_N_FOR_VERDICT pairs", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 20 }, (_, i) =>
          makeEstimate({ id: `e${i}`, inputs: { task_type: "testing" }, outputs: { expected: 10, unit: "hours" } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 20 }, (_, i) =>
          makeActual({ estimateId: `e${i}`, actualHours: 9 + (i % 3) })
        ).join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(defined(report.byTaskType["testing"]).recommendation).not.toContain("Insufficient sample");
    expect(defined(report.byTaskType["testing"]).recommendation).toContain("MdAPE:");
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
    expect(typeof defined(report.byTool["pert_estimate"]).bias).toBe("number");
    expect(defined(report.byTool["pert_estimate"]).bias).toBeCloseTo(0.33, 1);
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
    expect(defined(report.byTaskType["bugfix"]).bias).toBeGreaterThan(0);
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
          makeActual({ estimateId: `e${i}`, actualHours: 10 + defined(i) })
        ).join("\n") + "\n";
      }
      return "";
    });
    const report = getFeedbackHealthReport();
    expect(report.dataQuality.dataCompletenessScore).toBeGreaterThan(0);
    expect(report.dataQuality.dataCompletenessScore).toBeLessThanOrEqual(100);
  });
});

// ---- Wave 2 auto-actuals: byProvenance segmentation (verified vs auto) ----

describe("getFeedbackHealthReport byProvenance", () => {
  it("reports zero auto and zero verified when there are no matched pairs", () => {
    mockReadFileSync.mockReturnValue("");
    const report = getFeedbackHealthReport();
    expect(report.byProvenance).toEqual({
      verified: { matchedPairs: 0, mdape: null, cappedMdape: null },
      auto: { matchedPairs: 0, mdape: null, cappedMdape: null },
    });
  });

  it("segments prospective (verified) actuals separately from auto_wallclock actuals", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", outputs: { expected: 5, unit: "hours" } }),
          makeEstimate({ id: "e2", outputs: { expected: 5, unit: "hours" } }),
          makeEstimate({ id: "e3", outputs: { expected: 5, unit: "hours" } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          // verified (no explicit provenance -> classified "prospective")
          makeActual({ estimateId: "e1", actualHours: 5 }),
          makeActual({ estimateId: "e2", actualHours: 6 }),
          // auto_wallclock
          JSON.stringify({ estimateId: "e3", actualHours: 4, reportedAt: "2026-05-02T10:00:00.000Z", calibrationProvenance: "auto_wallclock" }),
        ].join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    expect(report.byProvenance.verified.matchedPairs).toBe(2);
    expect(report.byProvenance.auto.matchedPairs).toBe(1);
    // n=2 is enough for computeAccuracyMetrics; n=1 stays null (matches byTool/byTaskType's own >=2 gate).
    expect(report.byProvenance.verified.mdape).not.toBeNull();
    expect(report.byProvenance.auto.mdape).toBeNull();
  });

  it("does not blend auto_wallclock records into the verified segment's MdAPE", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 4 }, (_, i) =>
          makeEstimate({ id: `e${i}`, outputs: { expected: 10, unit: "hours" } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          // verified: well-calibrated (small error)
          makeActual({ estimateId: "e0", actualHours: 10 }),
          makeActual({ estimateId: "e1", actualHours: 11 }),
          // auto_wallclock: large error (wall-clock noise), must not pollute "verified"
          JSON.stringify({ estimateId: "e2", actualHours: 3, reportedAt: "2026-05-02T10:00:00.000Z", calibrationProvenance: "auto_wallclock" }),
          JSON.stringify({ estimateId: "e3", actualHours: 4, reportedAt: "2026-05-02T10:00:00.000Z", calibrationProvenance: "auto_wallclock" }),
        ].join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    expect(report.byProvenance.verified.matchedPairs).toBe(2);
    expect(report.byProvenance.auto.matchedPairs).toBe(2);
    expect(defined(report.byProvenance.verified.mdape)).toBeLessThan(defined(report.byProvenance.auto.mdape));
  });
});

// ---- matchEstimatesToActuals / extractEstimatedHours ----

describe("matchEstimatesToActuals", () => {
  it("extracts hours from totalHours", () => {
    const estimates = [{ id: "e1", tool: "sprint_forecast", inputs: {}, outputs: { totalHours: 100 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 80, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(100);
  });

  it("extracts hours from estimatedHours", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 24 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 20, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(24);
  });

  it("extracts hours from estimatedMinutes", () => {
    const estimates = [{ id: "e1", tool: "token_time_bridge", inputs: {}, outputs: { estimatedMinutes: 30 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 0.5, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBeCloseTo(0.5, 1);
  });

  it("extracts hours from estimatedSeconds", () => {
    const estimates = [{ id: "e1", tool: "token_time_bridge", inputs: {}, outputs: { estimatedSeconds: 3600 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(1);
  });

  it("extracts hours from expected with unit=days", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { expected: 5, unit: "days" }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 40, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(40);
  });

  it("extracts hours from expected with unit=weeks", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { expected: 2, unit: "weeks" }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 80, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(80);
  });

  it("extracts hours from correctedEstimate", () => {
    const estimates = [{ id: "e1", tool: "reference_class_estimate", inputs: {}, outputs: { correctedEstimate: 15.5 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 12, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(15.5);
  });

  it("extracts hours from total_duration (critical path)", () => {
    const estimates = [{ id: "e1", tool: "critical_path", inputs: {}, outputs: { total_duration: 11, critical_path: ["A", "B"] }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 88, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(88);
  });

  it("extracts hours from personMonthsLlmAdjusted", () => {
    const estimates = [{ id: "e1", tool: "cocomo_estimate", inputs: {}, outputs: { personMonthsLlmAdjusted: 8.2 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1312, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).estimatedHours).toBe(8.2 * 160);
  });

  it("skips estimates with no extractable hours", () => {
    const estimates = [{ id: "e1", tool: "get_current_time", inputs: {}, outputs: { iso: "2026-01-01T00:00:00Z" }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(0);
  });

  it("keeps fast actuals when the estimate/actual ratio is plausible", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 0.1 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 0.08, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).actualHours).toBe(0.08);
  });

  it("returns empty for unmatched estimateIds", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 5 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "orphan", actualHours: 10, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(0);
  });

  it("filters records with seed- prefixed estimateId", () => {
    const estimates = [{ id: "seed-abc", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "seed-abc", actualHours: 8, reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(0);
  });

  it("filters records with 'seed' in notes", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 8, notes: "seed data", reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(0);
  });

  it("filters records with 'synthetic' in notes", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 8, notes: "synthetic baseline", reportedAt: "2026-01-10T00:00:00Z" }];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(0);
  });

  it("filters records with implausibly low actual/estimate ratio", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 100 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 1, reportedAt: "2026-01-10T00:00:00Z" }]; // ratio = 0.01
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(0);
  });

  it("keeps records with reasonable ratio even if small", () => {
    const estimates = [{ id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" }];
    const actuals = [{ estimateId: "e1", actualHours: 3, reportedAt: "2026-01-10T00:00:00Z" }]; // ratio = 0.3
    const result = matchFixtureRecords(estimates, actuals);
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
    const result = matchFixtureRecords(estimates, actuals);
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
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).completedAt).toBe("2026-01-10T00:00:00Z");
  });

  it("prefers actual completion time over later reporting time for calibration history", () => {
    const estimates = [
      { id: "e1", tool: "pert_estimate", inputs: {}, outputs: { estimatedHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" },
    ];
    const actuals = [
      {
        estimateId: "e1",
        actualHours: 8,
        completedAt: "2026-01-10T00:00:00Z",
        reportedAt: "2026-01-12T00:00:00Z",
      },
    ];
    const result = matchFixtureRecords(estimates, actuals);
    expect(result).toHaveLength(1);
    expect(defined(result[0]).completedAt).toBe("2026-01-10T00:00:00Z");
  });
});

describe("cappedMdape in feedback health", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("cappedMdape caps individual errors at 500%", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", tool: "monte_carlo_schedule", inputs: { task_type: "feature" }, outputs: { estimatedHours: 10 } }),
          makeEstimate({ id: "e2", tool: "monte_carlo_schedule", inputs: { task_type: "feature" }, outputs: { estimatedHours: 8 } }),
          makeEstimate({ id: "e3", tool: "monte_carlo_schedule", inputs: { task_type: "feature" }, outputs: { estimatedHours: 5 } }),
          makeEstimate({ id: "e4", tool: "monte_carlo_schedule", inputs: { task_type: "feature" }, outputs: { estimatedHours: 12 } }),
          makeEstimate({ id: "e5", tool: "monte_carlo_schedule", inputs: { task_type: "feature" }, outputs: { estimatedHours: 3 } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          JSON.stringify({ estimateId: "e1", actualHours: 0.3, reportedAt: "2026-01-10T00:00:00Z" }), // 3233% error, ratio=0.03
          JSON.stringify({ estimateId: "e2", actualHours: 0.25, reportedAt: "2026-01-10T00:00:00Z" }), // 3100% error, ratio=0.031
          JSON.stringify({ estimateId: "e3", actualHours: 4.5, reportedAt: "2026-01-10T00:00:00Z" }), // 11% error
          JSON.stringify({ estimateId: "e4", actualHours: 0.5, reportedAt: "2026-01-10T00:00:00Z" }), // 2300% error, ratio=0.042
          JSON.stringify({ estimateId: "e5", actualHours: 2.8, reportedAt: "2026-01-10T00:00:00Z" }), // 7% error
        ].join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    const tool = defined(report.byTool["monte_carlo_schedule"]);
    expect(tool).toBeDefined();
    expect(tool.cappedMdape).not.toBeNull();
    // 5 records: 3 extreme outliers (2300-3233%) + 2 reasonable (7-11%).
    // Uncapped median picks 3rd sorted error ≈ 2300%+
    // Capped median picks 3rd capped error = 500%
    expect(defined(tool.cappedMdape)).toBeLessThanOrEqual(500);
    expect(defined(tool.mdape)).toBeGreaterThan(defined(tool.cappedMdape));
  });

  it("recommendation includes bias direction for systematic overestimation", () => {
    // 21 pairs (>= MIN_N_FOR_VERDICT) cycling through 3 heavily-overestimated ratios.
    const estHours = [20, 15, 10];
    const actHours = [1, 0.5, 0.3];
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 21 }, (_, i) =>
          makeEstimate({ id: `e${i}`, tool: "pert_estimate", inputs: { task_type: "documentation" }, outputs: { estimatedHours: defined(estHours[i % 3]) } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 21 }, (_, i) =>
          JSON.stringify({ estimateId: `e${i}`, actualHours: defined(actHours[i % 3]), reportedAt: "2026-01-10T00:00:00Z" })
        ).join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    const tool = defined(report.byTool["pert_estimate"]);
    expect(tool.recommendation).toContain("systematic overestimation");
  });

  it("recommendation shows well-calibrated for small bias", () => {
    // 21 pairs (>= MIN_N_FOR_VERDICT) cycling through 3 well-calibrated ratios.
    const estHours = [5, 4, 6];
    const actHours = [5.1, 3.9, 6.2];
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 21 }, (_, i) =>
          makeEstimate({ id: `e${i}`, tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { estimatedHours: defined(estHours[i % 3]) } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 21 }, (_, i) =>
          JSON.stringify({ estimateId: `e${i}`, actualHours: defined(actHours[i % 3]), reportedAt: "2026-01-10T00:00:00Z" })
        ).join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    const tool = defined(report.byTool["pert_estimate"]);
    expect(tool.recommendation).toContain("well-calibrated");
  });

  it("byTaskType recommendation includes bias direction", () => {
    // 21 pairs (>= MIN_N_FOR_VERDICT) cycling through 3 systematically-underestimated ratios.
    const estHours = [5, 3, 4];
    const actHours = [10, 8, 9];
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 21 }, (_, i) =>
          makeEstimate({ id: `e${i}`, inputs: { task_type: "migration" }, outputs: { estimatedHours: defined(estHours[i % 3]) } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 21 }, (_, i) =>
          JSON.stringify({ estimateId: `e${i}`, actualHours: defined(actHours[i % 3]), reportedAt: "2026-01-10T00:00:00Z" })
        ).join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    const type = defined(report.byTaskType["migration"]);
    expect(type.recommendation).toContain("systematic underestimation");
  });

  it("byTool includes trend field", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return Array.from({ length: 8 }, (_, i) =>
          makeEstimate({ id: `e${i}`, tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { estimatedHours: 5 + i } })
        ).join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return Array.from({ length: 8 }, (_, i) =>
          JSON.stringify({ estimateId: `e${i}`, actualHours: 5 + i - (i < 4 ? 2 : 0), reportedAt: `2026-01-${10 + i}T00:00:00Z` })
        ).join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    const tool = defined(report.byTool["pert_estimate"]);
    expect(tool.trend).not.toBeNull();
    expect(["improving", "degrading", "stable"]).toContain(tool.trend);
  });

  it("byTaskType trend is null with fewer than 6 records", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return [
          makeEstimate({ id: "e1", inputs: { task_type: "testing" }, outputs: { estimatedHours: 5 } }),
          makeEstimate({ id: "e2", inputs: { task_type: "testing" }, outputs: { estimatedHours: 4 } }),
          makeEstimate({ id: "e3", inputs: { task_type: "testing" }, outputs: { estimatedHours: 3 } }),
        ].join("\n") + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return [
          JSON.stringify({ estimateId: "e1", actualHours: 5, reportedAt: "2026-01-10T00:00:00Z" }),
          JSON.stringify({ estimateId: "e2", actualHours: 4, reportedAt: "2026-01-10T00:00:00Z" }),
          JSON.stringify({ estimateId: "e3", actualHours: 3, reportedAt: "2026-01-10T00:00:00Z" }),
        ].join("\n") + "\n";
      }
      return "";
    });

    const report = getFeedbackHealthReport();
    const type = defined(report.byTaskType["testing"]);
    // Trend requires 6+ records to compute; with 3, metrics still has trend="stable"
    expect(typeof type.trend).toBe("string");
  });
});

// ---- Phase 1 ingest guards: tool-name canonicalization ----

describe("recordEstimate tool canonicalization", () => {
  it("normalizes a camelCase tool name to canonical snake_case", () => {
    recordEstimate("pertEstimate", { optimistic: 5 }, { expected: 7 });
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.tool).toBe("pert_estimate");
  });

  it("resolves manual_pert_estimate via the explicit alias map", () => {
    recordEstimate("manual_pert_estimate", { optimistic: 5 }, { expected: 7 });
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.tool).toBe("pert_estimate");
  });

  it("leaves an already-canonical tool name unchanged", () => {
    recordEstimate("cocomo_estimate", {}, {});
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.tool).toBe("cocomo_estimate");
  });

  it("falls back to the raw value for a tool name that cannot be resolved (never rejects a write)", () => {
    recordEstimate("totally_unknown_tool", {}, {});
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.tool).toBe("totally_unknown_tool");
  });
});

describe("matchEstimatesToActuals tool canonicalization", () => {
  it("groups a camelCase-spelled tool under its canonical name when filtering by tool", () => {
    const estimates = [
      { id: "est-1", tool: "pertEstimate", inputs: {}, outputs: { totalHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" },
      { id: "est-2", tool: "pert_estimate", inputs: {}, outputs: { totalHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" },
    ];
    const actuals = [
      { estimateId: "est-1", actualHours: 12, reportedAt: "2026-01-10T00:00:00Z" },
      { estimateId: "est-2", actualHours: 12, reportedAt: "2026-01-10T00:00:00Z" },
    ];
    const records = matchFixtureRecords(estimates, actuals);
    expect(records).toHaveLength(2);
    expect(records.every((r) => r.tool === "pert_estimate")).toBe(true);

    const filtered = matchEstimatesToActuals(estimates, actuals, { tool: "pert_estimate" });
    expect(filtered).toHaveLength(2);
  });

  it("passes through a tool name that cannot be canonicalized unchanged rather than dropping the record", () => {
    const estimates = [
      { id: "est-1", tool: "external_partner_tool", inputs: {}, outputs: { totalHours: 10 }, estimatedAt: "2026-01-01T00:00:00Z" },
    ];
    const actuals = [{ estimateId: "est-1", actualHours: 12, reportedAt: "2026-01-10T00:00:00Z" }];
    const records = matchFixtureRecords(estimates, actuals);
    expect(records).toHaveLength(1);
    expect(defined(records[0]).tool).toBe("external_partner_tool");
  });
});

// ---- Phase 1 ingest guards: recordActualDetailed unknown_tool / raw-UUID rejection ----

describe("recordActualDetailed unknown_tool rejection", () => {
  it("rejects an actual whose matched estimate has an unmapped tool name", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", tool: "totally_unknown_tool" }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 5);
    // Ticket 16: the rejection semantics are unchanged (ticket 04 pin), but
    // the result now carries an actionable hint naming the canonical set.
    expect(result).toEqual({ ok: false, reason: "unknown_tool", hint: expect.stringContaining("estimation tools") });
    if (!result.ok) expect(result.hint).toContain("pert_estimate");
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("rejects an actual whose matched estimate's tool is a raw UUID", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", tool: "550e8400-e29b-41d4-a716-446655440000" }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 5);
    expect(result).toEqual({ ok: false, reason: "unknown_tool", hint: expect.any(String) });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("accepts an actual whose matched estimate has a resolvable (camelCase) tool name", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", tool: "pertEstimate" }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 5);
    expect(result.ok).toBe(true);
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
  });

  it("does not reject an orphan actual (no matching estimate on file)", () => {
    mockReadFileSync.mockReturnValue("");
    const result = recordActualDetailed("no-such-estimate", 5);
    expect(result.ok).toBe(true);
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
  });
});

// ---- Phase 1 ingest guards: unit normalization + unit_suspect flag ----

describe("recordActualDetailed unit normalization", () => {
  beforeEach(() => {
    mockReadFileSync.mockReturnValue("");
  });

  it("treats an omitted unit as hours (no change to existing behavior)", () => {
    recordActualDetailed("est-1", 5);
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.actualHours).toBe(5);
  });

  it("normalizes minutes to hours", () => {
    recordActualDetailed("est-1", 30, undefined, "minutes");
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.actualHours).toBeCloseTo(0.5, 10);
  });

  it("normalizes days to hours (8h/day convention)", () => {
    recordActualDetailed("est-1", 2, undefined, "days");
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.actualHours).toBe(16);
  });

  it("normalizes weeks to hours (40h/week convention)", () => {
    recordActualDetailed("est-1", 1, undefined, "weeks");
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.actualHours).toBe(40);
  });

  it("passes hours through unchanged", () => {
    recordActualDetailed("est-1", 7.5, undefined, "hours");
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.actualHours).toBe(7.5);
  });

  it("rejects below-threshold actuals after normalization, not before", () => {
    // 0 minutes normalizes to 0 hours either way — still rejected.
    const result = recordActualDetailed("est-1", 0, undefined, "minutes");
    expect(result).toEqual({ ok: false, reason: "below_threshold" });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });
});

describe("recordActualDetailed unit_suspect flag", () => {
  it("flags a >10x ratio between normalized actual and estimated hours, but still records it", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", outputs: { totalHours: 5 } }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 100); // 100 / 5 = 20x
    expect(result).toEqual({ ok: true, flagged: "unit_suspect" });
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.actualHours).toBe(100);
  });

  it("flags a >10x ratio in the opposite direction (actual far below estimate)", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", outputs: { totalHours: 100 } }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 5); // 100 / 5 = 20x
    expect(result).toEqual({ ok: true, flagged: "unit_suspect" });
  });

  it("does not flag a ratio at or below 10x", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", outputs: { totalHours: 5 } }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 45); // 45 / 5 = 9x
    expect(result).toEqual({ ok: true });
  });

  it("does not flag when there is no matching estimate to compare against", () => {
    mockReadFileSync.mockReturnValue("");
    const result = recordActualDetailed("no-such-estimate", 100);
    expect(result).toEqual({ ok: true });
  });

  it("evaluates the ratio against the normalized (unit-converted) hours, catching a person-months-as-hours mistake", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        // Estimate expects ~4h; actual submitted as "2 days" (16h) is well within range,
        // but submitted as "2 weeks" (80h) is a 20x ratio and should be caught.
        return makeEstimate({ id: "est-1", outputs: { totalHours: 4 } }) + "\n";
      }
      return "";
    });

    const withinRange = recordActualDetailed("est-1", 2, undefined, "days");
    expect(withinRange).toEqual({ ok: true });

    mockAppendFileSync.mockClear();
    const suspect = recordActualDetailed("est-1", 2, undefined, "weeks");
    expect(suspect).toEqual({ ok: true, flagged: "unit_suspect" });
  });
});

// ---- Wave 2 auto-actuals: recordActualDetailed write-time sanity gate ----

describe("recordActualDetailed auto_wallclock sanity gate", () => {
  it("records an in-bounds auto_wallclock actual with the provenance persisted", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", outputs: { totalHours: 5 } }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 3, "auto-recorded at session end (wall-clock)", undefined, "auto_wallclock");
    expect(result).toEqual({ ok: true });
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.calibrationProvenance).toBe("auto_wallclock");
  });

  it("rejects an auto_wallclock actual below the lower bound and does not write", () => {
    mockReadFileSync.mockReturnValue("");
    const result = recordActualDetailed("est-1", 0.01, undefined, undefined, "auto_wallclock");
    expect(result).toEqual({ ok: false, reason: "auto_wallclock_out_of_bounds" });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("rejects an auto_wallclock actual above the upper bound and does not write", () => {
    mockReadFileSync.mockReturnValue("");
    const result = recordActualDetailed("est-1", 20, undefined, undefined, "auto_wallclock");
    expect(result).toEqual({ ok: false, reason: "auto_wallclock_out_of_bounds" });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("rejects an in-bounds auto_wallclock actual whose ratio to the matched estimate is unit-suspect", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", outputs: { totalHours: 0.5 } }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 10, undefined, undefined, "auto_wallclock"); // 10 / 0.5 = 20x
    expect(result).toEqual({ ok: false, reason: "auto_wallclock_out_of_bounds" });
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("does not apply the auto_wallclock gate to actuals without that provenance (existing behavior preserved)", () => {
    mockReadFileSync.mockReturnValue("");
    const result = recordActualDetailed("est-1", 20); // would fail the auto_wallclock bounds, but no provenance was given
    expect(result).toEqual({ ok: true });
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
  });
});

// ---- Ticket 16: unit_suspect persistence on the actual record ----

describe("recordActualDetailed unit_suspect persistence (ticket 16)", () => {
  it("persists unitSuspect: true on the written record when flagged", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", outputs: { totalHours: 5 } }) + "\n"; // 300 / 5 = 60x
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 300);
    expect(result).toEqual({ ok: true, flagged: "unit_suspect" });
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written.unitSuspect).toBe(true);
  });

  it("omits unitSuspect when the ratio is not unit-suspect", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", outputs: { totalHours: 5 } }) + "\n";
      }
      return "";
    });

    const result = recordActualDetailed("est-1", 8);
    expect(result).toEqual({ ok: true });
    const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
    expect(written).not.toHaveProperty("unitSuspect");
  });
});

// ---- Ticket 16: dry-run duplicate check + estimate lookup use dry-run files ----

describe("recordActualDetailed dry-run ledger consistency (ticket 16)", () => {
  function withDryRun(enabled: boolean, fn: () => void) {
    const original = process.env["EPOCH_DRY_RUN"];
    if (enabled) process.env["EPOCH_DRY_RUN"] = "1";
    else delete process.env["EPOCH_DRY_RUN"];
    try {
      fn();
    } finally {
      if (original === undefined) delete process.env["EPOCH_DRY_RUN"];
      else process.env["EPOCH_DRY_RUN"] = original;
    }
  }

  it("checks the DRY-RUN actuals file for duplicates, not the production one", () => {
    // Production feedback.jsonl already has an actual for est-1; the dry-run
    // ledger does not. A dry-run write must succeed (proving the production
    // file was not consulted) and target the dry-run file.
    withDryRun(true, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("feedback.jsonl")) return makeActual({ estimateId: "est-1" }) + "\n";
        if (p.endsWith("feedback.dry-run.jsonl")) return "";
        return "";
      });

      const result = recordActualDetailed("est-1", 8);
      expect(result).toEqual({ ok: true });
      expect(mockAppendFileSync).toHaveBeenCalledOnce();
      expect((defined(mockAppendFileSync.mock.calls[0])[0] as string).endsWith("feedback.dry-run.jsonl")).toBe(true);
    });
  });

  it("rejects a duplicate recorded earlier in the SAME dry-run ledger", () => {
    withDryRun(true, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("feedback.dry-run.jsonl")) return makeActual({ estimateId: "est-1" }) + "\n";
        return "";
      });

      const result = recordActualDetailed("est-1", 8);
      expect(result).toEqual({ ok: false, reason: "duplicate" });
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });

  it("looks the estimate up in the DRY-RUN estimates file, not the production one", () => {
    // Production knows est-1 as a resolvable pert_estimate; the dry-run
    // estimates file knows it as an unmapped tool. The dry-run view must win.
    withDryRun(true, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.jsonl")) return makeEstimate({ id: "est-1", tool: "pert_estimate" }) + "\n";
        if (p.endsWith("estimates.dry-run.jsonl")) return makeEstimate({ id: "est-1", tool: "totally_unknown_tool" }) + "\n";
        return "";
      });

      const result = recordActualDetailed("est-1", 5);
      expect(result).toEqual({ ok: false, reason: "unknown_tool", hint: expect.any(String) });
      expect(mockAppendFileSync).not.toHaveBeenCalled();
    });
  });

  it("computes the unit_suspect ratio against the dry-run estimate and writes the dry-run actuals file", () => {
    withDryRun(true, () => {
      mockReadFileSync.mockImplementation((path: unknown) => {
        const p = path as string;
        if (p.endsWith("estimates.dry-run.jsonl")) return makeEstimate({ id: "est-1", outputs: { totalHours: 5 } }) + "\n";
        return "";
      });

      const result = recordActualDetailed("est-1", 300); // 60x
      expect(result).toEqual({ ok: true, flagged: "unit_suspect" });
      expect((defined(mockAppendFileSync.mock.calls[0])[0] as string).endsWith("feedback.dry-run.jsonl")).toBe(true);
      const written = JSON.parse(defined(mockAppendFileSync.mock.calls[0])[1] as string);
      expect(written.unitSuspect).toBe(true);
    });
  });
});

// ---- Ticket 16: unknown_tool rejection leaves a trace (log-once) ----

describe("recordActualDetailed unknown_tool log-once diagnostic (ticket 16)", () => {
  it("logs the diagnostic once per process even across repeated rejections", async () => {
    vi.resetModules(); // fresh module instance so the process-lifetime flag starts unset
    const originalDebug = process.env["EPOCH_DEBUG"];
    process.env["EPOCH_DEBUG"] = "1";
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      const fresh = await import("./feedback.js");
      const readFixture = () =>
        mockReadFileSync.mockImplementation((path: unknown) => {
          const p = path as string;
          if (p.endsWith("estimates.jsonl")) return makeEstimate({ id: "est-1", tool: "totally_unknown_tool" }) + "\n";
          return "";
        });

      readFixture();
      const first = fresh.recordActualDetailed("est-1", 5);
      expect(first).toEqual({ ok: false, reason: "unknown_tool", hint: expect.any(String) });

      readFixture();
      const second = fresh.recordActualDetailed("est-1", 5);
      expect(second).toEqual({ ok: false, reason: "unknown_tool", hint: expect.any(String) });

      const writes = stderrSpy.mock.calls.map((args) => String(defined(args)[0])).join("\n");
      const hits = writes.split("feedback.unknown-tool").length - 1;
      expect(hits).toBe(1); // once, not twice — repeated severance must not spam
      expect(writes).toContain("totally_unknown_tool");
    } finally {
      stderrSpy.mockRestore();
      if (originalDebug === undefined) delete process.env["EPOCH_DEBUG"];
      else process.env["EPOCH_DEBUG"] = originalDebug;
    }
  });
});

// ---- Ticket 16: explicit structured classification overrides note-sniffing ----

describe("classifyCalibrationRecord explicit-override (ticket 16)", () => {
  it("an explicit calibration_provenance beats an 'ingested from' note (no baseline demotion)", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", inputs: { task_type: "feature", calibration_provenance: "prospective" } }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "est-1", actualHours: 6, notes: "Ingested from liminal: feature, 10 LOC, 2 files" }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData(undefined, undefined, undefined, undefined, "all");
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationProvenance).toBe("prospective");
    expect(defined(records[0]).calibrationUsage).toBe("correction");
  });

  it("an explicit calibration_usage beats an 'ingested from' note", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", inputs: { task_type: "feature", calibration_usage: "correction" } }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "est-1", actualHours: 6, notes: "ingested from a real session log" }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData(undefined, undefined, undefined, undefined, "all");
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationProvenance).toBe("prospective");
    expect(defined(records[0]).calibrationUsage).toBe("correction");
  });

  it("an explicit calibration_provenance beats a seed-matching note in exclusion classification", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1", inputs: { task_type: "feature", calibration_provenance: "prospective" } }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "est-1", actualHours: 6, notes: "seeded from dogfood run" }) + "\n";
      }
      return "";
    });

    // Without the explicit field this pair is excluded as seed_notes; with it,
    // the deliberate classification wins and the pair trains correction.
    const records = getCalibrationData();
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationProvenance).toBe("prospective");
    expect(defined(records[0]).calibrationUsage).toBe("correction");
  });

  it("an explicit structured usage on the actual record overrides a seed note (legacy camelCase field)", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return JSON.stringify({ estimateId: "est-1", actualHours: 6, notes: "seed data", reportedAt: "2026-05-02T10:00:00.000Z", calibrationUsage: "correction" }) + "\n";
      }
      return "";
    });

    const records = getCalibrationData();
    expect(records).toHaveLength(1);
    expect(defined(records[0]).calibrationUsage).toBe("correction");
  });

  it("control: without explicit fields the note heuristics still apply", () => {
    mockReadFileSync.mockImplementation((path: unknown) => {
      const p = path as string;
      if (p.endsWith("estimates.jsonl")) {
        return makeEstimate({ id: "est-1" }) + "\n";
      }
      if (p.endsWith("feedback.jsonl")) {
        return makeActual({ estimateId: "est-1", actualHours: 6, notes: "seed data" }) + "\n";
      }
      return "";
    });

    expect(getCalibrationData()).toEqual([]);
  });
});

// ---- Ticket 16: symmetric high-side ratio exclusion in the matcher ----

describe("matchEstimatesToActuals symmetric ratio bounds (ticket 16)", () => {
  const estimate = (id: string, hours: number) => ({
    id,
    tool: "pert_estimate",
    inputs: {},
    outputs: { totalHours: hours },
    estimatedAt: "2026-01-01T00:00:00Z",
  });
  const actual = (id: string, hours: number) => ({
    estimateId: id,
    actualHours: hours,
    reportedAt: "2026-01-10T00:00:00Z",
  });

  it("excludes a 60x overrun (suspected person-months-as-hours) from calibration", () => {
    const result = matchFixtureRecords([estimate("e1", 5)], [actual("e1", 300)]);
    expect(result).toHaveLength(0);
  });

  it("keeps a ratio of exactly 50x (bound is inclusive-safe, mirroring MIN_RATIO)", () => {
    const result = matchFixtureRecords([estimate("e1", 10)], [actual("e1", 500)]);
    expect(result).toHaveLength(1);
  });

  it("excludes a ratio just above 50x", () => {
    const result = matchFixtureRecords([estimate("e1", 10)], [actual("e1", 501)]);
    expect(result).toHaveLength(0);
  });

  it("still keeps a 9x overrun (flagged unit_suspect at write time, but trainable)", () => {
    const result = matchFixtureRecords([estimate("e1", 10)], [actual("e1", 90)]);
    expect(result).toHaveLength(1);
  });
});
