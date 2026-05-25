import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(tmpdir(), `epoch-telemetry-e2e-${process.pid}`);

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("telemetry ingestion end to end", () => {
  it("extracts feedback, signs payload, receives records, and deduplicates repeats", async () => {
    const { recordEstimate, recordActual } = await import("./feedback.js");
    const estimateId = recordEstimate(
      "reference_class_estimate",
      { task_type: "feature", complexity: 3 },
      { correctedEstimate: 4 },
    );
    expect(recordActual(estimateId, 5)).toBe(true);

    const { buildPayload, extractAnonymizedRecords, signPayload } = await import("./telemetry-submit.js");
    const records = extractAnonymizedRecords();
    expect(records).toHaveLength(1);

    const payload = buildPayload(records);
    const rawBody = JSON.stringify(payload);
    const signature = signPayload(payload, payload.installation_id);
    expect(signature).toBe(
      createHmac("sha256", payload.installation_id).update(rawBody).digest("hex"),
    );

    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    expect(receiveTelemetry(rawBody, signature)).toMatchObject({
      ok: true,
      accepted: 1,
      deduplicated: 0,
    });
    expect(receiveTelemetry(rawBody, signature)).toMatchObject({
      ok: true,
      accepted: 0,
      deduplicated: 1,
    });

    const stored = readFileSync(join(TEST_DIR, "telemetry-records.jsonl"), "utf8").trim().split("\n");
    expect(stored).toHaveLength(1);
    expect(existsSync(join(TEST_DIR, "telemetry-receipts.jsonl"))).toBe(true);
  });
});
