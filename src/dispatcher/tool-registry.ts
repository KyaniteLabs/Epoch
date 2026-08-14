// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Tool Registry
// Maps all 25 tool names (TOOL_COUNT, derived from src/lib/tool-aliases.ts —
// the authoritative tool surface) to handler functions and Zod input schemas.
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
import { classifyContext, resolveContextEstimateInputs } from "../lib/context-estimate.js";
import { computeIntervalCoverage, empiricalRatioQuantilesForTaskType, empiricalIntervals, pertVarianceIntervals } from "../lib/coverage.js";
import type { PredictedIntervals } from "../lib/coverage.js";
import {
  timeMathSchema,
  pertEstimateSchema,
  cocomoEstimateSchema,
  sprintForecastSchema,
  criticalPathSchema,
  monteCarloSchema,
  referenceClassEstimateSchema,
  calibrateEstimatesSchema,
  businessDaysOffset,
  MONTE_CARLO_ITERATION_TASK_PRODUCT_LIMIT,
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
import {
  CANONICAL_TOOL_NAMES,
  ESTIMATION_TOOL_NAMES,
  NON_ESTIMATION_TOOL_NAMES,
} from "../lib/tool-aliases.js";

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
  // Input safety bound (W1): the business-day walk is day-by-day, so an
  // uncapped days (e.g. 1e9) hangs the event loop. Bounded field from
  // schemas/index.ts (businessDaysOffset).
  days: businessDaysOffset,
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
    calendarVersion: { type: "string", description: "Holiday-table version stamp (CALENDAR_VERSION) used for the computation" },
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
    humanReadable: { type: "string", description: "Human-readable summary. Leads with the calibrated P80 interval when one could be computed, followed by the point estimate." },
    interval: {
      type: "object",
      description: "P50/P80/P90 calibrated prediction intervals around adjustedEstimate. `source` is \"empirical_ratio_quantile\" when >=5 exclusion-filtered historical (pert_estimate, task_type) pairs are available, else \"pert_variance\" (derived from this estimate's own optimistic/most_likely/pessimistic spread) — see `intervalNote` when the fallback is used.",
      properties: {
        p50: { type: "object", properties: { lower: { type: "number" }, upper: { type: "number" } } },
        p80: { type: "object", properties: { lower: { type: "number" }, upper: { type: "number" } } },
        p90: { type: "object", properties: { lower: { type: "number" }, upper: { type: "number" } } },
        source: { type: "string", enum: ["pert_variance", "empirical_ratio_quantile"] },
      },
    },
    intervalNote: { type: "string", description: "Present only when the empirical per-task-type interval was unavailable (n<5) and the PERT-variance fallback was used instead." },
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
    criticalPathProbability: {
      type: ["number", "null"],
      description: "P(total <= target_hours) when a target_hours deadline was supplied; null otherwise (never a fabricated probability)",
    },
    targetHours: { type: "number", description: "The caller-supplied deadline in hours the probability was computed against, when supplied" },
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
    humanReadable: { type: "string", description: "Human-readable summary. Leads with the calibrated P80 interval when >=5 exclusion-filtered historical (reference_class_estimate, task_type) pairs are available; otherwise states plainly that there wasn't enough data for a confidence interval." },
    interval: {
      type: "object",
      description: "P50/P80/P90 empirical prediction intervals around adjustedEstimate, from per-task-type actual/estimate ratio quantiles. Present only when >=5 matched pairs were available for this task_type — see `intervalNote` otherwise.",
      properties: {
        p50: { type: "object", properties: { lower: { type: "number" }, upper: { type: "number" } } },
        p80: { type: "object", properties: { lower: { type: "number" }, upper: { type: "number" } } },
        p90: { type: "object", properties: { lower: { type: "number" }, upper: { type: "number" } } },
        source: { type: "string", enum: ["empirical_ratio_quantile"] },
      },
    },
    intervalNote: { type: "string", description: "Present only when there wasn't enough per-task-type data (n<5) to compute an empirical interval." },
    feedbackRef: feedbackRefField,
  },
} satisfies Record<string, unknown>;

