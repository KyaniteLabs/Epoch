import type {
  TokenTimeMapping,
  ConfidenceLevel,
  UrgencyCategory,
  AccuracyMetrics,
  ReasoningDepth,
  TaskType,
} from "../types/index.js";
import { loadReferenceDb, getTaskTypeCorrectionFactor as getDbCorrectionFactor, getToolTaskCorrectionFactor, getGlobalCorrectionFactor } from "./self-improve.js";
import { getTelemetry } from "./telemetry.js";
import { getReferenceClassForCategory } from "./supplementary-data.js";

interface ModelCalibration {
  readonly tokensPerSecond: number;
  readonly reasoningOverheadMs: number;
  readonly toolCallLatencyMs: number;
}

const MODEL_CALIBRATIONS: Record<string, ModelCalibration> = {
  "claude-3.5-haiku-20241022": { tokensPerSecond: 100, reasoningOverheadMs: 145, toolCallLatencyMs: 200 },
  "claude-opus-4-20250514": { tokensPerSecond: 55, reasoningOverheadMs: 360, toolCallLatencyMs: 200 },
  "claude-sonnet-4-20250514": { tokensPerSecond: 72, reasoningOverheadMs: 205, toolCallLatencyMs: 200 },
  "deepseek-v3": { tokensPerSecond: 97, reasoningOverheadMs: 410, toolCallLatencyMs: 200 },
  "gemini-2.0-flash": { tokensPerSecond: 230, reasoningOverheadMs: 90, toolCallLatencyMs: 200 },
  "gemini-2.5-pro": { tokensPerSecond: 68, reasoningOverheadMs: 280, toolCallLatencyMs: 200 },
  "gpt-4-turbo": { tokensPerSecond: 27.5, reasoningOverheadMs: 1405, toolCallLatencyMs: 200 },
  "gpt-4o": { tokensPerSecond: 85, reasoningOverheadMs: 155, toolCallLatencyMs: 200 },
  "gpt-4o-mini": { tokensPerSecond: 180, reasoningOverheadMs: 130, toolCallLatencyMs: 200 },
  "llama-3.1-405b": { tokensPerSecond: 30, reasoningOverheadMs: 300, toolCallLatencyMs: 200 },
  "llama-3.1-70b": { tokensPerSecond: 100, reasoningOverheadMs: 100, toolCallLatencyMs: 200 },
  "mistral-large": { tokensPerSecond: 42.6, reasoningOverheadMs: 730, toolCallLatencyMs: 200 },
};

const REASONING_DEPTH_MULTIPLIER: Record<ReasoningDepth, number> = {
  shallow: 1.0,
  moderate: 2.5,
  deep: 5.0,
};

const INDUSTRY_CORRECTION_FACTORS: Record<string, number> = {
  feature: 1.8,
  bugfix: 1.4,
  refactor: 2.0,
  migration: 2.2,
  infrastructure: 1.9,
  documentation: 1.3,
  testing: 1.5,
  design: 1.7,
};

function getUrgency(seconds: number): UrgencyCategory {
  const hours = seconds / 3600;
  if (hours < 2) return "short";
  if (hours <= 48) return "medium";
  return "long";
}

function getMedianTps(cal: { medianTps?: number; medianTokensPerSecond?: number }): number {
  return cal.medianTps ?? cal.medianTokensPerSecond ?? 0;
}

function getModelCalibration(model: string): ModelCalibration {
  // Priority: live telemetry → reference DB → hardcoded table → generic fallback
  const telemetryStats = getTelemetry().getModelStats(model, 30);
  if (telemetryStats && telemetryStats.sampleCount >= 10) {
    const base = MODEL_CALIBRATIONS[model] ?? { tokensPerSecond: 75, reasoningOverheadMs: 2500, toolCallLatencyMs: 500 };
    return { ...base, tokensPerSecond: telemetryStats.medianTps };
  }

  const db = loadReferenceDb();
  if (db?.tokenTimeCalibration?.[model]) {
    const dbTps = getMedianTps(db.tokenTimeCalibration[model]);
    if (dbTps > 0) {
      const base = MODEL_CALIBRATIONS[model] ?? { tokensPerSecond: 75, reasoningOverheadMs: 2500, toolCallLatencyMs: 500 };
      return { ...base, tokensPerSecond: dbTps };
    }
  }

  const dbDefault = db?.tokenTimeCalibration?.["_default"];
  if (dbDefault && !MODEL_CALIBRATIONS[model]) {
    const tps = getMedianTps(dbDefault);
    return { tokensPerSecond: tps > 0 ? tps : 75, reasoningOverheadMs: 2500, toolCallLatencyMs: 500 };
  }

  return MODEL_CALIBRATIONS[model] ?? { tokensPerSecond: 75, reasoningOverheadMs: 2500, toolCallLatencyMs: 500 };
}

