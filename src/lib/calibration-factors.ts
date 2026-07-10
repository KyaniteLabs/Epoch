import type { HistoricalRecord } from "../types/index.js";
import { loadLedgerWithOverlays } from "./ledger.js";
import { isExcluded } from "./exclusion.js";

export const MIN_RECORDS_FOR_DATABASE_UPDATE = 5;
export const MIN_RECORDS_PER_FACTOR = 3;
const MIN_FACTOR = 0.1;
const MAX_FACTOR = 3.0;

function roundFactor(value: number): number {
  return Math.round(Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, value)) * 100) / 100;
}

function median(values: number[], fallback: number): number {
  if (values.length === 0) return fallback;
  values.sort((a, b) => a - b);
  const mid = Math.floor(values.length / 2);
  return values.length % 2 === 0
    ? ((values[mid - 1] ?? fallback) + (values[mid] ?? fallback)) / 2
    : (values[mid] ?? fallback);
}

function validRatios(records: HistoricalRecord[]): Array<{ record: HistoricalRecord; ratio: number }> {
  return records
    .filter((record) => record.estimatedHours > 0 && record.actualHours > 0)
    .map((record) => ({ record, ratio: record.actualHours / record.estimatedHours }));
}

export function isCorrectionEligibleRecord(record: HistoricalRecord): boolean {
  return record.calibrationUsage === undefined || record.calibrationUsage === "correction";
}

export function computeTaskTypeCorrectionFactors(records: HistoricalRecord[]): Record<string, number> {
  const grouped = new Map<string, number[]>();
  for (const { record, ratio } of validRatios(records)) {
    const arr = grouped.get(record.taskType) ?? [];
    arr.push(ratio);
    grouped.set(record.taskType, arr);
  }

  const factors: Record<string, number> = {};
  for (const [type, ratios] of grouped) {
    if (ratios.length < MIN_RECORDS_PER_FACTOR) continue;
    factors[type] = roundFactor(median(ratios, 1.8));
  }

  return factors;
}

export function computeGlobalCorrectionFactor(records: HistoricalRecord[], fallback = 1.07): number {
  const ratios = validRatios(records).map(({ ratio }) => ratio);
  if (ratios.length === 0) return fallback;
  return roundFactor(median(ratios, fallback));
}

// ---------------------------------------------------------------------------
// Recency weighting (Phase 1 accuracy remediation)
// ---------------------------------------------------------------------------
//
// The PERT backtest (scripts/backtest-pert-correction.mjs) showed the
// unweighted correction factor — trained on ALL matched history with equal
// weight — undercorrects on a chronological held-out split (median
// actual/predicted ~0.55, outside the [0.7, 1.3] Tier-1 band) because the
// operator's actual/estimate ratio has been drifting over time (getting
// faster) and old, slower-era pairs outvote recent ones. Two opt-in recency
// schemes address this; both are OFF by default (`{ kind: "none" }`, the
// historical behavior) so every other caller of computeToolTaskCorrectionFactors
// is unaffected unless it explicitly opts in.

export type RecencyScheme =
  | { readonly kind: "none" }
  | { readonly kind: "exponential"; readonly halfLifeDays: number }
  | { readonly kind: "window"; readonly windowDays: number };

export interface RecencyOptions {
  readonly scheme: RecencyScheme;
  /** Reference date/time for age computation (ISO string). Defaults to now. */
  readonly asOf?: string;
  /** Minimum pairs required for the "window" scheme before falling back to all-history for that cell. Defaults to MIN_RECORDS_PER_FACTOR. */
  readonly minRecords?: number;
}

/** Weighted median (50th percentile by cumulative weight) over (value, weight) pairs. Reduces to the standard upper-median rule when all weights are equal. */
function weightedMedian(items: ReadonlyArray<{ value: number; weight: number }>, fallback: number): number {
  const valid = items.filter((item) => item.weight > 0);
  if (valid.length === 0) return fallback;
  const sorted = [...valid].sort((a, b) => a.value - b.value);
  const total = sorted.reduce((sum, item) => sum + item.weight, 0);
  let cumulative = 0;
  for (const item of sorted) {
    cumulative += item.weight;
    if (cumulative >= total / 2) return item.value;
  }
  return sorted[sorted.length - 1]?.value ?? fallback;
}

