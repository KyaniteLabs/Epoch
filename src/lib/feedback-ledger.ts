/** Ledger store for the feedback pipeline (split from feedback.ts, L6).

    Owns estimate/tool-call ingest, dedup, the JSONL append primitives and
    dry-run file routing. Analytics and the health report build on this. */
import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readLines, dataDir, withLedgerWriteLock, ESTIMATES_FILE, ACTUALS_FILE, CURRENT_BASIS_VERSION, LedgerLockTimeoutError, LedgerLockUnavailableError } from "./ledger.js";
import { stringField } from "./feedback-analytics.js";
import type { EstimateRecord, ActualRecord } from "./ledger.js";
import { canonicalizeToolName } from "./tool-aliases.js";
import { debugLog } from "./internal/logging.js";

export type { EstimateRecord, ActualRecord };

const DEFAULT_PENDING_TTL_DAYS = 30;

/** Resolve the pending-estimate TTL (days) from env, falling back to the default. */
function pendingTtlDays(): number {
  const raw = process.env["EPOCH_PENDING_TTL_DAYS"];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PENDING_TTL_DAYS;
}

/**
 * Dedup get-or-create window, in minutes (Phase 4, Pre-mortem Scenario 3).
 * Unset (default) = feature OFF: recordEstimate() always mints a new row,
 * byte-identical to pre-Phase-4 behavior. Set via EPOCH_DEDUP_WINDOW.
 */
function dedupWindowMinutes(): number | null {
  const raw = process.env["EPOCH_DEDUP_WINDOW"];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Count of recordEstimate() calls that reused an existing pending estimate
 * instead of appending a new row (dedup-hit counter, plan §4 Observability).
 * Process-lifetime counter, not persisted — mirrors self-improve.ts's
 * in-memory callCounter pattern.
 */
let dedupHitCount = 0;

/** Number of dedup hits since process start. Exposed for tests/observability. */
export function getDedupHitCount(): number {
  return dedupHitCount;
}

/** Deterministic signature over an estimate's inputs, used to match "identical" dedup calls regardless of key order. */
function inputsSignature(inputs: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(inputs));
}

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeysDeep(v)]));
  }
  return value;
}

/**
 * Find a single pending estimate to reuse for a dedup get-or-create call
 * (Phase 4, Pre-mortem Scenario 3): same canonical tool + same normalized
 * inputs signature + same session_id, estimated within the dedup window,
 * and still pending (no matched actual, not TTL-expired).
 *
 * Ambiguity is never guessed — mirrors the Phase 2 orphan re-link policy
 * ("exactly one candidate ⇒ relink; zero or >1 ⇒ never guess"): zero or
 * multiple candidates both fall through to minting a new row.
 */
function findDedupMatch(
  canonicalTool: string,
  inputs: Record<string, unknown>,
  sessionId: string,
  windowMinutes: number,
  estimatesFile: string,
  actualsFile: string,
): string | null {
  const signature = inputsSignature(inputs);
  const cutoffMs = Date.now() - windowMinutes * 60_000;
  const nowMs = Date.now();
  const estimates = readLines<EstimateRecord>(estimatesFile);
  const actualIds = new Set(readLines<ActualRecord>(actualsFile).map((a) => a.estimateId));

  const candidates = estimates.filter((e) => {
    if (actualIds.has(e.id)) return false; // must still be pending
    if ((canonicalizeToolName(e.tool) ?? e.tool) !== canonicalTool) return false;
    if (stringField(e.inputs["session_id"]) !== sessionId) return false;
    if (inputsSignature(e.inputs) !== signature) return false;
    const estimatedAtMs = Date.parse(e.estimatedAt);
    if (!Number.isFinite(estimatedAtMs) || estimatedAtMs < cutoffMs) return false;
    if (e.expiresAt) {
      const expiresMs = Date.parse(e.expiresAt);
      if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return false;
    }
    return true;
  });

  if (candidates.length !== 1) return null;
  const [onlyCandidate] = candidates;
  return onlyCandidate ? onlyCandidate.id : null;
}


function ensureDir(): boolean {
  const dir = dataDir();
  if (existsSync(dir)) return true;
  try {
    mkdirSync(dir, { recursive: true });
    return true;
  } catch {
    return false;
  }
}

