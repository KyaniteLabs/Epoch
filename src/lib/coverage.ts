// ---------------------------------------------------------------------------
// Epoch Interval Coverage — P50/P80/P90 prediction intervals + calibration
// ---------------------------------------------------------------------------
//
// Computes prediction intervals around an estimate and, separately, a
// coverage-calibration report: what fraction of recorded actuals actually
// landed inside their predicted P80 interval (target: 0.80). Surfaced as an
// additive `intervalCoverage` block on the `feedback_health` tool output
// (see src/dispatcher/tool-registry.ts — merged in at the dispatcher layer,
// not baked into FeedbackHealthReport, to avoid an import cycle: this module
// reuses feedback.ts's extractEstimatedHours(), so feedback.ts must not
// import this module back).
//
// Two interval sources, chosen per matched record:
//   1. "pert_variance" — for pert_estimate rows, the estimate's own recorded
//      `expected`/`stdDeviation` (persisted on the ledger row's outputs)
//      are used directly with a normal-distribution z-score approximation.
//      This is the more principled source when it's available, since it
//      reflects the actual three-point spread the caller supplied.
//   2. "empirical_ratio_quantile" — for every other tool (and for
//      pert_estimate rows without a usable variance), intervals are derived
//      from the empirical distribution of actual/estimate ratios for
//      exclusion-filtered matched pairs of the same task_type, via the
//      shared overlay-merge loader (ledger.ts) + shared exclusion predicate
//      (exclusion.ts) — the same "clean path" established in
//      calibration-factors.ts. Requires at least MIN_N_FOR_QUANTILES (5)
//      matched pairs for that task_type, matching the existing "sufficient
//      data" threshold used by referenceClassEstimate() in analytics.ts; a
//      task_type below the threshold reports method "insufficient_data"
//      rather than fabricating an interval from too few points.
//
// Coverage-calibration methodology note (documented honestly, per the
// no-fabricated-estimate rule): this is an IN-SAMPLE check — the empirical
// quantiles for a task_type are computed from the same corpus of matched
// pairs whose coverage is then scored against those quantiles (this module
// does not do leave-one-out cross-validation). It is a coverage SANITY
// CHECK, not an out-of-sample validation. Drift from the 0.80 target is a
// signal to revisit interval width, not a guarantee of future calibration.
// ---------------------------------------------------------------------------

import { loadLedgerWithOverlays } from "./ledger.js";
import { isExcluded } from "./exclusion.js";
import { extractEstimatedHours } from "./feedback.js";

/** Matches the "sufficient data" threshold used elsewhere (analytics.ts referenceClassEstimate, `filtered.length >= 5`). */
export const MIN_N_FOR_QUANTILES = 5;

export interface Interval {
  readonly lower: number;
  readonly upper: number;
}

export type IntervalSource = "pert_variance" | "empirical_ratio_quantile";

export interface PredictedIntervals {
  readonly p50: Interval;
  readonly p80: Interval;
  readonly p90: Interval;
  readonly source: IntervalSource;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function clampedInterval(lower: number, upper: number): Interval {
  return { lower: round(Math.max(0, lower), 2), upper: round(Math.max(0, upper), 2) };
}

// Two-sided normal-distribution z-scores for central coverage intervals.
const Z_P50 = 0.674;
const Z_P80 = 1.282;
const Z_P90 = 1.645;

/**
 * P50/P80/P90 intervals from a PERT estimate's own expected value + standard
 * deviation, via a normal-distribution approximation. Lower bounds are
 * clamped at 0 (durations can't go negative).
 */
export function pertVarianceIntervals(expected: number, stdDeviation: number): PredictedIntervals {
  return {
    p50: clampedInterval(expected - Z_P50 * stdDeviation, expected + Z_P50 * stdDeviation),
    p80: clampedInterval(expected - Z_P80 * stdDeviation, expected + Z_P80 * stdDeviation),
    p90: clampedInterval(expected - Z_P90 * stdDeviation, expected + Z_P90 * stdDeviation),
    source: "pert_variance",
  };
}

/** Nearest-rank quantile over a pre-sorted-ascending array. Matches the convention in reference-db-recalculation.ts's percentile(). */
function quantile(sortedAsc: readonly number[], q: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.round(q * (sortedAsc.length - 1))));
  return sortedAsc[idx] ?? 0;
}

