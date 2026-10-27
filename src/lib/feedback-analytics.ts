/** Calibration analytics for the feedback pipeline (split from feedback.ts).

    Owns actual-hours intake (units, suspects, duplicates), estimate/actual
    matching, calibration classification and batch recording. Reads and
    writes through the ledger store module. */
import type { HistoricalRecord, TaskType } from "../types/index.js";
import { readLines, joinActualsEarliestReported, withLedgerWriteLock, LedgerLockTimeoutError, LedgerLockUnavailableError, ESTIMATES_FILE, ACTUALS_FILE, loadLedgerWithOverlays } from "./ledger.js";
import type { EstimateRecord, ActualRecord, MergedOverlayFlags } from "./ledger.js";
import { isExcluded, isSyntheticId, isAutoWallclockSane, isGitDerivedSane, isGitDerivedProvenance, type ExclusionReason } from "./exclusion.js";
import { canonicalizeToolName, ESTIMATION_TOOL_NAMES } from "./tool-aliases.js";
import { debugLog } from "./internal/logging.js";
import { appendLine, appendLines, isDryRun, DRY_RUN_FILE, DRY_RUN_ESTIMATES_FILE } from "./feedback-ledger.js";

/** Default minimum matched-pair sample size required before a calibration verdict is reported. */
const DEFAULT_MIN_N_FOR_VERDICT = 20;

/** Resolve MIN_N_FOR_VERDICT from env (EPOCH_MIN_N_FOR_VERDICT), falling back to the default. */
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
 * Actionable hint surfaced alongside every unit_suspect flag (ticket 16) by
 * BOTH transport seams — the record_actual MCP tool
 * (dispatcher/tool-registry.ts) and the /v1/feedback/record-actual HTTP route
 * (entries/http.ts) — so the two surfaces can never drift on what the flag
 * means. Text is pinned by substring in dispatcher and http tests.
 */
export const UNIT_SUSPECT_FLAG_HINT =
  "Suspected unit mismatch: the estimate and actual differ by more than 10x (either direction — the detection is symmetric) — check the units (hours vs days/weeks/person-months). The record is saved and flagged; it is excluded from calibration math if the ratio exceeds 50x.";

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

export function normalizeActualHours(value: number, unit?: ActualUnit): number {
  if (!unit) return value;
  return value * ACTUAL_UNIT_TO_HOURS[unit];
}



/** One-shot log guard for unknown-tool actual rejections (ticket 16). */
let unknownToolRejectionLogged = false;

export function minNForVerdict(): number {
  const raw = process.env["EPOCH_MIN_N_FOR_VERDICT"];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MIN_N_FOR_VERDICT;
}

