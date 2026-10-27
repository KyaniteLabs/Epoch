/** Health report for the feedback pipeline (split from feedback.ts).

    One pass over the ledgers: coverage, per-tool/per-type calibration
    readiness and data-quality signals. Depends on the analytics module. */
import type { HistoricalRecord } from "../types/index.js";
import { readLines, dataDir, joinActualsEarliestReported, countDuplicateActuals, getLedgerCorruptLines, ESTIMATES_FILE, ACTUALS_FILE } from "./ledger.js";
import type { EstimateRecord, ActualRecord } from "./ledger.js";
import { isExcluded } from "./exclusion.js";
import { join } from "node:path";
import { ESTIMATION_TOOL_NAMES } from "./tool-aliases.js";
import { isGitDerivedProvenance } from "./exclusion.js";
import { computeAccuracyMetrics } from "./accuracy-metrics.js";
import { matchEstimatesToActuals, extractEstimatedHours, inferTaskType, minNForVerdict, overlayFlagsById, exclusionActualFields } from "./feedback-analytics.js";

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


export interface FeedbackHealthReport {
  totalEstimates: number;
  totalActuals: number;
  matchedPairs: number;
  seedRecordsFiltered: number;
  /**
   * Ticket 18 (D3): count of estimateIds carrying more than one actual row.
   * Zero is the write lock's invariant; non-zero means duplicates exist on
   * disk (pre-lock history or a non-cooperating writer) and are being
   * resolved deterministically (earliest-reportedAt wins).
   */
  duplicateActuals: number;
  /**
   * Ticket 18: non-empty ledger lines (estimates + actuals) that failed
   * JSON.parse as of this report's reads — previously skipped silently, now
   * counted (torn writes / corruption made visible).
   */
  corruptLines: number;
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
    /**
     * Matched pairs stamped git_derived / git_derived_review_inclusive (S1.1
     * mine-git): cycle-time actuals mined from local git history. Segmented
     * exactly like auto_wallclock so calendar-window noise never silently
     * blends into verified actuals — the dev window and the review-inclusive
     * window share this bucket (the window distinction lives on each
     * actual's own provenance stamp).
     */
    gitDerived: { matchedPairs: number; mdape: number | null; cappedMdape: number | null };
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

  // Ticket 18 counters: duplicate actuals (join-side) and corrupt lines
  // (read-side, populated by the readLines calls above — skipped lines were
  // always dropped silently; now the drop count is visible).
  const duplicateActuals = countDuplicateActuals(actuals);
  const corruptLineCounts = getLedgerCorruptLines();
  const corruptLines =
    (corruptLineCounts.get(join(dataDir(), ESTIMATES_FILE)) ?? 0) +
    (corruptLineCounts.get(join(dataDir(), ACTUALS_FILE)) ?? 0);

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
  // Recount iterates the SAME earliest-reported join winners the matcher
  // calibrates (review M2): a later duplicate actual that would be excluded
  // cannot inflate the count while a clean earlier winner joined.
  const estimatesById = new Map<string, EstimateRecord>();
  for (const e of estimates) estimatesById.set(e.id, e);
  const joinedActuals = joinActualsEarliestReported(actuals);
  let seedRecordsFiltered = 0;
  for (const a of joinedActuals.values()) {
    const est = estimatesById.get(a.estimateId);
    if (!est) continue;
    const estHours = extractEstimatedHours(est.outputs);
    const verdict = isExcluded({
      id: est.id,
      tool: est.tool,
      inputs: est.inputs,
      estimatedAt: est.estimatedAt,
      estimatedHours: estHours,
      actual: exclusionActualFields(a),
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

  // byProvenance (Wave 2 auto-actuals + S1.1 mine-git): split the same
  // correctionMatched population used by byTool/byTaskType into verified vs
  // auto_wallclock vs git-derived so drift between the buckets is visible
  // without waiting for a manual audit.
  const autoMatched = correctionMatched.filter((r) => r.calibrationProvenance === "auto_wallclock");
  const gitDerivedMatched = correctionMatched.filter((r) => isGitDerivedProvenance(r.calibrationProvenance));
  const verifiedMatched = correctionMatched.filter(
    (r) => r.calibrationProvenance !== "auto_wallclock" && !isGitDerivedProvenance(r.calibrationProvenance),
  );
  const autoMetrics = autoMatched.length >= 2 ? computeAccuracyMetrics(autoMatched) : null;
  const verifiedMetrics = verifiedMatched.length >= 2 ? computeAccuracyMetrics(verifiedMatched) : null;
  const gitDerivedMetrics = gitDerivedMatched.length >= 2 ? computeAccuracyMetrics(gitDerivedMatched) : null;
  const byProvenance: FeedbackHealthReport["byProvenance"] = {
    verified: { matchedPairs: verifiedMatched.length, mdape: verifiedMetrics?.mdape ?? null, cappedMdape: verifiedMetrics?.cappedMdape ?? null },
    auto: { matchedPairs: autoMatched.length, mdape: autoMetrics?.mdape ?? null, cappedMdape: autoMetrics?.cappedMdape ?? null },
    gitDerived: { matchedPairs: gitDerivedMatched.length, mdape: gitDerivedMetrics?.mdape ?? null, cappedMdape: gitDerivedMetrics?.cappedMdape ?? null },
  };

  // Ticket 18: integrity visibility appended only when non-zero, so the
  // base humanReadable stays byte-identical for healthy ledgers.
  const integrityLabel =
    duplicateActuals > 0 || corruptLines > 0
      ? ` Data integrity: ${duplicateActuals} estimate id${duplicateActuals === 1 ? "" : "s"} with duplicate actuals (earliest-reported wins the join), ${corruptLines} corrupt ledger line${corruptLines === 1 ? "" : "s"} skipped.`
      : "";

  return {
    totalEstimates,
    totalActuals,
    matchedPairs: correctionMatched.length,
    seedRecordsFiltered,
    duplicateActuals,
    corruptLines,
    provenance: { correctionRecords: correctionMatched.length, baselineRecords, excludedRecords: seedRecordsFiltered },
    matchRate,
    byTool,
    byTaskType,
    byProvenance,
    selfImprovement: { readyTypes, callsUntilUpdate },
    dataQuality: { overallMdape, overallCappedMdape, outlierRatio, recommendation, dataCompletenessScore },
    humanReadable: `${correctionMatched.length} correction-eligible matched pairs across ${toolsWithData} tools and ${typesWithData} task types (capped MdAPE: ${cappedLabel}, raw MdAPE: ${mdapeLabel}; ${baselineRecords} baseline-only records held out). ${totalEstimates} estimates, ${totalActuals} actuals, match rate: ${matchRate}%${seedLabel}. ${recommendation}${integrityLabel}`,
  };
}
