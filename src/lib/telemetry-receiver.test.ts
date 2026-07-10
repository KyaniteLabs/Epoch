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

function signedPayload(overrides: Record<string, unknown> = {}): { rawBody: string; signature: string } {
  const payload: Record<string, unknown> = {
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
      },
    ],
    generated_at: "2026-05-07T00:00:00.000Z",
    ...overrides,
  };
  const rawBody = JSON.stringify(payload);
  const signature = createHmac("sha256", payload["installation_id"] as string).update(rawBody).digest("hex");
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

  it("accepts a schema_version 2 payload and stores agent-qualification fields", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({
      schema_version: 2,
      client_name: "claude-code",
      client_version: "1.2.3",
      transport: "mcp-stdio",
      runtime_hint: "agent",
    });

    const result = receiveTelemetry(rawBody, signature);
    expect(result).toEqual({ ok: true, status: 200, accepted: 1, deduplicated: 0 });

    const stored = JSON.parse(
      readFileSync(join(TEST_DIR, "telemetry-records.jsonl"), "utf-8").trim(),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({
      client_name: "claude-code",
      client_version: "1.2.3",
      transport: "mcp-stdio",
      runtime_hint: "agent",
    });
  });

  it("rejects a v1 payload carrying v2-only fields (schema pinning)", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({ client_name: "claude-code" });

    const result = receiveTelemetry(rawBody, signature);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/disallowed fields/);
  });

  it("rejects an unknown top-level field regardless of schema version", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({
      schema_version: 2,
      unexpected_field: "leak",
    });

    const result = receiveTelemetry(rawBody, signature);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/disallowed fields/);
  });

  it("rejects an unknown record-level field (privacy allowlist)", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({
      records: [
        {
          task_type: "feature",
          complexity: 3,
          tool: "reference_class_estimate",
          estimated_hours: 4,
          actual_hours: 5,
          ratio: 1.25,
          date: "2026-05-07",
          hostname: "leak.local",
        },
      ],
    });

    const result = receiveTelemetry(rawBody, signature);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/invalid anonymized/);
  });

  it("rejects an unsupported schema_version", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({ schema_version: 3 });

    const result = receiveTelemetry(rawBody, signature);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/schema_version/);
  });
});
