import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  MAX_RATIO,
  MINIMUM_CALIBRATION_ACTUAL_HOURS,
  MIN_RATIO,
} from "./exclusion.js";
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

// ---------------------------------------------------------------------------
// Ticket 19 — receive-time trust boundary (statistical validation + labeled
// integrity). Until a receiver-side secret exists (deferred D2 infrastructure
// decision), the HMAC is integrity-only: the key (`installation_id`) travels
// IN the payload, so anyone can forge a "validly signed" submission. The
// receiver therefore (a) rejects statistically impossible payloads outright,
// (b) bounds magnitudes and admission volumes, and (c) quarantines every
// admitted record instead of merging it into the calibration store.
// ---------------------------------------------------------------------------

/**
 * Relative tolerance for `ratio ≈ actual_hours / estimated_hours`.
 * 2% comfortably covers the sender's 4-decimal ratio rounding for any
 * realistic hours magnitude; the half-cent hour-rounding interval below
 * covers the rest (see isRatioConsistent).
 */
export const RATIO_CONSISTENCY_TOLERANCE = 0.02;
/**
 * The sender rounds hours to 2 decimals, so the unrounded true ratio lies in
 * [(actual−0.005)/(estimated+0.005), (actual+0.005)/(estimated−0.005)]. The
 * consistency check accepts the claimed ratio anywhere in that interval
 * widened by RATIO_CONSISTENCY_TOLERANCE — no legitimate sender record is
 * rejected for rounding, while forged ratios (the audit's 1e8 fixture) are
 * off by orders of magnitude.
 */
const HOURS_ROUNDING_HALF_SPAN = 0.005;
/**
 * Floor for transmitted hours. Matches exclusion.ts's
 * MINIMUM_CALIBRATION_ACTUAL_HOURS — anything smaller is a microtask
 * artifact (or rounding noise) and never trains calibration math anyway.
 */
export const MIN_TELEMETRY_HOURS = MINIMUM_CALIBRATION_ACTUAL_HOURS;
/** Ceiling for transmitted hours — ~11 years of continuous work; larger values are unit mistakes or abuse. */
export const MAX_TELEMETRY_HOURS = 100_000;
/** Records per submission payload (pre-existing wire limit). */
export const MAX_RECORDS_PER_PAYLOAD = 100;
/**
 * Admitted (stored + quarantined) records allowed per installation_id.
 * Bounds a patient attacker spamming fresh installation IDs: each identity
 * is capped, making volume poisoning require observable identity churn.
 * Overridable for tests via EPOCH_TELEMETRY_RECEIVER_MAX_PER_INSTALLATION.
 */
export const DEFAULT_MAX_RECORDS_PER_INSTALLATION = 10_000;
/**
 * Admitted records across ALL installations. Bounds total receiver growth
 * and the blast radius of any poisoning campaign.
 * Overridable for tests via EPOCH_TELEMETRY_RECEIVER_MAX_TOTAL.
 */
export const DEFAULT_MAX_TOTAL_RECORDS = 1_000_000;

/** Quarantine reason for records admitted over the untrusted (integrity-only HMAC) receive path. */
export const QUARANTINE_REASON_UNTRUSTED_SOURCE = "untrusted_integrity_only_source";
/** Quarantine reason for records whose provenance matches the smoke/synthetic patterns (soft check). */
export const QUARANTINE_REASON_SMOKE_PROVENANCE = "smoke_provenance";

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
  /** Ticket 19: records admitted to the quarantine store (the merge path is closed until a trusted source exists). */
  quarantined: number;
}

export interface TelemetryReceiveResult {
  ok: boolean;
  status: 200 | 400 | 401;
  /** Records merged into the trusted store — always 0 while every receive path is untrusted. */
  accepted: number;
  deduplicated: number;
  /** Records admitted to the quarantine store by this request. */
  quarantined: number;
  error?: string;
}

/** Visible quarantine accounting for receiver status/health surfaces. */
export interface TelemetryQuarantineStatus {
  path: string;
  quarantinedRecords: number;
}

function dataDir(): string {
  return process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
}

function receiptPath(): string {
  return join(dataDir(), "telemetry-receipts.jsonl");
}

