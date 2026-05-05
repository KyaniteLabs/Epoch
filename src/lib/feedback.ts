import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { HistoricalRecord, TaskType } from "../types/index.js";
import { computeAccuracyMetrics } from "./analytics.js";

function biasLabel(bias: number | null): string {
  if (bias === null) return "";
  if (bias > 2) return "systematic underestimation";
  if (bias > 0.5) return "mild underestimation";
  if (bias > -0.5) return "well-calibrated";
  if (bias > -3) return "mild overestimation";
  return "systematic overestimation";
}

export interface EstimateRecord {
  id: string;
  tool: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  estimatedAt: string;
  /** Project or source that generated this estimate (e.g. "epoch", "liminal", "github_pipeline"). */
  source?: string;
}

export interface ActualRecord {
  estimateId: string;
  actualHours: number;
  notes?: string;
  reportedAt: string;
}

const DEFAULT_DATA_DIR = join(homedir(), ".epoch");
const ESTIMATES_FILE = "estimates.jsonl";
const ACTUALS_FILE = "feedback.jsonl";

/** Actuals below this threshold (15 min) are excluded as seed/test artifacts. */
const MINIMUM_ACTUAL_HOURS = 0.25;
/** Ratio threshold — actual/estimate below this indicates synthetic/seed data. */
const MIN_RATIO = 0.03;

function dataDir(): string {
  return process.env["EPOCH_DATA_DIR"] ?? DEFAULT_DATA_DIR;
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

function readLines<T>(filename: string): T[] {
  const path = join(dataDir(), filename);
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as T; } catch { return null; }
      })
      .filter((r): r is T => r !== null);
  } catch {
    return [];
  }
}

export function recordEstimate(
  tool: string,
  inputs: Record<string, unknown>,
  outputs: Record<string, unknown>,
  source?: string,
): string {
  const id = randomUUID();
  const record: EstimateRecord = {
    id,
    tool,
    inputs,
    outputs,
    estimatedAt: new Date().toISOString(),
    ...(source && { source }),
  };
  appendLine(isDryRun() ? DRY_RUN_ESTIMATES_FILE : ESTIMATES_FILE, record);
  return id;
}

export type RecordActualResult =
  | { ok: true }
  | { ok: false; reason: "below_threshold" | "duplicate" | "write_failed" | "synthetic_id" };

/** File used for dry-run / test writes when EPOCH_DRY_RUN is set. */
const DRY_RUN_FILE = "feedback.dry-run.jsonl";
const DRY_RUN_ESTIMATES_FILE = "estimates.dry-run.jsonl";

function isDryRun(): boolean {
  return process.env["EPOCH_DRY_RUN"] === "1" || process.env["EPOCH_DRY_RUN"] === "true";
}

export function recordActual(estimateId: string, actualHours: number, notes?: string): boolean {
  const result = recordActualDetailed(estimateId, actualHours, notes);
  return result.ok;
}

export function recordActualDetailed(estimateId: string, actualHours: number, notes?: string): RecordActualResult {
  if (actualHours < MINIMUM_ACTUAL_HOURS) return { ok: false, reason: "below_threshold" };

  // Reject synthetic estimate IDs at write time — prevents test data from polluting calibration
  if (isSyntheticId(estimateId)) return { ok: false, reason: "synthetic_id" };

  // Reject duplicates — last-write-wins silently corrupts calibration
  const existing = readLines<ActualRecord>(ACTUALS_FILE);
  if (existing.some((a) => a.estimateId === estimateId)) {
    return { ok: false, reason: "duplicate" };
  }

  const record: ActualRecord = {
    estimateId,
    actualHours,
    ...(notes && { notes }),
    reportedAt: new Date().toISOString(),
  };

  // Dry-run mode: write to separate file so tests never touch production data
  const targetFile = isDryRun() ? DRY_RUN_FILE : ACTUALS_FILE;
  const written = appendLine(targetFile, record);
  return written ? { ok: true } : { ok: false, reason: "write_failed" };
}

export function getPendingEstimates(limit = 50): Array<EstimateRecord & { hasActual: boolean }> {
  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const actualIds = new Set(actuals.map((a) => a.estimateId));

  return estimates
    .map((e) => ({ ...e, hasActual: actualIds.has(e.id) }))
    .filter((e) => !e.hasActual)
    .slice(-limit);
}

export function getCalibrationData(
  teamId?: string,
  taskType?: TaskType,
  windowDays?: number,
  tool?: string,
): HistoricalRecord[] {
  return matchEstimatesToActuals(
    readLines<EstimateRecord>(ESTIMATES_FILE),
    readLines<ActualRecord>(ACTUALS_FILE),
    { teamId, taskType, windowDays, tool },
  );
}

/** Prefixes that indicate synthetic/test/batch data, not real estimates. */
const SYNTHETIC_PREFIXES = [
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
];

/** Check if a bare ID string matches a synthetic prefix pattern. */
function isSyntheticId(id: string): boolean {
  for (const prefix of SYNTHETIC_PREFIXES) {
    if (id.startsWith(prefix)) return true;
  }
  return false;
}