/** Age in days of `completedAt` relative to `asOfMs`. Unparseable dates are treated as age 0 (full weight) rather than excluded. */
function ageDaysOf(completedAt: string, asOfMs: number): number {
  const t = Date.parse(completedAt);
  if (Number.isNaN(t)) return 0;
  return Math.max(0, (asOfMs - t) / 86_400_000);
}

function exponentialWeight(ageDays: number, halfLifeDays: number): number {
  if (halfLifeDays <= 0) return 1;
  return Math.pow(2, -ageDays / halfLifeDays);
}

export function computeToolTaskCorrectionFactors(
  records: HistoricalRecord[],
  recency?: RecencyOptions,
): Record<string, Record<string, number>> {
  const grouped = new Map<string, Map<string, Array<{ record: HistoricalRecord; ratio: number }>>>();
  for (const pair of validRatios(records)) {
    const tool = pair.record.tool ?? "unknown";
    let taskMap = grouped.get(tool);
    if (!taskMap) {
      taskMap = new Map();
      grouped.set(tool, taskMap);
    }
    const arr = taskMap.get(pair.record.taskType) ?? [];
    arr.push(pair);
    taskMap.set(pair.record.taskType, arr);
  }

  const scheme = recency?.scheme ?? { kind: "none" as const };
  const asOfMs = recency?.asOf !== undefined ? Date.parse(recency.asOf) : Date.now();
  const minRecords = recency?.minRecords ?? MIN_RECORDS_PER_FACTOR;

  const result: Record<string, Record<string, number>> = {};
  for (const [tool, taskMap] of grouped) {
    const toolFactors: Record<string, number> = {};
    for (const [taskType, pairs] of taskMap) {
      // Low-n gate is always evaluated on the raw matched-pair count for this
      // cell, regardless of recency scheme — never relaxed by weighting.
      if (pairs.length < MIN_RECORDS_PER_FACTOR) continue;

      let factor: number;
      if (scheme.kind === "none") {
        factor = roundFactor(median(pairs.map((p) => p.ratio), 1.4));
      } else if (scheme.kind === "exponential") {
        const weighted = pairs.map((p) => ({
          value: p.ratio,
          weight: exponentialWeight(ageDaysOf(p.record.completedAt, asOfMs), scheme.halfLifeDays),
        }));
        factor = roundFactor(weightedMedian(weighted, 1.4));
      } else {
        const windowed = pairs.filter((p) => ageDaysOf(p.record.completedAt, asOfMs) <= scheme.windowDays);
        // Hard rolling window with a min-n fallback to all-history for this
        // cell when the window itself doesn't clear MIN_RECORDS_PER_FACTOR.
        const effective = windowed.length >= minRecords ? windowed : pairs;
        factor = roundFactor(median(effective.map((p) => p.ratio), 1.4));
      }
      toolFactors[taskType] = factor;
    }
    result[tool] = toolFactors;
  }
  return result;
}

