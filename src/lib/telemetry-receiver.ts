import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AnonymizedRecord } from "./telemetry-submit.js";

export interface TelemetryReceipt {
  receivedAt: string;
  installationId: string;
  schemaVersion: number;
  epochVersion: string;
  accepted: number;
  deduplicated: number;
}

export interface TelemetryReceiveResult {
  ok: boolean;
  status: 200 | 400 | 401;
  accepted: number;
  deduplicated: number;
  error?: string;
}

function dataDir(): string {
  return process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
}

function receiptPath(): string {
  return join(dataDir(), "telemetry-receipts.jsonl");
}

function recordsPath(): string {
  return join(dataDir(), "telemetry-records.jsonl");
}

function recordKeysPath(): string {
  return join(dataDir(), "telemetry-record-keys.jsonl");
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isAnonymizedRecord(value: unknown): value is AnonymizedRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["task_type"] === "string" &&
    (typeof record["complexity"] === "number" || record["complexity"] === null) &&
    typeof record["tool"] === "string" &&
    typeof record["estimated_hours"] === "number" &&
    Number.isFinite(record["estimated_hours"]) &&
    typeof record["actual_hours"] === "number" &&
    Number.isFinite(record["actual_hours"]) &&
    typeof record["ratio"] === "number" &&
    Number.isFinite(record["ratio"]) &&
    typeof record["date"] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record["date"])
  );
}

function loadRecordKeys(): Set<string> {
  const path = recordKeysPath();
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean));
}

function recordKey(installationId: string, record: AnonymizedRecord): string {
  return createHash("sha256").update(JSON.stringify({ installationId, record })).digest("hex");
}

export function receiveTelemetry(rawBody: string, signature: string | undefined): TelemetryReceiveResult {
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "invalid JSON body" };
  }

  const installationId = payload["installation_id"];
  const schemaVersion = payload["schema_version"];
  const epochVersion = payload["epoch_version"];
  const records = payload["records"];

  if (schemaVersion !== 1) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "unsupported schema_version" };
  }
  if (typeof installationId !== "string" || installationId.length === 0) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "missing installation_id" };
  }
  if (typeof epochVersion !== "string" || epochVersion.length === 0) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "missing epoch_version" };
  }
  if (!isRecordArray(records)) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "records must be an array" };
  }
  if (!records.every(isAnonymizedRecord)) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "records contain invalid anonymized telemetry fields" };
  }
  if (records.length > 100) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "too many records" };
  }
  if (!signature) {
    return { ok: false, status: 401, accepted: 0, deduplicated: 0, error: "missing signature" };
  }

  const expected = createHmac("sha256", installationId).update(rawBody).digest("hex");
  if (!safeEqualHex(signature, expected)) {
    return { ok: false, status: 401, accepted: 0, deduplicated: 0, error: "invalid signature" };
  }

  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const receivedAt = new Date().toISOString();
  const knownKeys = loadRecordKeys();
  let accepted = 0;
  let deduplicated = 0;

  for (const record of records) {
    const key = recordKey(installationId, record);
    if (knownKeys.has(key)) {
      deduplicated += 1;
      continue;
    }
    knownKeys.add(key);
    appendFileSync(recordKeysPath(), `${key}\n`, "utf-8");
    appendFileSync(recordsPath(), `${JSON.stringify({ ...record, received_at: receivedAt })}\n`, "utf-8");
    accepted += 1;
  }

  const receipt: TelemetryReceipt = {
    receivedAt,
    installationId,
    schemaVersion,
    epochVersion,
    accepted,
    deduplicated,
  };
  appendFileSync(receiptPath(), `${JSON.stringify(receipt)}\n`, "utf-8");

  return { ok: true, status: 200, accepted, deduplicated };
}