const estimateFromContextOutput = {
  type: "object",
  properties: {
    tool: { type: "string" },
    rawEstimate: { type: "number" },
    correctedEstimate: { type: "number" },
    correctionFactor: { type: "number" },
    sampleSize: { type: "number" },
    baselineSource: { type: "string" },
    scopeUsed: { type: "string" },
    scopeInferred: { type: "boolean" },
    confidence: { type: "string", enum: ["likely", "optimistic", "pessimistic"] },
    estimatedTokenCost: { type: "number" },
    classification: {
      type: "object",
      description: "Provenance of the local heuristic classification (src/lib/context-estimate.ts), before any caller-supplied hint override.",
      properties: {
        classified_task_type: { type: "string" },
        classified_complexity: { type: "number" },
        confidence: { type: "string", enum: ["high", "medium", "low"] },
        signals: { type: "array", items: { type: "string" } },
        task_type_from_hint: { type: "boolean" },
        complexity_from_hint: { type: "boolean" },
      },
    },
    lowConfidenceNote: { type: "string" },
    note: { type: "string" },
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



// ---- Interval-first humanReadable helpers (coverage.ts wiring) -------------
//
// pert_estimate and reference_class_estimate both lead their `humanReadable`
// output with a calibrated P80 range and mention the point estimate second
// (interval-first). Both prefer per-task-type empirical ratio quantiles
// (>= MIN_N_FOR_QUANTILES matched pairs, via coverage.ts's shared
// exclusion-filtered "clean path") and fall back to a PERT-variance interval
// only for pert_estimate (which has its own optimistic/most_likely/
// pessimistic spread to derive one from); reference_class_estimate has no
// analogous variance source, so it states plainly when there isn't enough
// data for an interval rather than fabricating one.

/** Mirrors calibration-factors.ts's extractPertEstimatedHours unit table, for converting a pert_estimate value to/from hours so empirical (hours-denominated) ratio quantiles can be applied regardless of the caller's chosen `unit`. */
const HOURS_PER_UNIT: Record<string, number> = { hours: 1, days: 8, weeks: 40, months: 160 };

function toHoursForUnit(value: number, unit: string): number {
  return value * (HOURS_PER_UNIT[unit] ?? 1);
}

function fromHoursForUnit(hours: number, unit: string): number {
  return hours / (HOURS_PER_UNIT[unit] ?? 1);
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Convert an hours-denominated Interval back to the caller's unit, rounding for display. */
function intervalToUnit(interval: { lower: number; upper: number }, unit: string): { lower: number; upper: number } {
  return { lower: round2(fromHoursForUnit(interval.lower, unit)), upper: round2(fromHoursForUnit(interval.upper, unit)) };
}

/** Formats an Interval as "X–Yh" (or the given unit's short label) for humanReadable text. */
function formatInterval(interval: { lower: number; upper: number }, unitLabel: string): string {
  return `${interval.lower}–${interval.upper} ${unitLabel}`;
}

// ---- Handler wrappers (snake_case -> camelCase translation) ----------------

// monte_carlo_schedule: optional deadline input for the P(total <= target)
// metric (W2). The base schema lives in schemas/index.ts (owned by the
// numeric-bounds lane); the optional target is extended here so it stays
// registry-local.
const monteCarloTargetSchema = monteCarloSchema.extend({
  target_hours: z
    .coerce.number()
    .positive()
    .optional()
    .describe(
      "Optional deadline in working hours (task durations are in 8-hour days). When supplied, criticalPathProbability reports P(total <= target_hours); when omitted it is null instead of a fabricated value.",
    ),
});

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
    "Converts an ISO-8601 timestamp to a target IANA timezone. The input timestamp must include timezone information or be in UTC. " +
      "Returns the localised time, UTC offset, and human-readable format. Use when you need to display or compare a moment in another region's local time.",
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
      "m (minutes), s (seconds). Examples: '2h30m', '1d6h', '1w3d', '45m'. " +
      "Returns the total seconds for the duration. Use when normalising a free-text duration for arithmetic or comparison.",
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
      "country-specific public holidays. Supports US, UK, FR, DE, and JP holidays. " +
      "Returns the resulting date. Use when computing a deadline that excludes non-working days.",
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
      "The count is exclusive of the start date and inclusive of the end date. " +
      "Returns the integer day count. Use when measuring working-time span between two dates.",
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

      const adjustedEstimate = Math.round(result.data.expected * composedFactor * 100) / 100;

      const data: Record<string, unknown> = {
        ...result.data,
        developerProfile: { mode: profile.mode, correctionFactor: profile.correctionFactor },
        adjustedEstimate,
        rawEstimate: result.data.expected,
        correctionFactor: learnedFactor,
        n: learnedN,
      };

      // Interval-first humanReadable (coverage.ts wiring): prefer per-task-type
      // empirical ratio quantiles (n >= MIN_N_FOR_QUANTILES); fall back to this
      // estimate's own PERT-variance interval when unavailable, saying so.
      const quantiles = p.task_type ? empiricalRatioQuantilesForTaskType(p.task_type) : null;
      let interval: PredictedIntervals;
      let intervalNote: string | undefined;
      if (quantiles) {
        const hoursIntervals = empiricalIntervals(toHoursForUnit(adjustedEstimate, p.unit), quantiles);
        interval = {
          p50: intervalToUnit(hoursIntervals.p50, p.unit),
          p80: intervalToUnit(hoursIntervals.p80, p.unit),
          p90: intervalToUnit(hoursIntervals.p90, p.unit),
          source: "empirical_ratio_quantile",
        };
      } else {
        interval = pertVarianceIntervals(result.data.expected, result.data.stdDeviation);
        intervalNote = p.task_type
          ? `Fewer than 5 exclusion-filtered historical "${p.task_type}" pert_estimate pairs are available yet, so this interval is derived from the PERT variance (optimistic/most_likely/pessimistic spread) instead of empirical data.`
          : "No task_type was supplied, so this interval is derived from the PERT variance (optimistic/most_likely/pessimistic spread) instead of empirical data.";
      }
      data.interval = interval;
      if (intervalNote) data.intervalNote = intervalNote;
      data.humanReadable = `Expected ${formatInterval(interval.p80, p.unit)} (80% confidence interval); point estimate ${adjustedEstimate} ${p.unit}.${intervalNote ? ` ${intervalNote}` : ""}`;

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
and human oversight. Returns both nominal and LLM-adjusted person-months. Use when estimating effort for a codebase you can size in KLOC.
iterative_cycles: values <= 2.0 are literal multipliers (0.5 = one-shot,
1.0 = typical debug loop, 2.0 = heavy back-and-forth); values above 2.0 are
literal cycle counts, each additional cycle adding 0.1 of multiplier anchored
at 2.0 (2.0 -> 2.0x, 3 -> 2.1x, 10 -> 2.8x) — monotonic with no cliff at 2.0.`,
    cocomoEstimateSchema,
    cocomoOutput,
    (input) => {
      const p = cocomoEstimateSchema.parse(input);
      const profile = getDeveloperProfileGradient(p.ai_native);
      const rawCycles = p.iterative_cycles;
      // Continuous cycle normalization (W2 math fix): values <= 2.0 are literal
      // multipliers, unchanged. Above 2.0 the input is a literal cycle count
      // and each additional cycle adds a fixed 0.1 of multiplier, anchored at
      // the literal-region endpoint (2.0) so the mapping is monotonic
      // non-decreasing over [0.5, 10] with no cliff at 2.0 — the previous
      // `1 + min(c,10)*0.1` rule made 2.0 -> 2.0x but 2.01 -> 1.201x.
      const iterativeCycles = rawCycles <= 2.0
        ? rawCycles
        : 2.0 + 0.1 * (Math.min(rawCycles, 10.0) - 2.0);
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
and returns required sprints with pessimistic estimate based on velocity variance. Use when planning a sprint completion date from backlog size and velocity history.`,
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
Applies merge bias: tasks with >2 predecessors get 5% duration increase per extra predecessor. Returns the critical path, task slack, and project duration. Use when sequencing dependent tasks to find the longest path and available slack.`,
    criticalPathSchema,
    criticalPathOutput,
    (input) => {
      const p = criticalPathSchema.parse(input);
      return criticalPath(p.tasks);
    },
  ),

  // monte_carlo_schedule uses monteCarloTargetSchema (declared above the
  // handlers map): optional target_hours for P(total <= target).

  tool(
    "monte_carlo_schedule",
    `Run Monte Carlo simulation for probabilistic schedule risk analysis.

Samples task durations from triangular distributions and returns P10/P50/P80/P95
completion estimates with identified risk events. Use seed for reproducible results.
Supply target_hours (working hours; durations are 8-hour days) to get
criticalPathProbability = P(total <= target_hours); without it that field is null.`,
    monteCarloTargetSchema,
    monteCarloOutput,
    (input) => {
      const p = monteCarloTargetSchema.parse(input);
      // Input safety bound (W1): the schema caps each factor independently
      // (<=500 tasks, <=100,000 iterations), but 500 × 100,000 sampled task-
      // durations would still monopolize the event loop in a single call —
      // cap the product too, rejecting with an actionable message.
      const taskCount = p.tasks.length;
      const product = taskCount * p.iterations;
      if (product > MONTE_CARLO_ITERATION_TASK_PRODUCT_LIMIT) {
        const maxIterations = Math.max(1, Math.floor(MONTE_CARLO_ITERATION_TASK_PRODUCT_LIMIT / taskCount));
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: `iterations × tasks = ${product.toLocaleString("en-US")} exceeds the ${MONTE_CARLO_ITERATION_TASK_PRODUCT_LIMIT.toLocaleString("en-US")} cap (${p.iterations.toLocaleString("en-US")} iterations × ${taskCount} tasks).`,
            retryHint: `Lower iterations to at most ${maxIterations.toLocaleString("en-US")} for ${taskCount} tasks, or split the schedule into smaller task lists.`,
          },
        };
      }
      const tasks = p.tasks.map((t) => ({
        name: t.name,
        optimistic: t.optimistic,
        mostLikely: t.most_likely,
        pessimistic: t.pessimistic,
      }));
      return { ok: true as const, data: monteCarloSim(tasks, p.iterations, p.seed, p.target_hours) };
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
      const adjustedEstimate = Math.round(result.rawEstimate * profile.correctionFactor * 100) / 100;

      // Interval-first humanReadable (coverage.ts wiring): reference_class_estimate
      // has no PERT-variance spread to fall back on, so when there isn't enough
      // per-task-type empirical data (n < MIN_N_FOR_QUANTILES) it states that
      // plainly rather than fabricating an interval.
      const quantiles = empiricalRatioQuantilesForTaskType(p.task_type);
      let interval: PredictedIntervals | undefined;
      let intervalNote: string | undefined;
      let humanReadable: string;
      if (quantiles) {
        interval = empiricalIntervals(adjustedEstimate, quantiles);
        humanReadable = `Expected ${formatInterval(interval.p80, "hours")} (80% confidence interval); point estimate ${adjustedEstimate} hours.`;
      } else {
        intervalNote = `Fewer than 5 exclusion-filtered historical "${p.task_type}" reference_class_estimate pairs are available yet, so no empirical confidence interval could be computed.`;
        humanReadable = `Expected ~${adjustedEstimate} hours (point estimate). ${intervalNote}`;
      }

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
          adjustedEstimate,
          note: records.length >= 5
            ? `Based on ${records.length} historical records for "${p.task_type}" tasks.`
            : "Using reference database correction factors. Submit actuals via /v1/feedback/record-actual to improve accuracy.",
          humanReadable,
          ...(interval ? { interval } : {}),
          ...(intervalNote ? { intervalNote } : {}),
        },
      };
    },
  ),

  tool(
    "calibrate_estimates",
    `Recalculate team-specific correction factors from historical estimation data.

Compares estimated vs actual hours to compute a correction multiplier.
Requires PM system integration for best results. Returns recommendations
for improving estimation accuracy. Use when you have accumulated actuals and want to refresh team calibration factors.`,
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
        // Ticket 04 (feedback contract): EVERY recordActualDetailed failure
        // reason maps to a distinct, actionable message. The reason union is
        // closed (src/lib/feedback.ts RecordActualResult); the exhaustive map
        // below plus the honest fallback means "Unknown error." is unreachable
        // for these failures. Pinned by
        // src/dispatcher/record-actual-errors.test.ts.
        const messages: Record<string, string> = {
          below_threshold: `Actual hours (${p.actual_hours}) must be positive.`,
          duplicate: `An actual for estimate ${p.estimate_id} already exists. Each estimate can only have one actual.`,
          write_failed: "Failed to write to feedback storage — ensure ~/.epoch/ directory is writable.",
          synthetic_id: `Estimate ID "${p.estimate_id}" looks like test/synthetic data (reserved prefix), so it cannot receive actuals. Use the feedbackRef returned by a fresh estimation-tool call.`,
          unknown_tool: `Estimate ${p.estimate_id} was recorded under an unrecognized tool name, so its actual cannot join calibration. Re-run the estimation tool and record against the new feedbackRef it returns.`,
          auto_wallclock_out_of_bounds: `Auto wall-clock actual for estimate ${p.estimate_id} failed the sanity gate (outside 0.05–12h or ≥10x the estimate). Record a verified actual manually via record_actual instead.`,
        };
        return {
          ok: false as const,
          error: {
            isError: true,
            message: messages[result.reason] ?? `Failed to record actual for estimate ${p.estimate_id} (unrecognized reason: ${String(result.reason)}).`,
            retryHint: "Use the feedbackRef from a recent estimation tool call with a positive actual_hours value.",
          },
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
Each entry pairs an estimate ID with the actual hours spent. Returns total/succeeded/failed counts. Use when closing the feedback loop for many estimates at once; pass estimate_id values from get_pending_estimates.`,
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
        // Ticket 04: the all-failed envelope must not swallow the per-entry
        // reasons — surface the first one (they carry "(reason: ...)" from
        // batchRecordActuals) so the caller can self-correct.
        const firstError = result.errors[0] ?? "no per-entry error reported";
        return {
          ok: false as const,
          error: { isError: true, message: `All ${result.total} entries failed to record. First failure: ${firstError}`, retryHint: "Each entry needs the feedbackRef from a recent estimation tool call and a positive actual_hours value." },
        };
      }
      return { ok: true as const, data: result };
    },
  ),

  tool(
    "feedback_health",
    `Get a health report on the estimation feedback loop.

Shows total estimates, actuals, match rate, MAPE by tool and task type,
and self-improvement readiness (which types have enough data for auto-calibration). Use when checking whether you have enough recorded actuals for calibration to kick in.`,
    feedbackHealthSchema,
    { type: "object", properties: { totalEstimates: { type: "number" }, totalActuals: { type: "number" }, matchedPairs: { type: "number" }, seedRecordsFiltered: { type: "number" }, matchRate: { type: "number" }, byTool: { type: "object" }, byTaskType: { type: "object" }, selfImprovement: { type: "object" }, dataQuality: { type: "object" }, humanReadable: { type: "string" }, intervalCoverage: { type: "object", description: "P80 prediction-interval coverage calibration (Phase 5, additive). See src/lib/coverage.ts.", properties: { n: { type: "number" }, p80CoverageRate: { type: "number" }, targetP80Coverage: { type: "number" }, byTaskType: { type: "object" }, note: { type: "string" } } } } } satisfies Record<string, unknown>,
    () => {
      return {
        ok: true as const,
        data: { ...getFeedbackHealthReport(), intervalCoverage: computeIntervalCoverage() },
      };
    },
  ),

  // -- Context-driven estimation (registered Phase 3; logic lands Phase 5) --

  tool(
    "estimate_from_context",
    `Classify a free-text task description and delegate to reference-class estimation.

Classifies task_type and complexity from free text (issue body, PR/diff
description, or task summary) using a LOCAL, deterministic keyword/signal
heuristic — no LLM call (see src/lib/context-estimate.ts). Caller-supplied
task_type/complexity hints always override the classification. Delegates the
resolved inputs to the same reference-class-forecasting path used by
reference_class_estimate, and returns classification provenance
(classified_task_type, classified_complexity, confidence, signals) alongside
the estimate so callers can judge how much to trust it.`,
    estimateFromContextSchema,
    estimateFromContextOutput,
    (input) => {
      const p = estimateFromContextSchema.parse(input);
      const classification = classifyContext(p.context);
      const resolved = resolveContextEstimateInputs(classification, {
        ...(p.task_type !== undefined && { taskType: p.task_type }),
        ...(p.complexity !== undefined && { complexity: p.complexity }),
      });

      const records = getCalibrationData(p.team_id, resolved.taskType, 90, "estimate_from_context");
      // ai_native=true: Epoch is built for LLM/AI-agent estimation (matches
      // pertEstimateSchema's ai_native default of 1.0); no ai_native input
      // exists on this schema, so the AI-native reference-class baselines
      // are used unconditionally.
      const result = referenceClassEstimate(records, resolved.taskType, resolved.complexity, undefined, true);
      const scopeGuide = getScopeGuide(resolved.taskType);

      const lowConfidenceNote = classification.confidence === "low" && !resolved.taskTypeFromHint && !resolved.complexityFromHint
        ? `Classification confidence is low — no clear task-type keywords or complexity signals were found in the supplied context; defaulted to task_type="${classification.taskType}" and complexity=${classification.complexity}. Supply task_type/complexity hints for a more reliable estimate.`
        : undefined;

      return {
        ok: true as const,
        data: {
          tool: "estimate_from_context",
          ...result,
          ...(scopeGuide ? { scopeGuide } : {}),
          classification: {
            classified_task_type: classification.taskType,
            classified_complexity: classification.complexity,
            confidence: classification.confidence,
            signals: classification.signals,
            task_type_from_hint: resolved.taskTypeFromHint,
            complexity_from_hint: resolved.complexityFromHint,
          },
          ...(lowConfidenceNote ? { lowConfidenceNote } : {}),
          note: records.length >= 5
            ? `Based on ${records.length} historical records for "${resolved.taskType}" tasks.`
            : "Using reference database correction factors. Submit actuals via record_actual to improve accuracy.",
        },
      };
    },
  ),
]);

