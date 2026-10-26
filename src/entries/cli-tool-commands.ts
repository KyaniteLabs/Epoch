/**
 * The CLI's tool commands as data: one entry per dispatcher tool, giving the
 * command name, its help text, and how each option maps onto the tool input.
 * cli.ts turns every entry into a commander command with the same generic
 * action, so adding or changing a tool command is a data edit here.
 *
 * Option fields:
 * - key: the tool-input field the option fills.
 * - parse: "float" rejects non-numbers before dispatch (exit 1);
 *   "intLegacyRadix" is commander's raw parseInt call (see get-pending-estimates).
 * - after: post-parse conversion run in the action: "json" (exit 1 on bad
 *   JSON), "csvNumbers" (exit 1 on a non-number), "csvStrings" (trimmed list).
 * - include: "always" (required or defaulted), "defined" (when given), or
 *   "truthy" (when given and non-empty).
 * - into: nest the value under that input field instead of the top level.
 */

export type ToolOptionParse = "float" | "intLegacyRadix";
export type ToolOptionAfter = "json" | "csvNumbers" | "csvStrings";

export interface ToolOptionSpec {
	readonly flags: string;
	readonly description: string;
	readonly key: string;
	readonly required?: boolean;
	readonly defaultValue?: string | number;
	readonly parse?: ToolOptionParse;
	readonly after?: ToolOptionAfter;
	readonly include?: "always" | "defined" | "truthy";
	readonly into?: string;
}

export interface ToolCommandSpec {
	readonly name: string;
	readonly tool: string;
	readonly description: string;
	readonly options: readonly ToolOptionSpec[];
}

