// ---------------------------------------------------------------------------
// Epoch Shared Exclusion Predicate
// ---------------------------------------------------------------------------
//
// Single source of truth for whether a ledger record (an estimate, optionally
// joined with its actual) should be excluded from calibration / accuracy /
// correction-factor math. Every reader of the ledger (feedback.ts's
// matchEstimatesToActuals — and, transitively, every consumer of it such as
// analytics.ts, calibration-factors.ts, reference-db-recalculation.ts — plus
// the shared overlay loader in ledger.ts) must route candidate records
// through isExcluded() rather than reimplementing any of these checks.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 1 Task 4 ("shared exclusion predicate") and Pre-mortem Scenario 1
// (over-matching the 2026-05-05 backfill) / Scenario 6 (skipped-join guard).

/** Reasons isExcluded() can report. Exactly one is returned per verdict. */
export type ExclusionReason =
  | "quarantine_flag"
  | "orphan"
  | "synthetic_id"
  | "explicit_exclude"
  | "seed_notes"
  | "smoke"
  | "industry_calibration_note"
  | "backfill_signature"
  | "ratio_outlier"
  | "below_calibration_threshold"
  | "ttl_expired"
  | "auto_wallclock_sanity_gate";

export interface ExclusionVerdict {
  excluded: boolean;
  reason?: ExclusionReason;
}

/** The actual-side of a matched estimate/actual pair, as far as exclusion cares. */
export interface ExclusionActual {
  actualHours: number;
  notes?: string;
  reportedAt?: string;
  completedAt?: string;
  /** Explicit provenance/usage carried on the actual record itself (legacy ingest paths). */
  calibrationProvenance?: string;
  calibrationUsage?: string;
  calibration_provenance?: string;
  calibration_usage?: string;
}

/** Overlay flags merged in by ledger.ts's loadLedgerWithOverlays(), if any. */
export interface ExclusionOverlayFlags {
  quarantined?: boolean;
  orphan?: boolean;
}

/** The normalized shape isExcluded() evaluates. Callers build this from their own record types. */
export interface ExclusionRecord {
  id: string;
  tool: string;
  inputs?: Record<string, unknown>;
  estimatedAt: string;
  /** Extracted estimated hours for the estimate's headline output, if derivable. */
  estimatedHours?: number | null;
  /** Present only for records with a matched actual. Pending (unmatched) estimates omit this. */
  actual?: ExclusionActual;
  /** Overlay flags from the shared ledger loader (default: none). */
  flags?: ExclusionOverlayFlags;
  /** Pending-estimate TTL expiry (Phase 1 Task 7); only meaningful when `actual` is absent. */
  expiresAt?: string;
}

/** Prefixes that indicate synthetic/test/batch data, not real estimates or actuals. */
export const SYNTHETIC_ID_PREFIXES = [
  "seed-",
  "test-",
  "batch-test-",
  "batch-max-",
  "batch-single-",
  "synth-",
  "demo-",
  "example-",
  "sample-",
  "fake-",
  // Verified 2026-07-10 against a read-only copy of the live ~/.epoch ledger
  // (loose-ends cleanup): old http-test-harness / feedback-batch-test runs
  // leaked exactly 472 rows under these two additional prefixes — all as
  // orphaned feedback.jsonl actuals, none as estimates.jsonl rows. See
  // src/lib/migrations/flag-test-fixture-rows.ts for the migration that
  // overlay-flags the leaked rows.
  "http-test-estimate-",
  "fb-batch-",
  "fb-max-",
  "fb-single-",
] as const;

/** Check if a bare id string (estimate id or actual's estimateId) matches a synthetic prefix pattern. */
export function isSyntheticId(id: string): boolean {
  return SYNTHETIC_ID_PREFIXES.some((prefix) => id.startsWith(prefix));
}

/** Ratio threshold — actual/estimate below this indicates synthetic/seed data. */
export const MIN_RATIO = 0.03;
/** Actuals below this threshold are stored but excluded from calibration math as microtask artifacts. */
export const MINIMUM_CALIBRATION_ACTUAL_HOURS = 0.01;
/** Relative tolerance for treating actual === estimate as an exact ("fake-perfect") match. */
export const EXACT_MATCH_EPSILON = 0.005;
/** UTC calendar-date signature of the known exact-match backfill batch (audit finding). */
export const BACKFILL_SIGNATURE_DATE = "2026-05-05";

/**
 * Sanity-gate bounds for `auto_wallclock` actuals (Wave 2 auto-actuals
 * feature). Wall-clock-derived actuals are an honest proxy for session
 * duration, not verified focused effort — they're included in correction
 * training by default, but only within a narrow, dedicated band. Below the
 * minimum, wall-clock noise (a session that "ended" seconds after the
 * estimate) dominates; above the maximum, the actual likely spans idle time
 * (breaks, multi-day sessions) rather than work on the estimated task.
 */
export const AUTO_WALLCLOCK_MIN_HOURS = 0.05;
export const AUTO_WALLCLOCK_MAX_HOURS = 12;
/**
 * Ratio threshold (either direction) between an auto_wallclock actual and
 * its matched estimate above which the pair is excluded as unit-suspect —
 * mirrors feedback.ts's UNIT_SUSPECT_RATIO. Kept here (not imported from
 * feedback.ts, which itself imports from this module) so isExcluded() and
 * feedback.ts's write-time guard share one constant without a cycle.
 */
export const AUTO_WALLCLOCK_RATIO_LIMIT = 10;

