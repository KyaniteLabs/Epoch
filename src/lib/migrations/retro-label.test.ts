import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runRetroLabelEstimates, deriveTaskLabel } from "./retro-label.js";
import { ESTIMATES_FILE, ACTUALS_FILE, LABELS_FILE } from "../ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-retro-label-test-${Date.now()}`);

function sha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeLedger(): void {
  writeFileSync(
    join(TEST_DIR, ESTIMATES_FILE),
    [
      JSON.stringify({ id: "e1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
      // Exact-match backfill signature — excluded, must not get labeled.
      JSON.stringify({ id: "e2", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-05-05T10:00:00.000Z" }),
      // No notes on the actual — nothing to label.
      JSON.stringify({ id: "e3", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-03T10:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(TEST_DIR, ACTUALS_FILE),
    [
      JSON.stringify({ estimateId: "e1", actualHours: 8, notes: "Initial project scaffolding: TypeScript toolchain", reportedAt: "2026-06-02T10:00:00.000Z" }),
      JSON.stringify({ estimateId: "e2", actualHours: 10, notes: "Real work done", reportedAt: "2026-05-05T20:00:00.000Z" }),
      JSON.stringify({ estimateId: "e3", actualHours: 6, reportedAt: "2026-06-04T10:00:00.000Z" }),
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

describe("deriveTaskLabel", () => {
  it("returns null for too-short notes", () => {
    expect(deriveTaskLabel(" a ")).toBeNull();
  });

  it("returns the trimmed notes verbatim when short enough", () => {
    expect(deriveTaskLabel("  Fixed the bug  ")).toBe("Fixed the bug");
  });

  it("truncates long notes on a word boundary with an ellipsis", () => {
    const long = "a".repeat(30) + " " + "b".repeat(60);
    const label = deriveTaskLabel(long);
    expect(label?.endsWith("…")).toBe(true);
    expect(label?.length).toBeLessThanOrEqual(82);
  });
});

describe("runRetroLabelEstimates", () => {
  it("labels only the confidently-matched (non-excluded) row with notes", () => {
    const report = runRetroLabelEstimates({ mode: "dry-run" });
    expect(report.candidateCount).toBe(1);
    expect(report.sample[0]).toMatchObject({ id: "e1", taskLabel: "Initial project scaffolding: TypeScript toolchain" });
  });

  it("skips the backfill-signature-excluded row even though it has notes", () => {
    const report = runRetroLabelEstimates({ mode: "dry-run" });
    expect(report.sample.some((c) => c.id === "e2")).toBe(false);
  });

  it("skips rows without notes", () => {
    const report = runRetroLabelEstimates({ mode: "dry-run" });
    expect(report.sample.some((c) => c.id === "e3")).toBe(false);
  });

  it("dry-run writes nothing", () => {
    const before = sha256(join(TEST_DIR, LABELS_FILE));
    runRetroLabelEstimates({ mode: "dry-run" });
    expect(sha256(join(TEST_DIR, LABELS_FILE))).toBe(before);
    expect(existsSync(join(TEST_DIR, LABELS_FILE))).toBe(false);
  });

  it("apply writes exactly one overlay label record and never touches estimates.jsonl", () => {
    const estBefore = sha256(join(TEST_DIR, ESTIMATES_FILE));
    const report = runRetroLabelEstimates({ mode: "apply" });
    expect(report.written).toBe(1);
    const labels = readFileSync(join(TEST_DIR, LABELS_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ id: "e1", taskLabel: "Initial project scaffolding: TypeScript toolchain" });
    expect(sha256(join(TEST_DIR, ESTIMATES_FILE))).toBe(estBefore);
  });

  it("apply is idempotent — a second run labels nothing new", () => {
    runRetroLabelEstimates({ mode: "apply" });
    const second = runRetroLabelEstimates({ mode: "apply" });
    expect(second.candidateCount).toBe(0);
    expect(second.written).toBe(0);
    const labels = readFileSync(join(TEST_DIR, LABELS_FILE), "utf-8").trim().split("\n");
    expect(labels).toHaveLength(1);
  });
});
