// ---------------------------------------------------------------------------
// Epoch CLI Entry Point — Commander.js-based terminal interface
// Routes CLI subcommands to the dispatcher layer.
// ---------------------------------------------------------------------------

import { Command, Option } from "commander";
import { dispatch } from "../dispatcher/index.js";
import { formatJson, formatTable } from "../dispatcher/formatters.js";
import type { ToolResult } from "../types/index.js";
import { getVersion } from "../version.js";

// ---- Helpers ----------------------------------------------------------------

/** Parse a JSON string, exiting with code 1 on failure. */
function parseJsonArg(raw: string, flagName: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch (err: unknown) {
		const message = err instanceof SyntaxError ? err.message : "Invalid JSON";
		process.stderr.write(
			`Error: --${flagName} must be valid JSON: ${message}\n`,
		);
		process.exit(1);
	}
}

/** Safe parseFloat that exits on NaN instead of propagating silently. */
function safeFloat(flagName: string): (value: string) => number {
	return (value: string) => {
		const n = Number.parseFloat(value);
		if (Number.isNaN(n)) {
			process.stderr.write(
				`Error: --${flagName} must be a number, got "${value}"\n`,
			);
			process.exit(1);
		}
		return n;
	};
}

/** Resolve output format from root options, applying --pretty override. */
function resolveFormat(rootOpts: Record<string, unknown>): "json" | "table" {
	if (rootOpts.pretty === true) return "table";
	return (rootOpts.format ?? "json") as "json" | "table";
}