function getPromptRatio(model: string): number {
  const db = loadReferenceDb();
  const profile = db?.modelLatencyProfiles?.[model];
  if (profile?.tokensPerRound && typeof profile.tokensPerRound === "object") {
    const total = profile.tokensPerRound.mean;
    const prompt = profile.tokensPerRound.meanPrompt;
    if (total > 0) return prompt / total;
  }
  return 0.3;
}

function getConfidence(model: string): ConfidenceLevel {
  const cal = getModelCalibration(model);
  if (MODEL_CALIBRATIONS[model]) return "likely";
  if (cal.tokensPerSecond !== 75) return "likely";
  return "optimistic";
}

export function tokenTimeBridge(params: {
  tokens: number;
  model: string;
  toolCalls: number;
  reasoningDepth: ReasoningDepth;
}): TokenTimeMapping {
  const cal = getModelCalibration(params.model);
  const promptRatio = getPromptRatio(params.model);

  const generationTimeSeconds = params.tokens / cal.tokensPerSecond;
  const toolOverheadSeconds = (params.toolCalls * cal.toolCallLatencyMs) / 1000;
  const reasoningSeconds = (cal.reasoningOverheadMs / 1000) * REASONING_DEPTH_MULTIPLIER[params.reasoningDepth];

  const totalSeconds = generationTimeSeconds + toolOverheadSeconds + reasoningSeconds;
  const estMin = Math.round(totalSeconds / 60 * 10) / 10;
  const timeStr = estMin >= 60
    ? `${Math.round(estMin / 60 * 10) / 10} hours`
    : `${estMin} minutes`;
  const confidence = getConfidence(params.model);

  return {
    tokens: params.tokens,
    model: params.model,
    estimatedSeconds: Math.round(totalSeconds),
    estimatedMinutes: estMin,
    confidence,
    urgency: getUrgency(totalSeconds),
    breakdown: {
      promptTokens: Math.round(params.tokens * promptRatio),
      completionTokens: Math.round(params.tokens * (1 - promptRatio)),
      toolOverheadSeconds: Math.round(toolOverheadSeconds * 100) / 100,
    },
    humanReadable: `Approximately ${timeStr} for ${params.tokens.toLocaleString()} tokens with ${params.model} (${params.reasoningDepth} reasoning, ${params.toolCalls} tool calls). Confidence: ${confidence}.`,
  };
}

export interface HistoricalRecord {
  readonly taskType: string;
  readonly estimatedHours: number;
  readonly actualHours: number;
  readonly teamId?: string;
  readonly tool?: string;
  readonly completedAt: string;
}

function getCorrectionFactorForTaskType(taskType: TaskType, tool?: string): number {
  // Priority: tool-specific reference DB → task-type reference DB → industry defaults
  if (tool) {
    const toolFactor = getToolTaskCorrectionFactor(tool, taskType);
    if (toolFactor !== 1.8) return toolFactor;
  }
  const dbFactor = getDbCorrectionFactor(taskType);
  if (dbFactor !== 1.8) return dbFactor;
  return INDUSTRY_CORRECTION_FACTORS[taskType] ?? 1.8;
}

export function referenceClassEstimate(
  records: HistoricalRecord[],
  taskType: TaskType,
  complexity: number,
): {
  rawEstimate: number;
  correctedEstimate: number;
  correctionFactor: number;
  sampleSize: number;
  baselineSource: string;
  confidence: ConfidenceLevel;
} {
  const filtered = records.filter(r => r.taskType === taskType && r.estimatedHours > 0);

  let correctionFactor: number;
  let sampleSize: number;

  if (filtered.length >= 5) {
    const ratios = filtered.map(r => r.actualHours / r.estimatedHours);
    ratios.sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    correctionFactor = ratios.length % 2 === 0
      ? ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2
      : (ratios[mid] ?? 1.8);
    sampleSize = filtered.length;
  } else {
    correctionFactor = getCorrectionFactorForTaskType(taskType, "reference_class_estimate");
    sampleSize = filtered.length;
  }

  // Use real session data when available, otherwise fall back to traditional 8h baseline
  const realBaseline = getReferenceClassForCategory(taskType);
  let rawEstimate: number;
  let baselineSource: string;
  if (realBaseline && realBaseline.total_samples >= 5) {
    const clampedComplexity = Math.max(1, Math.min(5, complexity));
    const complexityNorm = (clampedComplexity - 1) / 4; // 0..1 for complexity 1..5
    rawEstimate = realBaseline.p25_hours + (realBaseline.p75_hours - realBaseline.p25_hours) * complexityNorm;
    baselineSource = `real_tasks_${realBaseline.total_samples}`;
  } else {
    const complexityMultiplier = 0.5 + (complexity - 1) * 0.375;
    rawEstimate = 8 * complexityMultiplier;
    baselineSource = "industry_8h";
  }

  const correctedEstimate = Math.round(rawEstimate * correctionFactor * 10) / 10;

  return {
    rawEstimate: Math.round(rawEstimate * 10) / 10,
    correctedEstimate,
    correctionFactor: Math.round(correctionFactor * 100) / 100,
    sampleSize,
    baselineSource,
    confidence: sampleSize >= 10 ? "likely" : sampleSize >= 5 ? "optimistic" : "pessimistic",
  };
}

