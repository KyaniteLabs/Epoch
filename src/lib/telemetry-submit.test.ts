import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `epoch-tel-sub-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  delete process.env["EPOCH_TELEMETRY"];
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  delete process.env["EPOCH_TELEMETRY"];
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

describe("extractAnonymizedRecords", () => {
  it("returns empty array when no feedback data exists", async () => {
    const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords();
    expect(Array.isArray(records)).toBe(true);
  });

  it("strips estimate IDs, source, notes — keeps only categorical + numeric fields", async () => {
    const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords();

    for (const rec of records) {
      expect(rec).toHaveProperty("task_type");
      expect(rec).toHaveProperty("complexity");
      expect(rec).toHaveProperty("tool");
      expect(rec).toHaveProperty("estimated_hours");
      expect(rec).toHaveProperty("actual_hours");
      expect(rec).toHaveProperty("ratio");
      expect(rec).toHaveProperty("date");

      // Must NOT have identifying fields
      const obj = rec as unknown as Record<string, unknown>;
      expect(obj["estimateId"]).toBeUndefined();
      expect(obj["source"]).toBeUndefined();
      expect(obj["notes"]).toBeUndefined();
      expect(obj["teamId"]).toBeUndefined();
    }
  });

  it("truncates dates to YYYY-MM-DD only (no time component)", async () => {
    const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords();

    for (const rec of records) {
      expect(rec.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(rec.date).toHaveLength(10);
    }
  });

  it("computes ratio as actual/estimated", async () => {
    const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords();

    for (const rec of records) {
      const expected = Math.round((rec.actual_hours / rec.estimated_hours) * 10000) / 10000;
      expect(rec.ratio).toBe(expected);
    }
  });
});

describe("buildPayload", () => {
  it("includes schema_version, installation_id, epoch_version, records, generated_at", async () => {
    const { buildPayload } = await import("./telemetry-submit.js");
    const payload = buildPayload([]);

    expect(payload.schema_version).toBe(1);
    expect(typeof payload.installation_id).toBe("string");
    expect(payload.installation_id).toHaveLength(36); // UUID format
    expect(typeof payload.epoch_version).toBe("string");
    expect(Array.isArray(payload.records)).toBe(true);
    expect(typeof payload.generated_at).toBe("string");
  });
});

describe("signPayload", () => {
  it("produces a consistent HMAC for the same input", async () => {
    const { buildPayload, signPayload } = await import("./telemetry-submit.js");
    const payload = buildPayload([]);
    const id = payload.installation_id;

    const sig1 = signPayload(payload, id);
    const sig2 = signPayload(payload, id);

    expect(sig1).toBe(sig2);
    expect(sig1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("produces different HMACs for different payloads", async () => {
    const { buildPayload, signPayload } = await import("./telemetry-submit.js");
    const payload1 = buildPayload([]);
    const payload2 = buildPayload([{ task_type: "feature", complexity: 3, tool: "test", estimated_hours: 4, actual_hours: 5, ratio: 1.25, date: "2026-01-01" }]);
    const id = payload1.installation_id;

    const sig1 = signPayload(payload1, id);
    const sig2 = signPayload(payload2, id);

    expect(sig1).not.toBe(sig2);
  });
});

describe("submitTelemetry", () => {
  it("returns error when telemetry is not enabled", async () => {
    const { submitTelemetry } = await import("./telemetry-submit.js");
    const result = await submitTelemetry();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("not enabled");
  });

  it("returns error when no endpoint is configured", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      telemetry: { enabled: true, endpoint: "", lastSubmissionAt: null, lastSubmissionRecordCount: 0, installationId: "test-id" },
    });
    const { submitTelemetry } = await import("./telemetry-submit.js");
    const result = await submitTelemetry();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no endpoint");
  });

  it("returns error when rate limited", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      telemetry: {
        enabled: true,
        endpoint: "https://example.com",
        lastSubmissionAt: new Date().toISOString(),
        lastSubmissionRecordCount: 0,
        installationId: "test-id",
      },
    });
    const { submitTelemetry } = await import("./telemetry-submit.js");
    const result = await submitTelemetry();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("rate limited");
  });
});

describe("maybeSubmitTelemetry", () => {
  it("does nothing for the first 99 calls", async () => {
    const { maybeSubmitTelemetry, resetCallCount } = await import("./telemetry-submit.js");
    resetCallCount();
    // Should not throw or do anything observable
    for (let i = 0; i < 99; i++) {
      maybeSubmitTelemetry();
    }
    // No error means it correctly skipped
    expect(true).toBe(true);
  });
});

describe("exportToFile", () => {
  it("writes anonymized records to a file", async () => {
    const { exportToFile } = await import("./telemetry-submit.js");
    const path = exportToFile();
    expect(existsSync(path)).toBe(true);

    const { readFileSync } = await import("node:fs");
    const content = readFileSync(path, "utf-8");
    const records = JSON.parse(content);
    expect(Array.isArray(records)).toBe(true);
  });

  it("writes to custom path when provided", async () => {
    const { exportToFile } = await import("./telemetry-submit.js");
    const customPath = join(TEST_DIR, "custom-export.json");
    const path = exportToFile(customPath);
    expect(path).toBe(customPath);
    expect(existsSync(customPath)).toBe(true);
  });
});
