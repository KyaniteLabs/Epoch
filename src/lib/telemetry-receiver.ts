import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { AnonymizedRecord } from "./telemetry-submit.js";

const V1_TOP_LEVEL_FIELDS = new Set([
  "schema_version",
  "installation_id",
  "epoch_version",
  "records",
  "generated_at",
]);

const V2_TOP_LEVEL_FIELDS = new Set([
  ...V1_TOP_LEVEL_FIELDS,
  "client_name",
  "client_version",
  "transport",
  "runtime_hint",
]);

const RECORD_FIELDS = new Set([
  "task_type",
  "complexity",
  "tool",
  "estimated_hours",
  "actual_hours",
  "ratio",
  "date",
  "completed_at",
]);

const VALID_TRANSPORTS = new Set(["mcp-stdio", "mcp-http", "cli", "rest"]);
const VALID_RUNTIME_HINTS = new Set(["agent", "human", "unknown"]);

function hasOnlyAllowedKeys(obj: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(obj).every((key) => allowed.has(key));
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

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
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (!hasOnlyAllowedKeys(record, RECORD_FIELDS)) return false;
  return (
    typeof record["task_type"] === "string" &&
    record["task_type"].length > 0 &&
    (typeof record["complexity"] === "number" || record["complexity"] === null) &&
    typeof record["tool"] === "string" &&
    record["tool"].length > 0 &&
    typeof record["estimated_hours"] === "number" &&
    Number.isFinite(record["estimated_hours"]) &&
    typeof record["actual_hours"] === "number" &&
    Number.isFinite(record["actual_hours"]) &&
    typeof record["ratio"] === "number" &&
    Number.isFinite(record["ratio"]) &&
    typeof record["date"] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record["date"]) &&
    (record["completed_at"] === undefined || typeof record["completed_at"] === "string")
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "invalid JSON body" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "payload must be a JSON object" };
  }
  const payload = parsed as Record<string, unknown>;

  const installationId = payload["installation_id"];
  const schemaVersion = payload["schema_version"];
  const epochVersion = payload["epoch_version"];
  const records = payload["records"];

  if (schemaVersion !== 1 && schemaVersion !== 2) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "unsupported schema_version" };
  }
  const allowedTopLevel = schemaVersion === 2 ? V2_TOP_LEVEL_FIELDS : V1_TOP_LEVEL_FIELDS;
  if (!hasOnlyAllowedKeys(payload, allowedTopLevel)) {
    return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "payload contains disallowed fields" };
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

  let clientName: string | null = null;
  let clientVersion: string | null = null;
  let transport: string | null = null;
  let runtimeHint: string | null = null;
  if (schemaVersion === 2) {
    const rawClientName = payload["client_name"];
    const rawClientVersion = payload["client_version"];
    const rawTransport = payload["transport"];
    const rawRuntimeHint = payload["runtime_hint"];
    if (rawClientName !== undefined && !isNullableString(rawClientName)) {
      return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "client_name must be a string or null" };
    }
    if (rawClientVersion !== undefined && !isNullableString(rawClientVersion)) {
      return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "client_version must be a string or null" };
    }
    if (rawTransport !== undefined && rawTransport !== null && (typeof rawTransport !== "string" || !VALID_TRANSPORTS.has(rawTransport))) {
      return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "invalid transport" };
    }
    if (rawRuntimeHint !== undefined && rawRuntimeHint !== null && (typeof rawRuntimeHint !== "string" || !VALID_RUNTIME_HINTS.has(rawRuntimeHint))) {
      return { ok: false, status: 400, accepted: 0, deduplicated: 0, error: "invalid runtime_hint" };
    }
    clientName = (rawClientName as string | null | undefined) ?? null;
    clientVersion = (rawClientVersion as string | null | undefined) ?? null;
    transport = (rawTransport as string | null | undefined) ?? null;
    runtimeHint = (rawRuntimeHint as string | null | undefined) ?? null;
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
    appendFileSync(
      recordsPath(),
      `${JSON.stringify({
        ...record,
        received_at: receivedAt,
        ...(schemaVersion === 2
          ? {
              client_name: clientName,
              client_version: clientVersion,
              transport,
              runtime_hint: runtimeHint,
            }
          : {}),
      })}\n`,
      "utf-8",
    );
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
