import { createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(a) || !/^[0-9a-f]{64}$/i.test(b)) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

function isRecordArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
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
  const receipt: TelemetryReceipt = {
    receivedAt: new Date().toISOString(),
    installationId,
    schemaVersion,
    epochVersion,
    accepted: records.length,
    deduplicated: 0,
  };
  appendFileSync(receiptPath(), `${JSON.stringify(receipt)}\n`, "utf-8");

  return { ok: true, status: 200, accepted: records.length, deduplicated: 0 };
}

