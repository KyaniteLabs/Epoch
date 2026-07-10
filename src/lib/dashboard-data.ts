// ---------------------------------------------------------------------------
// Epoch Calibration Dashboard — dataset computation (Phase 6)
// ---------------------------------------------------------------------------
//
// Pure, read-only computation of the calibration-dashboard dataset consumed
// by scripts/build-calibration-dashboard.mjs. STRICTLY read-only against the
// live Epoch data dir: every number here is derived from the shared,
// exclusion-filtered, overlay-merged API surface (feedback.ts, ledger.ts,
// exclusion.ts, coverage.ts, calibration-factors.ts, accuracy-trend.ts) —
// never a raw read of `estimates.jsonl` / `feedback.jsonl` (see the
// skipped-join guard in ledger.test.ts, Pre-mortem Scenario 6). The one
// exception is the orphan-actual scan, which legitimately needs the raw id
// sets (an actual with no matching estimate never appears as `rec.actual`
// on any loadLedgerWithOverlays() row, so it can't be derived from the
// merged view) — that scan uses ledger.ts's exported `readLines()` +
// `ESTIMATES_FILE`/`ACTUALS_FILE` constants, mirroring the exact pattern
// `src/lib/migrations/repair-orphaned-actuals.ts` already uses.
//
// Extracted from the build script so the dataset math is directly
// unit-testable (dashboard-data.test.ts) without rendering HTML.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 6.

import {
  getFeedbackHealthReport,
  getCalibrationData,
  minNForVerdict,
  getDedupHitCount,
  type FeedbackHealthReport,
} from "./feedback.js";
import { computeAccuracyTrend } from "./accuracy-trend.js";
import { computeIntervalCoverage } from "./coverage.js";
import {
  isPertLearnedCorrectionEnabled,
  computeToolTaskCorrectionFactors,
  MIN_RECORDS_PER_FACTOR,
} from "./calibration-factors.js";
import type { HistoricalRecord } from "./analytics.js";
import {
  loadLedgerWithOverlays,
  readLines,
  dataDir,
  ESTIMATES_FILE,
  ACTUALS_FILE,
  FLAGS_FILE,
  LABELS_FILE,
  QUARANTINE_ARCHIVE_FILE,
  type EstimateRecord,
  type ActualRecord,
} from "./ledger.js";
import { isExcluded, BACKFILL_SIGNATURE_DATE } from "./exclusion.js";
import { TASKTYPE_FILE } from "./migrations/normalize-task-types.js";
import type { AccuracyTrend } from "../types/index.js";

// ---- Shared numeric helpers -------------------------------------------------

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2 : (sorted[mid] ?? 0);
}

/** Median actual/predicted ratio per key (tool or task_type), over correction-eligible matched records. */
function medianRatiosByKey(records: readonly HistoricalRecord[], keyOf: (r: HistoricalRecord) => string): Map<string, number | null> {
  const grouped = new Map<string, number[]>();
  for (const r of records) {
    if (!(r.estimatedHours > 0)) continue;
    const key = keyOf(r);
    const arr = grouped.get(key) ?? [];
    arr.push(r.actualHours / r.estimatedHours);
    grouped.set(key, arr);
  }
  const out = new Map<string, number | null>();
  for (const [key, ratios] of grouped) out.set(key, median(ratios));
  return out;
}

// ---- Section 1: Headline ----------------------------------------------------

export interface DashboardHeadline {
  readonly matchedPairs: number;
  readonly totalEstimates: number;
  readonly totalActuals: number;
  readonly matchRate: number;
  readonly seedRecordsFiltered: number;
  readonly cappedMdape: number | null;
  readonly mdape: number | null;
  readonly trend: AccuracyTrend["overallTrend"];
  readonly trendMinNGated: boolean;
  readonly minNForVerdict: number;
  readonly trendHumanReadable: string;
  readonly recommendation: string;
  readonly remediationNotes: readonly string[];
  readonly soWhat: string;
}

