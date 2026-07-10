import type {
  ReasoningDepth,
  TokenCostEstimate,
  ModelComparison,
  ModelComparisonEntry,
  QualityTier,
} from "../types/index.js";
import { tokenTimeBridge, MODEL_CALIBRATIONS } from "./analytics.js";
import { getModelPricing, getAllModelPricing } from "./supplementary-data.js";

// ---------------------------------------------------------------------------
// Fallback pricing for models without supplementary data
// ---------------------------------------------------------------------------

const FALLBACK_COST_INPUT = 3; // $3 / 1M input tokens
const FALLBACK_COST_OUTPUT = 15; // $15 / 1M output tokens
const AVG_TOOL_CALL_TOKENS = 200;

// ---------------------------------------------------------------------------
// Quality-tier mapping
// ---------------------------------------------------------------------------

const FAST_MODELS = new Set([
  "claude-3.5-haiku-20241022",
  "claude-haiku-4-5",
  "gpt-4o-mini",
  "gemini-2.0-flash",
  "llama-3.1-70b",
]);

const PREMIUM_MODELS = new Set([
  "claude-opus-4-20250514",
  "claude-opus-4-8",
  "claude-fable-5",
  "gpt-4-turbo",
]);

function getQualityTier(model: string): QualityTier {
  if (FAST_MODELS.has(model)) return "fast";
  if (PREMIUM_MODELS.has(model)) return "premium";
  return "standard";
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

// ---------------------------------------------------------------------------
// tokenCostEstimate
// ---------------------------------------------------------------------------

export function tokenCostEstimate(params: {
  tokens: number;
  model: string;
  toolCalls: number;
  reasoningDepth: ReasoningDepth;
}): TokenCostEstimate {
  const timeMapping = tokenTimeBridge(params);
  const pricing = getModelPricing(params.model);

  const costInput = pricing?.costInput ?? FALLBACK_COST_INPUT;
  const costOutput = pricing?.costOutput ?? FALLBACK_COST_OUTPUT;

  const { promptTokens, completionTokens } = timeMapping.breakdown;

  if (!Number.isFinite(promptTokens) || !Number.isFinite(completionTokens)) {
    return {
      tokens: params.tokens, model: params.model,
      estimatedSeconds: 0, estimatedMinutes: 0,
      estimatedCost: 0, costBreakdown: { inputCost: 0, outputCost: 0, toolCallOverheadCost: 0 },
      timeBreakdown: timeMapping.breakdown, confidence: timeMapping.confidence, urgency: timeMapping.urgency,
      humanReadable: `Cost estimate unavailable for ${params.model} — calibration data issue.`,
    };
  }

  const inputCost = round4((promptTokens * costInput) / 1_000_000);
  const outputCost = round4((completionTokens * costOutput) / 1_000_000);
  const toolCallOverheadCost = round4(
    (params.toolCalls * AVG_TOOL_CALL_TOKENS * costOutput) / 1_000_000,
  );

  const totalCost = round4(inputCost + outputCost + toolCallOverheadCost);

  const estMin = Math.round(timeMapping.estimatedMinutes * 10) / 10;

  const humanReadable =
    `~${estMin} min, ~$${totalCost} for ${params.tokens} tokens with ${params.model} (${params.reasoningDepth} reasoning, ${params.toolCalls} tool calls)`;

  return {
    tokens: params.tokens,
    model: params.model,
    estimatedSeconds: timeMapping.estimatedSeconds,
    estimatedMinutes: timeMapping.estimatedMinutes,
    estimatedCost: totalCost,
    costBreakdown: {
      inputCost,
      outputCost,
      toolCallOverheadCost,
    },
    timeBreakdown: timeMapping.breakdown,
    confidence: timeMapping.confidence,
    urgency: timeMapping.urgency,
    humanReadable,
  };
}

// ---------------------------------------------------------------------------
// compareModels
// ---------------------------------------------------------------------------

export function compareModels(params: {
  tokens: number;
  toolCalls: number;
  reasoningDepth: ReasoningDepth;
  sortBy?: "cost" | "time";
}): ModelComparison {
  const sortBy = params.sortBy ?? "cost";
  const allPricing = getAllModelPricing();

  const entries: ModelComparisonEntry[] = [];

  for (const model of Object.keys(MODEL_CALIBRATIONS)) {
    const timeMapping = tokenTimeBridge({
      tokens: params.tokens,
      model,
      toolCalls: params.toolCalls,
      reasoningDepth: params.reasoningDepth,
    });

    const pricing = allPricing[model];
    const costInput = pricing?.costInput ?? FALLBACK_COST_INPUT;
    const costOutput = pricing?.costOutput ?? FALLBACK_COST_OUTPUT;

    const { promptTokens, completionTokens } = timeMapping.breakdown;

    const inputCost = (promptTokens * costInput) / 1_000_000;
    const outputCost = (completionTokens * costOutput) / 1_000_000;
    const toolCallOverheadCost =
      (params.toolCalls * AVG_TOOL_CALL_TOKENS * costOutput) / 1_000_000;

    const totalCost = round4(inputCost + outputCost + toolCallOverheadCost);

    const calibration = MODEL_CALIBRATIONS[model];
    const tps = calibration?.tokensPerSecond ?? 75;

    entries.push({
      model,
      estimatedSeconds: timeMapping.estimatedSeconds,
      estimatedMinutes: timeMapping.estimatedMinutes,
      estimatedCost: totalCost,
      costAvailable: pricing != null,
      qualityTier: getQualityTier(model),
      tokensPerSecond: tps,
    });
  }

  // Sort — models with cost 0 go last
  entries.sort((a, b) => {
    if (sortBy === "time") {
      return a.estimatedSeconds - b.estimatedSeconds;
    }
    // default: cost
    if (a.estimatedCost === 0 && b.estimatedCost !== 0) return 1;
    if (a.estimatedCost !== 0 && b.estimatedCost === 0) return -1;
    return a.estimatedCost - b.estimatedCost;
  });

  // Build human-readable table
  const header = "Model                          | Time (min) | Cost ($)  | Tier";
  const separator = "-------------------------------|------------|-----------|--------";
  const rows = entries.map((e) => {
    const modelCol = e.model.padEnd(30);
    const timeCol = String(e.estimatedMinutes).padStart(10);
    const costCol = e.estimatedCost.toFixed(4).padStart(9);
    const tierCol = e.qualityTier;
    return `${modelCol}| ${timeCol} | ${costCol} | ${tierCol}`;
  });

  const humanReadable = [header, separator, ...rows].join("\n");

  return {
    tokens: params.tokens,
    models: entries,
    sortBy,
    humanReadable,
  };
}