export function computeComplexityCorrectionFactors(records: HistoricalRecord[]): Record<string, Record<number, number>> {
  const grouped = new Map<string, Map<number, number[]>>();
  for (const { record, ratio } of validRatios(records)) {
    if (record.complexity === undefined) continue;
    const taskMap = grouped.get(record.taskType) ?? new Map<number, number[]>();
    const arr = taskMap.get(record.complexity) ?? [];
    arr.push(ratio);
    taskMap.set(record.complexity, arr);
    grouped.set(record.taskType, taskMap);
  }

  const result: Record<string, Record<number, number>> = {};
  for (const [taskType, taskMap] of grouped) {
    const taskFactors: Record<number, number> = {};
    for (const [complexity, ratios] of taskMap) {
      if (ratios.length < MIN_RECORDS_PER_FACTOR) continue;
      taskFactors[complexity] = roundFactor(median(ratios, 1.0));
    }
    if (Object.keys(taskFactors).length > 0) {
      result[taskType] = taskFactors;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// PERT learned-correction wiring (Phase 1 Task 0)
// ---------------------------------------------------------------------------
//
// Feature-flagged (EPOCH_PERT_LEARNED_CORRECTION, default OFF). Loads matched
// pert_estimate pairs via the shared overlay-merge loader (ledger.ts) +
// shared exclusion predicate (exclusion.ts) — "the clean path" — and computes
// a per-(tool='pert_estimate', task_type) correction factor via
// computeToolTaskCorrectionFactors(). Composition rule (no double-correction):
// the learned factor REPLACES the ai_native developerProfile.correctionFactor
// heuristic in the adjustedEstimate computation only when the matching cell
// has n >= MIN_RECORDS_PER_FACTOR; otherwise the profile factor (or, absent a
// profile, a neutral 1.0 with a low-n note) is used unchanged. Never multiply
// both. Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 1 Task 0.

const PERT_TOOL = "pert_estimate";

/** True when EPOCH_PERT_LEARNED_CORRECTION is enabled (default: OFF). */
export function isPertLearnedCorrectionEnabled(): boolean {
  const raw = process.env["EPOCH_PERT_LEARNED_CORRECTION"];
  return raw === "1" || raw === "true";
}

/** Extract estimated hours from a pert_estimate output shape ({ expected, unit }). */
function extractPertEstimatedHours(outputs: Record<string, unknown>): number | null {
  if (typeof outputs["expected"] !== "number") return null;
  const expected = outputs["expected"];
  const unit = outputs["unit"];
  if (typeof unit !== "string") return expected;
  switch (unit) {
    case "hours": return expected;
    case "days": return expected * 8;
    case "weeks": return expected * 40;
    case "months": return expected * 160;
    default: return null; // unrecognized unit — skip to avoid corrupting calibration
  }
}

/**
 * Load exclusion-filtered, overlay-merged pert_estimate matched (estimate,
 * actual) pairs as HistoricalRecord[], ready for computeToolTaskCorrectionFactors.
 * Uses loadLedgerWithOverlays() + isExcluded() directly (the clean path) rather
 * than feedback.ts's matchEstimatesToActuals(), per Task 0 scope.
 */
export function loadPertMatchedRecords(): HistoricalRecord[] {
  const merged = loadLedgerWithOverlays();
  const records: HistoricalRecord[] = [];

  for (const rec of merged) {
    if (rec.tool !== PERT_TOOL) continue;
    if (!rec.actual) continue;
    if (!(rec.actual.actualHours > 0)) continue;

    const estimatedHours = extractPertEstimatedHours(rec.outputs);
    if (estimatedHours === null || !(estimatedHours > 0)) continue;

    const verdict = isExcluded({
      id: rec.id,
      tool: rec.tool,
      inputs: rec.inputs,
      estimatedAt: rec.estimatedAt,
      estimatedHours,
      actual: {
        actualHours: rec.actual.actualHours,
        notes: rec.actual.notes,
        reportedAt: rec.actual.reportedAt,
        completedAt: rec.actual.completedAt,
        calibrationProvenance: rec.actual.calibrationProvenance,
      },
      flags: { quarantined: rec.flags.quarantined, orphan: rec.flags.orphan },
      ...(rec.expiresAt && { expiresAt: rec.expiresAt }),
    });
    if (verdict.excluded) continue;

    const taskType = typeof rec.inputs["task_type"] === "string" ? (rec.inputs["task_type"] as string) : "feature";
    const complexity = typeof rec.inputs["complexity"] === "number" ? rec.inputs["complexity"] : undefined;

    records.push({
      taskType,
      estimatedHours,
      actualHours: rec.actual.actualHours,
      tool: rec.tool,
      ...(complexity !== undefined && { complexity }),
      completedAt: rec.actual.completedAt ?? rec.actual.reportedAt ?? "",
    });
  }

  return records;
}

export interface PertToolTaskCorrection {
  factor: number;
  n: number;
}

/**
 * The recency scheme used by default for the (pert_estimate, task_type)
 * learned correction factor. Chosen by scripts/backtest-pert-correction.mjs,
 * which compares unweighted vs exponential-decay (30/45/90d half-life) vs
 * hard rolling-window (60/90/180d, min-n fallback to all-history) variants
 * on a chronological held-out split, then re-checks the winner on an
 * independent 70/30 split as an overfitting guard.
 *
 * Result on the live ~/.epoch corpus at time of writing (~698 matched
 * pert_estimate pairs, ~53-day training span): NONE of the exponential or
 * window variants at the specified half-life/window sizes beat the
 * unweighted baseline — the exponential variants were measurably WORSE
 * (higher MdAPE) and the window variants were IDENTICAL to unweighted
 * because every tested window (60/90/180d) is longer than the entire
 * training history span, so no training pair was ever excluded. Much
 * shorter windows (7-21d) looked attractive on the 80/20 split but failed
 * catastrophically on the 70/30 sanity split (textbook overfitting to a
 * single noisy chunk) — see the backtest script's comparison table. The
 * default therefore stays unweighted ("none", byte-identical to the
 * pre-recency-weighting behavior) until real data shows the "operator gets
 * faster over time" trend cleanly enough for a recency scheme to win the
 * backtest without overfitting. Re-run the backtest as the ledger grows.
 */
export const PERT_CORRECTION_RECENCY_DEFAULT: RecencyOptions = {
  scheme: { kind: "none" },
};

/**
 * Compute the learned (pert_estimate, taskType) correction factor + matched-pair
 * count n from the clean (exclusion-filtered, overlay-merged) ledger. n is the
 * count of matched pairs for this task type regardless of whether that meets
 * MIN_RECORDS_PER_FACTOR — callers (composePertCorrectionFactor) decide whether
 * n qualifies the factor for use. Trains with PERT_CORRECTION_RECENCY_DEFAULT
 * (recency-weighted) unless an explicit `recency` override is supplied.
 */
export function getPertToolTaskCorrection(taskType: string, recency: RecencyOptions = PERT_CORRECTION_RECENCY_DEFAULT): PertToolTaskCorrection {
  const records = loadPertMatchedRecords();
  const n = records.filter((r) => r.taskType === taskType).length;
  const factors = computeToolTaskCorrectionFactors(records, recency);
  const factor = factors[PERT_TOOL]?.[taskType] ?? 1.0;
  return { factor, n };
}

export interface PertCorrectionComposition {
  factor: number;
  n: number;
  source: "learned" | "profile" | "default";
  note?: string;
}

/**
 * Composition rule (no double-correction): if the matching (tool, task_type)
 * cell has n >= MIN_RECORDS_PER_FACTOR, the learned factor REPLACES the
 * developerProfile correction factor. Below that threshold, the developer
 * profile factor is kept unchanged (current behavior); if no profile factor
 * is available at all, falls back to a neutral 1.0 with a human-readable
 * low-n note. The learned and profile factors are never multiplied together.
 */
export function composePertCorrectionFactor(
  learned: PertToolTaskCorrection,
  profileFactor: number | undefined,
): PertCorrectionComposition {
  if (learned.n >= MIN_RECORDS_PER_FACTOR) {
    return { factor: learned.factor, n: learned.n, source: "learned" };
  }
  if (profileFactor !== undefined) {
    return { factor: profileFactor, n: learned.n, source: "profile" };
  }
  return {
    factor: 1.0,
    n: learned.n,
    source: "default",
    note: `Insufficient learned-correction data for this (tool, task_type) pair (n=${learned.n} < ${MIN_RECORDS_PER_FACTOR}) and no developer-profile fallback available; using a neutral correction factor of 1.0.`,
  };
}
