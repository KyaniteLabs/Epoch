// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Tool Registry
// Maps all 19 tool names to handler functions and Zod input schemas.
// Translates between snake_case schema fields and camelCase lib params.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolResult, TaskType } from "../types/index.js";
import {
  getCurrentTime,
  convertTimezone,
  parseDuration,
} from "../lib/temporal.js";
import { addBusinessDays, countBusinessDays } from "../lib/calendar.js";
import { dispatchTimeMath } from "../lib/internal/time-math-dispatch.js";
import type { TimeMathOp } from "../lib/internal/time-math-dispatch.js";
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
} from "../lib/analytics.js";
import { getCalibrationData, recordActual, getPendingEstimates } from "../lib/feedback.js";
import { tokenCostEstimate, compareModels } from "../lib/cost.js";
import { computeAccuracyTrend } from "../lib/accuracy-trend.js";
import { scheduleRisk } from "../lib/risk.js";
import { cocomoValidate } from "../lib/cocomo-validate.js";
import { getDeveloperProfile } from "../lib/profiles.js";
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
    humanReadable: { type: "string", description: "Human-readable summary" },
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
  },
} satisfies Record<string, unknown>;

const sprintOutput = {
  type: "object",
  properties: {
    backlogPoints: { type: "number" },
    averageVelocity: { type: "number" },
    requiredSprints: { type: "number" },
    pessimisticSprints: { type: "number" },
    hoursPerPoint: { type: "number" },
    totalHours: { type: "number" },
    completionDays: { type: "number" },
    sprintLengthDays: { type: "number" },
  },
} satisfies Record<string, unknown>;

