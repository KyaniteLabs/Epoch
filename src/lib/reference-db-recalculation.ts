import {
  computeComplexityCorrectionFactors,
  computeGlobalCorrectionFactor,
  computeTaskTypeCorrectionFactors,
  computeToolTaskCorrectionFactors,
  isCorrectionEligibleRecord,
  MIN_RECORDS_FOR_DATABASE_UPDATE,
} from "./calibration-factors.js";
import { matchEstimatesToActuals, type ActualRecord, type EstimateRecord } from "./feedback.js";
import { percentileIndex } from "./estimation.js";
import type { HistoricalRecord } from "../types/index.js";
import type { ToolCallRecord } from "./telemetry.js";

export interface ReceiverTelemetryRecord {
  task_type: string;
  complexity: number | null;
  tool: string;
  estimated_hours: number;
  actual_hours: number;
  ratio: number;
  date: string;
  received_at?: string;
  calibration_provenance?:
    | "prospective"
    | "backfilled_real_session"
    | "backfilled_calibration"
    | "synthetic"
    | "smoke"
    | "unknown";
  calibration_usage?: "correction" | "baseline" | "exclude";
}

export interface RecalculationSource {
  name: string;
  estimates?: EstimateRecord[];
  actuals?: ActualRecord[];
  receiverRecords?: ReceiverTelemetryRecord[];
  telemetryEvents?: ToolCallRecord[];
}

export interface CalibrationRecalculationInput {
  sources: RecalculationSource[];
  generatedAt: string;
  sourceLabel?: string;
  description?: string;
}

