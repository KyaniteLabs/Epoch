import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
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
const RATIO_CONSISTENCY_TOLERANCE = 0.02;
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
const MIN_TELEMETRY_HOURS = MINIMUM_CALIBRATION_ACTUAL_HOURS;
/** Ceiling for transmitted hours — ~11 years of continuous work; larger values are unit mistakes or abuse. */
const MAX_TELEMETRY_HOURS = 100_000;
/** Records per submission payload (pre-existing wire limit). */
const MAX_RECORDS_PER_PAYLOAD = 100;
/**
 * Admitted (stored + quarantined) records allowed per installation_id.
 * Bounds a patient attacker spamming fresh installation IDs: each identity
 * is capped, making volume poisoning require observable identity churn.
 * Overridable for tests via EPOCH_TELEMETRY_RECEIVER_MAX_PER_INSTALLATION.
 */
const DEFAULT_MAX_RECORDS_PER_INSTALLATION = 10_000;
/**
 * Admitted records across ALL installations. Bounds total receiver growth
 * and the blast radius of any poisoning campaign.
 * Overridable for tests via EPOCH_TELEMETRY_RECEIVER_MAX_TOTAL.
 */
const DEFAULT_MAX_TOTAL_RECORDS = 1_000_000;

/** Quarantine reason for records admitted over the untrusted (integrity-only HMAC) receive path. */
const QUARANTINE_REASON_UNTRUSTED_SOURCE = "untrusted_integrity_only_source";
/** Quarantine reason for records whose provenance matches the smoke/synthetic patterns (soft check). */
const QUARANTINE_REASON_SMOKE_PROVENANCE = "smoke_provenance";

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

// ---------------------------------------------------------------------------
// Ticket 22 — receiver dedup/admissions served from memory.
//
// The receiver used to re-parse telemetry-record-keys.jsonl AND
// telemetry-receipts.jsonl on EVERY POST — O(history) work per request and a
// memory-amplification vector (each request allocated a fresh copy of the
// whole key set). Both are now process memos validated by a stat on every
// receive, the exact shape of ledger.ts's read cache:
//
//   key = (size, mtimeMs, ino)
//
// so our own appends (size changes), another process's writes, a rename-based
// rewrite (inode/mtime), or a deletion are always picked up on the next
// receive. THE FILES REMAIN THE SOURCE OF TRUTH — the memo is a per-receive
// validation, never a TTL cache. Crash safety: every admitted key (and every
// receipt) is appended to its file IMMEDIATELY on admit; after a crash the
// memo is simply empty and reloads from the files, so nothing admitted is
// ever forgotten and nothing rejected is ever remembered.
//
// Within one process, receiveTelemetry is synchronous end to end (no await
// between the dedup check and the append), so the single-threaded event loop
// makes check-and-add atomic per tick: two concurrent POSTs of the same
// record can never both admit — the second call cannot start until the first
// returns, by which point the key is in the set and in the file.
// ---------------------------------------------------------------------------

/** Stat facts used to validate a memo entry against the file it summarizes. */
interface StatFacts {
  size: number;
  mtimeMs: number;
  ino: string;
}

function statFacts(path: string): StatFacts | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: String(s.ino) };
  } catch {
    return null;
  }
}

