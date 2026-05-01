import type {
  TokenTimeMapping,
  TokenTimeBreakdown,
  ConfidenceLevel,
  UrgencyCategory,
  AccuracyMetrics,
  LLMModel,
  ReasoningDepth,
  TaskType,
} from "../types/index.js";

interface ModelCalibration {
  readonly tokensPerSecond: number;
  readonly reasoningOverheadMs: number;
  readonly toolCallLatencyMs: number;
}

const MODEL_CALIBRATIONS: Record<string, ModelCalibration> = {
  "claude-sonnet-4-20250514": { tokensPerSecond: 80, reasoningOverheadMs: 2300, toolCallLatencyMs: 500 },
  "claude-opus-4-20250514": { tokensPerSecond: 40, reasoningOverheadMs: 3500, toolCallLatencyMs: 800 },
  "claude-3.5-haiku-20241022": { tokensPerSecond: 150, reasoningOverheadMs: 1200, toolCallLatencyMs: 350 },
  "gpt-4o": { tokensPerSecond: 100, reasoningOverheadMs: 2000, toolCallLatencyMs: 400 },
  "gpt-4o-mini": { tokensPerSecond: 200, reasoningOverheadMs: 1000, toolCallLatencyMs: 300 },
  "gpt-4-turbo": { tokensPerSecond: 90, reasoningOverheadMs: 2200, toolCallLatencyMs: 450 },
  "gemini-2.0-flash": { tokensPerSecond: 180, reasoningOverheadMs: 1100, toolCallLatencyMs: 350 },
  "gemini-2.5-pro": { tokensPerSecond: 70, reasoningOverheadMs: 2800, toolCallLatencyMs: 550 },
  "llama-3.1-70b": { tokensPerSecond: 120, reasoningOverheadMs: 1500, toolCallLatencyMs: 400 },
  "llama-3.1-405b": { tokensPerSecond: 50, reasoningOverheadMs: 3000, toolCallLatencyMs: 600 },
  "mistral-large": { tokensPerSecond: 85, reasoningOverheadMs: 2000, toolCallLatencyMs: 450 },
  "deepseek-v3": { tokensPerSecond: 95, reasoningOverheadMs: 1800, toolCallLatencyMs: 400 },
};

const REASONING_DEPTH_MULTIPLIER: Record<ReasoningDepth, number> = {
  shallow: 1.0,
  moderate: 2.5,
  deep: 5.0,
};

function getUrgency(seconds: number): UrgencyCategory {
  const hours = seconds / 3600;
  if (hours < 2) return "short";
  if (hours <= 48) return "medium";
  return "long";
}

function getConfidence(model: string): ConfidenceLevel {
  if (model in MODEL_CALIBRATIONS) return "likely";
  return "optimistic";
}

export function tokenTimeBridge(params: {
  tokens: number;
  model: string;
  toolCalls: number;
  reasoningDepth: ReasoningDepth;
}): TokenTimeMapping {
  const cal = MODEL_CALIBRATIONS[params.model] ?? {
    tokensPerSecond: 75,
    reasoningOverheadMs: 2500,
    toolCallLatencyMs: 500,
  };

  const generationTimeSeconds = params.tokens / cal.tokensPerSecond;
  const toolOverheadSeconds = (params.toolCalls * cal.toolCallLatencyMs) / 1000;
  const reasoningSeconds = (cal.reasoningOverheadMs / 1000) * REASONING_DEPTH_MULTIPLIER[params.reasoningDepth];

  const totalSeconds = generationTimeSeconds + toolOverheadSeconds + reasoningSeconds;

  return {
    tokens: params.tokens,
    model: params.model,
    estimatedSeconds: Math.round(totalSeconds),
    estimatedMinutes: Math.round(totalSeconds / 60 * 10) / 10,
    confidence: getConfidence(params.model),
    urgency: getUrgency(totalSeconds),
    breakdown: {
      promptTokens: Math.round(params.tokens * 0.3),
      completionTokens: Math.round(params.tokens * 0.7),
      toolOverheadSeconds: Math.round(toolOverheadSeconds * 100) / 100,
    },
  };
}

export interface HistoricalRecord {
  readonly taskType: string;
  readonly estimatedHours: number;
  readonly actualHours: number;
  readonly teamId?: string;
  readonly completedAt: string;
}

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

export function referenceClassEstimate(
  records: HistoricalRecord[],
  taskType: TaskType,
  complexity: number,
): {
  rawEstimate: number;
  correctedEstimate: number;
  correctionFactor: number;
  sampleSize: number;
  confidence: ConfidenceLevel;
} {
  const filtered = records.filter(r => r.taskType === taskType);

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
    correctionFactor = INDUSTRY_CORRECTION_FACTORS[taskType] ?? 1.8;
    sampleSize = filtered.length;
  }

  const complexityMultiplier = 0.5 + (complexity - 1) * 0.375;
  const rawEstimate = 8 * complexityMultiplier;
  const correctedEstimate = Math.round(rawEstimate * correctionFactor * 10) / 10;

  return {
    rawEstimate: Math.round(rawEstimate * 10) / 10,
    correctedEstimate,
    correctionFactor: Math.round(correctionFactor * 100) / 100,
    sampleSize,
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
  return records.reduce((sum, r) => sum + Math.abs(r.actualHours - r.estimatedHours) / r.actualHours, 0) / records.length * 100;
}

export function calibrateEstimates(
  _teamId: string,
  _periodDays: number,
  _minimumSamples: number,
): {
  correctionFactor: number;
  accuracyTrend: string;
  velocityTrend: string;
  recommendations: string[];
} {
  return {
    correctionFactor: 1.5,
    accuracyTrend: "stable",
    velocityTrend: "stable",
    recommendations: [
      "Connect a PM system (Jira, Asana, or Toggl) to enable data-driven calibration.",
      "Current correction factor uses industry averages (1.5x for software tasks).",
      "Accuracy improves significantly with 10+ historical data points per task type.",
    ],
  };
}

export { MODEL_CALIBRATIONS };
