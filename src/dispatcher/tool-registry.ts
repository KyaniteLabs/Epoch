// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Tool Registry
// Maps all 24 tool names to handler functions and Zod input schemas.
// Translates between snake_case schema fields and camelCase lib params.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolResult } from "../types/index.js";
import {
  getCurrentTime,
  convertTimezone,
  parseDuration,
} from "../lib/temporal.js";
import { addBusinessDays, countBusinessDays } from "../lib/calendar.js";
import { dispatchTimeMath } from "../lib/internal/time-math-dispatch.js";
import {
  pertEstimate,
  cocomoEstimate,
  sprintForecast,
  criticalPath,
  monteCarloSim,
} from "../lib/estimation.js";
import {
  referenceClassEstimate,
  calibrateEstimates,
  tokenTimeBridge,
  getScopeGuide,
  inferScopeFromComplexity,
} from "../lib/analytics.js";
import { getCalibrationData, recordActualDetailed, getPendingEstimates, batchRecordActuals, getFeedbackHealthReport } from "../lib/feedback.js";
import {
  isPertLearnedCorrectionEnabled,
  getPertToolTaskCorrection,
  composePertCorrectionFactor,
} from "../lib/calibration-factors.js";
import { tokenCostEstimate, compareModels } from "../lib/cost.js";
import { computeAccuracyTrend } from "../lib/accuracy-trend.js";
import { scheduleRisk } from "../lib/risk.js";
import { cocomoValidate } from "../lib/cocomo-validate.js";
import { cocomoValidateGroundTruth } from "../lib/cocomo-ground-truth.js";
import { getDeveloperProfileGradient } from "../lib/profiles.js";
import {
  timeMathSchema,
  pertEstimateSchema,
  cocomoEstimateSchema,
  sprintForecastSchema,
  criticalPathSchema,
  monteCarloSchema,
  referenceClassEstimateSchema,
  calibrateEstimatesSchema,
  tokenTimeBridgeSchema,
  tokenCostEstimateSchema,
  compareModelsSchema,
  accuracyTrendSchema,
  scheduleRiskSchema,
  cocomoValidateSchema,
  cocomoGroundTruthSchema,
  recordActualSchema,
  batchRecordActualsSchema,
  feedbackHealthSchema,
  estimateFromContextSchema,
} from "../schemas/index.js";

// ---- Tool Definition --------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  outputSchema: Record<string, unknown>;
  handler: (input: Record<string, unknown>) => ToolResult<unknown>;
}

// ---- Helper -----------------------------------------------------------------

function tool(
  name: string,
  description: string,
  inputSchema: z.ZodType,
  outputSchema: Record<string, unknown>,
  handler: (input: Record<string, unknown>) => ToolResult<unknown>,
): [string, ToolDefinition] {
  return [name, { name, description, inputSchema, outputSchema, handler }];
}

// ---- Simple schemas for tools without dedicated schemas ---------------------

const getCurrentTimeSchema = z.object({
  timezone: z
    .string()
    .describe('IANA timezone identifier. Defaults to "UTC".')
    .default("UTC"),
});

const convertTimezoneSchema = z.object({
  timestamp: z
    .string()
    .describe("ISO-8601 timestamp to convert."),
  target_tz: z
    .string()
    .describe("Target IANA timezone identifier."),
});

const parseDurationSchema = z.object({
  duration_string: z
    .string()
    .describe('Duration string like "2h30m", "1d6h", "45m".'),
});

const addBusinessDaysSchema = z.object({
  start_date: z
    .string()
    .describe("ISO date string for the start date."),
  days: z
    .coerce.number()
    .describe("Number of business days to add (negative to subtract)."),
  country: z
    .string()
    .describe("ISO-3166-1-alpha-2 country code for holiday calendar.")
    .default("US"),
});

const countBusinessDaysSchema = z.object({
  start_date: z
    .string()
    .describe("ISO date string for the start date."),
  end_date: z
    .string()
    .describe("ISO date string for the end date."),
  country: z
    .string()
    .describe("ISO-3166-1-alpha-2 country code for holiday calendar.")
    .default("US"),
});

const getPendingEstimatesSchema = z.object({
  limit: z.number().int().positive().max(100).default(20).describe("Max estimates to return."),
});

// ---- Output schemas (JSON Schema for OpenAPI response docs) -----------------

const temporalOutput = {
  type: "object",
  properties: {
    iso: { type: "string", description: "ISO-8601 timestamp" },
    humanReadable: { type: "string", description: "Human-readable date/time" },
    timezone: { type: "string", description: "IANA timezone identifier" },
    utcOffset: { type: "string", description: "UTC offset string" },
  },
} satisfies Record<string, unknown>;

const durationOutput = {
  type: "object",
  properties: {
    input: { type: "string" },
    totalSeconds: { type: "number" },
    humanReadable: { type: "string" },
  },
} satisfies Record<string, unknown>;

