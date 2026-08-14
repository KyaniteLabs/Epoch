import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { assertEstimateWritten } from "../test-support.js";

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
  it("extracts feedback, signs payload, quarantines received records, and deduplicates repeats", async () => {
    const { recordEstimate, recordActual } = await import("./feedback.js");
    const estimateId = recordEstimate(
      "reference_class_estimate",
      { task_type: "feature", complexity: 3 },
      { correctedEstimate: 4 },
    );
    assertEstimateWritten(estimateId);
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

    // Ticket 19: the receive path is untrusted (integrity-only HMAC), so
    // hard-valid records are quarantined — never merged into the store the
    // self-improvement correction factors read.
    const { receiveTelemetry, getQuarantineStatus } = await import("./telemetry-receiver.js");
    expect(receiveTelemetry(rawBody, signature)).toMatchObject({
      ok: true,
      accepted: 0,
      deduplicated: 0,
      quarantined: 1,
    });
    expect(receiveTelemetry(rawBody, signature)).toMatchObject({
      ok: true,
      accepted: 0,
      deduplicated: 1,
      quarantined: 0,
    });

    expect(existsSync(join(TEST_DIR, "telemetry-records.jsonl"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "telemetry-receipts.jsonl"))).toBe(true);
    const quarantined = readFileSync(join(TEST_DIR, "telemetry-quarantine.jsonl"), "utf8").trim().split("\n");
    expect(quarantined).toHaveLength(1);
    expect(getQuarantineStatus().quarantinedRecords).toBe(1);
  });
});
