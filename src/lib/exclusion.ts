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
  | "ttl_expired";

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

const VALID_PROVENANCE = new Set([
  "prospective",
  "backfilled_real_session",
  "backfilled_calibration",
  "synthetic",
  "smoke",
  "unknown",
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
