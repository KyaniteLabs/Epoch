// ---------------------------------------------------------------------------
// Epoch CLI Entry Point — Commander.js-based terminal interface
// Routes CLI subcommands to the dispatcher layer.
// ---------------------------------------------------------------------------

import { Command, Option } from "commander";
import { dispatch } from "../dispatcher/index.js";
import { formatJson, formatTable } from "../dispatcher/formatters.js";
import type { ToolResult } from "../types/index.js";

// ---- Helpers ----------------------------------------------------------------

/** Parse a JSON string, exiting with code 1 on failure. */
function parseJsonArg(raw: string, flagName: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (err: unknown) {
    const message =
      err instanceof SyntaxError ? err.message : "Invalid JSON";
    process.stderr.write(
      `Error: --${flagName} must be valid JSON: ${message}\n`,
    );
    process.exit(1);
  }
}

/** Resolve output format from root options, applying --pretty override. */
function resolveFormat(rootOpts: Record<string, unknown>): "json" | "table" {
  if (rootOpts.pretty === true) return "table";
  return (rootOpts.format ?? "json") as "json" | "table";
}

/** Resolve root options from Commander command chain. */
function getRootOpts(cmd: Command): Record<string, unknown> {
  return cmd.parent!.opts() as Record<string, unknown>;
}

function isQuiet(rootOpts: Record<string, unknown>): boolean {
  return rootOpts.quiet === true;
}

/** Run dispatch, format, and exit with the appropriate code. */
async function runAndExit(
  toolName: string,
  input: Record<string, unknown>,
  format: "json" | "table",
  quiet: boolean,
): Promise<never> {
  const result: ToolResult<unknown> = await dispatch(toolName, input);

  if (!result.ok) {
    process.stderr.write(formatJson(result) + "\n");
    process.exit(result.error.isError ? 2 : 1);
  }

  const output =
    format === "table"
      ? formatTable(result, toolName)
      : formatJson(result);

  if (!quiet || format === "json") {
    process.stdout.write(output + "\n");
  }

  process.exit(0);
}

// ---- Program builder --------------------------------------------------------

