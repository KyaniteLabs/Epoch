import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pertEstimate, sprintForecast, cocomoEstimate, criticalPath, monteCarloSim } from "../lib/estimation.js";

const annotations = {
  readOnlyHint: true as const,
  destructiveHint: false as const,
  idempotentHint: true as const,
  openWorldHint: false as const,
};

export function registerEstimationTools(server: McpServer): void {
  server.tool(
    "pert_estimate",
    `Calculate PERT expected duration from three-point estimates using Beta distribution.

Formula: E = (O + 4M + P) / 6. Returns expected value, variance, standard deviation,
and 95%/99% confidence bounds with urgency categorization.
Use when estimating task duration with uncertain outcomes.`,
    {
      optimistic: z.number().positive().describe("Best-case duration if everything goes perfectly. Do NOT use your initial guess — research shows initial estimates average 1.5x too low."),
      most_likely: z.number().positive().describe("Most probable duration under normal conditions."),
      pessimistic: z.number().positive().describe("Worst-case duration if multiple things go wrong."),
      unit: z.enum(["hours", "days", "weeks"]).default("hours").describe("Time unit for all three estimates."),
    },
    async ({ optimistic, most_likely, pessimistic, unit }) => {
      const result = pertEstimate(optimistic, most_likely, pessimistic, unit);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result.error) }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] };
    },
  );

  server.tool(
    "cocomo_estimate",
    `LLM-adapted COCOMO II parametric effort estimation.

Replaces traditional 17 human-labor cost drivers with 5 LLM-specific factors:
reasoning complexity, context completeness, transformation impact, iterative cycles,
and human oversight. Returns both nominal and LLM-adjusted person-months.`,
    {
      kloc: z.number().positive().describe("Estimated thousands of lines of code (KLOC)."),
      reasoning_complexity: z.number().min(0.5).max(2.0).default(1.0).describe("LLM reasoning depth required. 1.0=nominal, >1=complex multi-step reasoning, <1=simple generation."),
      context_completeness: z.number().min(0.5).max(2.0).default(1.0).describe("How much codebase context the LLM has. 1.0=complete, <1=incomplete context, >1=excessive context to filter."),
      transformation_impact: z.number().min(0.5).max(2.0).default(1.0).describe("Degree of architectural change. 1.0=local change, 2.0=cross-cutting refactor."),
      iterative_cycles: z.number().min(0.5).max(2.0).default(1.0).describe("Expected generate-test-revise loops. 1.0=single pass, 2.0=heavy iteration."),
      human_oversight: z.number().min(0.5).max(2.0).default(1.0).describe("Fraction of work requiring human review. 1.0=standard review, 2.0=extensive validation."),
    },
    async (params) => {
      const result = cocomoEstimate({
        kloc: params.kloc,
        reasoningComplexity: params.reasoning_complexity,
        contextCompleteness: params.context_completeness,
        transformationImpact: params.transformation_impact,
        iterativeCycles: params.iterative_cycles,
        humanOversight: params.human_oversight,
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );

  server.tool(
    "sprint_forecast",
    `Forecast sprint completion date from backlog size and historical velocity.

Computes average velocity from sprint history, converts story points to hours,
and returns required sprints with pessimistic estimate based on velocity variance.`,
    {
      backlog_points: z.number().positive().describe("Total story/effort points remaining in the backlog."),
      velocity_history: z.array(z.number().positive()).min(1).describe("Story points completed per past sprint. At least 1 sprint required; 5+ recommended for accuracy."),
      sprint_length_days: z.number().positive().int().default(14).describe("Length of one sprint in calendar days."),
      hours_per_sprint: z.number().positive().default(300).describe("Total working hours available per sprint."),
    },
    async (params) => {
      const result = sprintForecast({
        backlogPoints: params.backlog_points,
        velocityHistory: params.velocity_history,
        sprintLengthDays: params.sprint_length_days,
        hoursPerSprint: params.hours_per_sprint,
      });
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result.error) }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] };
    },
  );

  server.tool(
    "critical_path",
    `Compute critical path with merge-bias adjustment for project schedules.

Performs forward/backward pass to identify critical tasks and slack.
Applies merge bias: tasks with >2 predecessors get 5% duration increase per extra predecessor.`,
    {
      tasks: z.array(z.object({
        name: z.string().describe("Unique task name."),
        duration: z.number().positive().describe("Task duration in the chosen unit."),
        predecessors: z.array(z.string()).default([]).describe("Names of tasks that must complete before this one starts."),
      })).min(1).describe("List of project tasks with durations and dependencies."),
    },
    async ({ tasks }) => {
      const result = criticalPath(tasks);
      if (!result.ok) {
        return { content: [{ type: "text" as const, text: JSON.stringify(result.error) }], isError: true };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify(result.data) }] };
    },
  );

  server.tool(
    "monte_carlo_schedule",
    `Run Monte Carlo simulation for probabilistic schedule risk analysis.

Samples task durations from triangular distributions and returns P10/P50/P80/P95
completion estimates with identified risk events. Use seed for reproducible results.`,
    {
      tasks: z.array(z.object({
        name: z.string().describe("Task name."),
        optimistic: z.number().positive().describe("Best-case duration."),
        most_likely: z.number().positive().describe("Most probable duration."),
        pessimistic: z.number().positive().describe("Worst-case duration."),
      })).min(1).describe("Tasks with three-point duration estimates."),
      iterations: z.number().int().positive().default(10000).describe("Number of simulation iterations. 10000 is a good balance of speed and accuracy."),
      seed: z.number().optional().describe("Random seed for reproducibility. Omit for varied results."),
    },
    async ({ tasks, iterations, seed }) => {
      const mappedTasks = tasks.map(t => ({
        name: t.name,
        optimistic: t.optimistic,
        mostLikely: t.most_likely,
        pessimistic: t.pessimistic,
      }));
      const result = monteCarloSim(mappedTasks, iterations, seed);
      return { content: [{ type: "text" as const, text: JSON.stringify(result) }] };
    },
  );
}
