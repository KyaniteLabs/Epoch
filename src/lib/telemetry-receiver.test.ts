import { createHash, createHmac } from "node:crypto";
import { appendFileSync, existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const TEST_DIR = join(tmpdir(), `epoch-telemetry-receiver-test-${Date.now()}`);

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  delete process.env["EPOCH_TELEMETRY_RECEIVER_MAX_PER_INSTALLATION"];
  delete process.env["EPOCH_TELEMETRY_RECEIVER_MAX_TOTAL"];
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  delete process.env["EPOCH_TELEMETRY_RECEIVER_MAX_PER_INSTALLATION"];
  delete process.env["EPOCH_TELEMETRY_RECEIVER_MAX_TOTAL"];
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

function record(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    task_type: "feature",
    complexity: 3,
    tool: "reference_class_estimate",
    estimated_hours: 4,
    actual_hours: 5,
    ratio: 1.25,
    date: "2026-05-07",
    ...overrides,
  };
}

function readQuarantine(): Record<string, unknown>[] {
  const path = join(TEST_DIR, "telemetry-quarantine.jsonl");
  return readFileSync(path, "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("receiveTelemetry", () => {
  it("quarantines signed telemetry (untrusted path) instead of merging it into the shared records store", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload();

    const result = receiveTelemetry(rawBody, signature);

    expect(result).toEqual({ ok: true, status: 200, accepted: 0, deduplicated: 0, quarantined: 1 });

    // Nothing merged: the calibration store self-improvement reads is never written.
    expect(existsSync(join(TEST_DIR, "telemetry-records.jsonl"))).toBe(false);

    const quarantined = readQuarantine();
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0]).toMatchObject({
      task_type: "feature",
      complexity: 3,
      tool: "reference_class_estimate",
      estimated_hours: 4,
      actual_hours: 5,
      ratio: 1.25,
      date: "2026-05-07",
      quarantine_reason: "untrusted_integrity_only_source",
    });
    const firstQuarantined = quarantined[0] as Record<string, unknown>;
    expect(firstQuarantined["received_at"]).toEqual(expect.any(String));
    expect(firstQuarantined).not.toHaveProperty("installation_id");
    expect(firstQuarantined).not.toHaveProperty("dedupe_key");

    const receiptFile = join(TEST_DIR, "telemetry-receipts.jsonl");
    expect(existsSync(receiptFile)).toBe(true);
    const receipt = JSON.parse(readFileSync(receiptFile, "utf-8").trim()) as Record<string, unknown>;
    expect(receipt.accepted).toBe(0);
    expect(receipt.deduplicated).toBe(0);
    expect(receipt.quarantined).toBe(1);
    expect(receipt.installationId).toBe("test-installation");
    expect(receipt).not.toHaveProperty("records");
  });

  it("deduplicates repeated records by installation without storing private identifiers", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload();

    expect(receiveTelemetry(rawBody, signature)).toEqual({ ok: true, status: 200, accepted: 0, deduplicated: 0, quarantined: 1 });
    expect(receiveTelemetry(rawBody, signature)).toEqual({ ok: true, status: 200, accepted: 0, deduplicated: 1, quarantined: 0 });

    expect(readQuarantine()).toHaveLength(1);
    const keyLines = readFileSync(join(TEST_DIR, "telemetry-record-keys.jsonl"), "utf-8").trim().split("\n");
    expect(keyLines).toHaveLength(1);
    expect(keyLines[0]).toMatch(/^[0-9a-f]{64}$/);

    const receipts = readFileSync(join(TEST_DIR, "telemetry-receipts.jsonl"), "utf-8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(receipts).toMatchObject([
      { accepted: 0, deduplicated: 0, quarantined: 1 },
      { accepted: 0, deduplicated: 1, quarantined: 0 },
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

  it("accepts a schema_version 2 payload and stores agent-qualification fields on quarantined records", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({
      schema_version: 2,
      client_name: "claude-code",
      client_version: "1.2.3",
      transport: "mcp-stdio",
      runtime_hint: "agent",
    });

    const result = receiveTelemetry(rawBody, signature);
    expect(result).toEqual({ ok: true, status: 200, accepted: 0, deduplicated: 0, quarantined: 1 });

    expect(readQuarantine()[0]).toMatchObject({
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
      records: [record({ hostname: "leak.local" })],
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

  // -------------------------------------------------------------------------
  // Ticket 19 — receive-time statistical validation (hard rejects).
  // -------------------------------------------------------------------------

  it("rejects the audit's 1e8 forged-ratio fixture with a 400 and stores nothing", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    // Forge: plausible hours, absurd claimed ratio (the HMAC key travels in
    // the payload, so a "valid" signature proves nothing about this record).
    const { rawBody, signature } = signedPayload({
      records: [record({ ratio: 1e8 })],
    });

    const result = receiveTelemetry(rawBody, signature);

    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/ratio 100000000/);
    // Hard-validation failures are rejected outright — never stored anywhere,
    // not even the quarantine store.
    expect(existsSync(join(TEST_DIR, "telemetry-quarantine.jsonl"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "telemetry-record-keys.jsonl"))).toBe(false);
    expect(existsSync(join(TEST_DIR, "telemetry-receipts.jsonl"))).toBe(false);
  });

  it("rejects a ratio inconsistent with actual/estimated even when within [MIN_RATIO, MAX_RATIO]", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    // implied ratio 1.5 (5/3.3333...); claimed 1.0 is 33% off — inside the
    // exclusion bounds but statistically inconsistent with the payload hours.
    const { rawBody, signature } = signedPayload({
      records: [record({ estimated_hours: 3.33, actual_hours: 5, ratio: 1.0 })],
    });

    const result = receiveTelemetry(rawBody, signature);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/inconsistent with actual_hours\/estimated_hours/);
  });

  it("accepts a ratio just inside the consistency tolerance and rejects just outside it", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");

    // implied ratio = 1.5 exactly (150/100); the rounding interval is ±~0.02%
    // at this magnitude, so the acceptance band is ≈ [1.4703, 1.5302].
    const within = signedPayload({ records: [record({ estimated_hours: 100, actual_hours: 150, ratio: 1.52 })] });
    expect(receiveTelemetry(within.rawBody, within.signature)).toMatchObject({ ok: true, quarantined: 1 });

    const tooHigh = signedPayload({ records: [record({ estimated_hours: 100, actual_hours: 150, ratio: 1.55 })] });
    expect(receiveTelemetry(tooHigh.rawBody, tooHigh.signature)).toMatchObject({ ok: false, status: 400 });

    const tooLow = signedPayload({ records: [record({ estimated_hours: 100, actual_hours: 150, ratio: 1.4 })] });
    expect(receiveTelemetry(tooLow.rawBody, tooLow.signature)).toMatchObject({ ok: false, status: 400 });
  });

  it("accepts sender-rounded small-hours ratios (rounding interval, not a false positive)", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    // Sender stored est=0.104 -> transmitted 0.10, actual=0.2 -> 0.2, and
    // ratio from unrounded hours = round4(0.2/0.104) = 1.9231. The implied
    // ratio from transmitted hours is 2.0 — 4% off — but inside the 2-decimal
    // hour-rounding interval, so the record must be accepted.
    const { rawBody, signature } = signedPayload({
      records: [record({ estimated_hours: 0.1, actual_hours: 0.2, ratio: 1.9231 })],
    });

    expect(receiveTelemetry(rawBody, signature)).toMatchObject({ ok: true, quarantined: 1 });
  });

  it("enforces documented magnitude bounds on estimated_hours and actual_hours", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");

    const tooFewEst = signedPayload({ records: [record({ estimated_hours: 0.001, actual_hours: 5, ratio: 5000 })] });
    expect(receiveTelemetry(tooFewEst.rawBody, tooFewEst.signature)).toMatchObject({ ok: false, status: 400 });
    expect(receiveTelemetry(tooFewEst.rawBody, tooFewEst.signature).error).toMatch(/estimated_hours .* outside/);

    const tooMuchActual = signedPayload({ records: [record({ estimated_hours: 4, actual_hours: 500000, ratio: 4 })] });
    const tooMuchResult = receiveTelemetry(tooMuchActual.rawBody, tooMuchActual.signature);
    expect(tooMuchResult.ok).toBe(false);
    expect(tooMuchResult.status).toBe(400);
    expect(tooMuchResult.error).toMatch(/actual_hours 500000 outside/);

    // Bounds are inclusive: exactly at the floor/ceiling passes the magnitude
    // check (the ratio bounds below still apply independently).
    const atFloor = signedPayload({ records: [record({ estimated_hours: 0.01, actual_hours: 0.01, ratio: 1 })] });
    expect(receiveTelemetry(atFloor.rawBody, atFloor.signature)).toMatchObject({ ok: true, quarantined: 1 });
  });

  it("enforces the [MIN_RATIO, MAX_RATIO] bounds consistent with exclusion.ts", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");

    const overMax = signedPayload({ records: [record({ estimated_hours: 1, actual_hours: 100, ratio: 100 })] });
    expect(receiveTelemetry(overMax.rawBody, overMax.signature)).toMatchObject({ ok: false, status: 400 });
    expect(receiveTelemetry(overMax.rawBody, overMax.signature).error).toMatch(/ratio 100 outside \[0.03, 50\]/);

    const underMin = signedPayload({ records: [record({ estimated_hours: 100, actual_hours: 1, ratio: 0.01 })] });
    expect(receiveTelemetry(underMin.rawBody, underMin.signature)).toMatchObject({ ok: false, status: 400 });

    // Inclusive bounds, mirroring exclusion.ts ("a ratio of exactly 50x is kept").
    const atMax = signedPayload({ records: [record({ estimated_hours: 2, actual_hours: 100, ratio: 50 })] });
    expect(receiveTelemetry(atMax.rawBody, atMax.signature)).toMatchObject({ ok: true, quarantined: 1 });
  });

  it("rejects more than 100 records per payload", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const many = Array.from({ length: 101 }, () => record());
    const { rawBody, signature } = signedPayload({ records: many });

    const result = receiveTelemetry(rawBody, signature);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/too many records/);
  });

  it("enforces the per-installation admission cap", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    process.env["EPOCH_TELEMETRY_RECEIVER_MAX_PER_INSTALLATION"] = "3";

    // Two quarantined records admitted for this installation so far.
    const first = signedPayload({ records: [record({ date: "2026-05-01" }), record({ date: "2026-05-02" })] });
    expect(receiveTelemetry(first.rawBody, first.signature)).toMatchObject({ ok: true, quarantined: 2 });

    // A fresh installation is unaffected by the other identity's admissions.
    const other = signedPayload({ installation_id: "other-installation", records: [record()] });
    expect(receiveTelemetry(other.rawBody, other.signature)).toMatchObject({ ok: true, quarantined: 1 });

    // 2 already admitted for this installation + payload of 3 > cap of 3 -> whole-payload 400.
    const over = signedPayload({ records: [record({ date: "2026-05-03" }), record({ date: "2026-05-04" }), record({ date: "2026-05-05" })] });
    const result = receiveTelemetry(over.rawBody, over.signature);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/per-installation record cap exceeded/);
    // Quarantine still holds only the 2 records from install-a plus the 1
    // from the other installation — the over-cap payload stored nothing.
    expect(readQuarantine()).toHaveLength(3);
  });

  it("enforces the receiver-wide total admission cap across installations", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    process.env["EPOCH_TELEMETRY_RECEIVER_MAX_TOTAL"] = "3";

    const a = signedPayload({ installation_id: "install-a", records: [record({ date: "2026-05-01" }), record({ date: "2026-05-02" })] });
    expect(receiveTelemetry(a.rawBody, a.signature)).toMatchObject({ ok: true, quarantined: 2 });

    const b = signedPayload({ installation_id: "install-b", records: [record({ date: "2026-05-03" })] });
    expect(receiveTelemetry(b.rawBody, b.signature)).toMatchObject({ ok: true, quarantined: 1 });

    const c = signedPayload({ installation_id: "install-c", records: [record({ date: "2026-05-04" })] });
    const result = receiveTelemetry(c.rawBody, c.signature);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(400);
    expect(result.error).toMatch(/receiver total record cap exceeded/);
    // 3 admitted total, nothing further stored.
    expect(readQuarantine()).toHaveLength(3);
  });

  // -------------------------------------------------------------------------
  // Ticket 19 — quarantine accounting.
  // -------------------------------------------------------------------------

  it("quarantinedRecords counter increments and is exposed via getQuarantineStatus", async () => {
    const { receiveTelemetry, getQuarantineStatus } = await import("./telemetry-receiver.js");

    expect(getQuarantineStatus()).toEqual({
      path: join(TEST_DIR, "telemetry-quarantine.jsonl"),
      quarantinedRecords: 0,
    });

    const first = signedPayload({ records: [record({ date: "2026-05-01" })] });
    receiveTelemetry(first.rawBody, first.signature);
    expect(getQuarantineStatus().quarantinedRecords).toBe(1);

    const second = signedPayload({ records: [record({ date: "2026-05-02" }), record({ date: "2026-05-03" })] });
    receiveTelemetry(second.rawBody, second.signature);
    expect(getQuarantineStatus().quarantinedRecords).toBe(3);

    // Deduplicated re-sends do not inflate the counter.
    receiveTelemetry(second.rawBody, second.signature);
    expect(getQuarantineStatus().quarantinedRecords).toBe(3);

    // Rejected payloads do not either.
    const forged = signedPayload({ records: [record({ ratio: 1e8 })] });
    receiveTelemetry(forged.rawBody, forged.signature);
    expect(getQuarantineStatus().quarantinedRecords).toBe(3);
  });

  it("quarantines smoke-provenance records (receiver_smoke tool) with a distinct reason", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({
      records: [record({ tool: "receiver_smoke" })],
    });

    expect(receiveTelemetry(rawBody, signature)).toMatchObject({ ok: true, quarantined: 1 });
    expect(readQuarantine()[0]).toMatchObject({
      tool: "receiver_smoke",
      quarantine_reason: "smoke_provenance",
    });
  });

  // -------------------------------------------------------------------------
  // Ticket 22 — in-memory dedup + admissions (stat-validated memos; the files
  // stay the source of truth).
  // -------------------------------------------------------------------------

  it("deduplicates a repeated POST from memory — the key file is never re-parsed", async () => {
    const { receiveTelemetry, getReceiverRecordKeyParseCounts } = await import("./telemetry-receiver.js");
    const keyPath = join(TEST_DIR, "telemetry-record-keys.jsonl");
    const { rawBody, signature } = signedPayload({ installation_id: "memo-install" });

    expect(receiveTelemetry(rawBody, signature)).toMatchObject({ ok: true, quarantined: 1, deduplicated: 0 });
    // The admit CREATED the key file — a missing file is not a parse, and the
    // memo now carries the set + its stat.
    const parsesAfterFirst = getReceiverRecordKeyParseCounts().get(keyPath) ?? 0;
    expect(parsesAfterFirst).toBe(0);

    expect(receiveTelemetry(rawBody, signature)).toMatchObject({ ok: true, quarantined: 0, deduplicated: 1 });
    // Second POST served from the in-memory set: zero additional key-file parses.
    expect(getReceiverRecordKeyParseCounts().get(keyPath) ?? 0).toBe(parsesAfterFirst);
  });

  it("two rapid (concurrent) POSTs of the same record → exactly one admitted", async () => {
    const { receiveTelemetry } = await import("./telemetry-receiver.js");
    const { rawBody, signature } = signedPayload({ installation_id: "concurrent-install" });

    // Both calls issued back-to-back in the same tick. receiveTelemetry is
    // synchronous end to end (no await between the dedup check and the key
    // append), so the single-threaded event loop serializes them: the first
    // fully returns — key in the in-memory set AND in the file — before the
    // second starts. There is no interleaving point where both could admit.
    const results = [receiveTelemetry(rawBody, signature), receiveTelemetry(rawBody, signature)];

    expect(results.filter((r) => r.quarantined === 1)).toHaveLength(1);
    expect(results.filter((r) => r.deduplicated === 1 && r.quarantined === 0)).toHaveLength(1);
    // Exactly one key line and one quarantine row on disk — no double-admit.
    expect(readFileSync(join(TEST_DIR, "telemetry-record-keys.jsonl"), "utf-8").trim().split("\n")).toHaveLength(1);
    expect(readQuarantine()).toHaveLength(1);
  });

  it("the key file stays the source of truth: external appends dedupe, external deletions re-admit (stat revalidation)", async () => {
    const { receiveTelemetry, getReceiverRecordKeyParseCounts } = await import("./telemetry-receiver.js");
    const keyPath = join(TEST_DIR, "telemetry-record-keys.jsonl");
    const externalRecord = record({ date: "2026-06-01" });
    const external = signedPayload({ installation_id: "external-writer-install", records: [externalRecord] });

    // An "external writer" (another receiver process) appends the record's key
    // directly. Our memo sees the stat change, re-parses once, and the POST
    // deduplicates against the FILE's contents — not stale memory.
    const externalKey = createHash("sha256")
      .update(JSON.stringify({ installationId: "external-writer-install", record: externalRecord }))
      .digest("hex");
    appendFileSync(keyPath, `${externalKey}\n`, "utf-8");
    expect(receiveTelemetry(external.rawBody, external.signature)).toMatchObject({ ok: true, quarantined: 0, deduplicated: 1 });
    expect(getReceiverRecordKeyParseCounts().get(keyPath) ?? 0).toBe(1); // exactly one forced re-parse

    // An external deletion (crash + operator clearing the file): the memo
    // revalidates, finds nothing, and the record is admitted again — memory
    // never serves stale dedup after the file changed.
    rmSync(keyPath);
    expect(receiveTelemetry(external.rawBody, external.signature)).toMatchObject({ ok: true, quarantined: 1, deduplicated: 0 });
  });
});

describe("isRatioConsistent (shared with self-improve)", () => {
  it("is exported for the stored-record defense-in-depth path", async () => {
    const { isRatioConsistent } = await import("./telemetry-receiver.js");
    expect(isRatioConsistent(4, 5, 1.25)).toBe(true);
    expect(isRatioConsistent(4, 5, 1e8)).toBe(false);
    expect(isRatioConsistent(0, 5, 1)).toBe(false);
  });
});