function isSeedRecord(act: ActualRecord): boolean {
  const id = act.estimateId ?? "";
  for (const prefix of SYNTHETIC_PREFIXES) {
    if (id.startsWith(prefix)) return true;
  }
  const notes = (act.notes ?? "").toLowerCase();
  return notes.includes("seed") || notes.includes("synthetic") || notes.includes("dogfood-seed") || notes.includes("test data");
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
    if (act.actualHours < MINIMUM_ACTUAL_HOURS) continue;

    // Filter seed/synthetic records: explicitly marked or implausibly low ratio
    if (isSeedRecord(act)) continue;

    const estHours = extractEstimatedHours(est.outputs);
    if (estHours === null) continue;

    // Filter extreme ratio outliers (e.g. 0.02h actual against 4h estimate = synthetic)
    if (act.actualHours / estHours < MIN_RATIO) continue;

    const type = (est.inputs["task_type"] as string) ?? inferTaskType(est.tool);

    if (filters?.taskType && type !== filters.taskType) continue;
    if (filters?.teamId && est.inputs["team_id"] !== filters.teamId) continue;
    if (filters?.tool && est.tool !== filters.tool) continue;

    const complexity = typeof est.inputs["complexity"] === "number"
      ? est.inputs["complexity"]
      : undefined;

    records.push({
      taskType: type,
      estimatedHours: estHours,
      actualHours: act.actualHours,
      tool: est.tool,
      ...(complexity !== undefined && { complexity }),
      ...(filters?.teamId && { teamId: filters.teamId }),
      completedAt: act.reportedAt ?? act["completedAt" as keyof typeof act] ?? "",
    });
  }

  return records.sort((a, b) => (a.completedAt ?? "").localeCompare(b.completedAt ?? ""));
}

