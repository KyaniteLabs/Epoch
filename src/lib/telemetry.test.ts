import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn().mockReturnValue(true),
  mkdirSync: vi.fn(),
  appendFileSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { existsSync, appendFileSync, readFileSync } from "node:fs";
import { getTelemetry, resetTelemetry } from "./telemetry.js";
import type { ToolCallRecord } from "./telemetry.js";
import { defined } from "../test-support.js";


const mockExistsSync = vi.mocked(existsSync);
const mockAppendFileSync = vi.mocked(appendFileSync);
const mockReadFileSync = vi.mocked(readFileSync);

function makeRecord(overrides: Partial<ToolCallRecord> = {}): ToolCallRecord {
  return {
    timestamp: new Date().toISOString(),
    tool: "pert_estimate",
    inputHash: "abc123",
    outputOk: true,
    elapsedMs: 100,
    ...overrides,
  };
}

function makeRecordsJson(records: ToolCallRecord[]): string {
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

beforeEach(() => {
  vi.clearAllMocks();
  mockExistsSync.mockReturnValue(true);
  resetTelemetry();
});

afterEach(() => {
  resetTelemetry();
});

// ---- record() + flush() ----

describe("record + flush", () => {
  it("buffers records without writing", () => {
    const store = getTelemetry();
    store.record("pert_estimate", 150, true);
    store.record("get_current_time", 50, true);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("flush writes buffered records as JSONL", () => {
    const store = getTelemetry();
    store.record("pert_estimate", 150, true, { x: 1 });
    store.flush();
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
    const written = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    const lines = written.trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(defined(lines[0])) as ToolCallRecord;
    expect(parsed.tool).toBe("pert_estimate");
    expect(parsed.outputOk).toBe(true);
  });

  it("auto-flushes at FLUSH_BUFFER_SIZE (50)", () => {
    const store = getTelemetry();
    for (let i = 0; i < 49; i++) {
      store.record("tool", 10, true);
    }
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    store.record("tool", 10, true); // 50th
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
  });

  it("does not write when disabled (no data dir)", () => {
    mockExistsSync.mockReturnValue(false);
    resetTelemetry();
    const store = getTelemetry();
    store.record("pert_estimate", 150, true);
    store.flush();
    expect(mockAppendFileSync).not.toHaveBeenCalled();
  });

  it("rounds elapsedMs to 2 decimal places", () => {
    const store = getTelemetry();
    store.record("tool", 123.4567, true);
    store.flush();
    const written = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    const parsed = JSON.parse(written.trim()) as ToolCallRecord;
    expect(parsed.elapsedMs).toBe(123.46);
  });

  it("includes model and tokens when provided", () => {
    const store = getTelemetry();
    store.record("tool", 100, true, undefined, "gpt-4o", 5000);
    store.flush();
    const written = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    const parsed = JSON.parse(written.trim()) as ToolCallRecord;
    expect(parsed.model).toBe("gpt-4o");
    expect(parsed.tokens).toBe(5000);
  });

  it("omits model and tokens when not provided", () => {
    const store = getTelemetry();
    store.record("tool", 100, true);
    store.flush();
    const written = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    const parsed = JSON.parse(written.trim()) as ToolCallRecord;
    expect(parsed).not.toHaveProperty("model");
    expect(parsed).not.toHaveProperty("tokens");
  });
});

// ---- getStats() ----

describe("getStats", () => {
  it("returns empty array when no file exists", () => {
    mockExistsSync.mockReturnValue(false);
    resetTelemetry();
    const store = getTelemetry();
    expect(store.getStats()).toEqual([]);
  });

  it("returns empty array when file is empty", () => {
    mockReadFileSync.mockReturnValue("");
    const store = getTelemetry();
    expect(store.getStats()).toEqual([]);
  });

  it("returns stats grouped by tool", () => {
    const records = [
      makeRecord({ tool: "pert_estimate", elapsedMs: 100, outputOk: true }),
      makeRecord({ tool: "pert_estimate", elapsedMs: 200, outputOk: true }),
      makeRecord({ tool: "get_current_time", elapsedMs: 50, outputOk: true }),
    ];
    mockReadFileSync.mockReturnValue(makeRecordsJson(records));
    const store = getTelemetry();
    const stats = store.getStats();
    expect(stats).toHaveLength(2);
    const pertStats = stats.find((s) => s.tool === "pert_estimate");
    expect(pertStats?.callCount).toBe(2);
    expect(pertStats?.p50Ms).toBe(200);
  });

  it("filters by tool name", () => {
    const records = [
      makeRecord({ tool: "pert_estimate", elapsedMs: 100 }),
      makeRecord({ tool: "get_current_time", elapsedMs: 50 }),
    ];
    mockReadFileSync.mockReturnValue(makeRecordsJson(records));
    const store = getTelemetry();
    const stats = store.getStats("pert_estimate");
    expect(stats).toHaveLength(1);
    expect(defined(stats[0]).tool).toBe("pert_estimate");
  });

  it("computes success rate", () => {
    const records = [
      makeRecord({ tool: "tool", elapsedMs: 100, outputOk: true }),
      makeRecord({ tool: "tool", elapsedMs: 100, outputOk: false }),
      makeRecord({ tool: "tool", elapsedMs: 100, outputOk: true }),
      makeRecord({ tool: "tool", elapsedMs: 100, outputOk: true }),
    ];
    mockReadFileSync.mockReturnValue(makeRecordsJson(records));
    const store = getTelemetry();
    const stats = store.getStats("tool");
    expect(defined(stats[0]).successRate).toBe(0.75);
  });

  it("computes p50 and p95 percentiles", () => {
    const times = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    const records = times.map((ms) => makeRecord({ tool: "tool", elapsedMs: ms }));
    mockReadFileSync.mockReturnValue(makeRecordsJson(records));
    const store = getTelemetry();
    const stats = store.getStats("tool");
    expect(defined(stats[0]).p50Ms).toBe(60);
    expect(defined(stats[0]).p95Ms).toBe(100);
  });

  it("filters by time window", () => {
    const old = makeRecord({
      tool: "tool",
      elapsedMs: 100,
      timestamp: new Date(Date.now() - 200 * 86_400_000).toISOString(),
    });
    const recent = makeRecord({
      tool: "tool",
      elapsedMs: 50,
      timestamp: new Date().toISOString(),
    });
    mockReadFileSync.mockReturnValue(makeRecordsJson([old, recent]));
    const store = getTelemetry();
    const stats = store.getStats("tool", 90);
    expect(stats).toHaveLength(1);
    expect(defined(stats[0]).callCount).toBe(1);
    expect(defined(stats[0]).p50Ms).toBe(50);
  });
});

// ---- getModelStats() ----

describe("getModelStats", () => {
  it("returns null when fewer than 10 samples", () => {
    const records = Array.from({ length: 5 }, () =>
      makeRecord({ model: "gpt-4o", tokens: 1000, elapsedMs: 500 }),
    );
    mockReadFileSync.mockReturnValue(makeRecordsJson(records));
    const store = getTelemetry();
    expect(store.getModelStats("gpt-4o")).toBeNull();
  });

  it("returns correct stats with 10+ samples", () => {
    const records = Array.from({ length: 20 }, (_, i) =>
      makeRecord({ model: "gpt-4o", tokens: 1000, elapsedMs: 100 + i * 10 }),
    );
    mockReadFileSync.mockReturnValue(makeRecordsJson(records));
    const store = getTelemetry();
    const stats = store.getModelStats("gpt-4o");
    expect(stats).not.toBeNull();
    expect(defined(stats).sampleCount).toBe(20);
    expect(defined(stats).avgTps).toBeGreaterThan(0);
    expect(defined(stats).medianTps).toBeGreaterThan(0);
  });

  it("returns null when file does not exist", () => {
    mockExistsSync.mockReturnValue(false);
    resetTelemetry();
    const store = getTelemetry();
    expect(store.getModelStats("gpt-4o")).toBeNull();
  });

  it("filters out zero elapsedMs records", () => {
    const records = Array.from({ length: 15 }, (_, i) =>
      makeRecord({
        model: "gpt-4o",
        tokens: 1000,
        elapsedMs: i < 5 ? 0 : 100,
      }),
    );
    mockReadFileSync.mockReturnValue(makeRecordsJson(records));
    const store = getTelemetry();
    const stats = store.getModelStats("gpt-4o");
    expect(stats).not.toBeNull();
    expect(defined(stats).sampleCount).toBe(10);
  });
});

// ---- hashInput() (tested indirectly via record) ----

describe("hashInput", () => {
  it("produces deterministic hash for identical inputs", () => {
    const store = getTelemetry();
    store.record("tool", 100, true, { a: 1, b: 2 });
    store.flush();
    const written1 = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    resetTelemetry();
    mockAppendFileSync.mockClear();
    const store2 = getTelemetry();
    store2.record("tool", 100, true, { a: 1, b: 2 });
    store2.flush();
    const written2 = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    const hash1 = (JSON.parse(written1.trim()) as ToolCallRecord).inputHash;
    const hash2 = (JSON.parse(written2.trim()) as ToolCallRecord).inputHash;
    expect(hash1).toBe(hash2);
  });

  it("hashes consistently regardless of key order", () => {
    const store = getTelemetry();
    store.record("tool", 100, true, { b: 2, a: 1 });
    store.flush();
    const written = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    const parsed = JSON.parse(written.trim()) as ToolCallRecord;
    // Same values, different insertion order → same hash (keys are sorted)
    const store2 = getTelemetry();
    mockAppendFileSync.mockClear();
    store2.record("tool", 100, true, { a: 1, b: 2 });
    store2.flush();
    const written2 = defined(mockAppendFileSync.mock.calls[0])[1] as string;
    const parsed2 = JSON.parse(written2.trim()) as ToolCallRecord;
    expect(parsed.inputHash).toBe(parsed2.inputHash);
  });
});

// ---- Singleton lifecycle ----

describe("singleton lifecycle", () => {
  it("resetTelemetry clears the singleton", () => {
    const store1 = getTelemetry();
    resetTelemetry();
    mockExistsSync.mockReturnValue(true);
    const store2 = getTelemetry();
    expect(store1).not.toBe(store2);
  });

  it("destroy flushes remaining buffer", () => {
    const store = getTelemetry();
    store.record("tool", 100, true);
    expect(mockAppendFileSync).not.toHaveBeenCalled();
    resetTelemetry();
    expect(mockAppendFileSync).toHaveBeenCalledOnce();
  });
});