export const TOOL_COMMANDS: readonly ToolCommandSpec[] = [
	{
		name: "get-current-time",
		tool: "get_current_time",
		description: "Returns the current time in the specified IANA timezone.",
		options: [
			{ flags: "--timezone <tz>", description: "IANA timezone identifier (default \"UTC\")", key: "timezone", defaultValue: "UTC", include: "always" },
		],
	},
	{
		name: "convert-timezone",
		tool: "convert_timezone",
		description: "Converts a timestamp from its embedded timezone to a target timezone.",
		options: [
			{ flags: "--timestamp <ts>", description: "ISO-8601 timestamp to convert", key: "timestamp", required: true, include: "always" },
			{ flags: "--target-tz <tz>", description: "Target IANA timezone identifier", key: "target_tz", required: true, include: "always" },
		],
	},
	{
		name: "parse-duration",
		tool: "parse_duration",
		description: "Parses a duration string such as \"2h30m\", \"1d6h\", \"45m\".",
		options: [
			{ flags: "--duration <string>", description: "Duration string to parse", key: "duration_string", required: true, include: "always" },
		],
	},
	{
		name: "time-math",
		tool: "time_math",
		description: "Performs time arithmetic: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
		options: [
			{ flags: "--operation <op>", description: "Time math operation to perform", key: "operation", required: true, include: "always" },
			{ flags: "--date <d>", description: "ISO date string (add_days, diff)", key: "date", into: "operands" },
			{ flags: "--days <n>", description: "Number of days (add_days, add_business_days)", key: "days", parse: "float", into: "operands" },
			{ flags: "--start-date <d>", description: "ISO date string for start date (add_business_days)", key: "start_date", into: "operands" },
			{ flags: "--country <code>", description: "ISO-3166-1-alpha-2 country code (add_business_days, default US)", key: "country", into: "operands" },
			{ flags: "--end-date <d>", description: "ISO date string for end date (diff)", key: "end_date", into: "operands" },
			{ flags: "--timestamp <ts>", description: "ISO timestamp string (convert_tz)", key: "timestamp", into: "operands" },
			{ flags: "--target-tz <tz>", description: "IANA timezone string (convert_tz)", key: "target_tz", into: "operands" },
			{ flags: "--duration-string <s>", description: "Natural language duration string (parse_nl)", key: "duration_string", into: "operands" },
			{ flags: "--milliseconds <n>", description: "Duration in milliseconds (format_duration)", key: "milliseconds", parse: "float", into: "operands" },
		],
	},
	{
		name: "add-business-days",
		tool: "add_business_days",
		description: "Adds N business days to a start date, skipping weekends and holidays.",
		options: [
			{ flags: "--start-date <d>", description: "ISO date string for the start date", key: "start_date", required: true, include: "always" },
			{ flags: "--days <n>", description: "Number of business days to add", key: "days", required: true, parse: "float", include: "always" },
			{ flags: "--country <code>", description: "ISO-3166-1-alpha-2 country code", key: "country", defaultValue: "US", include: "always" },
		],
	},
	{
		name: "count-business-days",
		tool: "count_business_days",
		description: "Counts business days between two dates, skipping weekends and holidays.",
		options: [
			{ flags: "--start-date <d>", description: "ISO date string for the start date", key: "start_date", required: true, include: "always" },
			{ flags: "--end-date <d>", description: "ISO date string for the end date", key: "end_date", required: true, include: "always" },
			{ flags: "--country <code>", description: "ISO-3166-1-alpha-2 country code", key: "country", defaultValue: "US", include: "always" },
		],
	},
	{
		name: "pert-estimate",
		tool: "pert_estimate",
		description: "Computes a PERT three-point estimate with expected value, standard deviation, and confidence intervals.",
		options: [
			{ flags: "--optimistic <n>", description: "Best-case duration", key: "optimistic", required: true, parse: "float", include: "always" },
			{ flags: "--most-likely <n>", description: "Most probable duration", key: "most_likely", required: true, parse: "float", include: "always" },
			{ flags: "--pessimistic <n>", description: "Worst-case duration", key: "pessimistic", required: true, parse: "float", include: "always" },
			{ flags: "--unit <unit>", description: "Time unit (hours|days|weeks|months)", key: "unit", defaultValue: "hours", include: "always" },
		],
	},
	{
		name: "cocomo-estimate",
		tool: "cocomo_estimate",
		description: "Estimates effort using a COCOMO II model adjusted for LLM-assisted workflows.",
		options: [
			{ flags: "--kloc <n>", description: "Estimated thousands of lines of code", key: "kloc", required: true, parse: "float", include: "always" },
			{ flags: "--reasoning-complexity <n>", description: "Reasoning complexity multiplier (0.5-2.0)", key: "reasoning_complexity", parse: "float" },
			{ flags: "--context-completeness <n>", description: "Context completeness multiplier (0.5-2.0)", key: "context_completeness", parse: "float" },
			{ flags: "--transformation-impact <n>", description: "Transformation impact multiplier (0.5-2.0)", key: "transformation_impact", parse: "float" },
			{ flags: "--iterative-cycles <n>", description: "Iteration overhead multiplier (0.5-10.0)", key: "iterative_cycles", parse: "float" },
			{ flags: "--human-oversight <n>", description: "Human review overhead multiplier (0.5-2.0)", key: "human_oversight", parse: "float" },
		],
	},
	{
		name: "sprint-forecast",
		tool: "sprint_forecast",
		description: "Forecasts sprints needed to clear a backlog based on historical velocity.",
		options: [
			{ flags: "--backlog-points <n>", description: "Total backlog story points", key: "backlog_points", required: true, parse: "float", include: "always" },
			{ flags: "--velocity-history <csv>", description: "Comma-separated velocity values per sprint", key: "velocity_history", required: true, after: "csvNumbers", include: "always" },
			{ flags: "--sprint-length-days <n>", description: "Calendar days in one sprint", key: "sprint_length_days", parse: "float" },
			{ flags: "--hours-per-sprint <n>", description: "Productive engineering hours per sprint", key: "hours_per_sprint", parse: "float" },
		],
	},
	{
		name: "critical-path",
		tool: "critical_path",
		description: "Computes the critical path through a task graph with merge-bias adjustment.",
		options: [
			{ flags: "--tasks <json>", description: "Task array as JSON", key: "tasks", required: true, after: "json", include: "always" },
		],
	},
	{
		name: "monte-carlo-schedule",
		tool: "monte_carlo_schedule",
		description: "Runs a Monte Carlo simulation on a task list with three-point estimates.",
		options: [
			{ flags: "--tasks <json>", description: "Task array as JSON", key: "tasks", required: true, after: "json", include: "always" },
			{ flags: "--iterations <n>", description: "Number of simulation iterations", key: "iterations", parse: "float" },
		],
	},
	{
		name: "reference-class-estimate",
		tool: "reference_class_estimate",
		description: "Estimates effort using reference-class forecasting from historical data.",
		options: [
			{ flags: "--task-type <type>", description: "Category of work (feature|bugfix|refactor|migration|infrastructure|documentation|testing|design)", key: "task_type", required: true, include: "always" },
			{ flags: "--complexity <n>", description: "Complexity 1-5", key: "complexity", required: true, parse: "float", include: "always" },
			{ flags: "--scope <scope>", description: "Scope band (small|medium|large|xl)", key: "scope", include: "truthy" },
			{ flags: "--team-id <id>", description: "Team identifier for calibration lookup", key: "team_id", include: "truthy" },
			{ flags: "--ai-native <ratio>", description: "AI-native ratio 0.0-1.0 (default: 0.0)", key: "ai_native", parse: "float" },
		],
	},
	{
		name: "calibrate-estimates",
		tool: "calibrate_estimates",
		description: "Calibrates estimation accuracy using historical team data.",
		options: [
			{ flags: "--team-id <id>", description: "Team identifier", key: "team_id", required: true, include: "always" },
			{ flags: "--period-days <n>", description: "Lookback window in calendar days", key: "period_days", parse: "float" },
		],
	},
	{
		name: "wait-bound",
		tool: "wait_bound",
		description: "Derives a deadline from the mechanism a wait actually rides (three-clock law): fleet = k x cycle + PERT(turn) + 1 sd; world = external anchor required; ceo = the named ladder rung.",
		options: [
			{ flags: "--clock-class <class>", description: "Clock the wait rides: fleet | world | ceo", key: "clock_class", required: true, include: "always" },
			{ flags: "--cycle-seconds <n>", description: "Fleet: mechanism cycle seconds (default 40)", key: "cycle_seconds", parse: "float" },
			{ flags: "--cycles-k <n>", description: "Fleet: cycle multiplier 1..5 (default 2)", key: "cycles_k", parse: "float" },
			{ flags: "--turn-optimistic-minutes <n>", description: "Turn PERT optimistic minutes (default 15)", key: "turn_optimistic_minutes", parse: "float" },
			{ flags: "--turn-most-likely-minutes <n>", description: "Turn PERT most-likely minutes (default 45)", key: "turn_most_likely_minutes", parse: "float" },
			{ flags: "--turn-pessimistic-minutes <n>", description: "Turn PERT pessimistic minutes (default 120)", key: "turn_pessimistic_minutes", parse: "float" },
			{ flags: "--external-anchor <anchor>", description: "World (required): named external event", key: "external_anchor" },
			{ flags: "--ceo-rung <rung>", description: "CEO (required): pass | burst | sleep | cycle | season", key: "ceo_rung" },
			{ flags: "--from-timestamp <iso>", description: "ISO 8601 start instant (default now)", key: "from_timestamp" },
			{ flags: "--time-zone <tz>", description: "IANA timezone for rendered deadline (default America/Los_Angeles)", key: "time_zone" },
		],
	},
	{
		name: "token-time-bridge",
		tool: "token_time_bridge",
		description: "Estimates wall-clock time from token count and LLM model parameters.",
		options: [
			{ flags: "--tokens <n>", description: "Total number of tokens", key: "tokens", required: true, parse: "float", include: "always" },
			{ flags: "--model <model>", description: "LLM model identifier", key: "model", required: true, include: "always" },
			{ flags: "--tool-calls <n>", description: "Number of expected tool calls", key: "tool_calls", parse: "float" },
			{ flags: "--reasoning-depth <depth>", description: "Reasoning depth (shallow|moderate|deep)", key: "reasoning_depth" },
		],
	},
	{
		name: "token-cost-estimate",
		tool: "token_cost_estimate",
		description: "Estimates wall-clock time AND dollar cost from token count and LLM model.",
		options: [
			{ flags: "--tokens <n>", description: "Total number of tokens", key: "tokens", required: true, parse: "float", include: "always" },
			{ flags: "--model <model>", description: "LLM model identifier", key: "model", required: true, include: "always" },
			{ flags: "--tool-calls <n>", description: "Number of expected tool calls", key: "tool_calls", parse: "float" },
			{ flags: "--reasoning-depth <depth>", description: "Reasoning depth (shallow|moderate|deep)", key: "reasoning_depth" },
		],
	},
	{
		name: "compare-models",
		tool: "compare_models",
		description: "Compares all LLM models side-by-side for a given token budget.",
		options: [
			{ flags: "--tokens <n>", description: "Token count to estimate", key: "tokens", required: true, parse: "float", include: "always" },
			{ flags: "--tool-calls <n>", description: "Number of tool calls", key: "tool_calls", parse: "float" },
			{ flags: "--reasoning-depth <depth>", description: "Reasoning depth (shallow|moderate|deep)", key: "reasoning_depth" },
			{ flags: "--sort-by <field>", description: "Sort by cost or time", key: "sort_by", defaultValue: "cost", include: "always" },
		],
	},
	{
		name: "accuracy-trend",
		tool: "accuracy_trend",
		description: "Tracks estimation accuracy over time with sliding-window MAPE.",
		options: [
			{ flags: "--team-id <id>", description: "Team identifier", key: "team_id" },
			{ flags: "--window-size <n>", description: "Records per sliding window", key: "window_size", parse: "float" },
		],
	},
	{
		name: "schedule-risk",
		tool: "schedule_risk",
		description: "Assesses schedule risk using historical accuracy data.",
		options: [
			{ flags: "--estimated-hours <n>", description: "Estimated effort in hours", key: "estimated_hours", required: true, parse: "float", include: "always" },
			{ flags: "--task-type <type>", description: "Task type for accuracy lookup", key: "task_type" },
			{ flags: "--team-id <id>", description: "Team identifier", key: "team_id" },
		],
	},
	{
		name: "cocomo-validate",
		tool: "cocomo_validate",
		description: "Validates COCOMO estimation model against 195 real historical projects.",
		options: [
			{ flags: "--dataset-filter <datasets>", description: "Comma-separated dataset names", key: "dataset_filter", after: "csvStrings" },
		],
	},
	{
		name: "record-actual",
		tool: "record_actual",
		description: "Records actual hours for a previous estimate to improve future accuracy.",
		options: [
			{ flags: "--estimate-id <id>", description: "ID of the estimate to update", key: "estimate_id", required: true, include: "always" },
			{ flags: "--actual-hours <n>", description: "Actual hours spent", key: "actual_hours", required: true, parse: "float", include: "always" },
			{ flags: "--notes <text>", description: "Optional context about what affected the actual time", key: "notes" },
		],
	},
	{
		name: "get-pending-estimates",
		tool: "get_pending_estimates",
		description: "Lists recent estimates that have not yet received actual-hour feedback.",
		options: [
			{ flags: "--limit <n>", description: "Maximum estimates to return", key: "limit", defaultValue: 20, parse: "intLegacyRadix", include: "always" },
		],
	},
	{
		name: "batch-record-actuals",
		tool: "batch_record_actuals",
		description: "Record actual hours for multiple estimates at once.",
		options: [
			{ flags: "--entries <json>", description: "JSON array of {estimate_id, actual_hours, notes?} objects", key: "entries", required: true, after: "json", include: "always" },
		],
	},
	{
		name: "feedback-health",
		tool: "feedback_health",
		description: "Health report on the estimation feedback loop.",
		options: [
		],
	},
	{
		name: "cocomo-ground-truth",
		tool: "cocomo_ground_truth",
		description: "Validate COCOMO models against real historical projects with known effort.",
		options: [
			{ flags: "--dataset-filter <names>", description: "Comma-separated dataset names to include", key: "dataset_filter", after: "csvStrings" },
		],
	},
	{
		name: "estimate-from-context",
		tool: "estimate_from_context",
		description: "Classify a free-text task description and delegate to the estimation engine (registered stub \u2014 not yet implemented).",
		options: [
			{ flags: "--context <text>", description: "Free-text task description (issue body, diff, or PR description)", key: "context", required: true, include: "always" },
			{ flags: "--task-type <type>", description: "Optional pre-classified task type hint", key: "task_type" },
			{ flags: "--complexity <n>", description: "Optional pre-assessed complexity hint (1-5)", key: "complexity", parse: "float" },
			{ flags: "--team-id <id>", description: "Optional team identifier", key: "team_id" },
		],
	},
];