function extractEstimatedHours(outputs: Record<string, unknown>): number | null {
  if (typeof outputs["totalHours"] === "number") return outputs["totalHours"];
  if (typeof outputs["estimatedHours"] === "number") return outputs["estimatedHours"];
  if (typeof outputs["estimatedMinutes"] === "number") return outputs["estimatedMinutes"] / 60;
  if (typeof outputs["estimatedSeconds"] === "number") return outputs["estimatedSeconds"] / 3600;
  if (typeof outputs["expected"] === "number") {
    const unit = outputs["unit"] as string;
    if (unit === "hours") return outputs["expected"];
    if (unit === "days") return outputs["expected"] * 8;
    if (unit === "weeks") return outputs["expected"] * 40;
    if (unit === "months") return outputs["expected"] * 160;
    if (!unit) return outputs["expected"]; // no unit field — assume hours
    return null; // unrecognized unit — skip to avoid corrupting calibration
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
    const ok = recordActual(entry.estimateId, entry.actualHours, entry.notes);
    if (ok) {
      succeeded++;
    } else {
      errors.push(`Failed to record actual for estimate ${entry.estimateId}`);
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
  matchRate: number;
  byTool: Record<string, { estimates: number; actuals: number; matchedPairs: number; mape: number | null; mdape: number | null; cappedMdape: number | null; bias: number | null; trend: string | null; recommendation: string }>;
  byTaskType: Record<string, { estimates: number; actuals: number; matchedPairs: number; mape: number | null; mdape: number | null; cappedMdape: number | null; bias: number | null; trend: string | null; recommendation: string }>;
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

export function getFeedbackHealthReport(): FeedbackHealthReport {
  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const actualIds = new Set(actuals.map((a) => a.estimateId));

  const totalEstimates = estimates.length;
  const totalActuals = actuals.length;
  const matchRate = totalEstimates > 0
    ? Math.round((actualIds.size / totalEstimates) * 1000) / 10
    : 0;

  // Compute all matched records once (no re-reads)
  const allMatched = matchEstimatesToActuals(estimates, actuals);

  // Count seed records filtered from accuracy computation
  const actualsMap = new Map<string, ActualRecord>();
  for (const a of actuals) actualsMap.set(a.estimateId, a);
  const estSet = new Set(estimates.map(e => e.id));
  let seedRecordsFiltered = 0;
  for (const a of actuals) {
    if (!estSet.has(a.estimateId)) continue;
    if (a.actualHours < MINIMUM_ACTUAL_HOURS) { seedRecordsFiltered++; continue; }
    if (isSeedRecord(a)) { seedRecordsFiltered++; continue; }
  }
  // Also count extreme ratio records
  for (const e of estimates) {
    const act = actualsMap.get(e.id);
    if (!act || act.actualHours < MINIMUM_ACTUAL_HOURS || isSeedRecord(act)) continue;
    const estHours = extractEstimatedHours(e.outputs);
    if (estHours !== null && act.actualHours / estHours < MIN_RATIO) seedRecordsFiltered++;
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
  for (const r of allMatched) {
    const toolKey = r.tool ?? "unknown";
    if (!toolRecords.has(toolKey)) toolRecords.set(toolKey, []);
    toolRecords.get(toolKey)!.push(r);
  }

  const byTool: FeedbackHealthReport["byTool"] = {};
  for (const [tool, count] of toolEstimates) {
    const matched = toolRecords.get(tool) ?? [];
    const metrics = matched.length >= 2 ? computeAccuracyMetrics(matched) : null;
    const pairs = matched.length;
    let recommendation: string;
    const bl = biasLabel(metrics?.bias ?? null);
    if (pairs === 0) {
      recommendation = "No matched pairs. Record actuals to start calibration.";
    } else if (pairs < 3) {
      recommendation = `Only ${pairs} matched pair${pairs === 1 ? "" : "s"}. Need ${3 - pairs} more for MdAPE computation.`;
    } else if (pairs < 10) {
      recommendation = `Sufficient for calibration (${pairs} pairs, capped MdAPE: ${metrics?.cappedMdape?.toFixed(1) ?? "N/A"}%, ${bl}). Collect more to improve reliability.`;
    } else {
      recommendation = `Good coverage (${pairs} pairs, capped MdAPE: ${metrics?.cappedMdape?.toFixed(1) ?? "N/A"}%, ${bl}).${metrics && metrics.cappedMdape > 50 ? " Review outliers." : ""}`;
    }
    byTool[tool] = { estimates: count, actuals: toolActuals.get(tool) ?? 0, matchedPairs: pairs, mape: metrics?.mape ?? null, mdape: metrics?.mdape ?? null, cappedMdape: metrics?.cappedMdape ?? null, bias: metrics?.bias ?? null, trend: metrics?.trend ?? null, recommendation };
  }

  // By task type — group the pre-matched records
  const typeGroups = new Map<string, HistoricalRecord[]>();
  for (const r of allMatched) {
    if (!typeGroups.has(r.taskType)) typeGroups.set(r.taskType, []);
    typeGroups.get(r.taskType)!.push(r);
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
    let typeRec: string;
    const tbl = biasLabel(metrics?.bias ?? null);
    if (pairs === 0) {
      typeRec = "No matched pairs. Use this task type in estimates and record actuals.";
    } else if (pairs < 3) {
      typeRec = `Only ${pairs} matched pair${pairs === 1 ? "" : "s"}. Need ${3 - pairs} more for MdAPE computation.`;
    } else if (pairs < 10) {
      typeRec = `Sufficient for calibration (${pairs} pairs, capped MdAPE: ${metrics?.cappedMdape?.toFixed(1) ?? "N/A"}%, ${tbl}). Collect more to improve reliability.`;
    } else {
      typeRec = `Good coverage (${pairs} pairs, capped MdAPE: ${metrics?.cappedMdape?.toFixed(1) ?? "N/A"}%, ${tbl}).${metrics && metrics.cappedMdape > 50 ? " Review outliers." : ""}`;
    }
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

  if (allMatched.length >= 5) {
    const metrics = computeAccuracyMetrics(allMatched);
    overallMdape = metrics.mdape;
    overallCappedMdape = metrics.cappedMdape;

    // Outliers: records where MAPE > 3× cappedMdape
    const outlierThreshold = metrics.cappedMdape * 3;
    const outliers = allMatched.filter(r => {
      const err = Math.abs(r.actualHours - r.estimatedHours) / r.actualHours * 100;
      return err > outlierThreshold;
    });
    outlierRatio = Math.round(outliers.length / allMatched.length * 1000) / 10;

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
  const estimationTools = ["pert_estimate", "cocomo_estimate", "sprint_forecast", "critical_path", "monte_carlo_schedule", "token_time_bridge", "schedule_risk", "reference_class_estimate"];
  const toolsCalibrated = estimationTools.filter(t => (byTool[t]?.matchedPairs ?? 0) >= 3).length;
  const toolScore = Math.round((toolsCalibrated / estimationTools.length) * 40);

  const allTaskTypes = Object.keys(byTaskType);
  const typesCalibrated = allTaskTypes.filter(t => (byTaskType[t]?.matchedPairs ?? 0) >= 3).length;
  const typeScore = allTaskTypes.length > 0 ? Math.round((typesCalibrated / allTaskTypes.length) * 30) : 0;

  const pairScore = Math.min(30, Math.round((allMatched.length / 100) * 30));

  const dataCompletenessScore = toolScore + typeScore + pairScore;

  const seedLabel = seedRecordsFiltered > 0 ? ` (${seedRecordsFiltered} seed records filtered)` : "";

  return {
    totalEstimates,
    totalActuals,
    matchedPairs: allMatched.length,
    seedRecordsFiltered,
    matchRate,
    byTool,
    byTaskType,
    selfImprovement: { readyTypes, callsUntilUpdate },
    dataQuality: { overallMdape, overallCappedMdape, outlierRatio, recommendation, dataCompletenessScore },
    humanReadable: `${allMatched.length} matched pairs across ${toolsWithData} tools and ${typesWithData} task types (capped MdAPE: ${cappedLabel}, raw MdAPE: ${mdapeLabel}). ${totalEstimates} estimates, ${totalActuals} actuals, match rate: ${matchRate}%${seedLabel}. ${recommendation}`,
  };
}
