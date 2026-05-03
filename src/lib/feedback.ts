import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { HistoricalRecord, TaskType } from "../types/index.js";
import { computeAccuracyMetrics } from "./analytics.js";

export interface EstimateRecord {
  id: string;
  tool: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  estimatedAt: string;
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
): string {
  const id = randomUUID();
  const record: EstimateRecord = {
    id,
    tool,
    inputs,
    outputs,
    estimatedAt: new Date().toISOString(),
  };
  appendLine(ESTIMATES_FILE, record);
  return id;
}

export function recordActual(estimateId: string, actualHours: number, notes?: string): boolean {
  // Reject duplicates — last-write-wins silently corrupts calibration
  const existing = readLines<ActualRecord>(ACTUALS_FILE);
  if (existing.some((a) => a.estimateId === estimateId)) {
    return false;
  }

  const record: ActualRecord = {
    estimateId,
    actualHours,
    ...(notes && { notes }),
    reportedAt: new Date().toISOString(),
  };
  return appendLine(ACTUALS_FILE, record);
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

    const estHours = extractEstimatedHours(est.outputs);
    if (estHours === null) continue;

    const type = (est.inputs["task_type"] as string) ?? inferTaskType(est.tool);

    if (filters?.taskType && type !== filters.taskType) continue;
    if (filters?.teamId && est.inputs["team_id"] !== filters.teamId) continue;
    if (filters?.tool && est.tool !== filters.tool) continue;

    records.push({
      taskType: type,
      estimatedHours: estHours,
      actualHours: act.actualHours,
      tool: est.tool,
      ...(filters?.teamId && { teamId: filters.teamId }),
      completedAt: act.reportedAt,
    });
  }

  return records.sort((a, b) => a.completedAt.localeCompare(b.completedAt));
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
  return null;
}

function inferTaskType(tool: string): string {
  if (tool.includes("pert") || tool.includes("cocomo") || tool.includes("sprint")) return "feature";
  if (tool.includes("token")) return "infrastructure";
  if (tool.includes("calibrate") || tool.includes("reference")) return "testing";
  return "feature";
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
  matchRate: number;
  byTool: Record<string, { estimates: number; actuals: number; mape: number | null; mdape: number | null }>;
  byTaskType: Record<string, { estimates: number; actuals: number; mape: number | null; mdape: number | null }>;
  selfImprovement: {
    readyTypes: string[];
    callsUntilUpdate: number;
  };
  dataQuality: {
    overallMdape: number | null;
    outlierRatio: number;
    recommendation: string;
  };
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
    byTool[tool] = { estimates: count, actuals: toolActuals.get(tool) ?? 0, mape: metrics?.mape ?? null, mdape: metrics?.mdape ?? null };
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
    byTaskType[type] = { estimates: count, actuals: records.length, mape: metrics?.mape ?? null, mdape: metrics?.mdape ?? null };
  }

  // Self-improvement readiness: types with 5+ matched records
  const readyTypes: string[] = [];
  for (const [type, records] of typeGroups) {
    if (records.length >= 5) readyTypes.push(type);
  }

  const callsUntilUpdate = Math.max(0, 100 - totalEstimates);

  // Data quality: overall MdAPE and outlier ratio across all matched records
  let overallMdape: number | null = null;
  let outlierRatio = 0;
  let recommendation: string;

  if (allMatched.length >= 5) {
    const metrics = computeAccuracyMetrics(allMatched);
    overallMdape = metrics.mdape;

    // Outliers: records where MAPE > 3× MdAPE
    const outlierThreshold = metrics.mdape * 3;
    const outliers = allMatched.filter(r => {
      const err = Math.abs(r.actualHours - r.estimatedHours) / r.actualHours * 100;
      return err > outlierThreshold;
    });
    outlierRatio = Math.round(outliers.length / allMatched.length * 1000) / 10;

    if (overallMdape < 25) {
      recommendation = "Data quality is good. MdAPE below 25% indicates reliable estimates.";
    } else if (overallMdape < 50) {
      recommendation = "Data quality is moderate. Consider filtering outlier records or collecting more matched pairs.";
    } else {
      recommendation = "Data quality needs improvement. High MdAPE suggests systematic estimation bias. Review seed data for human/AI baseline mismatches.";
    }
  } else {
    recommendation = "Insufficient data for quality assessment. Need at least 5 matched estimate-actual pairs.";
  }

  return {
    totalEstimates,
    totalActuals,
    matchRate,
    byTool,
    byTaskType,
    selfImprovement: { readyTypes, callsUntilUpdate },
    dataQuality: { overallMdape, outlierRatio, recommendation },
  };
}
