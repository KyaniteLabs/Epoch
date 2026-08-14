// ---------------------------------------------------------------------------
// Tests for src/lib/data-status.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEpochDataPaths, getEpochDataStatus } from "./data-status.js";
import { readLines, resetLedgerReadCache, ESTIMATES_FILE, type EstimateRecord } from "./ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-data-status-test-${Date.now()}`);

beforeAll(() => {
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  // Clean test dir between tests but keep it alive
  try { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }); } catch { /* ok */ }
});

afterAll(() => {
  delete process.env["EPOCH_DATA_DIR"];
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

// ---- getEpochDataPaths ------------------------------------------------------

describe("getEpochDataPaths", () => {
  it("returns correct paths with EPOCH_DATA_DIR", () => {
    const paths = getEpochDataPaths();
    expect(paths.dataDir).toBe(TEST_DIR);
    expect(paths.config).toBe(join(TEST_DIR, "config.json"));
    expect(paths.estimates).toBe(join(TEST_DIR, "estimates.jsonl"));
    expect(paths.actuals).toBe(join(TEST_DIR, "feedback.jsonl"));
    expect(paths.toolTelemetry).toBe(join(TEST_DIR, "telemetry.jsonl"));
    expect(paths.referenceDatabase).toBe(join(TEST_DIR, "reference-database.json"));
    expect(paths.exportsDir).toBe(join(TEST_DIR, "exports"));
    expect(paths.receiverRecords).toBe(join(TEST_DIR, "telemetry-records.jsonl"));
    expect(paths.receiverReceipts).toBe(join(TEST_DIR, "telemetry-receipts.jsonl"));
    expect(paths.receiverDedupeKeys).toBe(join(TEST_DIR, "telemetry-record-keys.jsonl"));
  });

  it("does not create any files", () => {
    getEpochDataPaths();
    // Data dir exists from beforeAll, but no data files should be created
    expect(existsSync(join(TEST_DIR, "config.json"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "estimates.jsonl"))).toBe(false);
  });
});

// ---- getEpochDataStatus -----------------------------------------------------

describe("getEpochDataStatus", () => {
  it("works with empty data dir", () => {
    const status = getEpochDataStatus();
    expect(status.dataDir).toBe(TEST_DIR);
    expect(status.exists).toBe(true);
    expect(status.machine.hostname).toBeTruthy();
    expect(status.machine.platform).toBe(process.platform);
    expect(status.machine.arch).toBe(process.arch);
    expect(status.files.estimates.exists).toBe(false);
    expect(status.files.estimates.lines).toBe(0);
    expect(status.files.actuals.exists).toBe(false);
    expect(status.files.actuals.lines).toBe(0);
    expect(status.files.toolTelemetry.exists).toBe(false);
    expect(status.files.receiverRecords.exists).toBe(false);
    expect(status.feedback.totalEstimates).toBe(0);
    expect(status.feedback.totalActuals).toBe(0);
    expect(status.feedback.matchedPairs).toBe(0);
    expect(status.feedback.matchRate).toBe(0);
    expect(status.telemetry.enabled).toBe(false);
    expect(status.telemetry.endpointConfigured).toBe(false);
    expect(status.roleHints.hasReceiverRecords).toBe(false);
    expect(status.roleHints.likelyReceiver).toBe(false);
  });

  it("counts valid JSONL lines correctly", () => {
    writeFileSync(
      join(TEST_DIR, "estimates.jsonl"),
      JSON.stringify({ id: "1", tool: "pert", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }) + "\n" +
      JSON.stringify({ id: "2", tool: "pert", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }) + "\n",
    );
    writeFileSync(
      join(TEST_DIR, "feedback.jsonl"),
      JSON.stringify({ estimateId: "1", actualHours: 5, reportedAt: "2026-01-02T00:00:00Z" }) + "\n",
    );

    const status = getEpochDataStatus();
    expect(status.files.estimates.exists).toBe(true);
    expect(status.files.estimates.lines).toBe(2);
    expect(status.files.actuals.exists).toBe(true);
    expect(status.files.actuals.lines).toBe(1);
    expect(status.feedback.totalEstimates).toBe(2);
    expect(status.feedback.totalActuals).toBe(1);
    expect(status.feedback.matchedPairs).toBe(1);
    expect(status.feedback.matchRate).toBe(50);
  });

  it("handles malformed JSONL lines gracefully", () => {
    writeFileSync(
      join(TEST_DIR, "estimates.jsonl"),
      "not-json\n" +
      JSON.stringify({ id: "1", tool: "pert", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }) + "\n",
    );
    writeFileSync(
      join(TEST_DIR, "feedback.jsonl"),
      "also-not-json\n",
    );

    const status = getEpochDataStatus();
    expect(status.files.estimates.lines).toBe(2); // counts non-empty lines
    expect(status.feedback.totalEstimates).toBe(2);
    expect(status.feedback.totalActuals).toBe(1);
    // matched pairs should not crash
    expect(status.feedback.matchedPairs).toBe(0);
  });

  it("counts receiver files when present", () => {
    writeFileSync(
      join(TEST_DIR, "telemetry-records.jsonl"),
      JSON.stringify({ id: "r1" }) + "\n" +
      JSON.stringify({ id: "r2" }) + "\n",
    );
    writeFileSync(
      join(TEST_DIR, "telemetry-receipts.jsonl"),
      JSON.stringify({ id: "rc1" }) + "\n",
    );

    const status = getEpochDataStatus();
    expect(status.files.receiverRecords.exists).toBe(true);
    expect(status.files.receiverRecords.lines).toBe(2);
    expect(status.files.receiverReceipts.exists).toBe(true);
    expect(status.files.receiverReceipts.lines).toBe(1);
    expect(status.roleHints.hasReceiverRecords).toBe(true);
    expect(status.roleHints.likelyReceiver).toBe(true);
  });

  it("shows telemetry config status safely", () => {
    const status = getEpochDataStatus();
    expect(typeof status.telemetry.enabled).toBe("boolean");
    expect(typeof status.telemetry.endpointConfigured).toBe("boolean");
    expect(typeof status.telemetry.queuedRecords).toBe("number");
  });

  it("shows reference database status", () => {
    const status = getEpochDataStatus();
    expect(typeof status.referenceDatabase.loaded).toBe("boolean");
    // Even without a local reference DB, the bundled one loads
    expect(status.referenceDatabase.loaded).toBe(true);
    expect(status.referenceDatabase.sampleSize).toBeTruthy();
  });

  it("works with a non-existent data dir", () => {
    delete process.env["EPOCH_DATA_DIR"];
    process.env["EPOCH_DATA_DIR"] = join(tmpdir(), `epoch-nonexistent-${Date.now()}`);
    const status = getEpochDataStatus();
    expect(status.exists).toBe(false);
    expect(status.files.estimates.exists).toBe(false);
    delete process.env["EPOCH_DATA_DIR"];
    process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  });

  // ---- ledger read-cache provenance (ticket 17) ----

  it("surfaces ledger cache provenance; data_status's own corruptLines read is the first parse (ticket 18)", () => {
    resetLedgerReadCache();
    writeFileSync(
      join(TEST_DIR, "estimates.jsonl"),
      JSON.stringify({ id: "1", tool: "pert", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }) + "\n",
    );

    // Ticket 18 changed the cold behavior: data_status forces one ledger.ts
    // read so the corruptLines count is always current — so the FIRST status
    // call already shows exactly one parse and a non-null parsedAt.
    const cold = getEpochDataStatus();
    expect(cold.files.estimates.parses).toBe(1);
    expect(cold.files.estimates.parsedAt).not.toBeNull();
    expect(typeof cold.files.estimates.parsedAt).toBe("number");
    expect(cold.files.estimates.cacheAgeMs).toBeGreaterThanOrEqual(0);
    expect(cold.files.estimates.corruptLines).toBe(0);

    // A second status call is served by the stat-validated cache (no re-parse).
    const second = getEpochDataStatus();
    expect(second.files.estimates.parses).toBe(1);

    // Explicit ledger reads add no further parses either.
    readLines<EstimateRecord>(ESTIMATES_FILE);
    readLines<EstimateRecord>(ESTIMATES_FILE);
    const warm = getEpochDataStatus();
    expect(warm.files.estimates.parses).toBe(1);
    // Non-ledger files keep the plain shape (no cache fields asserted there).
    expect(warm.files.toolTelemetry.exists).toBe(false);
  });

  // ---- ticket 18: corruptLines + advisory write-lock surface ----

  it("counts a torn last line in corruptLines (estimates and actuals independently)", () => {
    resetLedgerReadCache();
    writeFileSync(
      join(TEST_DIR, "estimates.jsonl"),
      JSON.stringify({ id: "1", tool: "pert", inputs: {}, outputs: {}, estimatedAt: "2026-01-01T00:00:00Z" }) + "\n" +
      '{"id":"2","tool":"trunc', // torn tail — no newline, no closing brace
    );
    writeFileSync(
      join(TEST_DIR, "feedback.jsonl"),
      "garbage-not-json\n" +
      JSON.stringify({ estimateId: "1", actualHours: 5, reportedAt: "2026-01-02T00:00:00Z" }) + "\n",
    );

    const status = getEpochDataStatus();
    expect(status.files.estimates.corruptLines).toBe(1);
    expect(status.files.actuals.corruptLines).toBe(1);
    // The corrupt line still counts as a line (skip semantics unchanged).
    expect(status.files.estimates.lines).toBe(2);
    // A corrupt estimate id can never join — matchedPairs unaffected.
    expect(status.feedback.matchedPairs).toBe(1);
  });

  it("surfaces advisory write-lock state with the documented recovery path (ticket 18)", () => {
    // No locks held: absent, not stale, recovery text still documents removal.
    const clean = getEpochDataStatus();
    expect(clean.writeLocks.estimates.present).toBe(false);
    expect(clean.writeLocks.estimates.stale).toBe(false);
    expect(clean.writeLocks.estimates.recovery).toContain(".lock");

    // Fresh lock owned by THIS live process: present, not stale.
    writeFileSync(
      join(TEST_DIR, "feedback.jsonl.lock"),
      JSON.stringify({ owner: "test", pid: process.pid, acquiredAt: new Date().toISOString(), token: "t-1" }) + "\n",
    );
    const held = getEpochDataStatus();
    expect(held.writeLocks.actuals.present).toBe(true);
    expect(held.writeLocks.actuals.pid).toBe(process.pid);
    expect(held.writeLocks.actuals.stale).toBe(false);
    expect(held.writeLocks.actuals.recovery).toContain(`PID ${process.pid}`);

    // Stale fixture: dead PID + old mtime → stale: true, surfaced for removal.
    const old = new Date(Date.now() - 120_000);
    writeFileSync(
      join(TEST_DIR, "estimates.jsonl.lock"),
      JSON.stringify({ owner: "dead-process", pid: 999_999_999, acquiredAt: old.toISOString(), token: "t-2" }) + "\n",
    );
    utimesSync(join(TEST_DIR, "estimates.jsonl.lock"), old, old);
    const stale = getEpochDataStatus();
    expect(stale.writeLocks.estimates.present).toBe(true);
    expect(stale.writeLocks.estimates.stale).toBe(true);
    expect(stale.writeLocks.estimates.recovery).toContain("Stale write lock");
  });
});