const criticalPathOutput = {
  type: "object",
  properties: {
    critical_path: { type: "array", items: { type: "string" } },
    slack_per_task: { type: "object", additionalProperties: { type: "number" } },
    total_duration: { type: "number" },
    merge_bias_adjustment: { type: "number" },
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

const timeMathOutput = {
  type: "object",
  description: "Varies by operation. Returns temporal, duration, or date diff data.",
} satisfies Record<string, unknown>;



// ---- Handler wrappers (snake_case -> camelCase translation) ----------------

const handlers: Record<string, ToolDefinition> = Object.fromEntries([
  // -- Temporal tools (6) ----------------------------------------------------

  tool(
    "get_current_time",
    "Returns the current time in the specified IANA timezone.",
    getCurrentTimeSchema,
    temporalOutput,
    (input) => getCurrentTime(input.timezone as string),
  ),

  tool(
    "convert_timezone",
    "Converts a timestamp from its embedded timezone to a target timezone.",
    convertTimezoneSchema,
    temporalOutput,
    (input) =>
      convertTimezone(
        input.timestamp as string,
        input.target_tz as string,
      ),
  ),

  tool(
    "parse_duration",
    'Parses a duration string such as "2h30m", "1d6h", "45m" into seconds and a human-readable form.',
    parseDurationSchema,
    durationOutput,
    (input) => parseDuration(input.duration_string as string),
  ),

  tool(
    "time_math",
    "Performs time arithmetic: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration. For diff, use operands: {start_date, end_date}. For add_days, use operands: {start_date, days}. For add_business_days, use operands: {start_date, days, country}.",
    timeMathSchema,
    timeMathOutput,
    (input) => {
      const operation = input.operation as TimeMathOp;
      let ops = input.operands as Record<string, unknown>;

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
    "Adds N business days to a start date, skipping weekends and holidays.",
    addBusinessDaysSchema,
    businessDayOutput,
    (input) =>
      addBusinessDays(
        input.start_date as string,
        input.days as number,
        input.country as string,
      ),
  ),

  tool(
    "count_business_days",
    "Counts business days between two dates, skipping weekends and holidays.",
    countBusinessDaysSchema,
    businessDayOutput,
    (input) =>
      countBusinessDays(
        input.start_date as string,
        input.end_date as string,
        input.country as string,
      ),
  ),

  // -- Estimation tools (5) --------------------------------------------------

  tool(
    "pert_estimate",
    "Computes a PERT three-point estimate with expected value, standard deviation, and confidence intervals.",
    pertEstimateSchema,
    pertOutput,
    (input) => {
      const profile = getDeveloperProfile((input.ai_native as boolean) ?? true);
      const result = pertEstimate(
        input.optimistic as number,
        input.most_likely as number,
        input.pessimistic as number,
        input.unit as "hours" | "days" | "weeks" | "months",
      );
      if (!result.ok) return result;
      return {
        ok: true as const,
        data: {
          ...result.data,
          developerProfile: { mode: profile.mode, correctionFactor: profile.correctionFactor },
          adjustedEstimate: result.data.expected * profile.correctionFactor,
        },
      };
    },
  ),

  tool(
    "cocomo_estimate",
    "Estimates effort using a COCOMO II model adjusted for LLM-assisted workflows.",
    cocomoEstimateSchema,
    cocomoOutput,
    (input) => {
      const profile = getDeveloperProfile((input.ai_native as boolean) ?? true);
      const rawCycles = input.iterative_cycles as number;
      const iterativeCycles = rawCycles > 2.0 ? 1.0 + Math.min(rawCycles, 10) * 0.1 : rawCycles;
      const result = cocomoEstimate({
        kloc: input.kloc as number,
        reasoningComplexity: input.reasoning_complexity as number,
        contextCompleteness: input.context_completeness as number,
        transformationImpact: input.transformation_impact as number,
        iterativeCycles,
        humanOversight: input.human_oversight as number,
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
    "Forecasts sprints needed to clear a backlog based on historical velocity.",
    sprintForecastSchema,
    sprintOutput,
    (input) => {
      const profile = getDeveloperProfile((input.ai_native as boolean) ?? true);
      const result = sprintForecast({
        backlogPoints: input.backlog_points as number,
        velocityHistory: input.velocity_history as number[],
        sprintLengthDays: input.sprint_length_days as number,
        hoursPerSprint: input.hours_per_sprint as number,
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
    "Computes the critical path through a task graph with merge-bias adjustment.",
    criticalPathSchema,
    criticalPathOutput,
    (input) => {
      const tasks = input.tasks as Array<{
        name: string;
        duration: number;
        predecessors: string[];
      }>;
      return criticalPath(tasks);
    },
  ),

  tool(
    "monte_carlo_schedule",
    "Runs a Monte Carlo simulation on a task list with three-point estimates.",
    monteCarloSchema,
    monteCarloOutput,
    (input) => {
      const rawTasks = input.tasks as Array<{
        name: string;
        optimistic: number;
        most_likely: number;
        pessimistic: number;
        predecessors?: string[];
      }>;
      const tasks = rawTasks.map((t) => ({
        name: t.name,
        optimistic: t.optimistic,
        mostLikely: t.most_likely,
        pessimistic: t.pessimistic,
      }));
      const iterations = (input.iterations as number) ?? 10000;
      return { ok: true as const, data: monteCarloSim(tasks, iterations) };
    },
  ),

  // -- Analytics tools (3) ---------------------------------------------------

  tool(
    "reference_class_estimate",
    "Estimates effort using reference-class forecasting from historical data.",
    referenceClassEstimateSchema,
    referenceClassOutput,
    (input) => {
      const profile = getDeveloperProfile((input.ai_native as boolean) ?? true);
      const taskType = input.task_type as
        | "feature"
        | "bugfix"
        | "refactor"
        | "migration"
        | "infrastructure"
        | "documentation"
        | "testing"
        | "design";
      const records = getCalibrationData(
        input.team_id as string | undefined,
        taskType,
        90,
        "reference_class_estimate",
      );
      const result = referenceClassEstimate(records, taskType, input.complexity as number);
      return {
        ok: true as const,
        data: {
          ...result,
          developerProfile: { mode: profile.mode, correctionFactor: profile.correctionFactor },
          adjustedEstimate: Math.round(result.correctedEstimate * profile.correctionFactor * 10) / 10,
        },
      };
    },
  ),

  tool(
    "calibrate_estimates",
    "Calibrates estimation accuracy using historical team data.",
    calibrateEstimatesSchema,
    calibrateOutput,
    (input) => {
      const records = getCalibrationData(
        input.team_id as string,
        undefined,
        input.period_days as number,
      );
      return {
        ok: true as const,
        data: calibrateEstimates(
          input.team_id as string,
          input.period_days as number,
          input.minimum_samples as number,
          records,
        ),
      };
    },
  ),

  tool(
    "token_time_bridge",
    "Estimates wall-clock time from token count and LLM model parameters.",
    tokenTimeBridgeSchema,
    tokenTimeOutput,
    (input) => ({
      ok: true as const,
      data: tokenTimeBridge({
        tokens: input.tokens as number,
        model: input.model as string,
        toolCalls: (input.tool_calls as number) ?? 0,
        reasoningDepth: (input.reasoning_depth as "shallow" | "moderate" | "deep") ?? "moderate",
      }),
    }),
  ),

  // -- Cost & Comparison tools (2) -------------------------------------------

  tool(
    "token_cost_estimate",
    "Estimates wall-clock time AND dollar cost from token count and LLM model parameters.",
    tokenCostEstimateSchema,
    tokenTimeOutput,
    (input) => ({
      ok: true as const,
      data: tokenCostEstimate({
        tokens: input.tokens as number,
        model: input.model as string,
        toolCalls: (input.tool_calls as number) ?? 0,
        reasoningDepth: (input.reasoning_depth as "shallow" | "moderate" | "deep") ?? "moderate",
      }),
    }),
  ),

  tool(
    "compare_models",
    "Compares all LLM models side-by-side for a given token budget, ranked by cost or time.",
    compareModelsSchema,
    { type: "object", properties: { tokens: { type: "number" }, models: { type: "array" }, humanReadable: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => ({
      ok: true as const,
      data: compareModels({
        tokens: input.tokens as number,
        toolCalls: (input.tool_calls as number) ?? 0,
        reasoningDepth: (input.reasoning_depth as "shallow" | "moderate" | "deep") ?? "moderate",
        sortBy: (input.sort_by as "cost" | "time") ?? "cost",
      }),
    }),
  ),

  // -- Analytics & Risk tools (3) --------------------------------------------

  tool(
    "accuracy_trend",
    "Tracks estimation accuracy over time with sliding-window MAPE, compared to industry baselines.",
    accuracyTrendSchema,
    calibrateOutput,
    (input) => ({
      ok: true as const,
      data: computeAccuracyTrend({
        teamId: input.team_id as string | undefined,
        windowSize: (input.window_size as number) ?? 50,
      }),
    }),
  ),

  tool(
    "schedule_risk",
    "Assesses schedule risk using historical accuracy data to compute confidence intervals.",
    scheduleRiskSchema,
    { type: "object", properties: { estimatedHours: { type: "number" }, riskLevel: { type: "string" }, confidenceIntervals: { type: "object" }, recommendation: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => ({
      ok: true as const,
      data: scheduleRisk({
        estimatedHours: input.estimated_hours as number,
        taskType: input.task_type as TaskType | undefined,
        teamId: input.team_id as string | undefined,
      }),
    }),
  ),

  tool(
    "cocomo_validate",
    "Validates COCOMO estimation model against 195 real historical projects.",
    cocomoValidateSchema,
    { type: "object", properties: { projectsEvaluated: { type: "number" }, mape: { type: "number" }, bias: { type: "number" }, humanReadable: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => cocomoValidate({
      datasetFilter: input.dataset_filter as string[] | undefined,
    }),
  ),

  // -- Feedback tools (2) ----------------------------------------------------

  tool(
    "record_actual",
    "Records actual hours for a previous estimate to improve future estimation accuracy.",
    z.object({
      estimate_id: z.string().describe("ID of the estimate to update."),
      actual_hours: z.number().positive().describe("Actual hours spent."),
      notes: z.string().optional().describe("Optional context."),
    }),
    { type: "object", properties: { recorded: { type: "boolean" }, message: { type: "string" } } } satisfies Record<string, unknown>,
    (input) => {
      const recorded = recordActual(input.estimate_id as string, input.actual_hours as number, input.notes as string | undefined);
      return {
        ok: true as const,
        data: {
          recorded,
          estimate_id: input.estimate_id,
          actual_hours: input.actual_hours,
          message: recorded
            ? "Actual recorded. Correction factors update after more feedback accumulates."
            : "Failed to record actual — feedback storage unavailable.",
        },
      };
    },
  ),

  tool(
    "get_pending_estimates",
    "Lists recent estimates that have not yet received actual-hour feedback.",
    z.object({
      limit: z.number().int().positive().max(100).default(20).describe("Max estimates to return."),
    }),
    { type: "object", properties: { count: { type: "number" }, estimates: { type: "array" } } } satisfies Record<string, unknown>,
    (input) => {
      const pending = getPendingEstimates((input.limit as number) ?? 20);
      return {
        ok: true as const,
        data: {
          count: pending.length,
          estimates: pending.map((e) => ({ id: e.id, tool: e.tool, estimatedAt: e.estimatedAt, hasActual: e.hasActual })),
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