export type RecordActualResult =
  | { ok: true; flagged?: "unit_suspect" }
  | {
      ok: false;
      reason: "below_threshold" | "duplicate" | "write_failed" | "synthetic_id" | "unknown_tool" | "auto_wallclock_out_of_bounds" | "git_derived_out_of_bounds";
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
type RecordedActualRecord = ActualRecord & { unitSuspect?: true };

/**
 * Hint surfaced with every unknown_tool rejection (ticket 16): names the
 * canonical estimation-tool set so callers can tell a garbled tool name from
 * a bad estimate id. Derived from the authoritative partition, never
 * hand-copied.
 */
const UNKNOWN_TOOL_HINT = `Actuals can only join estimates produced by Epoch's estimation tools: ${[...ESTIMATION_TOOL_NAMES].join(", ")}.`;

/**
 * Hint attached to write_failed results abandoned on ledger write-lock
 * contention (ticket 18): names the lock path and the automatic stale-lock
 * recovery so the failure is actionable, never a silent drop. Shared by the
 * single (recordActualDetailed) and batch (batchRecordActuals) paths.
 */
function lockTimeoutHint(err: LedgerLockTimeoutError): string {
  return `Another process held the feedback ledger write lock past the timeout (${err.lockPath}). Retry shortly; a stale lock is removed automatically once its owner PID is gone or it exceeds the staleness window.`;
}

/**
 * Hint surfaced with write_failed results when the lock infrastructure itself
 * could not be created (permissions, unusable fs). The write fails closed —
 * the check-then-append region never runs unlocked — so the hint names the
 * actionable recovery instead of suggesting a blind retry loop.
 */
function lockUnavailableHint(err: LedgerLockUnavailableError): string {
  return `The feedback ledger write lock could not be created (${err.lockPath}) — check directory permissions and filesystem health. The write failed closed rather than racing unlocked; retry once the cause is fixed.`;
}

export function recordActual(estimateId: string, actualHours: number, notes?: string, unit?: ActualUnit, calibrationProvenance?: string): boolean {
  const result = recordActualDetailed(estimateId, actualHours, notes, unit, calibrationProvenance);
  return result.ok;
}

/**
 * Outcome of evaluating one actual against its (possibly absent) matched
 * estimate. On success `record` is the row to append; on failure it is null
 * and `result` carries the ticket-04 rejection reason.
 */
type ActualEvaluation =
  | { result: { ok: true; flagged?: "unit_suspect" }; record: RecordedActualRecord }
  | { result: Extract<RecordActualResult, { ok: false }>; record: null };

/**
 * Shared per-entry evaluation for both actual-recording paths — the single
 * recordActualDetailed and the single-pass batch (ticket 22): everything that
 * depends on the matched ESTIMATE but on no further file state. Extracted so
 * the two paths can never drift on order or semantics:
 *
 *   unknown_tool rejection (with the once-per-process diagnostic + hint)
 *   → unit_suspect flagging (ratio > UNIT_SUSPECT_RATIO against the estimate)
 *   → auto_wallclock write-time sanity gate
 *   → record construction.
 *
 * Duplicate detection deliberately stays with the callers: it depends on
 * their view of the actuals ledger (on-disk rows for the single path; on-disk
 * rows + intra-batch claims for the batch), and it PRECEDES everything here.
 */
function evaluateActualForWrite(
  estimateId: string,
  normalizedHours: number,
  notes: string | undefined,
  calibrationProvenance: string | undefined,
  matchedEstimate: EstimateRecord | undefined,
): ActualEvaluation {
  let flagged: "unit_suspect" | undefined;
  let matchedEstimatedHours: number | null = null;
  if (matchedEstimate) {
    // Guard against actuals joining an estimate whose tool name is unknown/unmapped
    // or a raw id (a garbled `tool` field) — such joins would silently corrupt
    // by-tool calibration math. Orphan actuals (no matching estimate on file)
    // are left to the existing join-time handling elsewhere and are not rejected here.
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
      return { result: { ok: false, reason: "unknown_tool", hint: UNKNOWN_TOOL_HINT }, record: null };
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
    return { result: { ok: false, reason: "auto_wallclock_out_of_bounds" }, record: null };
  }

  // S1.1 mine-git write-time guard: never persist a git-derived actual
  // (either window stamp) outside its dedicated sanity gate, regardless of
  // caller. Same three-seam defense as auto_wallclock — the mine-git CLI's
  // pre-filter, this guard, and isExcluded()'s calibration-math gate all
  // share isGitDerivedSane() as the single source of truth.
  if (isGitDerivedProvenance(calibrationProvenance) && !isGitDerivedSane(normalizedHours, matchedEstimatedHours)) {
    return { result: { ok: false, reason: "git_derived_out_of_bounds" }, record: null };
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
  return { result: flagged ? { ok: true, flagged } : { ok: true }, record };
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

  // Ticket 18 (D3 concurrency): the duplicate check → append sequence below is
  // a TOCTOU window — two processes recording the same estimateId could both
  // observe "no actual yet" and both append. The whole check-then-append
  // region therefore runs under the ledger write lock (exclusive-create
  // lockfile, ms-scale scope, released in a finally). A live holder that
  // outlasts the contention timeout fails the write as write_failed (with a
  // hint) — never a silent unlocked append.
  try {
    return withLedgerWriteLock(
      actualsSource,
      (): RecordActualResult => {
        // Reject duplicates — last-write-wins silently corrupts calibration
        const existing = readLines<ActualRecord>(actualsSource);
        if (existing.some((a) => a.estimateId === estimateId)) {
          return { ok: false, reason: "duplicate" };
        }

        const matchedEstimate = readLines<EstimateRecord>(estimatesSource).find((e) => e.id === estimateId);
        const { result, record } = evaluateActualForWrite(estimateId, normalizedHours, notes, calibrationProvenance, matchedEstimate);
        if (!result.ok) return result;

        // Dry-run mode: write to separate file so tests never touch production data
        const written = appendLine(actualsSource, record);
        if (!written) return { ok: false, reason: "write_failed" };
        return result;
      },
      "recordActual",
    );
  } catch (err) {
    if (err instanceof LedgerLockTimeoutError || err instanceof LedgerLockUnavailableError) {
      debugLog("feedback.lock-failure", `record_actual for ${estimateId} abandoned: ${err.message}`);
      return {
        ok: false,
        reason: "write_failed",
        hint: err instanceof LedgerLockUnavailableError ? lockUnavailableHint(err) : lockTimeoutHint(err),
      };
    }
    throw err;
  }
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

/**
 * Whether the durable estimates ledger contains any exact session match.
 * Unlike getPendingEstimates(), this intentionally includes finalized and
 * expired rows: auto-actuals must not reinterpret a repeated session run as a
 * window-only session after its matching estimates receive actuals.
 */
export function hasEstimateForSession(sessionId: string): boolean {
  return readLines<EstimateRecord>(ESTIMATES_FILE).some(
    (estimate) => stringField(estimate.inputs?.["session_id"]) === sessionId,
  );
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

export function stringField(value: unknown): string | undefined {
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
    actual: exclusionActualFields(act),
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
    // "correction" usage when no explicit usage is supplied. git_derived /
    // git_derived_review_inclusive (S1.1 mine-git) follow the same rule for
    // the same reason: honest proxies inside their dedicated sanity gates.
    // Every other explicit provenance (backfilled_*, synthetic, smoke,
    // unknown) defaults to "baseline" — held out of correction-factor
    // computation.
    const defaultUsage =
      explicitProvenance === "prospective" ||
      explicitProvenance === "auto_wallclock" ||
      isGitDerivedProvenance(explicitProvenance)
        ? "correction"
        : "baseline";
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

/**
 * Actual-side fields for isExcluded(), including the legacy camelCase and
 * snake_case provenance/usage spellings (ticket 16) — shared by the matcher
 * (classifyCalibrationRecord) and the feedback-health seed recount so the two
 * can never drift. The write-time unitSuspect audit flag rides along; it is
 * documentation on the record and never gates an exclusion verdict by itself.
 */
export function exclusionActualFields(act: ActualRecord) {
  const asRecord = act as unknown as Record<string, unknown>;
  return {
    actualHours: act.actualHours,
    notes: act.notes,
    reportedAt: act.reportedAt,
    completedAt: act.completedAt,
    calibrationProvenance: act.calibrationProvenance,
    calibrationUsage: stringField(asRecord["calibrationUsage"]),
    calibration_provenance: stringField(asRecord["calibration_provenance"]),
    calibration_usage: stringField(asRecord["calibration_usage"]),
    ...(unitSuspectFlag(act) && { unitSuspect: true as const }),
  };
}

const VALID_PROVENANCE = new Set<CalibrationProvenance>([
  "prospective",
  "backfilled_real_session",
  "backfilled_calibration",
  "synthetic",
  "smoke",
  "unknown",
  "auto_wallclock",
  "git_derived",
  "git_derived_review_inclusive",
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
export function overlayFlagsById(): Map<string, MergedOverlayFlags> {
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
  // Deterministic join (ticket 18, D3): earliest-reportedAt wins, tie =
  // earliest file order. Mirrors loadLedgerWithOverlays() so the matcher and
  // the merged view can never disagree about which duplicate actual joined.
  const actualsMap = joinActualsEarliestReported(actuals);

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

export function inferTaskType(tool: string): string {
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
  // Ticket 22 (batch single-pass): this used to route every entry through
  // recordActualDetailed, re-reading both ledgers and re-acquiring the write
  // lock per entry — up to k full parses per call over files the batch itself
  // was growing (O(n²) overall). The single pass instead:
  //
  //   1. rejects file-independent failures (below_threshold, synthetic_id)
  //      with no I/O at all — when no entry can be recorded, the batch takes
  //      no lock and reads nothing (matching the sequential loop, where those
  //      checks also preceded the lock);
  //   2. takes ONE advisory write lock and loads both ledgers ONCE (≤2 file
  //      reads for the whole batch), validates and dedupes in memory against
  //      the on-disk actuals snapshot plus an intra-batch `claimed` set — a
  //      later entry for an estimateId the batch itself is about to record is
  //      a duplicate, exactly what the sequential loop saw once the earlier
  //      append landed; and
  //   3. appends every successful record in ONE batched write (appendLines:
  //      a single appendFileSync of the joined lines — atomic-enough per
  //      ticket 18's analysis).
  //
  // Holding the lock across the whole batch also SHRINKS the concurrency
  // window versus per-entry locking: cooperating writers cannot interleave
  // at all now, and a non-cooperating writer's mid-batch append has a
  // strictly smaller window than the old per-entry re-read gaps.
  //
  // Per-entry semantics are preserved in order and precedence — each entry's
  // result is the first failure of
  //   below_threshold → synthetic_id → duplicate → unknown_tool →
  //   auto_wallclock_out_of_bounds → write_failed
  // — and an entry only CLAIMS its estimateId when the batch will actually
  // append it, so a failed earlier entry never turns a later same-id entry
  // into a duplicate (matching the sequential loop exactly).
  const perEntry: Array<RecordActualResult | undefined> = entries.map(() => undefined);

  const dryRun = isDryRun();
  const actualsSource = dryRun ? DRY_RUN_FILE : ACTUALS_FILE;
  const estimatesSource = dryRun ? DRY_RUN_ESTIMATES_FILE : ESTIMATES_FILE;

  // Phase 1 — file-independent rejections, in entry order (no reads, no lock).
  const candidates: Array<{ entry: BatchActualEntry; normalizedHours: number; index: number }> = [];
  for (const [index, entry] of entries.entries()) {
    const normalizedHours = normalizeActualHours(entry.actualHours, entry.unit);
    if (normalizedHours <= MINIMUM_RECORDED_ACTUAL_HOURS) {
      perEntry[index] = { ok: false, reason: "below_threshold" };
      continue;
    }
    if (isSyntheticId(entry.estimateId)) {
      perEntry[index] = { ok: false, reason: "synthetic_id" };
      continue;
    }
    candidates.push({ entry, normalizedHours, index });
  }

  // Phase 2 — one lock, two reads, in-memory validation, one batched append.
  if (candidates.length > 0) {
    try {
      withLedgerWriteLock(
        actualsSource,
        () => {
          const existingIds = new Set(readLines<ActualRecord>(actualsSource).map((a) => a.estimateId));
          const estimatesById = new Map<string, EstimateRecord>();
          for (const estimate of readLines<EstimateRecord>(estimatesSource)) estimatesById.set(estimate.id, estimate);

          const claimed = new Set<string>();
          const toAppend: Array<{ index: number; record: RecordedActualRecord }> = [];
          for (const candidate of candidates) {
            // Duplicate precedence is unchanged: an on-disk actual or an
            // intra-batch claim beats every later check (unknown_tool, the
            // wallclock gate, ...) — the same order the sequential loop hit.
            if (existingIds.has(candidate.entry.estimateId) || claimed.has(candidate.entry.estimateId)) {
              perEntry[candidate.index] = { ok: false, reason: "duplicate" };
              continue;
            }
            const evaluation = evaluateActualForWrite(
              candidate.entry.estimateId,
              candidate.normalizedHours,
              candidate.entry.notes,
              candidate.entry.calibrationProvenance,
              estimatesById.get(candidate.entry.estimateId),
            );
            perEntry[candidate.index] = evaluation.result;
            // record is non-null exactly when result.ok (see ActualEvaluation)
            // — the null check doubles as the success-arm discriminant.
            if (evaluation.record !== null) {
              claimed.add(candidate.entry.estimateId);
              toAppend.push({ index: candidate.index, record: evaluation.record });
            }
          }

          // One batched append for the whole batch. If it fails, ONLY the
          // would-be-recorded entries turn write_failed — nothing persisted
          // for them, the same no-phantom-records honesty the single path has.
          if (toAppend.length > 0 && !appendLines(actualsSource, toAppend.map((p) => p.record))) {
            for (const pending of toAppend) perEntry[pending.index] = { ok: false, reason: "write_failed" };
          }
        },
        "batchRecordActuals",
      );
    } catch (err) {
      if (err instanceof LedgerLockTimeoutError || err instanceof LedgerLockUnavailableError) {
        debugLog("feedback.lock-failure", `batch_record_actuals (${candidates.length} entries) abandoned: ${err.message}`);
        const hint = err instanceof LedgerLockUnavailableError ? lockUnavailableHint(err) : lockTimeoutHint(err);
        for (const candidate of candidates) {
          if (perEntry[candidate.index] === undefined) {
            perEntry[candidate.index] = { ok: false, reason: "write_failed", hint };
          }
        }
      } else {
        throw err;
      }
    }
  }

  // Ticket 04 (feedback contract): per-entry error strings carry the failure
  // REASON (e.g. "(reason: duplicate)") verbatim — callers (MCP
  // batch_record_actuals, HTTP batch endpoint) surface these strings, so the
  // reason must survive the batch path. Same shape, same entry order.
  const errors: string[] = [];
  let succeeded = 0;
  for (const [index, entry] of entries.entries()) {
    const result = perEntry[index] ?? { ok: false as const, reason: "write_failed" as const };
    if (result.ok) {
      succeeded++;
    } else {
      errors.push(`Failed to record actual for estimate ${entry.estimateId} (reason: ${result.reason})${result.hint ? ` — ${result.hint}` : ""}`);
    }
  }

  return { total: entries.length, succeeded, failed: errors.length, errors };
}

// ---- Feedback Health Report -------------------------------------------------

