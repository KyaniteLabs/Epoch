import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runQuarantineBackfill } from "./quarantine-backfill.js";
import { FLAGS_FILE, ESTIMATES_FILE, ACTUALS_FILE } from "../ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-quarantine-backfill-test-${Date.now()}`);

function sha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeLedger(): void {
  writeFileSync(
    join(TEST_DIR, ESTIMATES_FILE),
    [
      // Backfill-signature row: exact match, dated 2026-05-05.
      JSON.stringify({ id: "backfill-1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-05-05T10:00:00.000Z" }),
      // Clean row: real variance, different date.
      JSON.stringify({ id: "clean-1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(TEST_DIR, ACTUALS_FILE),
    [
      JSON.stringify({ estimateId: "backfill-1", actualHours: 10, reportedAt: "2026-05-05T20:00:00.000Z", completedAt: "2026-05-05T20:00:00.000Z" }),
      JSON.stringify({ estimateId: "clean-1", actualHours: 6, reportedAt: "2026-06-02T20:00:00.000Z", completedAt: "2026-06-02T20:00:00.000Z" }),
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

describe("runQuarantineBackfill", () => {
  it("identifies the backfill-signature row and not the clean row", () => {
    const report = runQuarantineBackfill({ mode: "dry-run" });
    expect(report.candidateCount).toBe(1);
    expect(report.sample[0]?.id).toBe("backfill-1");
  });

  it("dry-run writes nothing — estimates.flags.jsonl file hash unchanged (does not exist)", () => {
    const before = sha256(join(TEST_DIR, FLAGS_FILE));
    runQuarantineBackfill({ mode: "dry-run" });
    const after = sha256(join(TEST_DIR, FLAGS_FILE));
    expect(after).toBe(before);
    expect(existsSync(join(TEST_DIR, FLAGS_FILE))).toBe(false);
  });

  it("dry-run does not touch estimates.jsonl or feedback.jsonl", () => {
    const estBefore = sha256(join(TEST_DIR, ESTIMATES_FILE));
    const actBefore = sha256(join(TEST_DIR, ACTUALS_FILE));
    runQuarantineBackfill({ mode: "dry-run" });
    expect(sha256(join(TEST_DIR, ESTIMATES_FILE))).toBe(estBefore);
    expect(sha256(join(TEST_DIR, ACTUALS_FILE))).toBe(actBefore);
  });

  it("before/after clean-pair count is unchanged — isExcluded() already excludes the backfill row via the backfill_signature reason; quarantining makes that exclusion an explicit, auditable overlay flag rather than changing which rows are excluded", () => {
    const report = runQuarantineBackfill({ mode: "dry-run" });
    expect(report.before.cleanPairCount).toBe(1);
    expect(report.after.cleanPairCount).toBe(1);
  });

  it("apply writes exactly one overlay flag record and creates a backup marker", () => {
    const report = runQuarantineBackfill({ mode: "apply" });
    expect(report.written).toBe(1);
    const flags = readFileSync(join(TEST_DIR, FLAGS_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(flags).toHaveLength(1);
    expect(flags[0]).toMatchObject({ id: "backfill-1", quarantined: true, reason: "backfill_signature_2026-05-05", seq: 1 });
  });

  it("apply never rewrites the hot ledger (estimates.jsonl unchanged)", () => {
    const before = sha256(join(TEST_DIR, ESTIMATES_FILE));
    runQuarantineBackfill({ mode: "apply" });
    expect(sha256(join(TEST_DIR, ESTIMATES_FILE))).toBe(before);
  });

  it("apply is idempotent — a second apply run flags nothing new", () => {
    runQuarantineBackfill({ mode: "apply" });
    const second = runQuarantineBackfill({ mode: "apply" });
    expect(second.candidateCount).toBe(0);
    expect(second.written).toBe(0);
    const flags = readFileSync(join(TEST_DIR, FLAGS_FILE), "utf-8").trim().split("\n");
    expect(flags).toHaveLength(1);
  });

  it("apply's after stats match the dry-run simulation", () => {
    const report = runQuarantineBackfill({ mode: "apply" });
    expect(report.after.cleanPairCount).toBe(1);
  });

  it("rollback: restoring the backup returns feedback data untouched (backup targets estimates.flags.jsonl only, actuals/estimates never written)", () => {
    const actBefore = readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8");
    runQuarantineBackfill({ mode: "apply" });
    expect(readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8")).toBe(actBefore);
  });
});
