import { existsSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { HistoricalRecord, TaskType } from "../types/index.js";
import { computeAccuracyMetrics } from "./analytics.js";
import { readLines, dataDir, ESTIMATES_FILE, ACTUALS_FILE, loadLedgerWithOverlays, CURRENT_BASIS_VERSION } from "./ledger.js";
import type { EstimateRecord, ActualRecord, MergedOverlayFlags } from "./ledger.js";
import { isExcluded, isSyntheticId, isAutoWallclockSane, type ExclusionReason } from "./exclusion.js";
import { canonicalizeToolName, ESTIMATION_TOOL_NAMES } from "./tool-aliases.js";
import { debugLog } from "./internal/logging.js";

export type { EstimateRecord, ActualRecord };

/** Default pending-estimate TTL, in days. Overridable via EPOCH_PENDING_TTL_DAYS. */
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

/**
 * Process-lifetime flag: the unknown_tool rejection diagnostic logs only
 * once (ticket 16) — repeated rejections of the same unmapped tool name must
 * leave a trace without spamming the log on every attempt.
 */
let unknownToolRejectionLogged = false;

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

/** Default minimum matched-pair sample size required before a calibration verdict is reported. */
const DEFAULT_MIN_N_FOR_VERDICT = 20;

/** Resolve MIN_N_FOR_VERDICT from env (EPOCH_MIN_N_FOR_VERDICT), falling back to the default. */
export function minNForVerdict(): number {
  const raw = process.env["EPOCH_MIN_N_FOR_VERDICT"];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_N_FOR_VERDICT;
}

/**
 * Build the calibration verdict/recommendation string for a byTool/byTaskType
 * bucket, gated on MIN_N_FOR_VERDICT (Phase 1 Task 1). Below the threshold,
 * no directional claim ("Sufficient for calibration", "systematic
 * overestimation", etc.) is made — only an "insufficient sample" statement.
 */
function calibrationRecommendation(
  pairs: number,
  metrics: { cappedMdape: number; bias: number } | null,
  minN: number,
  zeroMessage: string,
): string {
  if (pairs === 0) {
    return `Insufficient sample (n=0). ${zeroMessage}`;
  }
  if (pairs < minN) {
    const needed = minN - pairs;
    return `Insufficient sample (n=${pairs}). Need ${needed} more matched pair${needed === 1 ? "" : "s"} before a calibration verdict is reported (minimum ${minN}).`;
  }
  const bl = biasLabel(metrics?.bias ?? null);
  if (pairs < 10) {
    return `Sufficient for calibration (${pairs} pairs, capped MdAPE: ${metrics?.cappedMdape?.toFixed(1) ?? "N/A"}%, ${bl}). Collect more to improve reliability.`;
  }
  return `Good coverage (${pairs} pairs, capped MdAPE: ${metrics?.cappedMdape?.toFixed(1) ?? "N/A"}%, ${bl}).${metrics && metrics.cappedMdape > 50 ? " Review outliers." : ""}`;
}

function biasLabel(bias: number | null): string {
  if (bias === null) return "";
  if (bias > 2) return "systematic underestimation";
  if (bias > 0.5) return "mild underestimation";
  if (bias > -0.5) return "well-calibrated";
  if (bias > -3) return "mild overestimation";
  return "systematic overestimation";
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

function appendLine(filename: string, data: unknown): boolean {
  if (!ensureDir()) return false;
  const path = join(dataDir(), filename);
  try {
    appendFileSync(path, JSON.stringify(data) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

export function recordEstimate(
  tool: string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  source?: string,
): string {
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
  const sessionId = stringField(inputs["session_id"]);
  const windowMinutes = dedupWindowMinutes();
  if (sessionId && windowMinutes !== null) {
    const actualsFile = isDryRun() ? DRY_RUN_FILE : ACTUALS_FILE;
    const existingId = findDedupMatch(canonicalTool, inputs, sessionId, windowMinutes, targetFile, actualsFile);
    if (existingId) {
      dedupHitCount++;
      debugLog("feedback.dedup-hit", `reused pending estimate ${existingId} for tool ${canonicalTool}, session ${sessionId}`);
      return existingId;
    }
  }

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
    // recorded — and ratio populations stay split by this era (coverage.ts),
    // with no automatic aging-out.
    basisVersion: CURRENT_BASIS_VERSION,
  };
  appendLine(targetFile, record);
  return id;
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

export type RecordActualResult =
  | { ok: true; flagged?: "unit_suspect" }
  | {
      ok: false;
      reason: "below_threshold" | "duplicate" | "write_failed" | "synthetic_id" | "unknown_tool" | "auto_wallclock_out_of_bounds";
      /**
       * Actionable hint to append to the surfaced error message (ticket 16).
       * Currently only the unknown_tool rejection carries one — it names the
       * canonical estimation-tool set so the contract severance is never
       * silent. The rejection semantics themselves are unchanged.
       */
      hint?: string;
    };

/**
 * The actual record as persisted by recordActualDetailed: the shared
 * ledger ActualRecord plus the write-time unit-suspect flag (ticket 16).
 * Declared here (not on ledger.ts's ActualRecord) so the persisted flag's
 * type lives with the code that writes it; read-side consumers see it via
 * exclusion.ts's ExclusionActual.unitSuspect.
 */
export type RecordedActualRecord = ActualRecord & { unitSuspect?: true };

/**
 * Hint surfaced with every unknown_tool rejection (ticket 16): names the
 * canonical estimation-tool set so callers can tell a garbled tool name from
 * a bad estimate id. Derived from the authoritative partition, never
 * hand-copied.
 */
export const UNKNOWN_TOOL_HINT = `Actuals can only join estimates produced by Epoch's estimation tools: ${[...ESTIMATION_TOOL_NAMES].join(", ")}.`;

/** File used for dry-run / test writes when EPOCH_DRY_RUN is set. */
const DRY_RUN_FILE = "feedback.dry-run.jsonl";
const DRY_RUN_ESTIMATES_FILE = "estimates.dry-run.jsonl";

/** Actuals must be positive to be recorded. */
const MINIMUM_RECORDED_ACTUAL_HOURS = 0;

/** Units an actual may be submitted in; normalized to hours at ingest (day/week use the same 8h/40h work-period convention as estimation.ts's toHours()). */
export type ActualUnit = "minutes" | "hours" | "days" | "weeks";

const ACTUAL_UNIT_TO_HOURS: Record<ActualUnit, number> = {
  minutes: 1 / 60,
  hours: 1,
  days: 8,
  weeks: 40,
};

/** Ratio (in either direction) between normalized actual hours and the matched estimate's hours above which a unit mistake (e.g. person-months entered as hours) is likely. Recorded, not silently ingested — flagged "unit_suspect". */
const UNIT_SUSPECT_RATIO = 10;

/**
 * Hours-per-unit conversion for estimate outputs recorded with a `unit` field
 * (PERT `expected`/`stdDeviation` and friends). Same 8h-day / 40h-week /
 * 160h-month work-period convention as estimation.ts's toHours(). Shared so
 * read-side consumers (coverage.ts interval scoring) convert with the exact
 * table used at ingest instead of duplicating it.
 */
export const ESTIMATE_UNIT_TO_HOURS: Record<string, number> = {
  hours: 1,
  days: 8,
  weeks: 40,
  months: 160,
};

function normalizeActualHours(value: number, unit?: ActualUnit): number {
  if (!unit) return value;
  return value * ACTUAL_UNIT_TO_HOURS[unit];
}

function isDryRun(): boolean {
  return process.env["EPOCH_DRY_RUN"] === "1" || process.env["EPOCH_DRY_RUN"] === "true";
}

export function recordActual(estimateId: string, actualHours: number, notes?: string, unit?: ActualUnit, calibrationProvenance?: string): boolean {
  const result = recordActualDetailed(estimateId, actualHours, notes, unit, calibrationProvenance);
  return result.ok;
}

export function recordActualDetailed(
  estimateId: string,
  actualHours: number,
  notes?: string,
  unit?: ActualUnit,
  calibrationProvenance?: string,
): RecordActualResult {
  const normalizedHours = normalizeActualHours(actualHours, unit);
  if (normalizedHours <= MINIMUM_RECORDED_ACTUAL_HOURS) return { ok: false, reason: "below_threshold" };

  // Reject synthetic estimate IDs at write time — prevents test data from polluting calibration
  if (isSyntheticId(estimateId)) return { ok: false, reason: "synthetic_id" };

  // Dry-run mode reads AND writes its own ledger (ticket 16): the duplicate
  // check and the estimate lookup below previously read the production files
  // while writes went to the dry-run ones, so repeated dry-run records never
  // collided with anything and accumulated unbounded.
  const dryRun = isDryRun();
  const actualsSource = dryRun ? DRY_RUN_FILE : ACTUALS_FILE;
  const estimatesSource = dryRun ? DRY_RUN_ESTIMATES_FILE : ESTIMATES_FILE;

  // Reject duplicates — last-write-wins silently corrupts calibration
  const existing = readLines<ActualRecord>(actualsSource);
  if (existing.some((a) => a.estimateId === estimateId)) {
    return { ok: false, reason: "duplicate" };
  }

  // Guard against actuals joining an estimate whose tool name is unknown/unmapped
  // or a raw id (a garbled `tool` field) — such joins would silently corrupt
  // by-tool calibration math. Orphan actuals (no matching estimate on file)
  // are left to the existing join-time handling elsewhere and are not rejected here.
  const matchedEstimate = readLines<EstimateRecord>(estimatesSource).find((e) => e.id === estimateId);
  let flagged: "unit_suspect" | undefined;
  let matchedEstimatedHours: number | null = null;
  if (matchedEstimate) {
    if (canonicalizeToolName(matchedEstimate.tool) === null) {
      // Ticket 16 (unknown-tool policy): the rejection stands (ticket 04's
      // pinned semantics), but it is never silent — log once per process and
      // carry an actionable hint naming the canonical estimation-tool set.
      if (!unknownToolRejectionLogged) {
        unknownToolRejectionLogged = true;
        debugLog(
          "feedback.unknown-tool",
          `rejecting actual for estimate ${estimateId}: tool "${matchedEstimate.tool}" is not in the canonical estimation set {${[...ESTIMATION_TOOL_NAMES].join(", ")}}`,
        );
      }
      return { ok: false, reason: "unknown_tool", hint: UNKNOWN_TOOL_HINT };
    }

    matchedEstimatedHours = extractEstimatedHours(matchedEstimate.outputs);
    if (matchedEstimatedHours !== null && matchedEstimatedHours > 0 && normalizedHours > 0) {
      const ratio = Math.max(normalizedHours / matchedEstimatedHours, matchedEstimatedHours / normalizedHours);
      if (ratio > UNIT_SUSPECT_RATIO) flagged = "unit_suspect";
    }
  }

  // Wave 2 auto-actuals write-time guard: never persist an auto_wallclock
  // actual outside the dedicated sanity gate, regardless of caller. Defense
  // in depth alongside the auto-actuals CLI's own pre-filter and
  // isExcluded()'s calibration-math gate (src/lib/exclusion.ts) — all three
  // share isAutoWallclockSane() as the single source of truth.
  if (calibrationProvenance === "auto_wallclock" && !isAutoWallclockSane(normalizedHours, matchedEstimatedHours)) {
    return { ok: false, reason: "auto_wallclock_out_of_bounds" };
  }

  const record: RecordedActualRecord = {
    estimateId,
    actualHours: normalizedHours,
    ...(notes && { notes }),
    reportedAt: new Date().toISOString(),
    ...(calibrationProvenance && { calibrationProvenance }),
    // Persist the unit-suspect verdict on the record itself (ticket 16) so
    // the flag survives as an audit artifact even though read-side exclusion
    // always recomputes the ratio (exclusion.ts's MAX_RATIO gate).
    ...(flagged === "unit_suspect" && { unitSuspect: true }),
  };

  // Dry-run mode: write to separate file so tests never touch production data
  const targetFile = dryRun ? DRY_RUN_FILE : ACTUALS_FILE;
  const written = appendLine(targetFile, record);
  if (!written) return { ok: false, reason: "write_failed" };
  return flagged ? { ok: true, flagged } : { ok: true };
}

export function getPendingEstimates(limit = 50): Array<EstimateRecord & { hasActual: boolean }> {
  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const actualIds = new Set(actuals.map((a) => a.estimateId));

  return estimates
    .map((e) => ({ ...e, hasActual: actualIds.has(e.id) }))
    .filter((e) => !e.hasActual)
    .filter((e) => {
      // Pending-TTL expiry (Phase 1 Task 7): route through the shared
      // isExcluded() predicate so this stays coordinated with exclusion.ts's
      // ttl_expired semantics — only exclude on that specific reason.
      const verdict = isExcluded({ id: e.id, tool: e.tool, estimatedAt: e.estimatedAt, expiresAt: e.expiresAt });
      return !(verdict.excluded && verdict.reason === "ttl_expired");
    })
    .slice(-limit);
}

export function getCalibrationData(
  teamId?: string,
  taskType?: TaskType,
  windowDays?: number,
  tool?: string,
  calibrationUsage: "correction" | "baseline" | "all" = "correction",
): HistoricalRecord[] {
  const records = matchEstimatesToActuals(
    readLines<EstimateRecord>(ESTIMATES_FILE),
    readLines<ActualRecord>(ACTUALS_FILE),
    { teamId, taskType, windowDays, tool },
    overlayFlagsById(),
  );
  if (calibrationUsage === "all") return records;
  return records.filter((record) => record.calibrationUsage === calibrationUsage);
}

type CalibrationProvenance = NonNullable<HistoricalRecord["calibrationProvenance"]>;
type CalibrationUsage = NonNullable<HistoricalRecord["calibrationUsage"]>;

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function happenedBefore(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const aTime = Date.parse(a);
  const bTime = Date.parse(b);
  if (!Number.isFinite(aTime) || !Number.isFinite(bTime)) return false;
  return aTime < bTime - 60_000;
}

/** Map an isExcluded() reason to the closest calibration-provenance label, for reporting. */
function provenanceForExclusionReason(reason: ExclusionReason | undefined): CalibrationProvenance {
  switch (reason) {
    case "smoke":
      return "smoke";
    case "explicit_exclude":
    case "industry_calibration_note":
    case "seed_notes":
    case "synthetic_id":
    case "backfill_signature":
    case "ratio_outlier":
    case "below_calibration_threshold":
      return "synthetic";
    default:
      return "unknown";
  }
}

/**
 * Determine calibration provenance/usage for a matched (estimate, actual) pair.
 * Hard-exclusion determination (seed/synthetic/smoke/backfill-signature/ratio-outlier/
 * below-threshold/explicit-exclude) is delegated entirely to the shared
 * isExcluded() predicate (src/lib/exclusion.ts) — this function only remains
 * responsible for the baseline-vs-correction split of records that survive it.
 */
function classifyCalibrationRecord(
  est: EstimateRecord,
  act: ActualRecord,
  estimatedHours: number | null,
  overlayFlags?: MergedOverlayFlags,
): { calibrationProvenance: CalibrationProvenance; calibrationUsage: CalibrationUsage } {
  const actualAsRecord = act as unknown as Record<string, unknown>;
  const verdict = isExcluded({
    id: est.id,
    tool: est.tool,
    inputs: est.inputs,
    estimatedAt: est.estimatedAt,
    estimatedHours,
    actual: {
      actualHours: act.actualHours,
      notes: act.notes,
      reportedAt: act.reportedAt,
      completedAt: act.completedAt,
      calibrationProvenance: act.calibrationProvenance,
      // Actual-side usage/provenance spellings (legacy camelCase + snake_case)
      // must reach isExcluded too — dropping them here would let note-sniffing
      // override an explicit structured classification (ticket 16).
      calibrationUsage: stringField(actualAsRecord["calibrationUsage"]),
      calibration_provenance: stringField(actualAsRecord["calibration_provenance"]),
      calibration_usage: stringField(actualAsRecord["calibration_usage"]),
      ...(unitSuspectFlag(act) && { unitSuspect: true }),
    },
    ...(overlayFlags && { flags: { quarantined: overlayFlags.quarantined, orphan: overlayFlags.orphan } }),
  });
  if (verdict.excluded) {
    return { calibrationProvenance: provenanceForExclusionReason(verdict.reason), calibrationUsage: "exclude" };
  }

  const inputs = est.inputs as Record<string, unknown>;
  const actual = actualAsRecord;
  const explicitProvenance = normalizeProvenance(
    inputs["calibration_provenance"] ?? actual["calibrationProvenance"] ?? actual["calibration_provenance"],
  );
  const explicitUsage = normalizeUsage(
    inputs["calibration_usage"] ?? actual["calibrationUsage"] ?? actual["calibration_usage"],
  );

  if (explicitProvenance) {
    // Ticket 16 (notes-sniffing override): a valid explicit structured
    // provenance wins over the note-substring and temporal heuristics below
    // — "ingested from" in free-text notes no longer overrides a deliberate
    // calibration_provenance="prospective" stamp.
    // "prospective" (an ordinary matched actual) and "auto_wallclock" (Wave 2
    // auto-actuals — included in correction training by default per plan,
    // subject only to isExcluded()'s dedicated sanity gate) both default to
    // "correction" usage when no explicit usage is supplied. Every other
    // explicit provenance (backfilled_*, synthetic, smoke, unknown) defaults
    // to "baseline" — held out of correction-factor computation.
    const defaultUsage = explicitProvenance === "prospective" || explicitProvenance === "auto_wallclock" ? "correction" : "baseline";
    return {
      calibrationProvenance: explicitProvenance,
      calibrationUsage: explicitUsage ?? defaultUsage,
    };
  }

  const notes = (act.notes ?? "").toLowerCase();
  const hasExplicitUsage = explicitUsage !== undefined;

  // Note-substring heuristics only run when no explicit structured field was
  // supplied (ticket 16) — an explicit usage classification beats note matches.
  if (!hasExplicitUsage) {
    if (notes.includes("ingested from")) {
      return { calibrationProvenance: "backfilled_real_session", calibrationUsage: "baseline" };
    }

    if (notes.includes("real data calibration")) {
      return { calibrationProvenance: "backfilled_calibration", calibrationUsage: "baseline" };
    }
  }

  if (happenedBefore(stringField(actual["completedAt"]), est.estimatedAt)) {
    return { calibrationProvenance: "backfilled_calibration", calibrationUsage: "baseline" };
  }

  return { calibrationProvenance: "prospective", calibrationUsage: explicitUsage ?? "correction" };
}

/** Read the persisted write-time unit-suspect flag off an actual record (tolerates older rows without it). */
function unitSuspectFlag(act: ActualRecord): boolean {
  return (act as unknown as Record<string, unknown>)["unitSuspect"] === true;
}

const VALID_PROVENANCE = new Set<CalibrationProvenance>([
  "prospective",
  "backfilled_real_session",
  "backfilled_calibration",
  "synthetic",
  "smoke",
  "unknown",
  "auto_wallclock",
]);

const VALID_USAGE = new Set<CalibrationUsage>(["correction", "baseline", "exclude"]);

function normalizeProvenance(value: unknown): CalibrationProvenance | undefined {
  const raw = stringField(value);
  if (!raw) return undefined;
  return VALID_PROVENANCE.has(raw as CalibrationProvenance) ? raw as CalibrationProvenance : undefined;
}

function normalizeUsage(value: unknown): CalibrationUsage | undefined {
  const raw = stringField(value);
  if (!raw) return undefined;
  return VALID_USAGE.has(raw as CalibrationUsage) ? raw as CalibrationUsage : undefined;
}

/**
 * Build an id -> merged-overlay-flags map from the shared ledger loader
 * (src/lib/ledger.ts's loadLedgerWithOverlays()), so matchEstimatesToActuals()
 * can route manual quarantine/orphan overlay flags into isExcluded() even
 * when they aren't independently caught by isExcluded()'s own date/ratio
 * heuristics (the KNOWN_LIMITATIONS gap — see dashboard-data.ts). Only the
 * live-ledger callers below (getCalibrationData / getFeedbackHealthReport)
 * pass this in; matchEstimatesToActuals() itself stays disk-agnostic so
 * callers matching arbitrary in-memory record sets (e.g.
 * reference-db-recalculation.ts's community-import path, or unit tests)
 * are unaffected.
 */
function overlayFlagsById(): Map<string, MergedOverlayFlags> {
  const map = new Map<string, MergedOverlayFlags>();
  for (const rec of loadLedgerWithOverlays()) {
    map.set(rec.id, rec.flags);
  }
  return map;
}

export function matchEstimatesToActuals(
  estimates: EstimateRecord[],
  actuals: ActualRecord[],
  filters?: {
    teamId?: string;
    taskType?: TaskType;
    windowDays?: number;
    tool?: string;
  },
  overlayFlags?: Map<string, MergedOverlayFlags>,
): HistoricalRecord[] {
  const actualsMap = new Map<string, ActualRecord>();
  for (const a of actuals) {
    actualsMap.set(a.estimateId, a);
  }

  const cutoff = filters?.windowDays
    ? new Date(Date.now() - filters.windowDays * 86_400_000).toISOString()
    : "0000";

  const records: HistoricalRecord[] = [];

  for (const est of estimates) {
    if (est.estimatedAt < cutoff) continue;

    const act = actualsMap.get(est.id);
    if (!act) continue;

    const estHours = extractEstimatedHours(est.outputs);

    // Resolve tool spelling once per record so filtering/grouping/inference
    // below never fragment the same tool across camelCase/alias variants.
    // Falls back to the raw value when unresolvable — read-side canonicalization
    // normalizes, it does not exclude (that stays isExcluded()'s job).
    const canonicalTool = canonicalizeToolName(est.tool) ?? est.tool;

    // Single exclusion truth: seed/synthetic, smoke, explicit-exclude,
    // 2026-05-05 exact-match backfill signature, ratio outliers,
    // below-threshold microtask artifacts, and (when overlayFlags is
    // supplied) manual quarantine/orphan overlay flags are all determined
    // here.
    const calibration = classifyCalibrationRecord(est, act, estHours, overlayFlags?.get(est.id));
    if (calibration.calibrationUsage === "exclude") continue;

    // Missing/unrecognized output shape is a data-completeness gap, not a
    // calibration-exclusion reason — kept as a separate check.
    if (estHours === null) continue;

    const type = (est.inputs["task_type"] as string) ?? inferTaskType(canonicalTool);

    if (filters?.taskType && type !== filters.taskType) continue;
    if (filters?.teamId && est.inputs["team_id"] !== filters.teamId) continue;
    if (filters?.tool && canonicalTool !== filters.tool) continue;

    const complexity = typeof est.inputs["complexity"] === "number"
      ? est.inputs["complexity"]
      : undefined;
    const completedAt = stringField((act as unknown as Record<string, unknown>)["completedAt"]) ?? act.reportedAt ?? "";

    records.push({
      taskType: type,
      estimatedHours: estHours,
      actualHours: act.actualHours,
      tool: canonicalTool,
      ...(complexity !== undefined && { complexity }),
      ...(filters?.teamId && { teamId: filters.teamId }),
      completedAt,
      calibrationProvenance: calibration.calibrationProvenance,
      calibrationUsage: calibration.calibrationUsage,
    });
  }

  return records.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
}

/**
 * Extract a headline estimated-hours value from an estimate's `outputs`
 * shape, across every estimation tool's output envelope. Exported (Phase 2)
 * so migration scripts (src/lib/migrations/*.ts, src/lib/migration-stats.ts,
 * src/lib/benchmark-export.ts) reuse this exact extraction logic instead of
 * reimplementing it — keeps "estimated hours" derivation a single source of
 * truth alongside the shared isExcluded() predicate.
 */
export function extractEstimatedHours(outputs: Record<string, unknown>): number | null {
  if (typeof outputs["totalHours"] === "number") return outputs["totalHours"];
  if (typeof outputs["estimatedHours"] === "number") return outputs["estimatedHours"];
  if (typeof outputs["estimatedMinutes"] === "number") return outputs["estimatedMinutes"] / 60;
  if (typeof outputs["estimatedSeconds"] === "number") return outputs["estimatedSeconds"] / 3600;
  if (typeof outputs["expected"] === "number") {
    const unit = outputs["unit"];
    if (unit === undefined) return outputs["expected"]; // no unit field — assume hours
    const factor = ESTIMATE_UNIT_TO_HOURS[unit as string];
    return factor === undefined ? null : outputs["expected"] * factor; // unrecognized unit — skip to avoid corrupting calibration
  }
  if (typeof outputs["personMonthsLlmAdjusted"] === "number") {
    return outputs["personMonthsLlmAdjusted"] * 160;
  }
  if (typeof outputs["correctedEstimate"] === "number") {
    return outputs["correctedEstimate"];
  }
  if (typeof outputs["total_duration"] === "number") {
    return outputs["total_duration"] * 8;
  }
  return null;
}

const TOOL_TASK_TYPE_FALLBACK: Record<string, string> = {
  pert_estimate: "feature",
  cocomo_estimate: "feature",
  sprint_forecast: "feature",
  reference_class_estimate: "feature",
  monte_carlo_schedule: "feature",
  critical_path: "feature",
  token_time_bridge: "infrastructure",
  token_cost_estimate: "infrastructure",
  calibrate_estimates: "feature",
  schedule_risk: "feature",
  feedback_health: "feature",
  accuracy_trend: "feature",
  compare_models: "feature",
};

function inferTaskType(tool: string): string {
  return TOOL_TASK_TYPE_FALLBACK[tool] ?? "feature";
}

// ---- Batch Operations -------------------------------------------------------

export interface BatchActualEntry {
  estimateId: string;
  actualHours: number;
  notes?: string;
  unit?: ActualUnit;
  calibrationProvenance?: string;
}

export interface BatchResult {
  total: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

export function batchRecordActuals(entries: BatchActualEntry[]): BatchResult {
  const errors: string[] = [];
  let succeeded = 0;

  for (const entry of entries) {
    // Ticket 04 (feedback contract): route through recordActualDetailed so
    // each per-entry error string carries the failure REASON (e.g.
    // "(reason: duplicate)") instead of a bare "Failed to record" — callers
    // (MCP batch_record_actuals, HTTP batch endpoint) surface these strings
    // verbatim, so the reason must survive the batch path.
    const result = recordActualDetailed(entry.estimateId, entry.actualHours, entry.notes, entry.unit, entry.calibrationProvenance);
    if (result.ok) {
      succeeded++;
    } else {
      errors.push(`Failed to record actual for estimate ${entry.estimateId} (reason: ${result.reason})${result.hint ? ` — ${result.hint}` : ""}`);
    }
  }

  return { total: entries.length, succeeded, failed: errors.length, errors };
}

// ---- Feedback Health Report -------------------------------------------------

export interface FeedbackHealthReport {
  totalEstimates: number;
  totalActuals: number;
  matchedPairs: number;
  seedRecordsFiltered: number;
  provenance: {
    correctionRecords: number;
    baselineRecords: number;
    excludedRecords: number;
  };
  matchRate: number;
  byTool: Record<string, { estimates: number; actuals: number; matchedPairs: number; mape: number | null; mdape: number | null; cappedMdape: number | null; bias: number | null; trend: string | null; recommendation: string }>;
  byTaskType: Record<string, { estimates: number; actuals: number; matchedPairs: number; mape: number | null; mdape: number | null; cappedMdape: number | null; bias: number | null; trend: string | null; recommendation: string }>;
  /**
   * Matched pairs segmented by calibration provenance (Wave 2 auto-actuals):
   * "verified" = every non-auto_wallclock provenance (prospective,
   * backfilled_*, unknown, etc — actuals a human/agent explicitly recorded);
   * "auto" = auto_wallclock actuals recorded automatically at session end.
   * Kept separate so calibration drift introduced by wall-clock noise is
   * visible rather than silently blended into the headline metrics.
   */
  byProvenance: {
    verified: { matchedPairs: number; mdape: number | null; cappedMdape: number | null };
    auto: { matchedPairs: number; mdape: number | null; cappedMdape: number | null };
  };
  selfImprovement: {
    readyTypes: string[];
    callsUntilUpdate: number;
  };
  dataQuality: {
    overallMdape: number | null;
    overallCappedMdape: number | null;
    outlierRatio: number;
    recommendation: string;
    dataCompletenessScore: number;
  };
  humanReadable: string;
}

/**
 * Denominator list for feedback-health's data-completeness tool-coverage
 * score: the estimation tools that count as "calibrated" once they accrue
 * 3+ matched pairs. DERIVED from the authoritative estimation partition
 * (src/lib/tool-aliases.ts ESTIMATION_TOOL_NAMES), never hand-copied — the
 * historical hand-copy here was missing estimate_from_context (8 of 9),
 * silently capping the completeness score. Exported so the dispatcher sync
 * suite (src/dispatcher/tool-surface-sync.test.ts) can pin the derivation.
 */
export const FEEDBACK_HEALTH_CALIBRATION_TOOLS: readonly string[] = [...ESTIMATION_TOOL_NAMES];

export function getFeedbackHealthReport(): FeedbackHealthReport {
  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const actualIds = new Set(actuals.map((a) => a.estimateId));

  const totalEstimates = estimates.length;
  const totalActuals = actuals.length;
  const matchedEstimateCount = estimates.filter((estimate) => actualIds.has(estimate.id)).length;
  const matchRate = totalEstimates > 0
    ? Math.round((matchedEstimateCount / totalEstimates) * 1000) / 10
    : 0;

  // Load the merged overlay-flags map once (Pre-mortem Scenario 6 gap-close)
  // and reuse it for both the matcher below and the seedRecordsFiltered
  // recount, so the two stay in agreement rather than drifting.
  const overlayFlags = overlayFlagsById();

  // Compute all matched records once (no re-reads)
  const allMatched = matchEstimatesToActuals(estimates, actuals, undefined, overlayFlags);
  const correctionMatched = allMatched.filter((record) => record.calibrationUsage !== "baseline");
  const baselineRecords = allMatched.length - correctionMatched.length;

  // Count records dropped by the shared exclusion predicate — single source of
  // truth (previously reimplemented ad hoc here, drifting from matchEstimatesToActuals).
  const estimatesById = new Map<string, EstimateRecord>();
  for (const e of estimates) estimatesById.set(e.id, e);
  let seedRecordsFiltered = 0;
  for (const a of actuals) {
    const est = estimatesById.get(a.estimateId);
    if (!est) continue;
    const estHours = extractEstimatedHours(est.outputs);
    const verdict = isExcluded({
      id: est.id,
      tool: est.tool,
      inputs: est.inputs,
      estimatedAt: est.estimatedAt,
      estimatedHours: estHours,
      actual: {
        actualHours: a.actualHours,
        notes: a.notes,
        reportedAt: a.reportedAt,
        completedAt: a.completedAt,
        calibrationProvenance: a.calibrationProvenance,
        // Same actual-side spellings as classifyCalibrationRecord — the
        // recount must not drift from the matcher (ticket 16).
        calibrationUsage: stringField((a as unknown as Record<string, unknown>)["calibrationUsage"]),
        calibration_provenance: stringField((a as unknown as Record<string, unknown>)["calibration_provenance"]),
        calibration_usage: stringField((a as unknown as Record<string, unknown>)["calibration_usage"]),
      },
      flags: { quarantined: overlayFlags.get(est.id)?.quarantined, orphan: overlayFlags.get(est.id)?.orphan },
    });
    if (verdict.excluded) seedRecordsFiltered++;
  }

  // By tool — group the pre-matched records
  const toolEstimates = new Map<string, number>();
  const toolActuals = new Map<string, number>();
  const toolRecords = new Map<string, HistoricalRecord[]>();
  for (const e of estimates) {
    toolEstimates.set(e.tool, (toolEstimates.get(e.tool) ?? 0) + 1);
    if (actualIds.has(e.id)) {
      toolActuals.set(e.tool, (toolActuals.get(e.tool) ?? 0) + 1);
    }
  }
  for (const r of correctionMatched) {
    const toolKey = r.tool ?? "unknown";
    const records = toolRecords.get(toolKey) ?? [];
    records.push(r);
    toolRecords.set(toolKey, records);
  }

  const minN = minNForVerdict();

  const byTool: FeedbackHealthReport["byTool"] = {};
  for (const [tool, count] of toolEstimates) {
    const matched = toolRecords.get(tool) ?? [];
    const metrics = matched.length >= 2 ? computeAccuracyMetrics(matched) : null;
    const pairs = matched.length;
    const recommendation = calibrationRecommendation(pairs, metrics, minN, "No matched pairs. Record actuals to start calibration.");
    byTool[tool] = { estimates: count, actuals: toolActuals.get(tool) ?? 0, matchedPairs: pairs, mape: metrics?.mape ?? null, mdape: metrics?.mdape ?? null, cappedMdape: metrics?.cappedMdape ?? null, bias: metrics?.bias ?? null, trend: metrics?.trend ?? null, recommendation };
  }

  // By task type — group the pre-matched records
  const typeGroups = new Map<string, HistoricalRecord[]>();
  for (const r of correctionMatched) {
    const records = typeGroups.get(r.taskType) ?? [];
    records.push(r);
    typeGroups.set(r.taskType, records);
  }

  const typeEstimateCounts = new Map<string, number>();
  for (const e of estimates) {
    const type = (e.inputs["task_type"] as string) ?? inferTaskType(e.tool);
    typeEstimateCounts.set(type, (typeEstimateCounts.get(type) ?? 0) + 1);
  }

  const byTaskType: FeedbackHealthReport["byTaskType"] = {};
  for (const [type, count] of typeEstimateCounts) {
    const records = typeGroups.get(type) ?? [];
    const metrics = records.length >= 2 ? computeAccuracyMetrics(records) : null;
    const pairs = records.length;
    const typeRec = calibrationRecommendation(pairs, metrics, minN, "No matched pairs. Use this task type in estimates and record actuals.");
    byTaskType[type] = { estimates: count, actuals: records.length, matchedPairs: pairs, mape: metrics?.mape ?? null, mdape: metrics?.mdape ?? null, cappedMdape: metrics?.cappedMdape ?? null, bias: metrics?.bias ?? null, trend: metrics?.trend ?? null, recommendation: typeRec };
  }

  // Self-improvement readiness: types with 5+ matched records
  const readyTypes: string[] = [];
  for (const [type, records] of typeGroups) {
    if (records.length >= 5) readyTypes.push(type);
  }

  const callsUntilUpdate = Math.max(0, 100 - totalEstimates);

  // Data quality: overall MdAPE and outlier ratio across all matched records
  let overallMdape: number | null = null;
  let overallCappedMdape: number | null = null;
  let outlierRatio = 0;
  let recommendation: string;

  if (correctionMatched.length >= 5) {
    const metrics = computeAccuracyMetrics(correctionMatched);
    overallMdape = metrics.mdape;
    overallCappedMdape = metrics.cappedMdape;

    // Outliers: records where MAPE > 3× cappedMdape
    const outlierThreshold = metrics.cappedMdape * 3;
    const outliers = correctionMatched.filter(r => {
      const err = Math.abs(r.actualHours - r.estimatedHours) / r.actualHours * 100;
      return err > outlierThreshold;
    });
    outlierRatio = Math.round(outliers.length / correctionMatched.length * 1000) / 10;

    if (overallCappedMdape < 25) {
      recommendation = "Data quality is good. Capped MdAPE below 25% indicates reliable estimates.";
    } else if (overallCappedMdape < 50) {
      recommendation = "Data quality is moderate. Consider filtering outlier records or collecting more matched pairs.";
    } else {
      recommendation = "Data quality needs improvement. High capped MdAPE suggests systematic estimation bias. Review seed data for human/AI baseline mismatches.";
    }
  } else {
    recommendation = "Insufficient data for quality assessment. Need at least 5 matched estimate-actual pairs.";
  }

  const toolsWithData = Object.entries(byTool).filter(([, v]) => v.matchedPairs > 0).length;
  const typesWithData = Object.entries(byTaskType).filter(([, v]) => v.matchedPairs > 0).length;
  const mdapeLabel = overallMdape !== null ? `${Math.round(overallMdape)}%` : "N/A";
  const cappedLabel = overallCappedMdape !== null ? `${Math.round(overallCappedMdape)}%` : "N/A";

  // Data completeness score (0-100): tool coverage (40) + type coverage (30) + pair count (30)
  const estimationTools = FEEDBACK_HEALTH_CALIBRATION_TOOLS;
  const toolsCalibrated = estimationTools.filter(t => (byTool[t]?.matchedPairs ?? 0) >= 3).length;
  const toolScore = Math.round((toolsCalibrated / estimationTools.length) * 40);

  const allTaskTypes = Object.keys(byTaskType);
  const typesCalibrated = allTaskTypes.filter(t => (byTaskType[t]?.matchedPairs ?? 0) >= 3).length;
  const typeScore = allTaskTypes.length > 0 ? Math.round((typesCalibrated / allTaskTypes.length) * 30) : 0;

  const pairScore = Math.min(30, Math.round((correctionMatched.length / 100) * 30));

  const dataCompletenessScore = toolScore + typeScore + pairScore;

  const seedLabel = seedRecordsFiltered > 0 ? ` (${seedRecordsFiltered} seed records filtered)` : "";

  // byProvenance (Wave 2 auto-actuals): split the same correctionMatched
  // population used by byTool/byTaskType into verified vs auto_wallclock so
  // drift between the two is visible without waiting for a manual audit.
  const autoMatched = correctionMatched.filter((r) => r.calibrationProvenance === "auto_wallclock");
  const verifiedMatched = correctionMatched.filter((r) => r.calibrationProvenance !== "auto_wallclock");
  const autoMetrics = autoMatched.length >= 2 ? computeAccuracyMetrics(autoMatched) : null;
  const verifiedMetrics = verifiedMatched.length >= 2 ? computeAccuracyMetrics(verifiedMatched) : null;
  const byProvenance: FeedbackHealthReport["byProvenance"] = {
    verified: { matchedPairs: verifiedMatched.length, mdape: verifiedMetrics?.mdape ?? null, cappedMdape: verifiedMetrics?.cappedMdape ?? null },
    auto: { matchedPairs: autoMatched.length, mdape: autoMetrics?.mdape ?? null, cappedMdape: autoMetrics?.cappedMdape ?? null },
  };

  return {
    totalEstimates,
    totalActuals,
    matchedPairs: correctionMatched.length,
    seedRecordsFiltered,
    provenance: { correctionRecords: correctionMatched.length, baselineRecords, excludedRecords: seedRecordsFiltered },
    matchRate,
    byTool,
    byTaskType,
    byProvenance,
    selfImprovement: { readyTypes, callsUntilUpdate },
    dataQuality: { overallMdape, overallCappedMdape, outlierRatio, recommendation, dataCompletenessScore },
    humanReadable: `${correctionMatched.length} correction-eligible matched pairs across ${toolsWithData} tools and ${typesWithData} task types (capped MdAPE: ${cappedLabel}, raw MdAPE: ${mdapeLabel}; ${baselineRecords} baseline-only records held out). ${totalEstimates} estimates, ${totalActuals} actuals, match rate: ${matchRate}%${seedLabel}. ${recommendation}`,
  };
}