export function computeAccuracyMetrics(records: HistoricalRecord[]): AccuracyMetrics {
  if (records.length === 0) {
    return { mape: 0, bias: 0, variance: 0, sample_size: 0, trend: "stable" };
  }

  const validRecords = records.filter(r => r.actualHours > 0);
  if (validRecords.length === 0) {
    return { mape: 0, bias: 0, variance: 0, sample_size: records.length, trend: "stable" };
  }

  const errors = validRecords.map(r => Math.abs(r.actualHours - r.estimatedHours) / r.actualHours);
  const mape = (errors.reduce((a, b) => a + b, 0) / errors.length) * 100;

  const biases = validRecords.map(r => r.actualHours - r.estimatedHours);
  const bias = biases.reduce((a, b) => a + b, 0) / biases.length;

  const meanBias = bias;
  const variance = biases.reduce((sum, b) => sum + (b - meanBias) ** 2, 0) / biases.length;

  let trend: AccuracyMetrics["trend"] = "stable";
  if (records.length >= 6) {
    const half = Math.floor(records.length / 2);
    const firstHalf = records.slice(0, half);
    const secondHalf = records.slice(half);
    const mapeFirst = avgPercentageError(firstHalf);
    const mapeSecond = avgPercentageError(secondHalf);
    if (mapeSecond < mapeFirst * 0.85) trend = "improving";
    else if (mapeSecond > mapeFirst * 1.15) trend = "degrading";
  }

  return {
    mape: Math.round(mape * 10) / 10,
    bias: Math.round(bias * 10) / 10,
    variance: Math.round(variance * 10) / 10,
    sample_size: records.length,
    trend,
  };
}

function avgPercentageError(records: HistoricalRecord[]): number {
  const valid = records.filter(r => r.actualHours > 0);
  if (valid.length === 0) return 0;
  return valid.reduce((sum, r) => sum + Math.abs(r.actualHours - r.estimatedHours) / r.actualHours, 0) / valid.length * 100;
}

export function calibrateEstimates(
  teamId: string,
  periodDays: number,
  minimumSamples: number,
  records?: HistoricalRecord[],
): {
  correctionFactor: number;
  accuracyTrend: string;
  velocityTrend: string;
  recommendations: string[];
} {
  const data = records ?? [];

  if (data.length >= minimumSamples) {
    const metrics = computeAccuracyMetrics(data);
    const correctionFactor = metrics.mape > 0
      ? Math.round((1 + metrics.mape / 100) * 100) / 100
      : getGlobalCorrectionFactor();

    const recs = [
      `Computed from ${data.length} historical records over ${periodDays} days.`,
      `MAPE: ${metrics.mape}%, bias: ${metrics.bias > 0 ? "underestimation" : "overestimation"} (${metrics.bias}).`,
      `Accuracy trend: ${metrics.trend}.`,
    ];
    if (metrics.trend === "degrading") {
      recs.push("Accuracy is degrading — review recent estimates for systematic bias.");
    }
    if (metrics.sample_size < 20) {
      recs.push("More data points (20+) will improve calibration reliability.");
    }

    return {
      correctionFactor,
      accuracyTrend: metrics.trend,
      velocityTrend: metrics.trend === "improving" ? "accelerating" : metrics.trend === "degrading" ? "slowing" : "stable",
      recommendations: recs,
    };
  }

  const dbFactor = getGlobalCorrectionFactor();
  return {
    correctionFactor: dbFactor,
    accuracyTrend: "stable",
    velocityTrend: "stable",
    recommendations: [
      `Using reference database correction factor (${dbFactor}x) — ${data.length} samples, need ${minimumSamples}.`,
      "Submit actuals via POST /v1/feedback/record-actual to enable data-driven calibration.",
      "Accuracy improves significantly with 10+ historical data points per task type.",
    ],
  };
}

export { MODEL_CALIBRATIONS };
