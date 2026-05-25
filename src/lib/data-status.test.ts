// ---------------------------------------------------------------------------
// Tests for src/lib/data-status.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getEpochDataPaths, getEpochDataStatus } from "./data-status.js";

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
});