export interface RatioQuantiles {
  readonly n: number;
  readonly p50: readonly [number, number];
  readonly p80: readonly [number, number];
  readonly p90: readonly [number, number];
}

/**
 * Empirical actual/estimate ratio quantiles for a set of ratios. Returns
 * null when below MIN_N_FOR_QUANTILES — callers must treat that as "cannot
 * predict an interval from this data", not silently substitute a guess.
 */
export function empiricalRatioQuantiles(ratios: readonly number[]): RatioQuantiles | null {
  if (ratios.length < MIN_N_FOR_QUANTILES) return null;
  const sorted = [...ratios].sort((a, b) => a - b);
  return {
    n: sorted.length,
    p50: [quantile(sorted, 0.25), quantile(sorted, 0.75)],
    p80: [quantile(sorted, 0.10), quantile(sorted, 0.90)],
    p90: [quantile(sorted, 0.05), quantile(sorted, 0.95)],
  };
}

/** Apply ratio quantiles to a specific estimated-hours value to get absolute-hour intervals. */
export function empiricalIntervals(estimatedHours: number, quantiles: RatioQuantiles): PredictedIntervals {
  return {
    p50: clampedInterval(estimatedHours * quantiles.p50[0], estimatedHours * quantiles.p50[1]),
    p80: clampedInterval(estimatedHours * quantiles.p80[0], estimatedHours * quantiles.p80[1]),
    p90: clampedInterval(estimatedHours * quantiles.p90[0], estimatedHours * quantiles.p90[1]),
    source: "empirical_ratio_quantile",
  };
}

export type CoverageMethod = IntervalSource | "mixed" | "insufficient_data";

export interface TaskTypeCoverage {
  readonly n: number;
  readonly p80CoverageRate: number | null;
  readonly method: CoverageMethod;
}

export interface IntervalCoverageReport {
  readonly n: number;
  readonly p80CoverageRate: number | null;
  readonly targetP80Coverage: 0.8;
  readonly byTaskType: Record<string, TaskTypeCoverage>;
  readonly note: string;
}

interface CleanPair {
  readonly taskType: string;
  readonly tool: string;
  readonly estimatedHours: number;
  readonly actualHours: number;
  readonly expected?: number;
  readonly stdDeviation?: number;
}

/** Load exclusion-filtered, overlay-merged matched pairs with enough data to predict an interval. Mirrors calibration-factors.ts's loadPertMatchedRecords() "clean path" pattern, generalized to every tool. */
function loadCleanMatchedPairs(): CleanPair[] {
  const merged = loadLedgerWithOverlays();
  const pairs: CleanPair[] = [];

  for (const rec of merged) {
    if (!rec.actual) continue;
    if (!(rec.actual.actualHours > 0)) continue;

    const estimatedHours = extractEstimatedHours(rec.outputs);
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
    const expected = typeof rec.outputs["expected"] === "number" ? rec.outputs["expected"] : undefined;
    const stdDeviation = typeof rec.outputs["stdDeviation"] === "number" ? rec.outputs["stdDeviation"] : undefined;

    pairs.push({
      taskType,
      tool: rec.tool,
      estimatedHours,
      actualHours: rec.actual.actualHours,
      ...(expected !== undefined && { expected }),
      ...(stdDeviation !== undefined && { stdDeviation }),
    });
  }

  return pairs;
}

/**
 * Empirical actual/estimate ratio quantiles for a single task_type, computed
 * from the exclusion-filtered, overlay-merged matched-pair corpus across
 * EVERY tool (not just one). Used by the pert_estimate and
 * reference_class_estimate tool handlers (tool-registry.ts) to lead their
 * `humanReadable` output with a calibrated interval instead of a bare point
 * estimate. Returns null below MIN_N_FOR_QUANTILES — callers must fall back
 * (e.g. to pertVarianceIntervals for pert_estimate) rather than fabricate.
 */