const businessDayOutput = {
  type: "object",
  properties: {
    startDate: { type: "string", description: "Start date (ISO)" },
    endDate: { type: "string", description: "End date (ISO)" },
    businessDays: { type: "number", description: "Number of business days" },
    countryCode: { type: "string", description: "ISO-3166 country code" },
    humanReadable: { type: "string", description: "Human-readable summary" },
  },
} satisfies Record<string, unknown>;

const feedbackRefField = { type: "string", description: "Token for recording actual hours via record_actual" };

const pertOutput = {
  type: "object",
  properties: {
    optimistic: { type: "number" },
    mostLikely: { type: "number" },
    pessimistic: { type: "number" },
    expected: { type: "number", description: "PERT expected value" },
    variance: { type: "number" },
    stdDeviation: { type: "number" },
    confidence95: { type: "array", items: { type: "number" }, description: "95% confidence interval [lower, upper]" },
    confidence99: { type: "array", items: { type: "number" }, description: "99% confidence interval [lower, upper]" },
    unit: { type: "string", enum: ["hours", "days", "weeks", "months"] },
    urgencyCategory: { type: "string", enum: ["short", "medium", "long"] },
    riskLevel: { type: "string", enum: ["low", "medium", "high"], description: "Estimation risk based on spread between optimistic and pessimistic" },
    humanReadable: { type: "string", description: "Human-readable summary" },
    referenceClassCrossCheck: { type: "object", description: "Reference class estimate for comparison (AI-native only)", properties: { estimate: { type: "number" }, scope: { type: "string" }, baselineSource: { type: "string" }, sampleSize: { type: "number" } } },
    recommendation: { type: "string", description: "When reference class disagrees significantly with PERT, explains which to trust" },
    rawEstimate: { type: "number", description: "Pre-correction expected-based headline (same value as `expected`), exposed for provenance parity with reference_class_estimate." },
    correctionFactor: { type: "number", description: "Learned (pert_estimate, task_type) correction factor from computeToolTaskCorrectionFactors, independent of the ai_native developerProfile factor. 1.0 when EPOCH_PERT_LEARNED_CORRECTION is off or the cell has fewer than MIN_RECORDS_PER_FACTOR matched pairs." },
    n: { type: "number", description: "Matched-pair sample size for the (pert_estimate, task_type) correction cell. 0 when the learned-correction flag is off or no task_type was supplied." },
    feedbackRef: feedbackRefField,
  },
} satisfies Record<string, unknown>;

const cocomoOutput = {
  type: "object",
  properties: {
    kloc: { type: "number" },
    personMonthsNominal: { type: "number" },
    personMonthsLlmAdjusted: { type: "number" },
    effortMultipliers: { type: "object", additionalProperties: { type: "number" } },
    assumptions: { type: "array", items: { type: "string" } },
    aiSpeedup: { type: "number", description: "AI speedup factor (nominal / LLM-adjusted)" },
    speedupCategory: { type: "string", enum: ["moderate", "significant", "extreme"], description: "Qualitative speedup category" },
    feedbackRef: feedbackRefField,
  },
} satisfies Record<string, unknown>;

const sprintOutput = {
  type: "object",
  properties: {
    backlogPoints: { type: "number" },
    averageVelocity: { type: "number" },
    requiredSprints: { type: "number" },
    optimisticSprints: { type: "number" },
    pessimisticSprints: { type: "number" },
    hoursPerPoint: { type: "number" },
    totalHours: { type: "number" },
    completionDays: { type: "number" },
    sprintLengthDays: { type: "number" },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    velocityCv: { type: "number" },
    estimatedTokenCost: { type: "number", description: "Estimated AI token cost (50k tokens/hour × totalHours)" },
    feedbackRef: feedbackRefField,
  },
} satisfies Record<string, unknown>;

const criticalPathOutput = {
  type: "object",
  properties: {
    critical_path: { type: "array", items: { type: "string" } },
    slack_per_task: { type: "object", additionalProperties: { type: "number" } },
    total_duration: { type: "number" },
    merge_bias_adjustment: { type: "number" },
    estimatedHours: { type: "number", description: "Total duration in hours (total_duration × 8)" },
    estimatedTokenCost: { type: "number", description: "Estimated token cost (50k tokens/hour × estimatedHours)" },
  },
} satisfies Record<string, unknown>;

