import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { tokenTimeBridge, referenceClassEstimate, calibrateEstimates } from "../lib/analytics.js";

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
      const records: Array<{
        readonly taskType: string;
        readonly estimatedHours: number;
        readonly actualHours: number;
        readonly teamId?: string;
        readonly completedAt: string;
      }> = [];
      const result = referenceClassEstimate(records, task_type, complexity);
      const output = {
        ...result,
        rawEstimate: result.rawEstimate,
        correctedEstimate: result.correctedEstimate,
        correctionFactor: result.correctionFactor,
        sampleSize: result.sampleSize,
        confidence: result.confidence,
        note: team_id
          ? "No historical data connected. Using industry correction factors."
          : "Connect a PM system (Jira/Asana/Toggl) for data-driven estimates.",
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
      const result = calibrateEstimates(team_id, period_days, minimum_samples);
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
}
