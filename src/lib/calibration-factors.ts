import type { HistoricalRecord } from "../types/index.js";

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
