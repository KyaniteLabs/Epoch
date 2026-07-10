import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runRepairOrphanedActuals } from "./repair-orphaned-actuals.js";
import { ESTIMATES_FILE, ACTUALS_FILE } from "../ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-repair-orphans-test-${Date.now()}`);

function sha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeLedger(): void {
  writeFileSync(
    join(TEST_DIR, ESTIMATES_FILE),
    [
      // Single candidate for orphan-ghost-1's window.
      JSON.stringify({ id: "target-1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-06-10T09:00:00.000Z" }),
      // Two candidates for orphan-ghost-2's window (ambiguous).
      JSON.stringify({ id: "target-2a", tool: "cocomo_estimate", inputs: { task_type: "feature" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-07-01T09:00:00.000Z" }),
      JSON.stringify({ id: "target-2b", tool: "cocomo_estimate", inputs: { task_type: "feature" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-07-01T10:00:00.000Z" }),
      // Estimate with a real matched actual, not a repair candidate.
      JSON.stringify({ id: "matched-1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-08-01T09:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(TEST_DIR, ACTUALS_FILE),
    [
      // Orphan with exactly one candidate in its 24h window.
      JSON.stringify({ estimateId: "orphan-ghost-1", actualHours: 4, reportedAt: "2026-06-10T18:00:00.000Z", completedAt: "2026-06-10T18:00:00.000Z" }),
      // Orphan with two candidates in its window — must NOT guess.
      JSON.stringify({ estimateId: "orphan-ghost-2", actualHours: 4, reportedAt: "2026-07-01T18:00:00.000Z", completedAt: "2026-07-01T18:00:00.000Z" }),
      // Orphan with zero candidates nearby.
      JSON.stringify({ estimateId: "orphan-ghost-3", actualHours: 4, reportedAt: "2020-01-01T18:00:00.000Z", completedAt: "2020-01-01T18:00:00.000Z" }),
      // Real matched pair — not orphaned.
      JSON.stringify({ estimateId: "matched-1", actualHours: 6, reportedAt: "2026-08-02T09:00:00.000Z", completedAt: "2026-08-02T09:00:00.000Z" }),
    ].join("\n") + "\n",
  );
}

beforeEach(() => {
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
  writeLedger();
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("runRepairOrphanedActuals", () => {
  it("finds 3 orphans and classifies them correctly", () => {
    const report = runRepairOrphanedActuals({ mode: "dry-run" });
    expect(report.totalOrphans).toBe(3);
    expect(report.relinked).toHaveLength(1);
    expect(report.relinked[0]).toMatchObject({ orphanEstimateId: "orphan-ghost-1", relinkedToEstimateId: "target-1" });
    expect(report.unresolved).toHaveLength(2);
  });

  it("zero-candidate orphan is flagged unresolved with reason zero_candidates", () => {
    const report = runRepairOrphanedActuals({ mode: "dry-run" });
    const zero = report.unresolved.find((u) => u.orphanEstimateId === "orphan-ghost-3");
    expect(zero).toMatchObject({ candidateCount: 0, reason: "zero_candidates" });
  });

  it("multi-candidate orphan is flagged unresolved with reason multiple_candidates — never guesses", () => {
    const report = runRepairOrphanedActuals({ mode: "dry-run" });
    const multi = report.unresolved.find((u) => u.orphanEstimateId === "orphan-ghost-2");
    expect(multi).toMatchObject({ candidateCount: 2, reason: "multiple_candidates" });
  });

  it("dry-run writes nothing — feedback.jsonl hash unchanged", () => {
    const before = sha256(join(TEST_DIR, ACTUALS_FILE));
    runRepairOrphanedActuals({ mode: "dry-run" });
    expect(sha256(join(TEST_DIR, ACTUALS_FILE))).toBe(before);
  });

  it("apply rewrites only the resolved orphan's estimateId, in place", () => {
    const report = runRepairOrphanedActuals({ mode: "apply" });
    expect(report.written).toBe(1);
    expect(report.backupPath).toBeTruthy();

    const actuals = readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const relinkedRow = actuals.find((a: { estimateId: string }) => a.estimateId === "target-1");
    expect(relinkedRow).toBeTruthy();
    expect(actuals.some((a: { estimateId: string }) => a.estimateId === "orphan-ghost-1")).toBe(false);
    // Unresolved orphans are left untouched.
    expect(actuals.some((a: { estimateId: string }) => a.estimateId === "orphan-ghost-2")).toBe(true);
    expect(actuals.some((a: { estimateId: string }) => a.estimateId === "orphan-ghost-3")).toBe(true);
    // Real matched pair untouched.
    expect(actuals.some((a: { estimateId: string }) => a.estimateId === "matched-1")).toBe(true);
    // Row count conserved (rewrite, not drop/duplicate).
    expect(actuals).toHaveLength(4);
  });

  it("apply is idempotent — a second run finds one fewer orphan (the relinked one) and re-links nothing new", () => {
    runRepairOrphanedActuals({ mode: "apply" });
    const second = runRepairOrphanedActuals({ mode: "apply" });
    expect(second.totalOrphans).toBe(2);
    expect(second.relinked).toHaveLength(0);
    expect(second.written).toBe(0);
  });

  it("respects a custom windowHours option", () => {
    // Narrow window excludes the 9h-apart orphan-ghost-1/target-1 pairing.
    const report = runRepairOrphanedActuals({ mode: "dry-run", windowHours: 1 });
    const stillUnresolved = report.unresolved.find((u) => u.orphanEstimateId === "orphan-ghost-1");
    expect(stillUnresolved).toMatchObject({ candidateCount: 0, reason: "zero_candidates" });
  });

  it("rollback: restoring the backup returns feedback.jsonl byte-identical to pre-migration", () => {
    const before = readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8");
    const report = runRepairOrphanedActuals({ mode: "apply" });
    expect(report.backupPath).toBeTruthy();
    const backupContent = readFileSync(report.backupPath as string, "utf-8");
    expect(backupContent).toBe(before);
  });
});