const monteCarloOutput = {
  type: "object",
  properties: {
    p10: { type: "string", description: "10th percentile (optimistic)" },
    p50: { type: "string", description: "50th percentile (median)" },
    p80: { type: "string", description: "80th percentile" },
    p95: { type: "string", description: "95th percentile (conservative)" },
    criticalPathProbability: { type: "number" },
    converged: { type: "boolean", description: "Whether p50 converged between iteration halves" },
    riskEvents: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          probability: { type: "number" },
          impactDays: { type: "number" },
        },
      },
    },
    humanReadable: { type: "string", description: "Human-readable summary" },
    estimatedHours: { type: "number", description: "Median estimate in hours (p50 × 8)" },
    estimatedCost: { type: "number", description: "Estimated AI token cost at p50 (50k tokens/hour × estimatedHours)" },
    feedbackRef: feedbackRefField,
  },
} satisfies Record<string, unknown>;

const tokenTimeOutput = {
  type: "object",
  properties: {
    tokens: { type: "number" },
    model: { type: "string" },
    estimatedSeconds: { type: "number" },
    estimatedMinutes: { type: "number" },
    confidence: { type: "string", enum: ["likely", "optimistic", "pessimistic"] },
    urgency: { type: "string", enum: ["short", "medium", "long"] },
    breakdown: {
      type: "object",
      properties: {
        promptTokens: { type: "number" },
        completionTokens: { type: "number" },
        toolOverheadSeconds: { type: "number" },
      },
    },
    humanReadable: { type: "string", description: "Human-readable summary" },
    estimatedTokenCost: { type: "number", description: "Estimated AI token cost (50k tokens/hour × estimatedHours)" },
    feedbackRef: feedbackRefField,
  },
} satisfies Record<string, unknown>;

const referenceClassOutput = {
  type: "object",
  properties: {
    rawEstimate: { type: "number" },
    correctedEstimate: { type: "number" },
    correctionFactor: { type: "number" },
    sampleSize: { type: "number" },
    confidence: { type: "string", enum: ["likely", "optimistic", "pessimistic"] },
    estimatedTokenCost: { type: "number", description: "Estimated AI token cost (50k tokens/hour × correctedEstimate)" },
    feedbackRef: feedbackRefField,
  },
} satisfies Record<string, unknown>;

const calibrateOutput = {
  type: "object",
  properties: {
    mape: { type: "number", description: "Mean Absolute Percentage Error" },
    bias: { type: "number", description: "Mean bias (positive = underestimation)" },
    variance: { type: "number" },
    sample_size: { type: "number" },
    trend: { type: "string", enum: ["improving", "degrading", "stable"] },
  },
} satisfies Record<string, unknown>;

const accuracyTrendOutput = {
  type: "object",
  properties: {
    windows: { type: "array", items: { type: "object", properties: { period: { type: "string" }, mape: { type: "number" }, bias: { type: "number" }, sampleSize: { type: "number" } } } },
    overallTrend: { type: "string", enum: ["improving", "degrading", "stable"] },
    currentMape: { type: "number" },
    industryBaselineMape: { type: "number" },
    improvementVsIndustry: { type: "number" },
    totalEstimates: { type: "number" },
    totalWithActuals: { type: "number" },
    humanReadable: { type: "string" },
  },
} satisfies Record<string, unknown>;

const timeMathOutput = {
  type: "object",
  description: "Varies by operation. Returns temporal, duration, or date diff data.",
} satisfies Record<string, unknown>;



// ---- Handler wrappers (snake_case -> camelCase translation) ----------------