/**
 * True when an `auto_wallclock` actual passes the dedicated sanity gate:
 * within [AUTO_WALLCLOCK_MIN_HOURS, AUTO_WALLCLOCK_MAX_HOURS], and — when a
 * matched estimate's hours are known — the ratio between actual and
 * estimated hours (either direction) is below AUTO_WALLCLOCK_RATIO_LIMIT.
 * Single source of truth reused by the auto-actuals CLI's pre-filter,
 * feedback.ts's write-time guard, and isExcluded()'s calibration-math gate.
 */
export function isAutoWallclockSane(actualHours: number, estimatedHours?: number | null): boolean {
  if (actualHours < AUTO_WALLCLOCK_MIN_HOURS || actualHours > AUTO_WALLCLOCK_MAX_HOURS) return false;
  if (estimatedHours != null && estimatedHours > 0) {
    const ratio = Math.max(actualHours / estimatedHours, estimatedHours / actualHours);
    if (ratio >= AUTO_WALLCLOCK_RATIO_LIMIT) return false;
  }
  return true;
}

const VALID_PROVENANCE = new Set([
  "prospective",
  "backfilled_real_session",
  "backfilled_calibration",
  "synthetic",
  "smoke",
  "unknown",
  "auto_wallclock",
]);
const VALID_USAGE = new Set(["correction", "baseline", "exclude"]);

function normalizeString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeProvenance(value: unknown): string | undefined {
  const raw = normalizeString(value);
  return raw && VALID_PROVENANCE.has(raw) ? raw : undefined;
}

function normalizeUsage(value: unknown): string | undefined {
  const raw = normalizeString(value);
  return raw && VALID_USAGE.has(raw) ? raw : undefined;
}

function hasSeedNotes(notes: string | undefined): boolean {
  const n = (notes ?? "").toLowerCase();
  return n.includes("seed") || n.includes("synthetic") || n.includes("dogfood-seed") || n.includes("test data");
}

function hasSmokeSignature(tool: string, notes: string | undefined): boolean {
  const n = (notes ?? "").toLowerCase();
  return tool.toLowerCase() === "receiver_smoke" || n.includes("receiver smoke") || n.includes("smoke test");
}

function hasIndustryCalibrationNote(notes: string | undefined): boolean {
  return (notes ?? "").toLowerCase().includes("industry calibration");
}

function isoDate(ts: string | undefined): string | null {
  if (!ts) return null;
  const parsed = new Date(ts);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function hasBackfillDateSignature(record: ExclusionRecord): boolean {
  return (
    isoDate(record.estimatedAt) === BACKFILL_SIGNATURE_DATE ||
    isoDate(record.actual?.reportedAt) === BACKFILL_SIGNATURE_DATE ||
    isoDate(record.actual?.completedAt) === BACKFILL_SIGNATURE_DATE
  );
}

function isExactMatch(estimatedHours: number, actualHours: number): boolean {
  if (estimatedHours <= 0) return false;
  const ratio = actualHours / estimatedHours;
  return Math.abs(ratio - 1) <= EXACT_MATCH_EPSILON;
}

/**
 * The single exclusion predicate. Subsumes: exact-match-epsilon + 2026-05-05
 * backfill signature (BOTH required — Pre-mortem Scenario 1), seed/synthetic,
 * smoke, orphan, quarantine-flag, and pending-TTL expiry.
 *
 * Every reader must run candidate records through this function — directly,
 * or transitively via matchEstimatesToActuals() / loadLedgerWithOverlays() —
 * before including them in calibration/accuracy/correction-factor math.
 */
export function isExcluded(record: ExclusionRecord, now: Date = new Date()): ExclusionVerdict {
  // Explicit overlay flags win first — an auditable human/pipeline decision
  // recorded via the shared ledger, never inferred.
  if (record.flags?.quarantined) return { excluded: true, reason: "quarantine_flag" };
  if (record.flags?.orphan) return { excluded: true, reason: "orphan" };

  if (isSyntheticId(record.id)) return { excluded: true, reason: "synthetic_id" };

  // No actual recorded yet (pending estimate) — only TTL expiry can exclude it.
  if (!record.actual) {
    if (record.expiresAt && Date.parse(record.expiresAt) < now.getTime()) {
      return { excluded: true, reason: "ttl_expired" };
    }
    return { excluded: false };
  }

  const { actual } = record;

  const explicitProvenance = normalizeProvenance(
    record.inputs?.["calibration_provenance"] ?? actual.calibrationProvenance ?? actual.calibration_provenance,
  );
  const explicitUsage = normalizeUsage(
    record.inputs?.["calibration_usage"] ?? actual.calibrationUsage ?? actual.calibration_usage,
  );
  if (explicitUsage === "exclude" || explicitProvenance === "synthetic" || explicitProvenance === "smoke") {
    return { excluded: true, reason: "explicit_exclude" };
  }

  if (actual.actualHours < MINIMUM_CALIBRATION_ACTUAL_HOURS) {
    return { excluded: true, reason: "below_calibration_threshold" };
  }

  if (explicitProvenance === "auto_wallclock" && !isAutoWallclockSane(actual.actualHours, record.estimatedHours)) {
    return { excluded: true, reason: "auto_wallclock_sanity_gate" };
  }

  if (hasSeedNotes(actual.notes)) return { excluded: true, reason: "seed_notes" };
  if (hasSmokeSignature(record.tool, actual.notes)) return { excluded: true, reason: "smoke" };
  if (hasIndustryCalibrationNote(actual.notes)) return { excluded: true, reason: "industry_calibration_note" };

  if (record.estimatedHours != null && record.estimatedHours > 0) {
    if (isExactMatch(record.estimatedHours, actual.actualHours) && hasBackfillDateSignature(record)) {
      return { excluded: true, reason: "backfill_signature" };
    }
    if (actual.actualHours / record.estimatedHours < MIN_RATIO) {
      return { excluded: true, reason: "ratio_outlier" };
    }
  }

  return { excluded: false };
}