function statMatches(a: StatFacts, b: StatFacts): boolean {
  return a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/** Memoized dedup key set, keyed by absolute key-file path (tests switch EPOCH_DATA_DIR per suite). */
const knownRecordKeysByPath = new Map<string, { stat: StatFacts; keys: Set<string> }>();
/** Memoized admission accounting, keyed by absolute receipts path. */
const admissionsByPath = new Map<string, { stat: StatFacts; admissions: Admissions }>();
/**
 * Cumulative count of full read+parse executions of the dedup key file per
 * absolute path (ticket 22 test instrumentation): proves a POST deduplicates
 * from memory (0 parses) instead of re-parsing the whole key file. A missing
 * file is not a parse. Never reset — tests snapshot deltas.
 */
const recordKeyParsesByPath = new Map<string, number>();

/** Parse-count snapshot for tests/observability (mirrors ledger.ts's getLedgerCacheStatus pattern). */
export function getReceiverRecordKeyParseCounts(): ReadonlyMap<string, number> {
  return new Map(recordKeyParsesByPath);
}

/** Read + parse the dedup key file. Missing file yields an empty set without counting a parse. */
function parseRecordKeys(path: string): Set<string> {
  if (!existsSync(path)) return new Set();
  recordKeyParsesByPath.set(path, (recordKeyParsesByPath.get(path) ?? 0) + 1);
  return new Set(readFileSync(path, "utf-8").split("\n").map((line) => line.trim()).filter(Boolean));
}

/**
 * The dedup key set for the current key file, from memory when the file is
 * unchanged since the last load/refresh (a stat, not a parse). The returned
 * Set is the memoized instance — callers mutate it on admit and then pass it
 * back to refreshRecordKeysMemo(), which re-attaches/updates the memo's stat
 * to match the file they just appended. (When the load ran while the file was
 * MISSING, no memo exists yet — the refresh then INSTALLS the mutated set,
 * so even the very first admit on a fresh receiver is followed by
 * parse-free receives.)
 */
function loadRecordKeys(): Set<string> {
  const path = recordKeysPath();
  const stat = statFacts(path);
  const memo = knownRecordKeysByPath.get(path);
  if (stat !== null && memo !== undefined && statMatches(memo.stat, stat)) return memo.keys;
  const keys = parseRecordKeys(path);
  if (stat !== null) knownRecordKeysByPath.set(path, { stat, keys });
  else knownRecordKeysByPath.delete(path);
  return keys;
}

/** Re-sync the key memo after this process appended keys: update the stat, or install the set when no memo exists yet. */
function refreshRecordKeysMemo(keys: Set<string>): void {
  const path = recordKeysPath();
  const stat = statFacts(path);
  if (stat === null) {
    knownRecordKeysByPath.delete(path);
    return;
  }
  const memo = knownRecordKeysByPath.get(path);
  if (memo !== undefined) memo.stat = stat;
  else knownRecordKeysByPath.set(path, { stat, keys });
}

/** Sum admitted (accepted + quarantined) records per installation from the receipt log. */
function parseAdmissions(path: string): Admissions {
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

/**
 * Admission accounting for the current receipts file, from memory when the
 * file is unchanged (a stat, not a parse). Caps (ticket 19) are computed from
 * this — same numbers the receipts re-parse produced, now without the
 * per-POST full-file read. The returned object is the memoized instance:
 * callers mutate it after appending a receipt, then pass it back to
 * refreshAdmissionsMemo().
 */
function loadAdmissions(): Admissions {
  const path = receiptPath();
  const stat = statFacts(path);
  const memo = admissionsByPath.get(path);
  if (stat !== null && memo !== undefined && statMatches(memo.stat, stat)) return memo.admissions;
  const admissions = parseAdmissions(path);
  if (stat !== null) admissionsByPath.set(path, { stat, admissions });
  else admissionsByPath.delete(path);
  return admissions;
}

/** Re-sync the admissions memo after this process appended a receipt (installs the memo on a previously missing file). */
function refreshAdmissionsMemo(admissions: Admissions): void {
  const path = receiptPath();
  const stat = statFacts(path);
  if (stat === null) {
    admissionsByPath.delete(path);
    return;
  }
  const memo = admissionsByPath.get(path);
  if (memo !== undefined) memo.stat = stat;
  else admissionsByPath.set(path, { stat, admissions });
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
  // Ticket 22: admissions come from the stat-validated in-memory accounting
  // (loadAdmissions above) — same numbers the per-POST receipts re-parse
  // produced, updated on admit at the bottom of this function.
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
  // Ticket 22: the in-memory (stat-validated) key set — O(1) set lookups per
  // record instead of a full-file re-parse per POST. Mutated on admit below;
  // refreshRecordKeysMemo() re-syncs the stat afterwards.
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

  // Ticket 22: keep the in-memory accounting consistent with the files this
  // receive just appended — the caps on the NEXT receive are computed from
  // this same object, so they stay exactly as tight as the receipts re-parse
  // made them (conservative whole-payload rejection included).
  const admittedThisReceive = accepted + quarantined;
  if (admittedThisReceive > 0) {
    admissions.total += admittedThisReceive;
    admissions.byInstallation.set(
      installationId,
      (admissions.byInstallation.get(installationId) ?? 0) + admittedThisReceive,
    );
  }
  refreshRecordKeysMemo(knownKeys);
  refreshAdmissionsMemo(admissions);

  return { ok: true, status: 200, accepted, deduplicated, quarantined };
}