// ---- Exports ----------------------------------------------------------------

export const TOOL_REGISTRY: Map<string, ToolDefinition> = new Map(
  Object.entries(handlers),
);

// Ticket 03 (authoritative tool surface): TOOL_NAMES / ESTIMATION_TOOLS /
// NON_ESTIMATION_TOOLS are DERIVED from src/lib/tool-aliases.ts — the single
// source of truth — not hand-copied here. The sync suite
// (src/dispatcher/tool-surface-sync.test.ts) pins the actual registration
// keys in TOOL_REGISTRY to CANONICAL_TOOL_NAMES, so registering a tool
// without updating lib (or vice versa) fails CI instead of silently drifting
// (the historical 24-vs-25 drift that broke estimate_from_context's feedback
// loop must never come back).

export const TOOL_NAMES: ReadonlySet<string> = CANONICAL_TOOL_NAMES;

// ---- Estimation vs. telemetry classification (Phase 1 Task 3) --------------
//
// Only tools that actually PRODUCE a time/effort estimate get recorded to the
// estimates ledger (estimates.jsonl) and are eligible for record_actual
// pairing. Every other registered tool call (temporal helpers, feedback
// plumbing, comparison/validation reports) is non-estimation telemetry and
// must be routed to recordToolCall() / tool-calls.jsonl instead — see
// dispatch() in src/dispatcher/index.ts, the sole recordEstimate() call site.
// The partition itself is owned by src/lib/tool-aliases.ts and only
// re-exported here.

export const ESTIMATION_TOOLS: ReadonlySet<string> = ESTIMATION_TOOL_NAMES;

export const NON_ESTIMATION_TOOLS: ReadonlySet<string> = NON_ESTIMATION_TOOL_NAMES;

export function isEstimationTool(toolName: string): boolean {
  return ESTIMATION_TOOLS.has(toolName);
}
