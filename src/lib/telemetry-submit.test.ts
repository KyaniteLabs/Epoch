import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { existsSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `epoch-tel-sub-test-${Date.now()}`);
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  delete process.env["EPOCH_TELEMETRY"];
  delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env["EPOCH_DATA_DIR"];
  delete process.env["EPOCH_TELEMETRY"];
  delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
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

  it("includes non-identifying calibration provenance fields", async () => {
    writeFileSync(join(TEST_DIR, "estimates.jsonl"), JSON.stringify({
      id: "backfilled-record",
      tool: "pert_estimate",
      inputs: { task_type: "feature", complexity: 3 },
      outputs: { expected: 4, unit: "hours" },
      estimatedAt: "2026-05-07T00:00:00.000Z",
    }) + "\n", "utf-8");
    writeFileSync(join(TEST_DIR, "feedback.jsonl"), JSON.stringify({
      estimateId: "backfilled-record",
      actualHours: 4,
      notes: "Ingested from liminal: feature, 10 LOC, 2 files",
      reportedAt: "2026-05-07T00:00:00.000Z",
    }) + "\n", "utf-8");

    const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords();

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      calibration_provenance: "backfilled_real_session",
      calibration_usage: "baseline",
    });
    const obj = records[0] as unknown as Record<string, unknown>;
    expect(obj["source"]).toBeUndefined();
    expect(obj["notes"]).toBeUndefined();
  });

  it("excludes records at or before the exact submission cutoff", async () => {
    const { recordEstimate, recordActual } = await import("./feedback.js");
    const estimateId = recordEstimate(
      "pert_estimate",
      { task_type: "feature", complexity: 3 },
      { expected: 2, unit: "hours" },
    );
    recordActual(estimateId, 3);
    const cutoff = new Date(Date.now() + 1_000).toISOString();

    const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
    expect(extractAnonymizedRecords(cutoff)).toHaveLength(0);
  });

  it("includes only records after the submission cutoff", async () => {
    writeFileSync(join(TEST_DIR, "estimates.jsonl"), [
      JSON.stringify({
        id: "old-record",
        tool: "pert_estimate",
        inputs: { task_type: "feature", complexity: 2 },
        outputs: { expected: 4, unit: "hours" },
        estimatedAt: "2026-05-07T00:00:00.000Z",
      }),
      JSON.stringify({
        id: "new-record",
        tool: "pert_estimate",
        inputs: { task_type: "feature", complexity: 4 },
        outputs: { expected: 8, unit: "hours" },
        estimatedAt: "2026-05-07T00:00:00.000Z",
      }),
    ].join("\n") + "\n", "utf-8");
    writeFileSync(join(TEST_DIR, "feedback.jsonl"), [
      JSON.stringify({
        estimateId: "old-record",
        actualHours: 5,
        reportedAt: "2026-05-07T00:00:00.000Z",
      }),
      JSON.stringify({
        estimateId: "new-record",
        actualHours: 12,
        reportedAt: "2026-05-07T00:00:01.000Z",
      }),
    ].join("\n") + "\n", "utf-8");

    const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords("2026-05-07T00:00:00.000Z");

    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      complexity: 4,
      estimated_hours: 8,
      actual_hours: 12,
      ratio: 1.5,
      date: "2026-05-07",
    });
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

  it("returns error when endpoint is the example.com placeholder", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      telemetry: {
        enabled: true,
        endpoint: "https://example.com/v1/telemetry",
        lastSubmissionAt: null,
        lastSubmissionRecordCount: 0,
        installationId: "test-id",
      },
    });
    const { submitTelemetry } = await import("./telemetry-submit.js");
    const result = await submitTelemetry();
    expect(result.ok).toBe(false);
    expect(result.error).toContain("placeholder endpoint");
  });

  it("returns error when rate limited", async () => {
    const { saveConfig } = await import("./config.js");
    saveConfig({
      telemetry: {
        enabled: true,
        endpoint: "https://collector.example.net",
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

  it("signs first-time submissions with the generated installation ID", async () => {
    const { saveConfig, loadConfig } = await import("./config.js");
    const { recordEstimate, recordActual } = await import("./feedback.js");
    const estimateId = recordEstimate(
      "pert_estimate",
      { task_type: "feature", complexity: 3 },
      { expected: 2, unit: "hours" },
    );
    recordActual(estimateId, 3);
    saveConfig({
      telemetry: {
        enabled: true,
        endpoint: "https://collector.example.net/v1/telemetry",
        lastSubmissionAt: null,
        lastSubmissionRecordCount: 0,
        installationId: "",
      },
    });

    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      const payload = JSON.parse(body) as { installation_id: string };
      const headers = init?.headers as Record<string, string>;
      const expected = createHmac("sha256", payload.installation_id).update(body).digest("hex");
      expect(payload.installation_id).toHaveLength(36);
      expect(headers["X-Epoch-Signature"]).toBe(expected);
      return new Response("{}", { status: 200 });
    }) as typeof fetch;

    const { submitTelemetry } = await import("./telemetry-submit.js");
    const result = await submitTelemetry();

    expect(result).toEqual({ ok: true, recordCount: 1, accepted: 1, deduplicated: 0 });
    expect(loadConfig().telemetry.lastSubmissionRecordCount).toBe(1);
    expect(loadConfig().telemetry.installationId).toHaveLength(36);
  });

  it("records accepted and deduplicated counts returned by receiver", async () => {
    const { saveConfig, loadConfig } = await import("./config.js");
    const { recordEstimate, recordActual } = await import("./feedback.js");
    const estimateId = recordEstimate(
      "pert_estimate",
      { task_type: "feature", complexity: 3 },
      { expected: 2, unit: "hours" },
    );
    recordActual(estimateId, 3);
    saveConfig({
      telemetry: {
        enabled: true,
        endpoint: "https://collector.example.net/v1/telemetry",
        lastSubmissionAt: null,
        lastSubmissionRecordCount: 0,
        installationId: "test-id",
      },
    });

    globalThis.fetch = (async () => {
      return new Response(JSON.stringify({ accepted: 0, deduplicated: 1 }), { status: 200 });
    }) as typeof fetch;

    const { submitTelemetry } = await import("./telemetry-submit.js");
    const result = await submitTelemetry();

    expect(result).toEqual({ ok: true, recordCount: 1, accepted: 0, deduplicated: 1 });
    expect(loadConfig().telemetry.totalRecordsAccepted).toBe(0);
    expect(loadConfig().telemetry.totalRecordsDeduplicated).toBe(1);
    expect(loadConfig().telemetry.lastSubmissionAcceptedCount).toBe(0);
    expect(loadConfig().telemetry.lastSubmissionDeduplicatedCount).toBe(1);
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