export function empiricalRatioQuantilesForTaskType(taskType: string): RatioQuantiles | null {
  const ratios = loadCleanMatchedPairs()
    .filter((pair) => pair.taskType === taskType)
    .map((pair) => pair.actualHours / pair.estimatedHours);
  return empiricalRatioQuantiles(ratios);
}

function predictInterval(pair: CleanPair, quantilesByType: Map<string, RatioQuantiles | null>): PredictedIntervals | null {
  if (pair.tool === "pert_estimate" && pair.expected !== undefined && pair.stdDeviation !== undefined && pair.stdDeviation >= 0) {
    return pertVarianceIntervals(pair.expected, pair.stdDeviation);
  }
  const quantiles = quantilesByType.get(pair.taskType);
  if (!quantiles) return null;
  return empiricalIntervals(pair.estimatedHours, quantiles);
}

/**
 * Compute the P80 coverage-calibration report over the current exclusion-
 * filtered ledger: what fraction of matched actuals fell inside their
 * predicted P80 interval, overall and per task_type. See the file header
 * for the interval-source and in-sample-methodology notes.
 */
export function computeIntervalCoverage(): IntervalCoverageReport {
  const pairs = loadCleanMatchedPairs();

  const ratiosByType = new Map<string, number[]>();
  for (const pair of pairs) {
    const arr = ratiosByType.get(pair.taskType) ?? [];
    arr.push(pair.actualHours / pair.estimatedHours);
    ratiosByType.set(pair.taskType, arr);
  }
  const quantilesByType = new Map<string, RatioQuantiles | null>();
  for (const [taskType, ratios] of ratiosByType) {
    quantilesByType.set(taskType, empiricalRatioQuantiles(ratios));
  }

  let totalScored = 0;
  let totalHits = 0;
  const typeTotals = new Map<string, number>();
  const typeHits = new Map<string, number>();
  const typeSources = new Map<string, Set<IntervalSource>>();

  for (const pair of pairs) {
    const interval = predictInterval(pair, quantilesByType);
    if (!interval) continue; // insufficient data to predict an interval — skip rather than fabricate

    totalScored += 1;
    typeTotals.set(pair.taskType, (typeTotals.get(pair.taskType) ?? 0) + 1);
    const sources = typeSources.get(pair.taskType) ?? new Set<IntervalSource>();
    sources.add(interval.source);
    typeSources.set(pair.taskType, sources);

    const within = pair.actualHours >= interval.p80.lower && pair.actualHours <= interval.p80.upper;
    if (within) {
      totalHits += 1;
      typeHits.set(pair.taskType, (typeHits.get(pair.taskType) ?? 0) + 1);
    }
  }

  const byTaskType: Record<string, TaskTypeCoverage> = {};
  const allTaskTypes = new Set<string>([...typeTotals.keys(), ...ratiosByType.keys()]);
  for (const taskType of allTaskTypes) {
    const n = typeTotals.get(taskType) ?? 0;
    if (n === 0) {
      byTaskType[taskType] = { n: 0, p80CoverageRate: null, method: "insufficient_data" };
      continue;
    }
    const hits = typeHits.get(taskType) ?? 0;
    const sources = typeSources.get(taskType) ?? new Set<IntervalSource>();
    const method: CoverageMethod = sources.size > 1 ? "mixed" : [...sources][0] ?? "insufficient_data";
    byTaskType[taskType] = { n, p80CoverageRate: round(hits / n, 3), method };
  }

  return {
    n: totalScored,
    p80CoverageRate: totalScored > 0 ? round(totalHits / totalScored, 3) : null,
    targetP80Coverage: 0.8,
    byTaskType,
    note:
      "In-sample calibration: P80 intervals for pert_estimate rows use their own recorded expected/stdDeviation; " +
      "every other tool uses per-task-type empirical actual/estimate ratio quantiles from the same exclusion-filtered " +
      `corpus (minimum ${MIN_N_FOR_QUANTILES} matched pairs per task_type; below that, method is "insufficient_data" ` +
      "and the pair is excluded from the coverage rate rather than scored against a fabricated interval). This is a " +
      "coverage sanity check against the 0.80 target, not an out-of-sample validation.",
  };
}