function computeHeadline(health: FeedbackHealthReport, trend: AccuracyTrend, minN: number, integrity: IntegritySection): DashboardHeadline {
  const trendMinNGated = health.matchedPairs < minN;
  const remediationNotes: string[] = [
    `${integrity.quarantine.count} rows quarantined (${integrity.quarantine.backfillSignatureDate} exact-match backfill signature) via append-only overlay flag — excluded from every calibration number below, never deleted from the hot ledger.`,
    `${integrity.labels.count} rows carry a retro-label task_label overlay, sharpening the per-task-type breakdown in Section 3.`,
    `${integrity.orphans.total} feedback rows are orphaned (no matching estimate id); ${integrity.orphans.testFixtureLeakage} are known test-fixture leakage (http-test-/fb-batch-/fb-max-/fb-single-/batch-* prefixes), ${integrity.orphans.unresolved} remain unresolved and are held out of every match-rate figure above.`,
  ];
  const soWhat = trendMinNGated
    ? `Below the minimum-n=${minN} verdict gate — headline numbers are informational only, not yet a calibration verdict.`
    : trend.overallTrend === "improving"
      ? "Accuracy is trending in the right direction — the remediation is working."
      : trend.overallTrend === "degrading"
        ? "Accuracy is trending the wrong way — investigate before trusting new estimates from the affected tools/task types below."
        : "Accuracy is holding steady — no regression, no breakthrough yet.";

  return {
    matchedPairs: health.matchedPairs,
    totalEstimates: health.totalEstimates,
    totalActuals: health.totalActuals,
    matchRate: health.matchRate,
    seedRecordsFiltered: health.seedRecordsFiltered,
    cappedMdape: health.dataQuality.overallCappedMdape,
    mdape: health.dataQuality.overallMdape,
    trend: trend.overallTrend,
    trendMinNGated,
    minNForVerdict: minN,
    trendHumanReadable: trend.humanReadable,
    recommendation: health.dataQuality.recommendation,
    remediationNotes,
    soWhat,
  };
}

// ---- Sections 2 & 3: per-tool / per-task-type calibration -------------------

export interface CalibrationRow {
  readonly key: string;
  readonly estimates: number;
  readonly actuals: number;
  readonly matchedPairs: number;
  readonly medianActualOverPredicted: number | null;
  readonly mdape: number | null;
  readonly cappedMdape: number | null;
  readonly bias: number | null;
  readonly trend: string | null;
  readonly minNGated: boolean;
  readonly recommendation: string;
}

function buildCalibrationRows(
  bucket: FeedbackHealthReport["byTool"] | FeedbackHealthReport["byTaskType"],
  medianByKey: Map<string, number | null>,
  minN: number,
): CalibrationRow[] {
  return Object.entries(bucket)
    .map(([key, v]) => ({
      key,
      estimates: v.estimates,
      actuals: v.actuals,
      matchedPairs: v.matchedPairs,
      medianActualOverPredicted: medianByKey.get(key) ?? null,
      mdape: v.mdape,
      cappedMdape: v.cappedMdape,
      bias: v.bias,
      trend: v.trend,
      minNGated: v.matchedPairs < minN,
      recommendation: v.recommendation,
    }))
    .sort((a, b) => b.matchedPairs - a.matchedPairs);
}

// ---- Section 4: PERT learned-correction status ------------------------------

const PERT_TOOL = "pert_estimate";
export const TIER1_BAND: readonly [number, number] = [0.7, 1.3];
const BACKTEST_TEST_FRACTION = 0.2;

interface PertBacktestPair {
  readonly taskType: string;
  readonly estimatedHours: number;
  readonly actualHours: number;
  readonly currentAdjusted: number;
  readonly completedAt: string;
}

/** Mirrors calibration-factors.ts's extractPertEstimatedHours / scripts/backtest-pert-correction.mjs's copy of the same shape logic. */
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
    default: return null;
  }
}