export function appendLine(filename: string, data: unknown): boolean {
  if (!ensureDir()) return false;
  const path = join(dataDir(), filename);
  try {
    appendFileSync(path, JSON.stringify(data) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Process-lifetime count of appendFileSync executions attempted by
 * appendLines() (ticket 22 test instrumentation): a k-entry
 * batch_record_actuals must show exactly ONE batched write, not k. Mirrors
 * getDedupHitCount's in-memory counter pattern.
 */
let batchAppendWriteCalls = 0;

/** Number of joined-line batch writes attempted since process start. Exposed for tests/observability. */
export function getBatchAppendWriteCallCount(): number {
  return batchAppendWriteCalls;
}

/**
 * Append several records in ONE appendFileSync of the joined lines (ticket 22,
 * batch single-pass): a single O_APPEND write of the whole payload is the
 * atomic-enough shape ticket 18 analyzed for the ledger — either the batch of
 * lines lands or the tail tears exactly like any single-line append would
 * (and a torn tail is counted by the corruptLines read-side counter either way).
 */
export function appendLines(filename: string, records: unknown[]): boolean {
  if (records.length === 0) return true;
  batchAppendWriteCalls++;
  if (!ensureDir()) return false;
  const path = join(dataDir(), filename);
  try {
    appendFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/**
 * Append a new estimate row and return its id — or null when the append
 * failed (ticket 18, write-failure propagation): callers must NEVER receive a
 * usable id for a record that never persisted (no phantom feedbackRefs).
 * Mirrors recordActualDetailed's write_failed honesty on the estimate side.
 */
function appendNewEstimate(
  canonicalTool: string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  source: string | undefined,
  targetFile: string,
): string | null {
  const id = randomUUID();
  const record: EstimateRecord = {
    id,
    tool: canonicalTool,
    inputs,
    outputs,
    estimatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + pendingTtlDays() * 86_400_000).toISOString(),
    ...(source && { source }),
    // --- Ticket 11 (estimate-basis unification) — SEPARATE HUNK, lane H ---
    // Every newly written row carries the post-unification basis-version
    // stamp: from this point on the estimate a tool DISPLAYS is the estimate
    // the ledger RECORDS (PERT: raw `expected`; reference-class:
    // `correctedEstimate`). Legacy rows (no stamp) are implicitly v1 — the
    // era in which tools displayed an adjustedEstimate the ledger never
    // recorded — and ratio populations stay split by that era (coverage.ts),
    // with no automatic aging-out.
    basisVersion: CURRENT_BASIS_VERSION,
  };
  const written = appendLine(targetFile, record);
  return written ? id : null;
}

export function recordEstimate(
  tool: string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  source?: string,
): string | null {
  // Normalize the tool spelling at ingest (camelCase writers, known aliases)
  // so calibration reads never fragment the same tool across spellings.
  // Falls back to the raw value when it can't be resolved — recordEstimate
  // never rejects a write; unresolvable tool names are guarded downstream
  // at the actual-recording step (see recordActualDetailed).
  const canonicalTool = canonicalizeToolName(tool) ?? tool;
  const targetFile = isDryRun() ? DRY_RUN_ESTIMATES_FILE : ESTIMATES_FILE;

  // Dedup get-or-create (Phase 4, flag-gated): only engages when the caller
  // supplies session_id AND EPOCH_DEDUP_WINDOW is set. Absent either, this
  // block is a no-op and behavior is byte-identical to pre-Phase-4.
  //
  // Ticket 18: the find-match → append sequence is a check-then-act region,
  // so it runs under the ledger write lock — two concurrent identical calls
  // can no longer both observe zero candidates and append duplicate pending
  // rows. Lock-infrastructure failures surface as null (no phantom id).
  const sessionId = stringField(inputs["session_id"]);
  const windowMinutes = dedupWindowMinutes();
  if (sessionId && windowMinutes !== null) {
    const actualsFile = isDryRun() ? DRY_RUN_FILE : ACTUALS_FILE;
    try {
      return withLedgerWriteLock(
        targetFile,
        () => {
          const existingId = findDedupMatch(canonicalTool, inputs, sessionId, windowMinutes, targetFile, actualsFile);
          if (existingId) {
            dedupHitCount++;
            debugLog("feedback.dedup-hit", `reused pending estimate ${existingId} for tool ${canonicalTool}, session ${sessionId}`);
            return existingId;
          }
          return appendNewEstimate(canonicalTool, inputs, outputs, source, targetFile);
        },
        "recordEstimate-dedup",
      );
    } catch (err) {
      if (err instanceof LedgerLockTimeoutError || err instanceof LedgerLockUnavailableError) {
        debugLog("feedback.lock-failure", `dedup get-or-create for tool ${canonicalTool} abandoned: ${err.message}`);
      }
      return null;
    }
  }

  return appendNewEstimate(canonicalTool, inputs, outputs, source, targetFile);
}

/** Non-estimation tool-call telemetry (Phase 1 Task 3): never joins the estimates ledger. */
export interface ToolCallRecord {
  id: string;
  tool: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  calledAt: string;
  source?: string;
}

/** File used for non-estimation tool-call telemetry — kept separate from ESTIMATES_FILE. */
const TOOL_CALLS_FILE = "tool-calls.jsonl";
const DRY_RUN_TOOL_CALLS_FILE = "tool-calls.dry-run.jsonl";

/**
 * Record a non-estimation tool call (e.g. get_current_time, feedback_health,
 * record_actual) as telemetry, separate from the estimates ledger. These
 * calls must never be counted as estimates in totalEstimates/matchRate.
 */
export function recordToolCall(
  tool: string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  source?: string,
): string {
  const id = randomUUID();
  const record: ToolCallRecord = {
    id,
    tool,
    inputs,
    outputs,
    calledAt: new Date().toISOString(),
    ...(source && { source }),
  };
  appendLine(isDryRun() ? DRY_RUN_TOOL_CALLS_FILE : TOOL_CALLS_FILE, record);
  return id;
}


/** File used for dry-run / test writes when EPOCH_DRY_RUN is set. */
export const DRY_RUN_FILE = "feedback.dry-run.jsonl";
export const DRY_RUN_ESTIMATES_FILE = "estimates.dry-run.jsonl";

export function isDryRun(): boolean {
  return process.env["EPOCH_DRY_RUN"] === "1" || process.env["EPOCH_DRY_RUN"] === "true";
}