/** Resolve root options from Commander command chain. */
function getRootOpts(cmd: Command): Record<string, unknown> {
	// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
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
		format === "table" ? formatTable(result, toolName) : formatJson(result);

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
		.version(getVersion())
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
		.option(
			"--timezone <tz>",
			'IANA timezone identifier (default "UTC")',
			"UTC",
		)
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
		.description(
			"Converts a timestamp from its embedded timezone to a target timezone.",
		)
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
		.description(
			"Performs time arithmetic: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
		)
		.requiredOption("--operation <op>", "Time math operation to perform")
		.option("--date <d>", "ISO date string (add_days, diff)")
		.option(
			"--days <n>",
			"Number of days (add_days, add_business_days)",
			safeFloat("days"),
		)
		.option(
			"--start-date <d>",
			"ISO date string for start date (add_business_days)",
		)
		.option(
			"--country <code>",
			"ISO-3166-1-alpha-2 country code (add_business_days, default US)",
		)
		.option("--end-date <d>", "ISO date string for end date (diff)")
		.option("--timestamp <ts>", "ISO timestamp string (convert_tz)")
		.option("--target-tz <tz>", "IANA timezone string (convert_tz)")
		.option(
			"--duration-string <s>",
			"Natural language duration string (parse_nl)",
		)
		.option(
			"--milliseconds <n>",
			"Duration in milliseconds (format_duration)",
			safeFloat("milliseconds"),
		)
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
			if (opts.durationString !== undefined)
				operands.duration_string = opts.durationString;
			if (opts.milliseconds !== undefined)
				operands.milliseconds = opts.milliseconds;
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
		.description(
			"Adds N business days to a start date, skipping weekends and holidays.",
		)
		.requiredOption("--start-date <d>", "ISO date string for the start date")
		.requiredOption(
			"--days <n>",
			"Number of business days to add",
			safeFloat("days"),
		)
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
		.description(
			"Counts business days between two dates, skipping weekends and holidays.",
		)
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
		.description(
			"Computes a PERT three-point estimate with expected value, standard deviation, and confidence intervals.",
		)
		.requiredOption(
			"--optimistic <n>",
			"Best-case duration",
			safeFloat("optimistic"),
		)
		.requiredOption(
			"--most-likely <n>",
			"Most probable duration",
			safeFloat("most-likely"),
		)
		.requiredOption(
			"--pessimistic <n>",
			"Worst-case duration",
			safeFloat("pessimistic"),
		)
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
		.description(
			"Estimates effort using a COCOMO II model adjusted for LLM-assisted workflows.",
		)
		.requiredOption(
			"--kloc <n>",
			"Estimated thousands of lines of code",
			safeFloat("kloc"),
		)
		.option(
			"--reasoning-complexity <n>",
			"Reasoning complexity multiplier (0.5-2.0)",
			safeFloat("reasoning-complexity"),
		)
		.option(
			"--context-completeness <n>",
			"Context completeness multiplier (0.5-2.0)",
			safeFloat("context-completeness"),
		)
		.option(
			"--transformation-impact <n>",
			"Transformation impact multiplier (0.5-2.0)",
			safeFloat("transformation-impact"),
		)
		.option(
			"--iterative-cycles <n>",
			"Iteration overhead multiplier (0.5-10.0)",
			safeFloat("iterative-cycles"),
		)
		.option(
			"--human-oversight <n>",
			"Human review overhead multiplier (0.5-2.0)",
			safeFloat("human-oversight"),
		)
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
		.description(
			"Forecasts sprints needed to clear a backlog based on historical velocity.",
		)
		.requiredOption(
			"--backlog-points <n>",
			"Total backlog story points",
			safeFloat("backlog-points"),
		)
		.requiredOption(
			"--velocity-history <csv>",
			"Comma-separated velocity values per sprint",
		)
		.option(
			"--sprint-length-days <n>",
			"Calendar days in one sprint",
			safeFloat("sprint-length-days"),
		)
		.option(
			"--hours-per-sprint <n>",
			"Productive engineering hours per sprint",
			safeFloat("hours-per-sprint"),
		)
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
		.description(
			"Computes the critical path through a task graph with merge-bias adjustment.",
		)
		.requiredOption("--tasks <json>", "Task array as JSON")
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const tasks = parseJsonArg(opts.tasks, "tasks");
			await runAndExit("critical_path", { tasks }, format, quiet);
		});

	program
		.command("monte-carlo-schedule")
		.description(
			"Runs a Monte Carlo simulation on a task list with three-point estimates.",
		)
		.requiredOption("--tasks <json>", "Task array as JSON")
		.option(
			"--iterations <n>",
			"Number of simulation iterations",
			safeFloat("iterations"),
		)
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
		.description(
			"Estimates effort using reference-class forecasting from historical data.",
		)
		.requiredOption(
			"--task-type <type>",
			"Category of work (feature|bugfix|refactor|migration|infrastructure|documentation|testing|design)",
		)
		.requiredOption(
			"--complexity <n>",
			"Complexity 1-5",
			safeFloat("complexity"),
		)
		.option("--scope <scope>", "Scope band (small|medium|large|xl)")
		.option("--team-id <id>", "Team identifier for calibration lookup")
		.option(
			"--ai-native <ratio>",
			"AI-native ratio 0.0-1.0 (default: 0.0)",
			safeFloat("ai-native"),
		)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const input: Record<string, unknown> = {
				task_type: opts.taskType,
				complexity: opts.complexity,
			};
			if (opts.scope) input.scope = opts.scope;
			if (opts.teamId) input.team_id = opts.teamId;
			if (opts.aiNative !== undefined) input.ai_native = opts.aiNative;
			await runAndExit("reference_class_estimate", input, format, quiet);
		});

	program
		.command("calibrate-estimates")
		.description("Calibrates estimation accuracy using historical team data.")
		.requiredOption("--team-id <id>", "Team identifier")
		.option(
			"--period-days <n>",
			"Lookback window in calendar days",
			safeFloat("period-days"),
		)
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
		.description(
			"Estimates wall-clock time from token count and LLM model parameters.",
		)
		.requiredOption(
			"--tokens <n>",
			"Total number of tokens",
			safeFloat("tokens"),
		)
		.requiredOption("--model <model>", "LLM model identifier")
		.option(
			"--tool-calls <n>",
			"Number of expected tool calls",
			safeFloat("tool-calls"),
		)
		.option(
			"--reasoning-depth <depth>",
			"Reasoning depth (shallow|moderate|deep)",
		)
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
		.description(
			"Estimates wall-clock time AND dollar cost from token count and LLM model.",
		)
		.requiredOption(
			"--tokens <n>",
			"Total number of tokens",
			safeFloat("tokens"),
		)
		.requiredOption("--model <model>", "LLM model identifier")
		.option(
			"--tool-calls <n>",
			"Number of expected tool calls",
			safeFloat("tool-calls"),
		)
		.option(
			"--reasoning-depth <depth>",
			"Reasoning depth (shallow|moderate|deep)",
		)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const input: Record<string, unknown> = {
				tokens: opts.tokens,
				model: opts.model,
			};
			if (opts.toolCalls !== undefined) input.tool_calls = opts.toolCalls;
			if (opts.reasoningDepth !== undefined)
				input.reasoning_depth = opts.reasoningDepth;
			await runAndExit("token_cost_estimate", input, format, quiet);
		});

	program
		.command("compare-models")
		.description(
			"Compares all LLM models side-by-side for a given token budget.",
		)
		.requiredOption(
			"--tokens <n>",
			"Token count to estimate",
			safeFloat("tokens"),
		)
		.option("--tool-calls <n>", "Number of tool calls", safeFloat("tool-calls"))
		.option(
			"--reasoning-depth <depth>",
			"Reasoning depth (shallow|moderate|deep)",
		)
		.option("--sort-by <field>", "Sort by cost or time", "cost")
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const input: Record<string, unknown> = { tokens: opts.tokens };
			if (opts.toolCalls !== undefined) input.tool_calls = opts.toolCalls;
			if (opts.reasoningDepth !== undefined)
				input.reasoning_depth = opts.reasoningDepth;
			if (opts.sortBy !== undefined) input.sort_by = opts.sortBy;
			await runAndExit("compare_models", input, format, quiet);
		});

	// -- Validation & analytics tools (3) ----------------------------------------

	program
		.command("accuracy-trend")
		.description(
			"Tracks estimation accuracy over time with sliding-window MAPE.",
		)
		.option("--team-id <id>", "Team identifier")
		.option(
			"--window-size <n>",
			"Records per sliding window",
			safeFloat("window-size"),
		)
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
		.requiredOption(
			"--estimated-hours <n>",
			"Estimated effort in hours",
			safeFloat("estimated-hours"),
		)
		.option("--task-type <type>", "Task type for accuracy lookup")
		.option("--team-id <id>", "Team identifier")
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const input: Record<string, unknown> = {
				estimated_hours: opts.estimatedHours,
			};
			if (opts.taskType !== undefined) input.task_type = opts.taskType;
			if (opts.teamId !== undefined) input.team_id = opts.teamId;
			await runAndExit("schedule_risk", input, format, quiet);
		});

	program
		.command("cocomo-validate")
		.description(
			"Validates COCOMO estimation model against 195 real historical projects.",
		)
		.option("--dataset-filter <datasets>", "Comma-separated dataset names")
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const input: Record<string, unknown> = {};
			if (opts.datasetFilter !== undefined) {
				input.dataset_filter = opts.datasetFilter
					.split(",")
					.map((s: string) => s.trim());
			}
			await runAndExit("cocomo_validate", input, format, quiet);
		});

	// ---- Feedback commands -----------------------------------------------------

	program
		.command("record-actual")
		.description(
			"Records actual hours for a previous estimate to improve future accuracy.",
		)
		.requiredOption("--estimate-id <id>", "ID of the estimate to update")
		.requiredOption(
			"--actual-hours <n>",
			"Actual hours spent",
			safeFloat("actual-hours"),
		)
		.option(
			"--notes <text>",
			"Optional context about what affected the actual time",
		)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const input: Record<string, unknown> = {
				estimate_id: opts.estimateId,
				actual_hours: opts.actualHours,
			};
			if (opts.notes !== undefined) input.notes = opts.notes;
			await runAndExit("record_actual", input, format, quiet);
		});

	program
		.command("get-pending-estimates")
		.description(
			"Lists recent estimates that have not yet received actual-hour feedback.",
		)
		.option("--limit <n>", "Maximum estimates to return", parseInt, 20)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			await runAndExit(
				"get_pending_estimates",
				{ limit: opts.limit },
				format,
				quiet,
			);
		});

	program
		.command("batch-record-actuals")
		.description("Record actual hours for multiple estimates at once.")
		.requiredOption(
			"--entries <json>",
			"JSON array of {estimate_id, actual_hours, notes?} objects",
		)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const entries = parseJsonArg(opts.entries, "entries");
			await runAndExit("batch_record_actuals", { entries }, format, quiet);
		});

	program
		.command("feedback-health")
		.description("Health report on the estimation feedback loop.")
		.action(async (_opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			await runAndExit("feedback_health", {}, format, quiet);
		});

	program
		.command("cocomo-ground-truth")
		.description(
			"Validate COCOMO models against real historical projects with known effort.",
		)
		.option(
			"--dataset-filter <names>",
			"Comma-separated dataset names to include",
		)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const input: Record<string, unknown> = {};
			if (opts.datasetFilter !== undefined) {
				input.dataset_filter = opts.datasetFilter
					.split(",")
					.map((s: string) => s.trim());
			}
			await runAndExit("cocomo_ground_truth", input, format, quiet);
		});

	program
		.command("self-improve")
		.description(
			"Trigger self-improvement: recompute correction factors from feedback data.",
		)
		.action(async () => {
			const { updateReferenceDatabase } = await import(
				"../lib/self-improve.js"
			);
			await updateReferenceDatabase();
			process.stdout.write(
				JSON.stringify({ ok: true, message: "Self-improvement complete." }) +
					"\n",
			);
			process.exit(0);
		});

	// ---- Telemetry commands ----------------------------------------------------

	const telemetryCmd = program
		.command("telemetry")
		.description("Manage anonymous telemetry settings");

	function validateTelemetryEndpoint(endpoint: string): string {
		const trimmed = endpoint.trim();
		let parsed: URL;
		try {
			parsed = new URL(trimmed);
		} catch {
			throw new Error("--endpoint must be a valid URL");
		}

		const isLocalHttp =
			parsed.protocol === "http:" &&
			["localhost", "127.0.0.1", "::1"].includes(parsed.hostname);
		const isTailscaleHttp =
			parsed.protocol === "http:" && isTailscalePrivateIpv4(parsed.hostname);
		if (parsed.protocol !== "https:" && !isLocalHttp && !isTailscaleHttp) {
			throw new Error(
				"--endpoint must use https://, except for localhost or Tailscale private receivers",
			);
		}

		return trimmed;
	}

	function isTailscalePrivateIpv4(hostname: string): boolean {
		const parts = hostname.split(".").map((part) => Number(part));
		if (
			parts.length !== 4 ||
			parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)
		) {
			return false;
		}
		const [first, second] = parts as [number, number, number, number];
		return first === 100 && second >= 64 && second <= 127;
	}

	telemetryCmd
		.command("status")
		.description("Show current telemetry configuration and history")
		.action(async () => {
			const { loadConfig, isUsableTelemetryEndpoint } = await import(
				"../lib/config.js"
			);
			const { extractAnonymizedRecords } = await import(
				"../lib/telemetry-submit.js"
			);
			const config = loadConfig();
			const envVal = process.env["EPOCH_TELEMETRY"];
			const endpointEnvVal = process.env["EPOCH_TELEMETRY_ENDPOINT"];
			const source = envVal ? "env var" : "config file";
			const endpointConfigured = isUsableTelemetryEndpoint(
				config.telemetry.endpoint,
			);
			const queuedRecords = extractAnonymizedRecords(
				config.telemetry.lastSubmissionAt ?? undefined,
			).length;
			const enabled =
				envVal === "1" || envVal === "true"
					? true
					: envVal === "0" || envVal === "false"
						? false
						: config.telemetry.enabled;
			process.stdout.write(
				JSON.stringify(
					{
						enabled,
						source,
						endpoint: endpointConfigured
							? config.telemetry.endpoint
							: "(not configured)",
						endpointSource: endpointEnvVal ? "env var" : "config file",
						endpointConfigured,
						queuedRecords,
						lastSubmissionAt: config.telemetry.lastSubmissionAt,
						totalRecordsSubmitted: config.telemetry.lastSubmissionRecordCount,
						lastSubmissionAcceptedCount:
							config.telemetry.lastSubmissionAcceptedCount ?? 0,
						lastSubmissionDeduplicatedCount:
							config.telemetry.lastSubmissionDeduplicatedCount ?? 0,
						totalRecordsAccepted: config.telemetry.totalRecordsAccepted ?? 0,
						totalRecordsDeduplicated:
							config.telemetry.totalRecordsDeduplicated ?? 0,
						installationId:
							config.telemetry.installationId || "(not generated yet)",
					},
					null,
					2,
				) + "\n",
			);
			process.exit(0);
		});

	telemetryCmd
		.command("preview")
		.description("Preview anonymized data that would be shared")
		.action(async () => {
			const { extractAnonymizedRecords } = await import(
				"../lib/telemetry-submit.js"
			);
			const records = extractAnonymizedRecords();
			const summary = {
				totalRecords: records.length,
				fields: Object.keys(records[0] ?? {}),
				strippedFields: [
					"estimateId",
					"source",
					"notes",
					"teamId",
					"time-of-day",
				],
				sample: records.slice(0, 5),
			};
			process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
			process.exit(0);
		});

	telemetryCmd
		.command("export")
		.option("--output <path>", "Output file path")
		.description("Export all anonymized data to a JSON file")
		.action(async (opts) => {
			const { exportToFile } = await import("../lib/telemetry-submit.js");
			const path = exportToFile(opts.output);
			process.stdout.write(
				JSON.stringify({
					ok: true,
					path,
					message: "Anonymized data exported.",
				}) + "\n",
			);
			process.exit(0);
		});

	telemetryCmd
		.command("enable")
		.option("--yes", "Skip confirmation prompt")
		.option("--endpoint <url>", "Telemetry receiver URL")
		.description("Opt in to anonymous telemetry sharing")
		.action(async (opts) => {
			const { saveConfig, loadConfig } = await import("../lib/config.js");
			const { extractAnonymizedRecords } = await import(
				"../lib/telemetry-submit.js"
			);
			let endpoint: string | undefined;

			if (opts.endpoint) {
				try {
					endpoint = validateTelemetryEndpoint(opts.endpoint);
				} catch (err) {
					const message =
						err instanceof Error ? err.message : "invalid endpoint";
					process.stderr.write(`${message}\n`);
					process.exit(1);
				}
			}

			if (!opts.yes) {
				const records = extractAnonymizedRecords();
				console.log("Epoch Anonymous Telemetry — Informed Consent");
				console.log("");
				console.log("What IS shared:");
				console.log("  - Task type (feature, bugfix, refactor, etc.)");
				console.log("  - Complexity rating (1-5)");
				console.log("  - Tool used (pert_estimate, cocomo_estimate, etc.)");
				console.log("  - Estimated hours and actual hours");
				console.log("  - Ratio (actual/estimated)");
				console.log("  - Date (YYYY-MM-DD only)");
				console.log("");
				console.log("What is NOT shared:");
				console.log("  - No project names, descriptions, or notes");
				console.log("  - No team identifiers or company information");
				console.log("  - No IP addresses or timestamps with time-of-day");
				console.log("  - No source code or task descriptions");
				console.log("");
				console.log(
					`A random installation ID is used to deduplicate submissions.`,
				);
				console.log(`This ID cannot be used to identify you.`);
				console.log("");
				console.log(`Records available: ${records.length}`);
				if (endpoint) {
					console.log(`Endpoint: ${endpoint}`);
				}
				console.log("");
				console.log(
					"Data stays local until an endpoint is configured and submission runs.",
				);
				console.log("Type 'yes' to confirm:");

				const { createInterface } = await import("node:readline");
				const rl = createInterface({
					input: process.stdin,
					output: process.stdout,
				});
				const answer: string = await new Promise((res) =>
					rl.question("> ", res),
				);
				rl.close();
				if (answer.toLowerCase() !== "yes" && answer.toLowerCase() !== "y") {
					console.log("Cancelled.");
					process.exit(0);
				}
			}

			const config = loadConfig();
			config.telemetry.enabled = true;
			if (endpoint) config.telemetry.endpoint = endpoint;
			saveConfig(config);
			process.stdout.write(
				JSON.stringify({
					ok: true,
					endpoint: config.telemetry.endpoint || "(not configured)",
					message:
						"Telemetry enabled. Use 'epoch telemetry preview' to see what will be shared.",
				}) + "\n",
			);
			process.exit(0);
		});

	telemetryCmd
		.command("set-endpoint")
		.requiredOption("--endpoint <url>", "Telemetry receiver URL")
		.description("Configure the telemetry receiver endpoint")
		.action(async (opts) => {
			const { saveConfig, loadConfig } = await import("../lib/config.js");
			let endpoint: string;
			try {
				endpoint = validateTelemetryEndpoint(opts.endpoint);
			} catch (err) {
				const message = err instanceof Error ? err.message : "invalid endpoint";
				process.stderr.write(`${message}\n`);
				process.exit(1);
			}

			const config = loadConfig();
			config.telemetry.endpoint = endpoint;
			saveConfig(config);
			process.stdout.write(JSON.stringify({ ok: true, endpoint }) + "\n");
			process.exit(0);
		});

	telemetryCmd
		.command("submit")
		.option(
			"--endpoint <url>",
			"Telemetry receiver URL to save before submitting",
		)
		.option("--force", "Bypass the local submit interval guard")
		.option(
			"--min-interval-hours <n>",
			"Minimum hours between submits for this invocation",
		)
		.description(
			"Submit queued anonymized telemetry to the configured endpoint",
		)
		.action(async (opts) => {
			const { saveConfig, loadConfig } = await import("../lib/config.js");
			const { submitTelemetry } = await import("../lib/telemetry-submit.js");

			if (opts.endpoint) {
				let endpoint: string;
				try {
					endpoint = validateTelemetryEndpoint(opts.endpoint);
				} catch (err) {
					const message =
						err instanceof Error ? err.message : "invalid endpoint";
					process.stderr.write(`${message}\n`);
					process.exit(1);
				}

				const config = loadConfig();
				config.telemetry.endpoint = endpoint;
				saveConfig(config);
			}

			if (opts.force) process.env["EPOCH_TELEMETRY_SUBMIT_FORCE"] = "1";
			if (opts.minIntervalHours !== undefined) {
				process.env["EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS"] = String(
					opts.minIntervalHours,
				);
			}

			const result = await submitTelemetry();
			process.stdout.write(JSON.stringify(result, null, 2) + "\n");
			process.exit(result.ok ? 0 : 1);
		});

	telemetryCmd
		.command("disable")
		.description("Opt out of anonymous telemetry sharing")
		.action(async () => {
			const { saveConfig, loadConfig } = await import("../lib/config.js");
			const config = loadConfig();
			config.telemetry.enabled = false;
			saveConfig(config);
			process.stdout.write(
				JSON.stringify({ ok: true, message: "Telemetry disabled." }) + "\n",
			);
			process.exit(0);
		});

	telemetryCmd
		.command("delete-data")
		.option("--confirm", "Skip confirmation")
		.description("Instructions for deleting your telemetry data")
		.action(async () => {
			const { loadConfig } = await import("../lib/config.js");
			const config = loadConfig();
			const id = config.telemetry.installationId || "(not generated)";
			console.log("To delete your telemetry data:");
			console.log("");
			console.log("1. Delete local data:");
			console.log(
				"   rm -rf ~/.epoch/estimates.jsonl ~/.epoch/feedback.jsonl ~/.epoch/telemetry.jsonl",
			);
			console.log("");
			console.log("2. Delete config:");
			console.log("   rm ~/.epoch/config.json");
			console.log("");
			console.log(`3. Your installation ID: ${id}`);
			console.log(
				"   (When a server endpoint is configured, this ID can be used to request remote deletion.)",
			);
			process.exit(0);
		});

	program
		.command("share-data")
		.description("Export anonymized data for community contribution")
		.option("--output <path>", "Output file path")
		.option("--description <text>", "Description of the exported dataset")
		.option("--validate", "Validate export against community data schema")
		.option(
			"--default-complexity <n>",
			"Default complexity for records missing it (1-5)",
			safeFloat("default-complexity"),
		)
		.action(async (opts) => {
			const { writeCommunityEstimationDataset, validateCommunityExport } =
				await import("../lib/community-export.js");

			try {
				const result = writeCommunityEstimationDataset({
					output: opts.output,
					description: opts.description ?? "Anonymized Epoch usage export",
					defaultComplexity: opts.defaultComplexity,
				});

				const output: Record<string, unknown> = {
					ok: true,
					path: result.path,
					recordCount: result.recordCount,
					skipped: result.skipped,
					schema: "estimation-record",
					validated: false as boolean,
				};

				if (opts.validate) {
					const validation = validateCommunityExport(result.path);
					output.validated = validation.valid;
					if (!validation.valid) {
						output.validationErrors = validation.errors;
					}
				}

				output.nextSteps = [
					"Review the exported file to verify anonymization",
					"Copy it to data/community/<contributor-id>-estimation.json",
					"Run node scripts/validate-community-data.mjs",
					"Open a pull request",
				];

				process.stdout.write(JSON.stringify(output, null, 2) + "\n");
				process.exit(0);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				process.stderr.write(JSON.stringify({ ok: false, message }) + "\n");
				process.exit(1);
			}
		});

	// ---- Data inspection commands ----------------------------------------------

	const dataCmd = program
		.command("data")
		.description("Inspect local Epoch data files");

	dataCmd
		.command("where")
		.description("Show local Epoch data file locations")
		.action(async () => {
			const { getEpochDataPaths } = await import("../lib/data-status.js");
			process.stdout.write(JSON.stringify(getEpochDataPaths(), null, 2) + "\n");
			process.exit(0);
		});

	dataCmd
		.command("status")
		.description("Show local Epoch data status and file counts")
		.action(async () => {
			const { getEpochDataStatus } = await import("../lib/data-status.js");
			process.stdout.write(
				JSON.stringify(getEpochDataStatus(), null, 2) + "\n",
			);
			process.exit(0);
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