function loadPertBacktestPairs(): PertBacktestPair[] {
  const merged = loadLedgerWithOverlays();
  const pairs: PertBacktestPair[] = [];

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
    const currentAdjusted = typeof rec.outputs["adjustedEstimate"] === "number" ? rec.outputs["adjustedEstimate"] : estimatedHours;
    const completedAt = rec.actual.completedAt ?? rec.actual.reportedAt ?? rec.estimatedAt;

    pairs.push({ taskType, estimatedHours, actualHours: rec.actual.actualHours, currentAdjusted, completedAt });
  }

  return pairs.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
}

export interface PertBacktestResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly totalMatchedPairs: number;
  readonly trainPairs: number;
  readonly testPairs: number;
  readonly current: { readonly mdapePercent: number | null; readonly medianActualOverPredicted: number | null };
  readonly corrected: { readonly mdapePercent: number | null; readonly medianActualOverPredicted: number | null };
  readonly guards: { readonly correctedMdapeLeCurrentMdape: boolean; readonly tier1BandMet: boolean };
  readonly recommendation: string;
}

const EMPTY_BACKTEST_METRICS = { mdapePercent: null, medianActualOverPredicted: null } as const;

/**
 * Held-out backtest of the (tool='pert_estimate', task_type) learned
 * correction factor — mirrors scripts/backtest-pert-correction.mjs's
 * algorithm exactly (80/20 chronological split, train-only factor fit,
 * current-path vs corrected-path MdAPE + median ratio on the held-out test
 * split) so the dashboard's numbers reconcile with that script's output.
 */
export function computePertBacktest(): PertBacktestResult {
  const pairs = loadPertBacktestPairs();
  if (pairs.length === 0) {
    return { ok: false, reason: "no_matched_pert_pairs", totalMatchedPairs: 0, trainPairs: 0, testPairs: 0, current: EMPTY_BACKTEST_METRICS, corrected: EMPTY_BACKTEST_METRICS, guards: { correctedMdapeLeCurrentMdape: false, tier1BandMet: false }, recommendation: "No matched pert_estimate pairs available for a backtest." };
  }

  const splitIdx = Math.max(1, Math.floor(pairs.length * (1 - BACKTEST_TEST_FRACTION)));
  const trainPairs = pairs.slice(0, splitIdx);
  const testPairs = pairs.slice(splitIdx);

  if (testPairs.length === 0) {
    return { ok: false, reason: "insufficient_pairs_for_holdout_split", totalMatchedPairs: pairs.length, trainPairs: trainPairs.length, testPairs: 0, current: EMPTY_BACKTEST_METRICS, corrected: EMPTY_BACKTEST_METRICS, guards: { correctedMdapeLeCurrentMdape: false, tier1BandMet: false }, recommendation: "Not enough matched pairs for an 80/20 held-out split." };
  }

  const trainHistorical: HistoricalRecord[] = trainPairs.map((p) => ({
    taskType: p.taskType,
    estimatedHours: p.estimatedHours,
    actualHours: p.actualHours,
    tool: PERT_TOOL,
    completedAt: p.completedAt,
  }));
  const trainFactors = computeToolTaskCorrectionFactors(trainHistorical);
  const trainN = new Map<string, number>();
  for (const p of trainPairs) trainN.set(p.taskType, (trainN.get(p.taskType) ?? 0) + 1);

  const currentApes: number[] = [];
  const correctedApes: number[] = [];
  const currentRatios: number[] = [];
  const correctedRatios: number[] = [];

  const apeOf = (predicted: number, actual: number): number => (Math.abs(predicted - actual) / actual) * 100;

  for (const p of testPairs) {
    currentApes.push(apeOf(p.currentAdjusted, p.actualHours));
    currentRatios.push(p.actualHours / p.currentAdjusted);

    const n = trainN.get(p.taskType) ?? 0;
    const learnedFactor = trainFactors[PERT_TOOL]?.[p.taskType];
    const correctedPrediction = n >= MIN_RECORDS_PER_FACTOR && learnedFactor !== undefined
      ? p.estimatedHours * learnedFactor
      : p.currentAdjusted;

    correctedApes.push(apeOf(correctedPrediction, p.actualHours));
    correctedRatios.push(p.actualHours / correctedPrediction);
  }

  const currentMdape = median(currentApes) ?? 0;
  const correctedMdape = median(correctedApes) ?? 0;
  const currentMedianRatio = median(currentRatios);
  const correctedMedianRatio = median(correctedRatios);

  const guardImproves = correctedMdape <= currentMdape;
  const guardBand = correctedMedianRatio !== null && correctedMedianRatio >= TIER1_BAND[0] && correctedMedianRatio <= TIER1_BAND[1];

  return {
    ok: true,
    totalMatchedPairs: pairs.length,
    trainPairs: trainPairs.length,
    testPairs: testPairs.length,
    current: { mdapePercent: round2(currentMdape), medianActualOverPredicted: currentMedianRatio !== null ? round2(currentMedianRatio) : null },
    corrected: { mdapePercent: round2(correctedMdape), medianActualOverPredicted: correctedMedianRatio !== null ? round2(correctedMedianRatio) : null },
    guards: { correctedMdapeLeCurrentMdape: guardImproves, tier1BandMet: guardBand },
    recommendation: guardImproves && guardBand
      ? "PASS — safe to flip EPOCH_PERT_LEARNED_CORRECTION on."
      : "HOLD — do not flip EPOCH_PERT_LEARNED_CORRECTION on yet; guard(s) failed.",
  };
}

