import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { HistoricalRecord, TaskType } from "../types/index.js";

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
  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);

  const actualsMap = new Map<string, ActualRecord>();
  for (const a of actuals) {
    actualsMap.set(a.estimateId, a);
  }

  const cutoff = windowDays
    ? new Date(Date.now() - windowDays * 86_400_000).toISOString()
    : "0000";

  const records: HistoricalRecord[] = [];

  for (const est of estimates) {
    if (est.estimatedAt < cutoff) continue;

    const act = actualsMap.get(est.id);
    if (!act) continue;

    const estHours = extractEstimatedHours(est.outputs);
    if (estHours === null) continue;

    const type = (est.inputs["task_type"] as string) ?? inferTaskType(est.tool);

    if (taskType && type !== taskType) continue;
    if (teamId && est.inputs["team_id"] !== teamId) continue;
    if (tool && est.tool !== tool) continue;

    records.push({
      taskType: type,
      estimatedHours: estHours,
      actualHours: act.actualHours,
      tool: est.tool,
      ...(teamId && { teamId }),
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
    return outputs["expected"];
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
