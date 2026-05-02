import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tokenTimeBridge, referenceClassEstimate, calibrateEstimates } from "../lib/analytics.js";
import { tokenCostEstimate, compareModels } from "../lib/cost.js";
import { computeAccuracyTrend } from "../lib/accuracy-trend.js";
import { scheduleRisk } from "../lib/risk.js";
import { getCalibrationData } from "../lib/feedback.js";

const readOnlyAnnotations = {
  readOnlyHint: true as const,
  destructiveHint: false as const,
  idempotentHint: true as const,
  openWorldHint: false as const,
};

export function registerAnalyticsTools(server: McpServer): void {
  server.tool(
    "reference_class_estimate",
    `Data-driven estimate using reference class forecasting.

Applies historical correction factors based on actual-vs-estimated ratios.
When no historical data exists, uses industry averages (1.3-2.2x for software tasks).
Prioritize this over algorithmic models when historical data is available.`,
    {
      task_type: z.enum([
        "feature", "bugfix", "refactor", "migration",
        "infrastructure", "documentation", "testing", "design",
      ]).describe("Category of the task being estimated."),
      complexity: z.number().int().min(1).max(5).describe("Task complexity: 1=trivial, 3=moderate, 5=architectural change."),
      team_id: z.string().optional().describe("Team identifier for team-specific correction factors."),
    },
    async ({ task_type, complexity, team_id }) => {
      const records = getCalibrationData(team_id, task_type, 90);
      const result = referenceClassEstimate(records, task_type, complexity);
      const output = {
        ...result,
        rawEstimate: result.rawEstimate,
        correctedEstimate: result.correctedEstimate,
        correctionFactor: result.correctionFactor,
        sampleSize: result.sampleSize,
        confidence: result.confidence,
        note: records.length >= 5
          ? `Based on ${records.length} historical records for "${task_type}" tasks.`
          : "Using reference database correction factors. Submit actuals via /v1/feedback/record-actual to improve accuracy.",
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(output) }] };
    },
  );

  server.tool(
    "calibrate_estimates",
    `Recalculate team-specific correction factors from historical estimation data.

Compares estimated vs actual hours to compute a correction multiplier.
Requires PM system integration for best results. Returns recommendations
for improving estimation accuracy.`,
    {
      team_id: z.string().describe("Team identifier to calibrate."),
      period_days: z.number().int().positive().default(90).describe("Look-back period in days for historical data."),
      minimum_samples: z.number().int().positive().default(10).describe("Minimum data points needed for reliable calibration."),
    },
    async ({ team_id, period_days, minimum_samples }) => {
      const records = getCalibrationData(team_id, undefined, period_days);
      const result = calibrateEstimates(team_id, period_days, minimum_samples, records);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            team_id,
            correction_factor: result.correctionFactor,
            accuracy_trend: result.accuracyTrend,
            velocity_trend: result.velocityTrend,
            recommendations: result.recommendations,
          }),
        }],
      };
    },
  );

  server.tool(
    "token_time_bridge",
    `Map LLM token budgets to estimated wall-clock time.

Uses model-specific calibration data (tokens/second, reasoning overhead,
tool-call latency) to estimate how long a task will actually take.
Bridges the gap between token-space (how agents reason) and time-space (what humans need).`,
    {
      tokens: z.number().int().positive().describe("Estimated token count for the task (input + output)."),
      model: z.enum([
        "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3.5-haiku-20241022",
        "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
        "gemini-2.0-flash", "gemini-2.5-pro",
        "llama-3.1-70b", "llama-3.1-405b",
        "mistral-large", "deepseek-v3",
      ]).describe("The LLM model being used."),
      tool_calls: z.number().int().nonnegative().default(0).describe("Estimated number of tool/API calls the agent will make."),
      reasoning_depth: z.enum(["shallow", "moderate", "deep"]).default("moderate").describe("Reasoning complexity: shallow=simple tasks, moderate=standard, deep=complex multi-step."),
    },
    async (params) => {
      const result = tokenTimeBridge({
        tokens: params.tokens,
        model: params.model,
        toolCalls: params.tool_calls,
        reasoningDepth: params.reasoning_depth,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "token_cost_estimate",
    `Estimate wall-clock time AND dollar cost for LLM token usage.

Combines token-to-time mapping with model-specific pricing data.
Returns cost breakdown (input/output/overhead) alongside the time estimate.`,
    {
      tokens: z.number().int().positive().describe("Estimated token count for the task (input + output)."),
      model: z.enum([
        "claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-3.5-haiku-20241022",
        "gpt-4o", "gpt-4o-mini", "gpt-4-turbo",
        "gemini-2.0-flash", "gemini-2.5-pro",
        "llama-3.1-70b", "llama-3.1-405b",
        "mistral-large", "deepseek-v3",
      ]).describe("The LLM model being used."),
      tool_calls: z.number().int().nonnegative().default(0).describe("Estimated number of tool/API calls."),
      reasoning_depth: z.enum(["shallow", "moderate", "deep"]).default("moderate").describe("Reasoning depth."),
    },
    async (params) => {
      const result = tokenCostEstimate({
        tokens: params.tokens,
        model: params.model,
        toolCalls: params.tool_calls,
        reasoningDepth: params.reasoning_depth,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "compare_models",
    `Compare all LLM models side-by-side for a given token budget.

Ranks models by estimated cost or time. Shows quality tier for each model.
Use when choosing which model to use for a task.`,
    {
      tokens: z.number().int().positive().describe("Token count to estimate across all models."),
      tool_calls: z.number().int().nonnegative().default(0).describe("Number of tool calls."),
      reasoning_depth: z.enum(["shallow", "moderate", "deep"]).default("moderate").describe("Reasoning depth."),
      sort_by: z.enum(["cost", "time"]).default("cost").describe("Sort by cost or time."),
    },
    async (params) => {
      const result = compareModels({
        tokens: params.tokens,
        toolCalls: params.tool_calls,
        reasoningDepth: params.reasoning_depth,
        sortBy: params.sort_by,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "accuracy_trend",
    `Track estimation accuracy improvement over time.

Computes sliding-window MAPE and compares against industry baseline (25%).
Shows whether your estimates are improving, degrading, or stable.
Industry research shows estimation accuracy does NOT improve with experience (Cao 2022) — self-correcting systems like Epoch can buck this trend.`,
    {
      team_id: z.string().optional().describe("Team identifier."),
      window_size: z.number().int().min(5).default(50).describe("Records per sliding window."),
    },
    async ({ team_id, window_size }) => {
      const result = computeAccuracyTrend({ teamId: team_id, windowSize: window_size });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "schedule_risk",
    `Assess schedule risk for an estimate using historical accuracy data.

Computes confidence intervals (p50/p80/p95) based on your team's MAPE.
Returns risk level and actionable recommendations.
Uses industry baseline (25% MAPE) when no historical data is available.`,
    {
      estimated_hours: z.number().positive().describe("The estimated effort in hours."),
      task_type: z.enum(["feature", "bugfix", "refactor", "migration", "infrastructure", "documentation", "testing", "design"]).optional().describe("Task type for accuracy lookup."),
      team_id: z.string().optional().describe("Team identifier."),
    },
    async ({ estimated_hours, task_type, team_id }) => {
      const result = scheduleRisk({
        estimatedHours: estimated_hours,
        taskType: task_type,
        teamId: team_id,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );
}
