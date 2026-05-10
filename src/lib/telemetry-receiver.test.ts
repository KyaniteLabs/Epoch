import { createHmac } from "node:crypto";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = join(tmpdir(), `epoch-telemetry-receiver-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* ok */ }
});

function signedPayload(): { rawBody: string; signature: string } {
  const payload = {
    schema_version: 1,
    installation_id: "test-installation",
    epoch_version: "0.2.2-test",
    records: [
      {
        task_type: "feature",
        complexity: 3,
        tool: "reference_class_estimate",
        estimated_hours: 4,
        actual_hours: 5,
        ratio: 1.25,
        date: "2026-05-07",
        calibration_provenance: "prospective",
        calibration_usage: "correction",
      },
    ],
    generated_at: "2026-05-07T00:00:00.000Z",
  };
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", payload.installation_id).update(rawBody).digest("hex");
  return { rawBody, signature };
}

describe("receiveTelemetry", () => {
  it("accepts signed telemetry and stores anonymized records separately from aggregate receipts", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload();

    const result = receiveTelemetry(rawBody, signature);

    expect(result).toEqual({ ok: true, status: 200, accepted: 1, deduplicated: 0 });

    const recordsFile = join(TEST_DIR, "telemetry-records.jsonl");
    expect(existsSync(recordsFile)).toBe(true);
    const stored = JSON.parse(readFileSync(recordsFile, "utf-8").trim()) as Record<string, unknown>;
    expect(stored).toMatchObject({
      task_type: "feature",
      complexity: 3,
      tool: "reference_class_estimate",
      estimated_hours: 4,
      actual_hours: 5,
      ratio: 1.25,
      date: "2026-05-07",
      calibration_provenance: "prospective",
      calibration_usage: "correction",
    });
    expect(stored.received_at).toEqual(expect.any(String));
    expect(stored).not.toHaveProperty("installation_id");
    expect(stored).not.toHaveProperty("dedupe_key");

    const receiptFile = join(TEST_DIR, "telemetry-receipts.jsonl");
    expect(existsSync(receiptFile)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptFile, "utf-8").trim()) as Record<string, unknown>;
    expect(receipt.accepted).toBe(1);
    expect(receipt.deduplicated).toBe(0);
    expect(receipt.installationId).toBe("test-installation");
    expect(receipt).not.toHaveProperty("records");
  });

  it("deduplicates repeated records by installation without storing private identifiers with the shared records", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload();

    expect(receiveTelemetry(rawBody, signature)).toEqual({ ok: true, status: 200, accepted: 1, deduplicated: 0 });
    expect(receiveTelemetry(rawBody, signature)).toEqual({ ok: true, status: 200, accepted: 0, deduplicated: 1 });

    const storedRecords = readFileSync(join(TEST_DIR, "telemetry-records.jsonl"), "utf-8").trim().split("\n");
    expect(storedRecords).toHaveLength(1);
    const keyLines = readFileSync(join(TEST_DIR, "telemetry-record-keys.jsonl"), "utf-8").trim().split("\n");
    expect(keyLines).toHaveLength(1);
    expect(keyLines[0]).toMatch(/^[0-9a-f]{64}$/);

    const receipts = readFileSync(join(TEST_DIR, "telemetry-receipts.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(receipts).toMatchObject([
      { accepted: 1, deduplicated: 0 },
      { accepted: 0, deduplicated: 1 },
    ]);
  });

  it("rejects invalid signatures", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody } = signedPayload();

    const result = receiveTelemetry(rawBody, "0".repeat(64));

    expect(result.ok).toBe(false);
    expect(result.status).toBe(401);
    expect(result.error).toContain("signature");
  });
});
