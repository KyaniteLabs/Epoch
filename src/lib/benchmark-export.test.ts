import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadLocalBenchmarkPairs, isBackfillSignaturePair } from "./benchmark-export.js";
import { ESTIMATES_FILE, ACTUALS_FILE } from "./ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-benchmark-export-test-${Date.now()}`);

beforeEach(() => {
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("isBackfillSignaturePair", () => {
  it("flags an exact-match ratio dated 2026-05-05", () => {
    expect(isBackfillSignaturePair(1.0, "2026-05-05T10:00:00.000Z")).toBe(true);
    expect(isBackfillSignaturePair(1.003, "2026-05-05")).toBe(true);
  });

  it("does not flag a real-variance ratio even on 2026-05-05", () => {
    expect(isBackfillSignaturePair(0.6, "2026-05-05T10:00:00.000Z")).toBe(false);
  });

  it("does not flag an exact-match ratio on a different date", () => {
    expect(isBackfillSignaturePair(1.0, "2026-06-01T10:00:00.000Z")).toBe(false);
  });

  it("does not flag when no date is available", () => {
    expect(isBackfillSignaturePair(1.0, undefined)).toBe(false);
    expect(isBackfillSignaturePair(1.0, null)).toBe(false);
  });
});

describe("loadLocalBenchmarkPairs", () => {
  it("excludes a known contaminated (backfill-signature) fixture row from the export output", () => {
    writeFileSync(
      join(TEST_DIR, ESTIMATES_FILE),
      [
        JSON.stringify({ id: "contaminated-1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-05-05T10:00:00.000Z" }),
        JSON.stringify({ id: "clean-1", tool: "pert_estimate", inputs: { task_type: "bugfix", complexity: 2 }, outputs: { expected: 8, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
      ].join("\n") + "\n",
    );
    writeFileSync(
      join(TEST_DIR, ACTUALS_FILE),
      [
        JSON.stringify({ estimateId: "contaminated-1", actualHours: 10, reportedAt: "2026-05-05T20:00:00.000Z", completedAt: "2026-05-05T20:00:00.000Z" }),
        JSON.stringify({ estimateId: "clean-1", actualHours: 5, reportedAt: "2026-06-02T20:00:00.000Z", completedAt: "2026-06-02T20:00:00.000Z" }),
      ].join("\n") + "\n",
    );

    const result = loadLocalBenchmarkPairs();
    expect(result.includedIds).toEqual(["clean-1"]);
    expect(result.excludedCount).toBe(1);
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toMatchObject({ task_type: "bugfix", tool: "pert_estimate", estimated_hours: 8, actual_hours: 5 });
  });

  it("returns an empty result for an empty ledger", () => {
    const result = loadLocalBenchmarkPairs();
    expect(result.pairs).toEqual([]);
    expect(result.includedIds).toEqual([]);
    expect(result.excludedCount).toBe(0);
  });
});