const handlers: Record<string, ToolDefinition> = Object.fromEntries([
  // -- Temporal tools (6) ----------------------------------------------------

  tool(
    "get_current_time",
    "Returns the current date and time in the specified IANA timezone. Useful for grounding the LLM in the user's local time. Example timezones: 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'.",
    getCurrentTimeSchema,
    temporalOutput,
    (input) => {
      const p = getCurrentTimeSchema.parse(input);
      return getCurrentTime(p.timezone);
    },
  ),

  tool(
    "convert_timezone",
    "Converts an ISO-8601 timestamp to a target IANA timezone. " +
      "The input timestamp must include timezone information or be in UTC. " +
      "Returns the localised time, UTC offset, and human-readable format.",
    convertTimezoneSchema,
    temporalOutput,
    (input) => {
      const p = convertTimezoneSchema.parse(input);
      return convertTimezone(p.timestamp, p.target_tz);
    },
  ),

  tool(
    "parse_duration",
    "Parses a human-readable duration string into structured seconds. " +
      "Supports combinations of y (years), mo (months), w (weeks), d (days), h (hours), " +
      "m (minutes), s (seconds). Examples: '2h30m', '1d6h', '1w3d', '45m'.",
    parseDurationSchema,
    durationOutput,
    (input) => {
      const p = parseDurationSchema.parse(input);
      return parseDuration(p.duration_string);
    },
  ),

  tool(
    "time_math",
    "Performs compound time-math operations. Dispatches to the appropriate " +
      "sub-operation based on the 'operation' parameter. " +
      "Operations: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration. " +
      "Use this for multi-step or dynamic time operations; for single-purpose calls use get_current_time, convert_timezone, parse_duration, add_business_days, or count_business_days.",
    timeMathSchema,
    timeMathOutput,
    (input) => {
      const p = timeMathSchema.parse(input);
      const operation = p.operation;
      let ops = p.operands;

      // Defensive: models sometimes send stringified JSON as operands
      if (typeof ops === "string") {
        try { ops = JSON.parse(ops); } catch { /* use as-is */ }
      }
      if (!ops || typeof ops !== "object") ops = {};

      return dispatchTimeMath(operation, ops);
    },
  ),

  tool(
    "add_business_days",
    "Adds N business (working) days to a start date, skipping weekends and " +
      "country-specific public holidays. Supports US, UK, FR, DE, and JP holidays.",
    addBusinessDaysSchema,
    businessDayOutput,
    (input) => {
      const p = addBusinessDaysSchema.parse(input);
      return addBusinessDays(p.start_date, p.days, p.country);
    },
  ),

  tool(
    "count_business_days",
    "Counts the number of business (working) days between two dates, " +
      "excluding weekends and country-specific public holidays. " +
      "The count is exclusive of the start date and inclusive of the end date.",
    countBusinessDaysSchema,
    businessDayOutput,
    (input) => {
      const p = countBusinessDaysSchema.parse(input);
      return countBusinessDays(p.start_date, p.end_date, p.country);
    },
  ),

  // -- Estimation tools (5) --------------------------------------------------

  tool(
    "pert_estimate",
    `Calculate PERT expected duration from three-point estimates using Beta distribution.

Formula: E = (O + 4M + P) / 6. Returns expected value, variance, standard deviation,
and 95%/99% confidence bounds with urgency categorization.
Use when estimating task duration with uncertain outcomes.`,
    pertEstimateSchema,
    pertOutput,
    (input) => {
      const p = pertEstimateSchema.parse(input);
      const profile = getDeveloperProfileGradient(p.ai_native);
      const result = pertEstimate(p.optimistic, p.most_likely, p.pessimistic, p.unit);
      if (!result.ok) return result;

      // Learned-correction wiring (feature-flagged, default OFF): when enabled
      // and task_type is supplied, replace the ai_native developerProfile
      // correction factor in the adjustedEstimate computation with the learned
      // (pert_estimate, task_type) factor IFF that cell has n >= MIN_RECORDS_PER_FACTOR.
      // Never multiplies the two factors together. See calibration-factors.ts
      // composePertCorrectionFactor() for the composition rule.
      //
      // Provenance outputs (rawEstimate, correctionFactor, n — Phase 3 contract
      // wave, additive): correctionFactor/n here report the RAW learned-factor
      // lookup (getPertToolTaskCorrection), not the composed value used for
      // adjustedEstimate — they default to {factor: 1.0, n: 0} when the flag is
      // off or no task_type is supplied, and to {factor: 1.0, n: <actual n>}
      // when the flag is on but the cell hasn't reached MIN_RECORDS_PER_FACTOR
      // (computeToolTaskCorrectionFactors itself withholds a factor below that
      // threshold). This mirrors reference_class_estimate's rawEstimate/
      // correctionFactor fields, which also report the data-driven correction
      // independent of the ai_native developerProfile heuristic.
      let composedFactor = profile.correctionFactor;
      let learnedFactor = 1.0;
      let learnedN = 0;
      if (isPertLearnedCorrectionEnabled() && p.task_type) {
        const learned = getPertToolTaskCorrection(p.task_type);
        learnedFactor = learned.factor;
        learnedN = learned.n;
        composedFactor = composePertCorrectionFactor(learned, profile.correctionFactor).factor;
      }

      const data: Record<string, unknown> = {
        ...result.data,
        developerProfile: { mode: profile.mode, correctionFactor: profile.correctionFactor },
        adjustedEstimate: Math.round(result.data.expected * composedFactor * 100) / 100,
        rawEstimate: result.data.expected,
        correctionFactor: learnedFactor,
        n: learnedN,
      };

      // Cross-check with reference class for AI-native workflows
      if (p.ai_native >= 0.7 && p.task_type) {
        const scope = inferScopeFromComplexity(
          result.data.expected <= 1 ? 1 : result.data.expected <= 4 ? 2 : result.data.expected <= 8 ? 3 : result.data.expected <= 20 ? 4 : 5,
        );
        const records = getCalibrationData(undefined, p.task_type, 90, "reference_class_estimate");
        const refResult = referenceClassEstimate(records, p.task_type, 3, scope, true);
        const refEstimate = Math.round(refResult.correctedEstimate * 100) / 100;
        data.referenceClassCrossCheck = {
          estimate: refEstimate,
          scope,
          baselineSource: refResult.baselineSource,
          sampleSize: refResult.sampleSize,
        };
        if (refEstimate < result.data.expected * 0.5) {
          data.recommendation = `For AI-native ${p.task_type} work, reference_class_estimate (${refEstimate}h) is typically more accurate than PERT (${result.data.expected}h). AI agents finish local-prep tasks 3-10x faster than PERT pessimistic scenarios suggest.`;
        }
      }

      return { ok: true as const, data };
    },
  ),

  tool(
    "cocomo_estimate",
    `LLM-adapted COCOMO II parametric effort estimation.

Replaces traditional 17 human-labor cost drivers with 5 LLM-specific factors:
reasoning complexity, context completeness, transformation impact, iterative cycles,
and human oversight. Returns both nominal and LLM-adjusted person-months.`,
    cocomoEstimateSchema,
    cocomoOutput,
    (input) => {
      const p = cocomoEstimateSchema.parse(input);
      const profile = getDeveloperProfileGradient(p.ai_native);
      const rawCycles = p.iterative_cycles;
      const iterativeCycles = rawCycles > 2.0 ? 1.0 + Math.min(rawCycles, 10) * 0.1 : rawCycles;
      const result = cocomoEstimate({
        kloc: p.kloc,
        reasoningComplexity: p.reasoning_complexity,
        contextCompleteness: p.context_completeness,
        transformationImpact: p.transformation_impact,
        iterativeCycles,
        humanOversight: p.human_oversight,
      });
      if (!result.ok) return result;
      return {
        ok: true as const,
        data: {
          ...result.data,
          developerProfile: { mode: profile.mode, correctionFactor: profile.correctionFactor },
        },
      };
    },
  ),

  tool(
    "sprint_forecast",
    `Forecast sprint completion date from backlog size and historical velocity.

Computes average velocity from sprint history, converts story points to hours,
and returns required sprints with pessimistic estimate based on velocity variance.`,
    sprintForecastSchema,
    sprintOutput,
    (input) => {
      const p = sprintForecastSchema.parse(input);
      const profile = getDeveloperProfileGradient(p.ai_native);
      const result = sprintForecast({
        backlogPoints: p.backlog_points,
        velocityHistory: p.velocity_history,
        sprintLengthDays: p.sprint_length_days,
        hoursPerSprint: p.hours_per_sprint,
      });
      if (!result.ok) return result;
      return {
        ok: true as const,
        data: {
          ...result.data,
          developerProfile: { mode: profile.mode, sprintVelocityPoints: profile.sprintVelocityPoints, correctionFactor: profile.correctionFactor },
        },
      };
    },
  ),

  tool(
    "critical_path",
    `Compute critical path with merge-bias adjustment for project schedules.

Performs forward/backward pass to identify critical tasks and slack.
Applies merge bias: tasks with >2 predecessors get 5% duration increase per extra predecessor.`,
    criticalPathSchema,
    criticalPathOutput,
    (input) => {
      const p = criticalPathSchema.parse(input);
      return criticalPath(p.tasks);
    },
  ),

  tool(
    "monte_carlo_schedule",
    `Run Monte Carlo simulation for probabilistic schedule risk analysis.

Samples task durations from triangular distributions and returns P10/P50/P80/P95
completion estimates with identified risk events. Use seed for reproducible results.`,
    monteCarloSchema,
    monteCarloOutput,
    (input) => {
      const p = monteCarloSchema.parse(input);
      const tasks = p.tasks.map((t) => ({
        name: t.name,
        optimistic: t.optimistic,
        mostLikely: t.most_likely,
        pessimistic: t.pessimistic,
      }));
      return { ok: true as const, data: monteCarloSim(tasks, p.iterations, p.seed) };
    },
  ),

  // -- Analytics tools (3) ---------------------------------------------------

  tool(
    "reference_class_estimate",
    `Data-driven estimate using reference class forecasting.

Applies historical correction factors based on actual-vs-estimated ratios.
When no historical data exists, uses industry averages (1.3-2.2x for software tasks).
Prioritize this over algorithmic models when historical data is available.`,
    referenceClassEstimateSchema,
    referenceClassOutput,
    (input) => {
      const p = referenceClassEstimateSchema.parse(input);
      const profile = getDeveloperProfileGradient(p.ai_native);
      const records = getCalibrationData(
        p.team_id,
        p.task_type,
        90,
        "reference_class_estimate",
      );
      const result = referenceClassEstimate(records, p.task_type, p.complexity, p.scope, p.ai_native >= 0.7);
      const scopeGuide = getScopeGuide(p.task_type);
      return {
        ok: true as const,
        data: {
          ...result,
          ...(scopeGuide ? { scopeGuide } : {}),
          developerProfile: {
            mode: profile.mode,
            estimationMape: profile.estimationMape,
            underestimationBias: profile.underestimationBias,
            correctionFactor: profile.correctionFactor,
          },
          adjustedEstimate: Math.round(result.rawEstimate * profile.correctionFactor * 100) / 100,
          note: records.length >= 5
            ? `Based on ${records.length} historical records for "${p.task_type}" tasks.`
            : "Using reference database correction factors. Submit actuals via /v1/feedback/record-actual to improve accuracy.",
        },
      };
    },
  ),

  tool(
    "calibrate_estimates",
    `Recalculate team-specific correction factors from historical estimation data.

Compares estimated vs actual hours to compute a correction multiplier.
Requires PM system integration for best results. Returns recommendations
for improving estimation accuracy.`,
    calibrateEstimatesSchema,
    calibrateOutput,
    (input) => {
      const p = calibrateEstimatesSchema.parse(input);
      const records = getCalibrationData(
        p.team_id,
        undefined,
        p.period_days,
      );
      return {
        ok: true as const,
        data: calibrateEstimates(
          p.team_id,
          p.period_days,
          p.minimum_samples,
          records,
        ),
      };
    },
  ),

  tool(
    "token_time_bridge",
    `Map LLM token budgets to estimated wall-clock time.

Uses model-specific calibration data (tokens/second, reasoning overhead,
tool-call latency) to estimate how long a task will actually take.
Bridges the gap between token-space (how agents reason) and time-space (what humans need).
Use token_cost_estimate instead when dollar cost matters too.`,
    tokenTimeBridgeSchema,
    tokenTimeOutput,
    (input) => {
      const p = tokenTimeBridgeSchema.parse(input);
      return {
        ok: true as const,
        data: tokenTimeBridge({
          tokens: p.tokens,
          model: p.model,
          toolCalls: p.tool_calls,
          reasoningDepth: p.reasoning_depth,
        }),
      };
    },
  ),

  // -- Cost & Comparison tools (2) -------------------------------------------

  tool(
    "token_cost_estimate",
    `Estimate wall-clock time AND dollar cost for LLM token usage.

Combines token-to-time mapping with model-specific pricing data.
Returns cost breakdown (input/output/overhead) alongside the time estimate.
Use token_time_bridge when you only need wall-clock time and not dollar cost.`,
    tokenCostEstimateSchema,
    tokenTimeOutput,
    (input) => {
      const p = tokenCostEstimateSchema.parse(input);
      return {
        ok: true as const,
        data: tokenCostEstimate({
          tokens: p.tokens,
          model: p.model,
          toolCalls: p.tool_calls,
          reasoningDepth: p.reasoning_depth,
        }),
      };
    },
  ),

  tool(
    "compare_models",
    `Compare all LLM models side-by-side for a given token budget.

Ranks models by estimated cost or time. Shows quality tier for each model.
Use when choosing which model to use for a task.`,
    compareModelsSchema,
    { type: "object", properties: { tokens: { type: "number" }, models: { type: "array" }, humanReadable: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => {
      const p = compareModelsSchema.parse(input);
      return {
        ok: true as const,
        data: compareModels({
          tokens: p.tokens,
          toolCalls: p.tool_calls,
          reasoningDepth: p.reasoning_depth,
          sortBy: p.sort_by,
        }),
      };
    },
  ),

  // -- Analytics & Risk tools (3) --------------------------------------------

  tool(
    "accuracy_trend",
    `Track estimation accuracy improvement over time.

Computes sliding-window MAPE and compares against industry baseline (25%).
Shows whether your estimates are improving, degrading, or stable.
Industry research shows estimation accuracy does NOT improve with experience (Cao 2022) — self-correcting systems like Epoch can buck this trend.`,
    accuracyTrendSchema,
    accuracyTrendOutput,
    (input) => {
      const p = accuracyTrendSchema.parse(input);
      return {
        ok: true as const,
        data: computeAccuracyTrend({
          teamId: p.team_id,
          windowSize: p.window_size,
        }),
      };
    },
  ),

  tool(
    "schedule_risk",
    `Assess schedule risk for an estimate using historical accuracy data.

Computes confidence intervals (p50/p80/p95) based on your team's MAPE.
Returns risk level and actionable recommendations.
Uses industry baseline (25% MAPE) when no historical data is available.`,
    scheduleRiskSchema,
    { type: "object", properties: { estimatedHours: { type: "number" }, estimatedTokenCost: { type: "number", description: "Estimated AI token cost (50k tokens/hour × estimatedHours)" }, riskLevel: { type: "string" }, confidenceIntervals: { type: "object" }, historicalAccuracy: { type: "object", properties: { mape: { type: "number" }, mdape: { type: "number" }, sampleSize: { type: "number" } } }, taskTypeBreakdown: { type: "object", additionalProperties: { type: "object", properties: { riskLevel: { type: "string" }, mdape: { type: "number" }, sampleSize: { type: "number" } } }, description: "Risk breakdown by task type from historical data" }, recommendation: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => {
      const p = scheduleRiskSchema.parse(input);
      return {
        ok: true as const,
        data: scheduleRisk({
          estimatedHours: p.estimated_hours,
          taskType: p.task_type,
          teamId: p.team_id,
          aiNative: p.ai_native,
          complexity: p.complexity,
        }),
      };
    },
  ),

  tool(
    "cocomo_validate",
    `Validate COCOMO estimation model against 195 real historical projects.

Runs the COCOMO Basic formula against projects from NASA93, COCOMO81, Albrecht, and Kemerer datasets.
Reports overall MAPE, bias, per-type accuracy, and recommended coefficient adjustments.
Use cocomo_ground_truth for the full multi-model benchmark across all COCOMO and AI-adjusted models.`,
    cocomoValidateSchema,
    { type: "object", properties: { projectsEvaluated: { type: "number" }, mape: { type: "number" }, bias: { type: "number" }, humanReadable: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => {
      const p = cocomoValidateSchema.parse(input);
      return cocomoValidate({
        datasetFilter: p.dataset_filter,
      });
    },
  ),

  tool(
    "cocomo_ground_truth",
    `Validate all COCOMO estimation models against 240 real historical projects with known effort.

Runs 6 models in parallel: COCOMO Basic, COCOMO II Nominal, COCOMO II + AI 12x speedup, and AI + developer profile at human/hybrid/ai_native gradients.
Reports MAPE, MMRE, PRED(25), PRED(50), bias per model, with breakdowns by dataset and project type.
Use cocomo_validate for a quicker Basic COCOMO-only validation pass.`,
    cocomoGroundTruthSchema,
    { type: "object", properties: { projectsEvaluated: { type: "number" }, models: { type: "array" }, winner: { type: "string" }, conclusion: { type: "string" }, humanReadable: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => {
      const p = cocomoGroundTruthSchema.parse(input);
      return cocomoValidateGroundTruth({
        datasetFilter: p.dataset_filter,
      });
    },
  ),

  // -- Feedback tools (4) ----------------------------------------------------

  tool(
    "record_actual",
    `Submit actual hours for a previous estimate to improve future accuracy.

Pairs with any estimation tool. The estimate_id comes from the estimate response.
Actuals feed into the self-improvement loop — after enough samples, correction factors
update automatically to reduce estimation bias.`,
    recordActualSchema,
    { type: "object", properties: { recorded: { type: "boolean" }, message: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => {
      const p = recordActualSchema.parse(input);
      const result = recordActualDetailed(p.estimate_id, p.actual_hours, p.notes, p.unit, p.calibration_provenance);
      if (!result.ok) {
        const messages: Record<string, string> = {
          below_threshold: `Actual hours (${p.actual_hours}) must be positive.`,
          duplicate: `An actual for estimate ${p.estimate_id} already exists. Each estimate can only have one actual.`,
          write_failed: "Failed to write to feedback storage — ensure ~/.epoch/ directory is writable.",
        };
        return {
          ok: false as const,
          error: { isError: true, message: messages[result.reason] ?? "Unknown error.", retryHint: "Check estimate_id and actual_hours values." },
        };
      }
      return {
        ok: true as const,
        data: {
          recorded: true,
          estimate_id: p.estimate_id,
          actual_hours: p.actual_hours,
          message: "Actual recorded. Correction factors update after more feedback accumulates.",
        },
      };
    },
  ),

  tool(
    "get_pending_estimates",
    `List recent estimates that have not yet received actual-hour feedback.

Returns estimates awaiting actuals so you can submit feedback via record_actual.
Use this to close the estimation feedback loop and improve accuracy over time.`,
    getPendingEstimatesSchema,
    { type: "object", properties: { count: { type: "number" }, estimates: { type: "array", items: { type: "object", properties: { id: { type: "string" }, tool: { type: "string" }, inputs: { type: "object" }, estimatedAt: { type: "string" }, task_label: { type: "string", description: "Optional task_label carried on the estimate's inputs, if supplied at estimate time." } } } } } } satisfies Record<string, unknown>,
    (input) => {
      const p = getPendingEstimatesSchema.parse(input);
      const pending = getPendingEstimates(p.limit);
      const summary = pending.length > 0
        ? `${pending.length} estimates awaiting actuals. Use record_actual with an estimate ID and the real hours spent to close the feedback loop.`
        : "No pending estimates — all recent estimates have actuals recorded.";
      return {
        ok: true as const,
        data: {
          count: pending.length,
          summary,
          estimates: pending.slice(-10).map((e) => {
            const taskLabel = e.inputs["task_label"];
            return {
              id: e.id,
              tool: e.tool,
              inputs: e.inputs,
              estimatedAt: e.estimatedAt,
              ...(typeof taskLabel === "string" && taskLabel.length > 0 && { task_label: taskLabel }),
            };
          }),
        },
      };
    },
  ),

  tool(
    "batch_record_actuals",
    `Record actual hours for multiple estimates in a single call.

Efficient for bulk feedback submission — accepts 1 to 500 entries at once.
Each entry pairs an estimate ID with the actual hours spent.`,
    batchRecordActualsSchema,
    { type: "object", properties: { total: { type: "number" }, succeeded: { type: "number" }, failed: { type: "number" }, errors: { type: "array" } } } satisfies Record<string, unknown>,
    (input) => {
      const p = batchRecordActualsSchema.parse(input);
      const result = batchRecordActuals(p.entries.map((e) => ({
        estimateId: e.estimate_id,
        actualHours: e.actual_hours,
        notes: e.notes,
        unit: e.unit,
        calibrationProvenance: e.calibration_provenance,
      })));
      if (result.succeeded === 0 && result.failed > 0) {
        return {
          ok: false as const,
          error: { isError: true, message: `All ${result.total} entries failed to record.`, retryHint: "Ensure ~/.epoch/ directory is writable." },
        };
      }
      return { ok: true as const, data: result };
    },
  ),

  tool(
    "feedback_health",
    `Get a health report on the estimation feedback loop.

Shows total estimates, actuals, match rate, MAPE by tool and task type,
and self-improvement readiness (which types have enough data for auto-calibration).`,
    feedbackHealthSchema,
    { type: "object", properties: { totalEstimates: { type: "number" }, totalActuals: { type: "number" }, matchedPairs: { type: "number" }, seedRecordsFiltered: { type: "number" }, matchRate: { type: "number" }, byTool: { type: "object" }, byTaskType: { type: "object" }, selfImprovement: { type: "object" }, dataQuality: { type: "object" }, humanReadable: { type: "string" } } } satisfies Record<string, unknown>,
    () => {
      return { ok: true as const, data: getFeedbackHealthReport() };
    },
  ),

  // -- Context-driven estimation (registered Phase 3; logic lands Phase 5) --

  tool(
    "estimate_from_context",
    `Classify a free-text task description and delegate to the estimation engine.

Not yet implemented — registered now so its input contract is stable before
the Rust parity freeze. Currently returns a structured "not implemented"
response; classification + delegation logic lands in a future release.`,
    estimateFromContextSchema,
    { type: "object", properties: { implemented: { type: "boolean" }, plannedPhase: { type: "number" }, tool: { type: "string" }, message: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => {
      const p = estimateFromContextSchema.parse(input);
      return {
        ok: true as const,
        data: {
          implemented: false,
          plannedPhase: 5,
          tool: "estimate_from_context",
          message: "estimate_from_context is registered but not yet implemented. Classification of free-text context into task_type/complexity and delegation to reference_class_estimate/pert_estimate lands in a future release. Use reference_class_estimate or pert_estimate directly in the meantime.",
          contextLength: p.context.length,
        },
      };
    },
  ),
]);

// ---- Exports ----------------------------------------------------------------

export const TOOL_REGISTRY: Map<string, ToolDefinition> = new Map(
  Object.entries(handlers),
);

export const TOOL_NAMES: Set<string> = new Set(Object.keys(handlers));

// ---- Estimation vs. telemetry classification (Phase 1 Task 3) --------------
//
// Only tools that actually PRODUCE a time/effort estimate get recorded to the
// estimates ledger (estimates.jsonl) and are eligible for record_actual
// pairing. Every other registered tool call (temporal helpers, feedback
// plumbing, comparison/validation reports) is non-estimation telemetry and
// must be routed to recordToolCall() / tool-calls.jsonl instead — see
// dispatch() in src/dispatcher/index.ts, the sole recordEstimate() call site.
// Every tool name registered above must appear in exactly one of these sets.

export const ESTIMATION_TOOLS: ReadonlySet<string> = new Set([
  "pert_estimate",
  "reference_class_estimate",
  "cocomo_estimate",
  "sprint_forecast",
  "monte_carlo_schedule",
  "schedule_risk",
  "critical_path",
  "token_time_bridge",
]);

export const NON_ESTIMATION_TOOLS: ReadonlySet<string> = new Set([
  "record_actual",
  "batch_record_actuals",
  "get_current_time",
  "convert_timezone",
  "parse_duration",
  "time_math",
  "add_business_days",
  "count_business_days",
  "feedback_health",
  "get_pending_estimates",
  "accuracy_trend",
  "calibrate_estimates",
  "compare_models",
  "token_cost_estimate",
  "cocomo_validate",
  "cocomo_ground_truth",
  "estimate_from_context",
]);

export function isEstimationTool(toolName: string): boolean {
  return ESTIMATION_TOOLS.has(toolName);
}
