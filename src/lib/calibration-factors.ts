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

export function computeToolTaskCorrectionFactors(records: HistoricalRecord[]): Record<string, Record<string, number>> {
  const grouped = new Map<string, Map<string, number[]>>();
  for (const { record, ratio } of validRatios(records)) {
    const tool = record.tool ?? "unknown";
    let taskMap = grouped.get(tool);
    if (!taskMap) {
      taskMap = new Map();
      grouped.set(tool, taskMap);
    }
    const arr = taskMap.get(record.taskType) ?? [];
    arr.push(ratio);
    taskMap.set(record.taskType, arr);
  }

  const result: Record<string, Record<string, number>> = {};
  for (const [tool, taskMap] of grouped) {
    const toolFactors: Record<string, number> = {};
    for (const [taskType, ratios] of taskMap) {
      if (ratios.length < MIN_RECORDS_PER_FACTOR) continue;
      toolFactors[taskType] = roundFactor(median(ratios, 1.4));
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
 * Compute the learned (pert_estimate, taskType) correction factor + matched-pair
 * count n from the clean (exclusion-filtered, overlay-merged) ledger. n is the
 * count of matched pairs for this task type regardless of whether that meets
 * MIN_RECORDS_PER_FACTOR — callers (composePertCorrectionFactor) decide whether
 * n qualifies the factor for use.
 */
export function getPertToolTaskCorrection(taskType: string): PertToolTaskCorrection {
  const records = loadPertMatchedRecords();
  const n = records.filter((r) => r.taskType === taskType).length;
  const factors = computeToolTaskCorrectionFactors(records);
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