function quarantinePath(): string {
  return join(dataDir(), "telemetry-quarantine.jsonl");
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

/**
 * True when `ratio` is consistent with `actualHours / estimatedHours`:
 * within the interval implied by the sender's 2-decimal hour rounding,
 * widened by RATIO_CONSISTENCY_TOLERANCE. Shared with self-improve.ts so
 * legacy stored rows are held to the same receive-time standard.
 */
export function isRatioConsistent(
  estimatedHours: number,
  actualHours: number,
  ratio: number,
): boolean {
  if (
    !Number.isFinite(estimatedHours) ||
    !Number.isFinite(actualHours) ||
    !Number.isFinite(ratio) ||
    estimatedHours <= 0 ||
    ratio <= 0
  ) {
    return false;
  }
  const low =
    ((actualHours - HOURS_ROUNDING_HALF_SPAN) /
      (estimatedHours + HOURS_ROUNDING_HALF_SPAN)) /
    (1 + RATIO_CONSISTENCY_TOLERANCE);
  const high =
    ((actualHours + HOURS_ROUNDING_HALF_SPAN) /
      Math.max(estimatedHours - HOURS_ROUNDING_HALF_SPAN, 1e-9)) *
    (1 + RATIO_CONSISTENCY_TOLERANCE);
  return ratio >= low && ratio <= high;
}

/** Hard (reject-with-4xx) per-record statistical validation. Returns an error message or null. */
function validateRecordStatistics(record: AnonymizedRecord, index: number): string | null {
  if (record.estimated_hours < MIN_TELEMETRY_HOURS || record.estimated_hours > MAX_TELEMETRY_HOURS) {
    return `records[${index}]: estimated_hours ${record.estimated_hours} outside [${MIN_TELEMETRY_HOURS}, ${MAX_TELEMETRY_HOURS}]`;
  }
  if (record.actual_hours < MIN_TELEMETRY_HOURS || record.actual_hours > MAX_TELEMETRY_HOURS) {
    return `records[${index}]: actual_hours ${record.actual_hours} outside [${MIN_TELEMETRY_HOURS}, ${MAX_TELEMETRY_HOURS}]`;
  }
  if (record.ratio < MIN_RATIO || record.ratio > MAX_RATIO) {
    return `records[${index}]: ratio ${record.ratio} outside [${MIN_RATIO}, ${MAX_RATIO}] (exclusion.ts calibration bounds)`;
  }
  if (!isRatioConsistent(record.estimated_hours, record.actual_hours, record.ratio)) {
    const implied = record.actual_hours / record.estimated_hours;
    return `records[${index}]: ratio ${record.ratio} inconsistent with actual_hours/estimated_hours (expected ≈ ${Math.round(implied * 10000) / 10000} within ${Math.round(RATIO_CONSISTENCY_TOLERANCE * 100)}% + rounding)`;
  }
  return null;
}

function countNonNegative(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

interface Admissions {
  total: number;
  byInstallation: Map<string, number>;
}

/** Sum admitted (accepted + quarantined) records per installation from the receipt log. */
function loadAdmissions(): Admissions {
  const path = receiptPath();
  const byInstallation = new Map<string, number>();
  if (!existsSync(path)) return { total: 0, byInstallation };
  let total = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let receipt: unknown;
    try {
      receipt = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof receipt !== "object" || receipt === null) continue;
    const r = receipt as Record<string, unknown>;
    const installationId = typeof r["installationId"] === "string" ? r["installationId"] : null;
    const admitted = countNonNegative(r["accepted"]) + countNonNegative(r["quarantined"]);
    if (!installationId || admitted <= 0) continue;
    total += admitted;
    byInstallation.set(installationId, (byInstallation.get(installationId) ?? 0) + admitted);
  }
  return { total, byInstallation };
}

function maxRecordsPerInstallation(): number {
  const raw = process.env["EPOCH_TELEMETRY_RECEIVER_MAX_PER_INSTALLATION"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_RECORDS_PER_INSTALLATION;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_RECORDS_PER_INSTALLATION;
}

function maxTotalRecords(): number {
  const raw = process.env["EPOCH_TELEMETRY_RECEIVER_MAX_TOTAL"]?.trim();
  if (raw === undefined || raw === "") return DEFAULT_MAX_TOTAL_RECORDS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_MAX_TOTAL_RECORDS;
}

/**
 * Cumulative quarantine accounting, derived from the quarantine file (one
 * JSON line per quarantined record) so it survives restarts and needs no
 * separate counter state. Intended for the receiver status/health surface.
 */
export function getQuarantineStatus(): TelemetryQuarantineStatus {
  const path = quarantinePath();
  if (!existsSync(path)) return { path, quarantinedRecords: 0 };
  let quarantinedRecords = 0;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    if (line.trim()) quarantinedRecords += 1;
  }
  return { path, quarantinedRecords };
}

function loadRecordKeys(): Set<string> {
  const path = recordKeysPath();
  if (!existsSync(path)) return new Set();
  return new Set(readFileSync(path, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean));
}

function recordKey(installationId: string, record: AnonymizedRecord): string {
  return createHash("sha256").update(JSON.stringify({ installationId, record })).digest("hex");
}

function rejection(error: string, status: 400 | 401 = 400): TelemetryReceiveResult {
  return { ok: false, status, accepted: 0, deduplicated: 0, quarantined: 0, error };
}

export function receiveTelemetry(rawBody: string, signature: string | undefined): TelemetryReceiveResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return rejection("invalid JSON body");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return rejection("payload must be a JSON object");
  }
  const payload = parsed as Record<string, unknown>;

  const installationId = payload["installation_id"];
  const schemaVersion = payload["schema_version"];
  const epochVersion = payload["epoch_version"];
  const records = payload["records"];

  if (schemaVersion !== 1 && schemaVersion !== 2) {
    return rejection("unsupported schema_version");
  }
  const allowedTopLevel = schemaVersion === 2 ? V2_TOP_LEVEL_FIELDS : V1_TOP_LEVEL_FIELDS;
  if (!hasOnlyAllowedKeys(payload, allowedTopLevel)) {
    return rejection("payload contains disallowed fields");
  }
  if (typeof installationId !== "string" || installationId.length === 0) {
    return rejection("missing installation_id");
  }
  if (typeof epochVersion !== "string" || epochVersion.length === 0) {
    return rejection("missing epoch_version");
  }
  if (!isRecordArray(records)) {
    return rejection("records must be an array");
  }
  if (!records.every(isAnonymizedRecord)) {
    return rejection("records contain invalid anonymized telemetry fields");
  }
  if (records.length > MAX_RECORDS_PER_PAYLOAD) {
    return rejection(`too many records: ${records.length} exceeds ${MAX_RECORDS_PER_PAYLOAD} per payload`);
  }

  // Ticket 19 hard validation: statistical impossibility is rejected outright
  // (400, never stored) before any signature/cap work — a forged ratio or a
  // unit mistake can never reach even the quarantine store.
  for (let index = 0; index < records.length; index++) {
    const error = validateRecordStatistics(records[index] as AnonymizedRecord, index);
    if (error) return rejection(error);
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
      return rejection("client_name must be a string or null");
    }
    if (rawClientVersion !== undefined && !isNullableString(rawClientVersion)) {
      return rejection("client_version must be a string or null");
    }
    if (rawTransport !== undefined && rawTransport !== null && (typeof rawTransport !== "string" || !VALID_TRANSPORTS.has(rawTransport))) {
      return rejection("invalid transport");
    }
    if (rawRuntimeHint !== undefined && rawRuntimeHint !== null && (typeof rawRuntimeHint !== "string" || !VALID_RUNTIME_HINTS.has(rawRuntimeHint))) {
      return rejection("invalid runtime_hint");
    }
    clientName = (rawClientName as string | null | undefined) ?? null;
    clientVersion = (rawClientVersion as string | null | undefined) ?? null;
    transport = (rawTransport as string | null | undefined) ?? null;
    runtimeHint = (rawRuntimeHint as string | null | undefined) ?? null;
  }

  if (!signature) {
    return rejection("missing signature", 401);
  }

  const expected = createHmac("sha256", installationId).update(rawBody).digest("hex");
  if (!safeEqualHex(signature, expected)) {
    return rejection("invalid signature", 401);
  }

  // Admission caps (Ticket 19): bound per-installation and total volume. The
  // conservative estimate (records.length new admissions) is used so a payload
  // that would exceed a cap is rejected whole rather than partially stored.
  const admissions = loadAdmissions();
  const perInstallationCap = maxRecordsPerInstallation();
  const alreadyAdmitted = admissions.byInstallation.get(installationId) ?? 0;
  if (alreadyAdmitted + records.length > perInstallationCap) {
    return rejection(
      `per-installation record cap exceeded: ${alreadyAdmitted} already admitted for this installation_id, payload of ${records.length} would exceed ${perInstallationCap}`,
    );
  }
  const totalCap = maxTotalRecords();
  if (admissions.total + records.length > totalCap) {
    return rejection(
      `receiver total record cap exceeded: ${admissions.total} already admitted, payload of ${records.length} would exceed ${totalCap}`,
    );
  }

  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const receivedAt = new Date().toISOString();
  const knownKeys = loadRecordKeys();
  // Always 0 while every receive path is untrusted — the merge store
  // (telemetry-records.jsonl) receives nothing until a trusted source
  // exists. Kept as a mutable accumulator so a future trusted path can
  // increment it without touching this loop's structure.
  const accepted = 0;
  let deduplicated = 0;
  let quarantined = 0;

  for (const record of records) {
    const key = recordKey(installationId, record);
    if (knownKeys.has(key)) {
      deduplicated += 1;
      continue;
    }
    knownKeys.add(key);
    appendFileSync(recordKeysPath(), `${key}\n`, "utf-8");

    // Quarantine, not merge (Ticket 19): every current receive path is
    // untrusted — the HMAC is keyed by the in-payload installation_id, so a
    // valid signature proves only integrity, not provenance. Records go to
    // telemetry-quarantine.jsonl for operator review; telemetry-records.jsonl
    // (the file self-improvement's correction factors read) receives nothing
    // until a trusted receive path (receiver secret, deferred D2) exists.
    // Soft provenance checks quarantine with a specific reason; everything
    // else is quarantined as untrusted-source.
    const quarantineReason = record.tool === "receiver_smoke"
      ? QUARANTINE_REASON_SMOKE_PROVENANCE
      : QUARANTINE_REASON_UNTRUSTED_SOURCE;
    appendFileSync(
      quarantinePath(),
      `${JSON.stringify({
        ...record,
        received_at: receivedAt,
        quarantine_reason: quarantineReason,
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
    quarantined += 1;
  }

  const receipt: TelemetryReceipt = {
    receivedAt,
    installationId,
    schemaVersion,
    epochVersion,
    accepted,
    deduplicated,
    quarantined,
  };
  appendFileSync(receiptPath(), `${JSON.stringify(receipt)}\n`, "utf-8");

  return { ok: true, status: 200, accepted, deduplicated, quarantined };
}