export interface PertCorrectionSection {
  readonly flagEnabled: boolean;
  readonly envVar: "EPOCH_PERT_LEARNED_CORRECTION";
  readonly tier1Band: readonly [number, number];
  readonly backtest: PertBacktestResult;
  /** 0-1 progress of the corrected median actual/predicted toward the Tier-1 band, for a progress-bar visualization. Distance-to-band-edge, clamped. */
  readonly bandProgress: number | null;
}

function computeBandProgress(medianRatio: number | null): number | null {
  if (medianRatio === null) return null;
  const [lo, hi] = TIER1_BAND;
  if (medianRatio >= lo && medianRatio <= hi) return 1;
  // Distance from 1.0 (perfect calibration), normalized against the distance
  // from 1.0 to the nearer band edge — 0 = as far as a >=0 ratio can be from
  // that edge (ratio of 0), 1 = at the edge.
  const nearestEdge = medianRatio < lo ? lo : hi;
  const distanceFromCenterToEdge = Math.abs(nearestEdge - 1);
  const distanceFromCenterToRatio = Math.abs(medianRatio - 1);
  if (distanceFromCenterToEdge === 0) return 0;
  const progress = 1 - Math.max(0, (distanceFromCenterToRatio - distanceFromCenterToEdge) / distanceFromCenterToEdge);
  return Math.max(0, Math.min(1, round2(progress)));
}

function computePertSection(): PertCorrectionSection {
  const backtest = computePertBacktest();
  return {
    flagEnabled: isPertLearnedCorrectionEnabled(),
    envVar: "EPOCH_PERT_LEARNED_CORRECTION",
    tier1Band: TIER1_BAND,
    backtest,
    bandProgress: computeBandProgress(backtest.corrected.medianActualOverPredicted),
  };
}

// ---- Section 5: interval coverage -------------------------------------------

export interface CoverageSection {
  readonly overall: { readonly n: number; readonly p80CoverageRate: number | null; readonly target: number };
  readonly rows: ReadonlyArray<{ readonly taskType: string; readonly n: number; readonly p80CoverageRate: number | null; readonly method: string }>;
  readonly note: string;
}

function computeCoverageSection(): CoverageSection {
  const report = computeIntervalCoverage();
  const rows = Object.entries(report.byTaskType)
    .map(([taskType, v]) => ({ taskType, n: v.n, p80CoverageRate: v.p80CoverageRate, method: v.method }))
    .sort((a, b) => b.n - a.n);
  return {
    overall: { n: report.n, p80CoverageRate: report.p80CoverageRate, target: report.targetP80Coverage },
    rows,
    note: report.note,
  };
}