export interface ReferenceDatabaseLike {
  generatedAt?: string;
  source?: string;
  sampleSize?: number;
  description?: string;
  toolExecutionBenchmarks?: Record<string, {
    p50_ms: number;
    p95_ms: number;
    mean_ms: number;
    stddev_ms: number;
    min_ms: number;
    max_ms: number;
    sampleCount: number;
  }>;
  estimationAccuracy?: {
    correctionFactors?: { global?: number; byTaskType?: Record<string, number>; methodology?: string };
  };
  taskTypeCorrectionFactors?: Record<string, number>;
  toolTaskCorrectionFactors?: Record<string, Record<string, number>>;
  complexityCorrectionFactors?: Record<string, Record<number, number>>;
  complexityCorrectionFactorStatus?: string;
  globalCorrectionFactor?: number;
  provenanceSummary?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface RecalculationSummary {
  generatedAt: string;
  sourceLabel: string;
  sourceNames: string[];
  telemetryEvents: number;
  receiverRecords: number;
  legacyReceiverBaselineRecords: number;
  totalCalibrationRecords: number;
  correctionRecords: number;
  baselineRecords: number;
  excludedRecords: number;
  duplicateCorrectionRecords: number;
  taskTypeSampleCounts: Record<string, number>;
  toolTaskSampleCounts: Record<string, Record<string, number>>;
  complexitySampleCounts: Record<string, Record<number, number>>;
}

export interface RecalculationResult {
  db: ReferenceDatabaseLike;
  summary: RecalculationSummary;
}

type CalibrationOrigin = "source" | "receiver";

interface CalibrationCandidate {
  record: HistoricalRecord;
  origin: CalibrationOrigin;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/**
 * Shared receiver-record provenance classification (ticket 19): the receive
 * path and self-improvement's loadReceivedTelemetryRecords() both route
 * records through this, so smoke/synthetic provenance and explicit excludes
 * are filtered identically everywhere a received record can reach
 * calibration math.
 */
export function classifyReceiverRecord(record: ReceiverTelemetryRecord): {
  calibrationProvenance: NonNullable<HistoricalRecord["calibrationProvenance"]>;
  calibrationUsage: NonNullable<HistoricalRecord["calibrationUsage"]>;
  legacyReceiverBaseline: boolean;
} {
  if (
    record.calibration_usage === "exclude"
    || record.calibration_provenance === "synthetic"
    || record.calibration_provenance === "smoke"
    || record.tool === "receiver_smoke"
  ) {
    return {
      calibrationProvenance: record.calibration_provenance ?? "smoke",
      calibrationUsage: "exclude",
      legacyReceiverBaseline: false,
    };
  }

  if (record.calibration_usage) {
    return {
      calibrationProvenance: record.calibration_provenance ?? "unknown",
      calibrationUsage: record.calibration_usage,
      legacyReceiverBaseline: false,
    };
  }

  if (record.calibration_provenance === "prospective") {
    return {
      calibrationProvenance: "prospective",
      calibrationUsage: "correction",
      legacyReceiverBaseline: false,
    };
  }

  return {
    calibrationProvenance: record.calibration_provenance ?? "unknown",
    calibrationUsage: "baseline",
    legacyReceiverBaseline: record.calibration_provenance === undefined,
  };
}

export function receiverToHistorical(record: ReceiverTelemetryRecord): {
  record?: HistoricalRecord;
  excluded: boolean;
  legacyReceiverBaseline: boolean;
} {
  const classification = classifyReceiverRecord(record);
  if (classification.calibrationUsage === "exclude") {
    return { excluded: true, legacyReceiverBaseline: false };
  }

  if (
    typeof record.task_type !== "string"
    || typeof record.tool !== "string"
    || !isFiniteNumber(record.estimated_hours)
    || !isFiniteNumber(record.actual_hours)
    || record.estimated_hours <= 0
    || record.actual_hours <= 0
  ) {
    return { excluded: true, legacyReceiverBaseline: false };
  }

  return {
    excluded: false,
    legacyReceiverBaseline: classification.legacyReceiverBaseline,
    record: {
      taskType: record.task_type,
      estimatedHours: record.estimated_hours,
      actualHours: record.actual_hours,
      tool: record.tool,
      ...(typeof record.complexity === "number" && { complexity: record.complexity }),
      completedAt: record.date,
      calibrationProvenance: classification.calibrationProvenance,
      calibrationUsage: classification.calibrationUsage,
    },
  };
}

function roundTelemetryHours(value: number): number {
  return Math.round(value * 100) / 100;
}

function correctionDedupeKey(record: HistoricalRecord): string {
  return [
    record.completedAt,
    record.taskType,
    record.tool ?? "unknown",
    record.complexity ?? "",
    roundTelemetryHours(record.estimatedHours),
    roundTelemetryHours(record.actualHours),
  ].join("|");
}

function sampleCounts(records: HistoricalRecord[]): Pick<
  RecalculationSummary,
  "taskTypeSampleCounts" | "toolTaskSampleCounts" | "complexitySampleCounts"
> {
  const taskTypeSampleCounts: Record<string, number> = {};
  const toolTaskSampleCounts: Record<string, Record<string, number>> = {};
  const complexitySampleCounts: Record<string, Record<number, number>> = {};

  for (const record of records) {
    taskTypeSampleCounts[record.taskType] = (taskTypeSampleCounts[record.taskType] ?? 0) + 1;
    const tool = record.tool ?? "unknown";
    toolTaskSampleCounts[tool] ??= {};
    toolTaskSampleCounts[tool][record.taskType] = (toolTaskSampleCounts[tool][record.taskType] ?? 0) + 1;
    if (record.complexity !== undefined) {
      const taskCounts = complexitySampleCounts[record.taskType] ?? {};
      taskCounts[record.complexity] = (taskCounts[record.complexity] ?? 0) + 1;
      complexitySampleCounts[record.taskType] = taskCounts;
    }
  }

  return { taskTypeSampleCounts, toolTaskSampleCounts, complexitySampleCounts };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Ceil-rank (nearest-rank) index, shared with monteCarloSim's quantiles:
  // the previous floor-rank index was biased one rank high (floor(p*n) can
  // equal n for p<1, so p95 of an n=20 sample returned the maximum).
  const idx = percentileIndex(sorted.length, p);
  return Math.round((sorted[idx] ?? 0) * 100) / 100;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

export function computeTelemetryBenchmarks(records: ToolCallRecord[]): NonNullable<ReferenceDatabaseLike["toolExecutionBenchmarks"]> {
  const grouped = new Map<string, ToolCallRecord[]>();
  for (const record of records) {
    if (!isFiniteNumber(record.elapsedMs) || record.elapsedMs < 0 || typeof record.tool !== "string") continue;
    const arr = grouped.get(record.tool) ?? [];
    arr.push(record);
    grouped.set(record.tool, arr);
  }

  const result: NonNullable<ReferenceDatabaseLike["toolExecutionBenchmarks"]> = {};
  for (const [tool, toolRecords] of [...grouped.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const elapsed = toolRecords.map((record) => record.elapsedMs).sort((a, b) => a - b);
    const mean = elapsed.reduce((sum, value) => sum + value, 0) / elapsed.length;
    const variance = elapsed.reduce((sum, value) => sum + (value - mean) ** 2, 0) / elapsed.length;
    result[tool] = {
      p50_ms: percentile(elapsed, 0.5),
      p95_ms: percentile(elapsed, 0.95),
      mean_ms: roundMs(mean),
      stddev_ms: roundMs(Math.sqrt(variance)),
      min_ms: roundMs(elapsed[0] ?? 0),
      max_ms: roundMs(elapsed[elapsed.length - 1] ?? 0),
      sampleCount: elapsed.length,
    };
  }

  return result;
}

export function recalculateReferenceDatabase(
  baseDb: ReferenceDatabaseLike,
  input: CalibrationRecalculationInput,
): RecalculationResult {
  const matchedRecords: HistoricalRecord[] = [];
  const calibrationCandidates: CalibrationCandidate[] = [];
  const telemetryEvents: ToolCallRecord[] = [];
  let receiverRecords = 0;
  let legacyReceiverBaselineRecords = 0;
  let excludedRecords = 0;

  for (const source of input.sources) {
    if (source.estimates || source.actuals) {
      const records = matchEstimatesToActuals(source.estimates ?? [], source.actuals ?? []);
      matchedRecords.push(...records);
      calibrationCandidates.push(...records.map((record) => ({ record, origin: "source" as const })));
    }
    if (source.receiverRecords) {
      receiverRecords += source.receiverRecords.length;
      for (const receiverRecord of source.receiverRecords) {
        const converted = receiverToHistorical(receiverRecord);
        if (converted.excluded) {
          excludedRecords++;
          continue;
        }
        if (converted.legacyReceiverBaseline) legacyReceiverBaselineRecords++;
        if (converted.record) {
          matchedRecords.push(converted.record);
          calibrationCandidates.push({ record: converted.record, origin: "receiver" });
        }
      }
    }
    if (source.telemetryEvents) {
      telemetryEvents.push(...source.telemetryEvents);
    }
  }

  const correctionRecords: HistoricalRecord[] = [];
  let duplicateCorrectionRecords = 0;
  const sourceCorrectionKeys = new Set(
    calibrationCandidates
      .filter((candidate) => candidate.origin === "source" && isCorrectionEligibleRecord(candidate.record))
      .map((candidate) => correctionDedupeKey(candidate.record)),
  );

  for (const { record, origin } of calibrationCandidates) {
    if (!isCorrectionEligibleRecord(record)) continue;
    if (origin === "receiver" && sourceCorrectionKeys.has(correctionDedupeKey(record))) {
      duplicateCorrectionRecords++;
      continue;
    }
    correctionRecords.push(record);
  }

  const baselineRecords = matchedRecords.filter((record) => record.calibrationUsage === "baseline").length;
  const sourceLabel = input.sourceLabel ?? "telemetry-prospective-aggregate";
  const counts = sampleCounts(correctionRecords);
  const taskTypeCorrectionFactors = correctionRecords.length >= MIN_RECORDS_FOR_DATABASE_UPDATE
    ? computeTaskTypeCorrectionFactors(correctionRecords)
    : (baseDb.taskTypeCorrectionFactors ?? {});
  const toolTaskCorrectionFactors = correctionRecords.length >= MIN_RECORDS_FOR_DATABASE_UPDATE
    ? computeToolTaskCorrectionFactors(correctionRecords)
    : (baseDb.toolTaskCorrectionFactors ?? {});
  const complexityCorrectionFactors = correctionRecords.length >= MIN_RECORDS_FOR_DATABASE_UPDATE
    ? computeComplexityCorrectionFactors(correctionRecords)
    : (baseDb.complexityCorrectionFactors ?? {});
  const globalCorrectionFactor = correctionRecords.length >= MIN_RECORDS_FOR_DATABASE_UPDATE
    ? computeGlobalCorrectionFactor(correctionRecords)
    : (baseDb.globalCorrectionFactor ?? 1.07);
  const toolExecutionBenchmarks = telemetryEvents.length > 0
    ? computeTelemetryBenchmarks(telemetryEvents)
    : (baseDb.toolExecutionBenchmarks ?? {});

  const summary: RecalculationSummary = {
    generatedAt: input.generatedAt,
    sourceLabel,
    sourceNames: input.sources.map((source) => source.name),
    telemetryEvents: telemetryEvents.length,
    receiverRecords,
    legacyReceiverBaselineRecords,
    totalCalibrationRecords: matchedRecords.length + excludedRecords,
    correctionRecords: correctionRecords.length,
    baselineRecords,
    excludedRecords,
    duplicateCorrectionRecords,
    ...counts,
  };

  const db: ReferenceDatabaseLike = {
    ...structuredClone(baseDb),
    generatedAt: input.generatedAt,
    source: sourceLabel,
    sampleSize: telemetryEvents.length + correctionRecords.length,
    description: input.description
      ?? "Reference database recalculated from prospective first-party Epoch telemetry; correction factors exclude backfilled, legacy receiver, synthetic, and smoke records.",
    toolExecutionBenchmarks,
    taskTypeCorrectionFactors,
    globalCorrectionFactor,
    toolTaskCorrectionFactors,
    complexityCorrectionFactors,
    complexityCorrectionFactorStatus: Object.keys(complexityCorrectionFactors).length > 0
      ? "Computed from prospective correction-eligible telemetry with at least 3 records per task type and complexity."
      : "No correction-eligible bundled telemetry source currently has at least 3 records per task type and complexity.",
    provenanceSummary: { ...summary },
  };

  if (db.estimationAccuracy?.correctionFactors) {
    db.estimationAccuracy = {
      ...db.estimationAccuracy,
      correctionFactors: {
        ...db.estimationAccuracy.correctionFactors,
        global: globalCorrectionFactor,
        methodology:
          "Global factor recalculated from prospective correction-eligible Epoch telemetry; canary task-type factors are retained separately.",
      },
    };
  }

  return { db, summary };
}
