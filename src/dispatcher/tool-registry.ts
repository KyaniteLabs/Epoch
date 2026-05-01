// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Tool Registry
// Maps all 14 tool names to handler functions and Zod input schemas.
// Translates between snake_case schema fields and camelCase lib params.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { ToolResult } from "../types/index.js";
import {
  getCurrentTime,
  convertTimezone,
  parseDuration,
  formatElapsed,
  diffDates,
  addDays,
} from "../lib/temporal.js";
import { addBusinessDays, countBusinessDays } from "../lib/calendar.js";
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
import {
  temporalStatusSchema,
  timeMathSchema,
  pertEstimateSchema,
  cocomoEstimateSchema,
  sprintForecastSchema,
  criticalPathSchema,
  monteCarloSchema,
  referenceClassEstimateSchema,
  calibrateEstimatesSchema,
  tokenTimeBridgeSchema,
} from "../schemas/index.js";

// ---- Tool Definition --------------------------------------------------------

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodType;
  handler: (input: Record<string, unknown>) => ToolResult<unknown>;
}

// ---- Helper -----------------------------------------------------------------

function tool(
  name: string,
  description: string,
  inputSchema: z.ZodType,
  handler: (input: Record<string, unknown>) => ToolResult<unknown>,
): [string, ToolDefinition] {
  return [name, { name, description, inputSchema, handler }];
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
    .number()
    .int()
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

// ---- Handler wrappers (snake_case -> camelCase translation) ----------------

const handlers: Record<string, ToolDefinition> = Object.fromEntries([
  // -- Temporal tools (6) ----------------------------------------------------

  tool(
    "get_current_time",
    "Returns the current time in the specified IANA timezone.",
    getCurrentTimeSchema,
    (input) => getCurrentTime(input.timezone as string),
  ),

  tool(
    "convert_timezone",
    "Converts a timestamp from its embedded timezone to a target timezone.",
    convertTimezoneSchema,
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
    (input) => parseDuration(input.duration_string as string),
  ),

  tool(
    "time_math",
    "Performs time arithmetic: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
    timeMathSchema,
    (input) => {
      const operation = input.operation as string;
      const ops = input.operands as Record<string, unknown>;

      switch (operation) {
        case "add_days":
          return { ok: true as const, data: addDays(ops.date as string, ops.days as number) };
        case "diff":
          return { ok: true as const, data: diffDates(ops.date as string, ops.end_date as string) };
        case "convert_tz":
          return convertTimezone(
            ops.timestamp as string,
            ops.target_tz as string,
          );
        case "parse_nl":
          return parseDuration(ops.duration_string as string);
        case "format_duration":
          return { ok: true as const, data: formatElapsed(ops.milliseconds as number) };
        case "add_business_days":
          return addBusinessDays(
            (ops.start_date as string) ?? (ops.date as string),
            ops.days as number,
            (ops.country as string) ?? "US",
          );
        default:
          return {
            ok: false as const,
            error: {
              isError: true as const,
              message: `Unknown time_math operation: ${operation}`,
              retryHint:
                "Use one of: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
            },
          };
      }
    },
  ),

  tool(
    "add_business_days",
    "Adds N business days to a start date, skipping weekends and holidays.",
    addBusinessDaysSchema,
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
    (input) =>
      pertEstimate(
        input.optimistic as number,
        input.most_likely as number,
        input.pessimistic as number,
        input.unit as "hours" | "days" | "weeks" | "months",
      ),
  ),

  tool(
    "cocomo_estimate",
    "Estimates effort using a COCOMO II model adjusted for LLM-assisted workflows.",
    cocomoEstimateSchema,
    (input) => ({
      ok: true as const,
      data: cocomoEstimate({
        kloc: input.kloc as number,
        reasoningComplexity: input.reasoning_complexity as number,
        contextCompleteness: input.context_completeness as number,
        transformationImpact: input.transformation_impact as number,
        iterativeCycles: input.iterative_cycles as number,
        humanOversight: input.human_oversight as number,
      }),
    }),
  ),

  tool(
    "sprint_forecast",
    "Forecasts sprints needed to clear a backlog based on historical velocity.",
    sprintForecastSchema,
    (input) =>
      sprintForecast({
        backlogPoints: input.backlog_points as number,
        velocityHistory: input.velocity_history as number[],
        sprintLengthDays: input.sprint_length_days as number,
        hoursPerSprint: input.hours_per_sprint as number,
      }),
  ),

  tool(
    "critical_path",
    "Computes the critical path through a task graph with merge-bias adjustment.",
    criticalPathSchema,
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
    (input) => ({
      ok: true as const,
      data: referenceClassEstimate(
        [],
        input.task_type as
          | "feature"
          | "bugfix"
          | "refactor"
          | "migration"
          | "infrastructure"
          | "documentation"
          | "testing"
          | "design",
        input.complexity as number,
      ),
    }),
  ),

  tool(
    "calibrate_estimates",
    "Calibrates estimation accuracy using historical team data.",
    calibrateEstimatesSchema,
    (input) => ({
      ok: true as const,
      data: calibrateEstimates(
        input.team_id as string,
        input.period_days as number,
        input.minimum_samples as number,
      ),
    }),
  ),

  tool(
    "token_time_bridge",
    "Estimates wall-clock time from token count and LLM model parameters.",
    tokenTimeBridgeSchema,
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
]);

// ---- Exports ----------------------------------------------------------------

export const TOOL_REGISTRY: Map<string, ToolDefinition> = new Map(
  Object.entries(handlers),
);

export const TOOL_NAMES: Set<string> = new Set(Object.keys(handlers));