// ---- Section 6: data-integrity audit ----------------------------------------

/** Known test-fixture id prefixes leaking into feedback.jsonl as orphans (e2e/http harnesses), distinct from the isSyntheticId() prefixes exclusion.ts already filters out of matched pairs. Reporting-only classification — does not change what isExcluded() excludes. */
const TEST_FIXTURE_ORPHAN_PREFIXES = [
  "http-test-",
  "fb-batch-",
  "fb-max-",
  "fb-single-",
  "batch-test-",
  "batch-max-",
  "batch-single-",
] as const;

function isTestFixtureLeakage(estimateId: string): boolean {
  return TEST_FIXTURE_ORPHAN_PREFIXES.some((prefix) => estimateId.startsWith(prefix));
}

const DEFAULT_PENDING_TTL_DAYS = 30;

function pendingTtlDaysForReport(): number {
  const raw = process.env["EPOCH_PENDING_TTL_DAYS"];
  const n = raw !== undefined ? Number(raw) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_PENDING_TTL_DAYS;
}

export interface IntegritySection {
  readonly quarantine: { readonly count: number; readonly source: string; readonly backfillSignatureDate: string };
  readonly labels: { readonly count: number; readonly source: string };
  readonly taskTypeOverlay: { readonly count: number; readonly source: string; readonly note: string };
  readonly archive: { readonly count: number; readonly source: string };
  readonly orphans: { readonly total: number; readonly testFixtureLeakage: number; readonly unresolved: number; readonly note: string };
  readonly expiredPending: { readonly count: number; readonly ttlDays: number };
  readonly dedup: { readonly enabled: boolean; readonly windowMinutes: number | null; readonly hitCount: number; readonly note: string };
}

function computeIntegrity(): IntegritySection {
  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const estimateIds = new Set(estimates.map((e) => e.id));
  const orphanActuals = actuals.filter((a) => !estimateIds.has(a.estimateId));
  const testFixtureLeakage = orphanActuals.filter((a) => isTestFixtureLeakage(a.estimateId)).length;

  const merged = loadLedgerWithOverlays();
  let quarantinedCount = 0;
  let labeledCount = 0;
  let archivedCount = 0;
  let expiredPendingCount = 0;
  for (const rec of merged) {
    if (rec.flags.quarantined) quarantinedCount++;
    if (rec.flags.taskLabel) labeledCount++;
    if (rec.archived) archivedCount++;
    if (!rec.actual) {
      const verdict = isExcluded({
        id: rec.id,
        tool: rec.tool,
        estimatedAt: rec.estimatedAt,
        flags: { quarantined: rec.flags.quarantined, orphan: rec.flags.orphan },
        ...(rec.expiresAt && { expiresAt: rec.expiresAt }),
      });
      if (verdict.excluded && verdict.reason === "ttl_expired") expiredPendingCount++;
    }
  }

  const taskTypeOverlayCount = readLines(TASKTYPE_FILE).length;

  const dedupWindowRaw = process.env["EPOCH_DEDUP_WINDOW"];
  const dedupWindowMinutes = dedupWindowRaw !== undefined && Number.isFinite(Number(dedupWindowRaw)) ? Number(dedupWindowRaw) : null;

  return {
    quarantine: { count: quarantinedCount, source: FLAGS_FILE, backfillSignatureDate: BACKFILL_SIGNATURE_DATE },
    labels: { count: labeledCount, source: LABELS_FILE },
    taskTypeOverlay: {
      count: taskTypeOverlayCount,
      source: TASKTYPE_FILE,
      note: "Not yet merged by loadLedgerWithOverlays() — normalize-task-types.mjs writes this sidecar, but wiring it into the shared loader is a later contract-touching step (out of Phase 2 / Phase 6 scope). Reported here for audit visibility only.",
    },
    archive: { count: archivedCount, source: QUARANTINE_ARCHIVE_FILE },
    orphans: {
      total: orphanActuals.length,
      testFixtureLeakage,
      unresolved: orphanActuals.length - testFixtureLeakage,
      note: "Orphan = a feedback.jsonl row whose estimateId matches no estimate on file. Test-fixture leakage (http-test-/fb-batch-/fb-max-/fb-single-/batch-* prefixes) is flagged for future cleanup, not auto-excluded. Run scripts/repair-orphaned-actuals.mjs to attempt single-candidate re-linking of the remainder.",
    },
    expiredPending: { count: expiredPendingCount, ttlDays: pendingTtlDaysForReport() },
    dedup: {
      enabled: dedupWindowMinutes !== null,
      windowMinutes: dedupWindowMinutes,
      hitCount: getDedupHitCount(),
      note: "Process-lifetime counter (mirrors self-improve.ts's in-memory callCounter pattern) — always 0 in this one-shot report; meaningful only inside a long-running MCP server process.",
    },
  };
}