export function createCliProgram(): Command {
  const program = new Command();

  program
    .name("epoch")
    .version("0.1.0")
    .description("Time Estimation CLI")
    .addOption(
      new Option("--format <type>", "Output format")
        .choices(["json", "table"])
        .default("json"),
    )
    .option("--pretty", "Alias for --format table", false)
    .option("--quiet", "Suppress non-data output", false);

  // -- Temporal tools (6) ----------------------------------------------------

  program
    .command("get-current-time")
    .description("Returns the current time in the specified IANA timezone.")
    .option("--timezone <tz>", 'IANA timezone identifier (default "UTC")', "UTC")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      await runAndExit(
        "get_current_time",
        { timezone: opts.timezone },
        format,
        quiet,
      );
    });

  program
    .command("convert-timezone")
    .description("Converts a timestamp from its embedded timezone to a target timezone.")
    .requiredOption("--timestamp <ts>", "ISO-8601 timestamp to convert")
    .requiredOption("--target-tz <tz>", "Target IANA timezone identifier")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      await runAndExit(
        "convert_timezone",
        {
          timestamp: opts.timestamp,
          target_tz: opts.targetTz,
        },
        format,
        quiet,
      );
    });

  program
    .command("parse-duration")
    .description('Parses a duration string such as "2h30m", "1d6h", "45m".')
    .requiredOption("--duration <string>", "Duration string to parse")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      await runAndExit(
        "parse_duration",
        { duration_string: opts.duration },
        format,
        quiet,
      );
    });

  program
    .command("time-math")
    .description("Performs time arithmetic: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.")
    .requiredOption("--operation <op>", "Time math operation to perform")
    .option("--date <d>", "ISO date string (add_days, diff)")
    .option("--days <n>", "Number of days (add_days, add_business_days)", parseFloat)
    .option("--start-date <d>", "ISO date string for start date (add_business_days)")
    .option("--country <code>", "ISO-3166-1-alpha-2 country code (add_business_days, default US)")
    .option("--end-date <d>", "ISO date string for end date (diff)")
    .option("--timestamp <ts>", "ISO timestamp string (convert_tz)")
    .option("--target-tz <tz>", "IANA timezone string (convert_tz)")
    .option("--duration-string <s>", "Natural language duration string (parse_nl)")
    .option("--milliseconds <n>", "Duration in milliseconds (format_duration)", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const operands: Record<string, unknown> = {};
      if (opts.date !== undefined) operands.date = opts.date;
      if (opts.days !== undefined) operands.days = opts.days;
      if (opts.startDate !== undefined) operands.start_date = opts.startDate;
      if (opts.country !== undefined) operands.country = opts.country;
      if (opts.endDate !== undefined) operands.end_date = opts.endDate;
      if (opts.timestamp !== undefined) operands.timestamp = opts.timestamp;
      if (opts.targetTz !== undefined) operands.target_tz = opts.targetTz;
      if (opts.durationString !== undefined) operands.duration_string = opts.durationString;
      if (opts.milliseconds !== undefined) operands.milliseconds = opts.milliseconds;
      await runAndExit(
        "time_math",
        {
          operation: opts.operation,
          operands,
        },
        format,
        quiet,
      );
    });

  program
    .command("add-business-days")
    .description("Adds N business days to a start date, skipping weekends and holidays.")
    .requiredOption("--start-date <d>", "ISO date string for the start date")
    .requiredOption("--days <n>", "Number of business days to add", parseFloat)
    .option("--country <code>", "ISO-3166-1-alpha-2 country code", "US")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      await runAndExit(
        "add_business_days",
        {
          start_date: opts.startDate,
          days: opts.days,
          country: opts.country,
        },
        format,
        quiet,
      );
    });

  program
    .command("count-business-days")
    .description("Counts business days between two dates, skipping weekends and holidays.")
    .requiredOption("--start-date <d>", "ISO date string for the start date")
    .requiredOption("--end-date <d>", "ISO date string for the end date")
    .option("--country <code>", "ISO-3166-1-alpha-2 country code", "US")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      await runAndExit(
        "count_business_days",
        {
          start_date: opts.startDate,
          end_date: opts.endDate,
          country: opts.country,
        },
        format,
        quiet,
      );
    });

  // -- Estimation tools (5) --------------------------------------------------

  program
    .command("pert-estimate")
    .description("Computes a PERT three-point estimate with expected value, standard deviation, and confidence intervals.")
    .requiredOption("--optimistic <n>", "Best-case duration", parseFloat)
    .requiredOption("--most-likely <n>", "Most probable duration", parseFloat)
    .requiredOption("--pessimistic <n>", "Worst-case duration", parseFloat)
    .option("--unit <unit>", "Time unit (hours|days|weeks|months)", "hours")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      await runAndExit(
        "pert_estimate",
        {
          optimistic: opts.optimistic,
          most_likely: opts.mostLikely,
          pessimistic: opts.pessimistic,
          unit: opts.unit,
        },
        format,
        quiet,
      );
    });

  program
    .command("cocomo-estimate")
    .description("Estimates effort using a COCOMO II model adjusted for LLM-assisted workflows.")
    .requiredOption("--kloc <n>", "Estimated thousands of lines of code", parseFloat)
    .option("--reasoning-complexity <n>", "Reasoning complexity multiplier (0.5-2.0)", parseFloat)
    .option("--context-completeness <n>", "Context completeness multiplier (0.5-2.0)", parseFloat)
    .option("--transformation-impact <n>", "Transformation impact multiplier (0.5-2.0)", parseFloat)
    .option("--iterative-cycles <n>", "Iteration overhead multiplier (0.5-2.0)", parseFloat)
    .option("--human-oversight <n>", "Human review overhead multiplier (0.5-2.0)", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { kloc: opts.kloc };
      if (opts.reasoningComplexity !== undefined) {
        input.reasoning_complexity = opts.reasoningComplexity;
      }
      if (opts.contextCompleteness !== undefined) {
        input.context_completeness = opts.contextCompleteness;
      }
      if (opts.transformationImpact !== undefined) {
        input.transformation_impact = opts.transformationImpact;
      }
      if (opts.iterativeCycles !== undefined) {
        input.iterative_cycles = opts.iterativeCycles;
      }
      if (opts.humanOversight !== undefined) {
        input.human_oversight = opts.humanOversight;
      }
      await runAndExit("cocomo_estimate", input, format, quiet);
    });

  program
    .command("sprint-forecast")
    .description("Forecasts sprints needed to clear a backlog based on historical velocity.")
    .requiredOption("--backlog-points <n>", "Total backlog story points", parseFloat)
    .requiredOption("--velocity-history <csv>", "Comma-separated velocity values per sprint")
    .option("--sprint-length-days <n>", "Calendar days in one sprint", parseFloat)
    .option("--hours-per-sprint <n>", "Productive engineering hours per sprint", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const velocityHistory = opts.velocityHistory
        .split(",")
        .map((s: string) => {
          const n = Number.parseFloat(s.trim());
          if (Number.isNaN(n)) {
            process.stderr.write(
              `Error: --velocity-history contains non-numeric value "${s.trim()}"\n`,
            );
            process.exit(1);
          }
          return n;
        });
      const input: Record<string, unknown> = {
        backlog_points: opts.backlogPoints,
        velocity_history: velocityHistory,
      };
      if (opts.sprintLengthDays !== undefined) {
        input.sprint_length_days = opts.sprintLengthDays;
      }
      if (opts.hoursPerSprint !== undefined) {
        input.hours_per_sprint = opts.hoursPerSprint;
      }
      await runAndExit("sprint_forecast", input, format, quiet);
    });

  program
    .command("critical-path")
    .description("Computes the critical path through a task graph with merge-bias adjustment.")
    .requiredOption("--tasks <json>", "Task array as JSON")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const tasks = parseJsonArg(opts.tasks, "tasks");
      await runAndExit(
        "critical_path",
        { tasks },
        format,
        quiet,
      );
    });

  program
    .command("monte-carlo-schedule")
    .description("Runs a Monte Carlo simulation on a task list with three-point estimates.")
    .requiredOption("--tasks <json>", "Task array as JSON")
    .option("--iterations <n>", "Number of simulation iterations", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const tasks = parseJsonArg(opts.tasks, "tasks");
      const input: Record<string, unknown> = { tasks };
      if (opts.iterations !== undefined) {
        input.iterations = opts.iterations;
      }
      await runAndExit("monte_carlo_schedule", input, format, quiet);
    });

  // -- Analytics tools (3) ---------------------------------------------------

  program
    .command("reference-class-estimate")
    .description("Estimates effort using reference-class forecasting from historical data.")
    .requiredOption("--task-type <type>", "Category of work (feature|bugfix|refactor|migration|infrastructure|documentation|testing|design)")
    .requiredOption("--complexity <n>", "Complexity 1-5", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      await runAndExit(
        "reference_class_estimate",
        {
          task_type: opts.taskType,
          complexity: opts.complexity,
        },
        format,
        quiet,
      );
    });

  program
    .command("calibrate-estimates")
    .description("Calibrates estimation accuracy using historical team data.")
    .requiredOption("--team-id <id>", "Team identifier")
    .option("--period-days <n>", "Lookback window in calendar days", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { team_id: opts.teamId };
      if (opts.periodDays !== undefined) {
        input.period_days = opts.periodDays;
      }
      await runAndExit("calibrate_estimates", input, format, quiet);
    });

  program
    .command("token-time-bridge")
    .description("Estimates wall-clock time from token count and LLM model parameters.")
    .requiredOption("--tokens <n>", "Total number of tokens", parseFloat)
    .requiredOption("--model <model>", "LLM model identifier")
    .option("--tool-calls <n>", "Number of expected tool calls", parseFloat)
    .option("--reasoning-depth <depth>", "Reasoning depth (shallow|moderate|deep)")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = {
        tokens: opts.tokens,
        model: opts.model,
      };
      if (opts.toolCalls !== undefined) {
        input.tool_calls = opts.toolCalls;
      }
      if (opts.reasoningDepth !== undefined) {
        input.reasoning_depth = opts.reasoningDepth;
      }
      await runAndExit("token_time_bridge", input, format, quiet);
    });

  // -- Token & cost tools (2) ------------------------------------------------

  program
    .command("token-cost-estimate")
    .description("Estimates wall-clock time AND dollar cost from token count and LLM model.")
    .requiredOption("--tokens <n>", "Total number of tokens", parseFloat)
    .requiredOption("--model <model>", "LLM model identifier")
    .option("--tool-calls <n>", "Number of expected tool calls", parseFloat)
    .option("--reasoning-depth <depth>", "Reasoning depth (shallow|moderate|deep)")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { tokens: opts.tokens, model: opts.model };
      if (opts.toolCalls !== undefined) input.tool_calls = opts.toolCalls;
      if (opts.reasoningDepth !== undefined) input.reasoning_depth = opts.reasoningDepth;
      await runAndExit("token_cost_estimate", input, format, quiet);
    });

  program
    .command("compare-models")
    .description("Compares all LLM models side-by-side for a given token budget.")
    .requiredOption("--tokens <n>", "Token count to estimate", parseFloat)
    .option("--tool-calls <n>", "Number of tool calls", parseFloat)
    .option("--reasoning-depth <depth>", "Reasoning depth (shallow|moderate|deep)")
    .option("--sort-by <field>", "Sort by cost or time", "cost")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { tokens: opts.tokens };
      if (opts.toolCalls !== undefined) input.tool_calls = opts.toolCalls;
      if (opts.reasoningDepth !== undefined) input.reasoning_depth = opts.reasoningDepth;
      if (opts.sortBy !== undefined) input.sort_by = opts.sortBy;
      await runAndExit("compare_models", input, format, quiet);
    });

  // -- Validation & analytics tools (3) ----------------------------------------

  program
    .command("accuracy-trend")
    .description("Tracks estimation accuracy over time with sliding-window MAPE.")
    .option("--team-id <id>", "Team identifier")
    .option("--window-size <n>", "Records per sliding window", parseFloat)
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = {};
      if (opts.teamId !== undefined) input.team_id = opts.teamId;
      if (opts.windowSize !== undefined) input.window_size = opts.windowSize;
      await runAndExit("accuracy_trend", input, format, quiet);
    });

  program
    .command("schedule-risk")
    .description("Assesses schedule risk using historical accuracy data.")
    .requiredOption("--estimated-hours <n>", "Estimated effort in hours", parseFloat)
    .option("--task-type <type>", "Task type for accuracy lookup")
    .option("--team-id <id>", "Team identifier")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = { estimated_hours: opts.estimatedHours };
      if (opts.taskType !== undefined) input.task_type = opts.taskType;
      if (opts.teamId !== undefined) input.team_id = opts.teamId;
      await runAndExit("schedule_risk", input, format, quiet);
    });

  program
    .command("cocomo-validate")
    .description("Validates COCOMO estimation model against 195 real historical projects.")
    .option("--dataset-filter <datasets>", "Comma-separated dataset names")
    .action(async (opts, cmd) => {
      const rootOpts = getRootOpts(cmd);
      const format = resolveFormat(rootOpts);
      const quiet = isQuiet(rootOpts);
      const input: Record<string, unknown> = {};
      if (opts.datasetFilter !== undefined) {
        input.dataset_filter = opts.datasetFilter.split(",").map((s: string) => s.trim());
      }
      await runAndExit("cocomo_validate", input, format, quiet);
    });

  // ---- Utility commands -------------------------------------------------------

  program
    .command("list-tools")
    .description("List all available tools and their descriptions")
    .action(async () => {
      const { listTools } = await import("../dispatcher/index.js");
      const tools = listTools();
      process.stdout.write(JSON.stringify(tools, null, 2) + "\n");
      process.exit(0);
    });

  return program;
}

// ---- CLI runner -------------------------------------------------------------

export function runCli(): void {
  createCliProgram().parse(process.argv);
}
