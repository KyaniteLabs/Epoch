import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runArchiveQuarantined } from "./archive-quarantined.js";
import { ESTIMATES_FILE, ACTUALS_FILE, FLAGS_FILE, LABELS_FILE, QUARANTINE_ARCHIVE_FILE } from "../ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-archive-quarantined-test-${Date.now()}`);

function writeLedger(): void {
  writeFileSync(
    join(TEST_DIR, ESTIMATES_FILE),
    [
      JSON.stringify({ id: "e1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-05-05T10:00:00.000Z" }),
      JSON.stringify({ id: "e2", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(TEST_DIR, ACTUALS_FILE),
    [
      JSON.stringify({ estimateId: "e1", actualHours: 10, reportedAt: "2026-05-05T20:00:00.000Z" }),
      JSON.stringify({ estimateId: "e2", actualHours: 6, reportedAt: "2026-06-02T20:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(TEST_DIR, FLAGS_FILE),
    JSON.stringify({ id: "e1", seq: 1, recordedAt: "2026-06-05T00:00:00.000Z", quarantined: true, reason: "backfill_signature_2026-05-05" }) + "\n",
  );
  writeFileSync(
    join(TEST_DIR, LABELS_FILE),
    [
      JSON.stringify({ id: "e1", seq: 1, recordedAt: "2026-06-05T00:00:00.000Z", taskLabel: "Should be GC'd with its row" }),
      JSON.stringify({ id: "e2", seq: 1, recordedAt: "2026-06-05T00:00:00.000Z", taskLabel: "Survives — its row stays hot" }),
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

describe("runArchiveQuarantined", () => {
  it("dry-run identifies the quarantined row and simulates before/after counts", () => {
    const report = runArchiveQuarantined({ mode: "dry-run", auditWindowConfirmed: false });
    expect(report.archivedCount).toBe(1);
    expect(report.sample).toEqual(["e1"]);
    expect(report.before).toEqual({ hotCount: 2, archiveCount: 0, total: 2 });
    expect(report.after).toEqual({ hotCount: 1, archiveCount: 1, total: 2 });
  });

  it("dry-run does not require --audit-window-confirmed and writes nothing", () => {
    expect(() => runArchiveQuarantined({ mode: "dry-run", auditWindowConfirmed: false })).not.toThrow();
    expect(existsSync(join(TEST_DIR, QUARANTINE_ARCHIVE_FILE))).toBe(false);
  });

  it("apply without --audit-window-confirmed throws and writes nothing", () => {
    expect(() => runArchiveQuarantined({ mode: "apply", auditWindowConfirmed: false })).toThrow(/audit-window-confirmed/);
    expect(existsSync(join(TEST_DIR, QUARANTINE_ARCHIVE_FILE))).toBe(false);
    const est = readFileSync(join(TEST_DIR, ESTIMATES_FILE), "utf-8").trim().split("\n");
    expect(est).toHaveLength(2);
  });

  it("apply with confirmation moves the row: conservation invariant holds (hot+archive constant)", () => {
    const report = runArchiveQuarantined({ mode: "apply", auditWindowConfirmed: true });
    expect(report.written).toBe(1);
    expect(report.before.total).toBe(report.after.total);
    expect(report.after).toEqual({ hotCount: 1, archiveCount: 1, total: 2 });

    const hot = readFileSync(join(TEST_DIR, ESTIMATES_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    const archive = readFileSync(join(TEST_DIR, QUARANTINE_ARCHIVE_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(hot.map((r: { id: string }) => r.id)).toEqual(["e2"]);
    expect(archive.map((r: { id: string }) => r.id)).toEqual(["e1"]);
  });

  it("apply GCs the matching flags/labels overlay records — no dangling overlays remain", () => {
    const report = runArchiveQuarantined({ mode: "apply", auditWindowConfirmed: true });
    expect(report.flagsGced).toBe(1);
    expect(report.labelsGced).toBe(1);

    const flags = readFileSync(join(TEST_DIR, FLAGS_FILE), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    const labels = readFileSync(join(TEST_DIR, LABELS_FILE), "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    expect(flags.some((f: { id: string }) => f.id === "e1")).toBe(false);
    // e2's label (a hot, non-archived row) survives — not a dangling overlay.
    expect(labels.map((l: { id: string }) => l.id)).toEqual(["e2"]);
  });

  it("feedback.jsonl (actuals) is never touched by archiving", () => {
    const before = readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8");
    runArchiveQuarantined({ mode: "apply", auditWindowConfirmed: true });
    expect(readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8")).toBe(before);
  });

  it("apply is idempotent — a second confirmed run archives nothing new", () => {
    runArchiveQuarantined({ mode: "apply", auditWindowConfirmed: true });
    const second = runArchiveQuarantined({ mode: "apply", auditWindowConfirmed: true });
    expect(second.archivedCount).toBe(0);
    expect(second.written).toBe(0);
    expect(second.before.total).toBe(2);
  });

  it("rollback: restoring all four printed backups returns byte-identical pre-migration state", () => {
    const preEst = readFileSync(join(TEST_DIR, ESTIMATES_FILE), "utf-8");
    const preFlags = readFileSync(join(TEST_DIR, FLAGS_FILE), "utf-8");
    const preLabels = readFileSync(join(TEST_DIR, LABELS_FILE), "utf-8");

    const report = runArchiveQuarantined({ mode: "apply", auditWindowConfirmed: true });
    expect(report.backupPaths.length).toBeGreaterThanOrEqual(3); // estimates + flags + labels (quarantine archive backup may be null pre-first-run)

    const estBackup = report.backupPaths.find((p) => p.includes(ESTIMATES_FILE) && !p.includes(QUARANTINE_ARCHIVE_FILE));
    const flagsBackup = report.backupPaths.find((p) => p.includes(FLAGS_FILE));
    const labelsBackup = report.backupPaths.find((p) => p.includes(LABELS_FILE));

    expect(estBackup && readFileSync(estBackup, "utf-8")).toBe(preEst);
    expect(flagsBackup && readFileSync(flagsBackup, "utf-8")).toBe(preFlags);
    expect(labelsBackup && readFileSync(labelsBackup, "utf-8")).toBe(preLabels);
  });
});