// ---- Full dataset ------------------------------------------------------------

export interface DashboardData {
  readonly generatedAt: string;
  readonly dataDir: string;
  readonly minNForVerdict: number;
  readonly headline: DashboardHeadline;
  readonly byTool: readonly CalibrationRow[];
  readonly byTaskType: readonly CalibrationRow[];
  readonly pert: PertCorrectionSection;
  readonly coverage: CoverageSection;
  readonly integrity: IntegritySection;
  readonly reconciliationNote: string;
  readonly knownLimitations: readonly string[];
}

/**
 * Honest, evidence-based caveats about what this dataset does and does not
 * reflect — surfaced explicitly rather than silently glossed over (this is a
 * decision surface, not a chart dump). Empty on the current codebase: the
 * gap previously recorded here (Sections 1-3's matcher not merging the
 * overlay sidecars) was closed by routing feedback.ts's
 * matchEstimatesToActuals() through ledger.ts's loadLedgerWithOverlays()-
 * sourced overlay-flags map (see dashboard-data.test.ts's former
 * "documents the known gap" test, now "closes the known gap"). Sections 1-3
 * and Section 6 now agree on manual quarantine/orphan flags in every case,
 * not just the ones that also happen to match the 2026-05-05 backfill
 * signature.
 */
const KNOWN_LIMITATIONS: readonly string[] = [];

/**
 * Compute the full calibration-dashboard dataset. STRICTLY read-only —
 * every number is derived by calling the existing shared library surface
 * (feedback.ts / ledger.ts / exclusion.ts / coverage.ts /
 * calibration-factors.ts / accuracy-trend.ts), never by re-implementing
 * exclusion or overlay-merge logic. Deterministic for a given ~/.epoch
 * snapshot (or EPOCH_DATA_DIR override).
 */
export function computeDashboardData(): DashboardData {
  const minN = minNForVerdict();
  const health = getFeedbackHealthReport();
  const trend = computeAccuracyTrend();
  const integrity = computeIntegrity();

  const correctionMatched = getCalibrationData();
  const medianByTool = medianRatiosByKey(correctionMatched, (r) => r.tool ?? "unknown");
  const medianByTaskType = medianRatiosByKey(correctionMatched, (r) => r.taskType);

  const byTool = buildCalibrationRows(health.byTool, medianByTool, minN);
  const byTaskType = buildCalibrationRows(health.byTaskType, medianByTaskType, minN);

  return {
    generatedAt: new Date().toISOString(),
    dataDir: dataDir(),
    minNForVerdict: minN,
    headline: computeHeadline(health, trend, minN, integrity),
    byTool,
    byTaskType,
    pert: computePertSection(),
    coverage: computeCoverageSection(),
    integrity,
    reconciliationNote:
      "Headline matched pairs, per-tool/per-task-type MdAPE, and the quarantine count above are read directly from getFeedbackHealthReport() / loadLedgerWithOverlays() — the same functions the feedback_health MCP tool calls — so this report always reconciles with a live feedback_health call against the same data dir.",
    knownLimitations: KNOWN_LIMITATIONS,
  };
}
