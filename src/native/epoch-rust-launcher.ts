import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type OutputFormat = "json" | "table";
type Mode = "mcp" | "http" | "rust-cli" | "typescript";
type JsonObject = Record<string, unknown>;
type OptionType = "string" | "number" | "json" | "csvNumbers" | "csvStrings";

export type LauncherPlan = {
	mode: Mode;
	commandPath?: string;
	toolName?: string;
	input?: JsonObject;
	root: RootOptions;
	httpEnv?: Record<string, string>;
	wrapRustOutput?: boolean;
	rawRustOutputIndent?: number | null;
};

type RootOptions = {
	format: OutputFormat;
	quiet: boolean;
	args: string[];
};

type OptionSpec = {
	flag: string;
	key: string;
	type: OptionType;
	required?: boolean;
	defaultValue?: unknown;
};

export type CommandSpec = {
	path: string;
	toolName: string;
	options: OptionSpec[];
	build?: (values: JsonObject) => JsonObject;
	wrapOutput?: boolean;
	rawOutputIndent?: number | null;
};

const RUST_CLI_COMMANDS: CommandSpec[] = [
	command("get-current-time", "get_current_time", [
		option("--timezone", "timezone", "string", { defaultValue: "UTC" }),
	]),
	command("convert-timezone", "convert_timezone", [
		option("--timestamp", "timestamp", "string", { required: true }),
		option("--target-tz", "target_tz", "string", { required: true }),
	]),
	command("parse-duration", "parse_duration", [
		option("--duration", "duration_string", "string", { required: true }),
	]),
	{
		...command("time-math", "time_math", [
			option("--operation", "operation", "string", { required: true }),
			option("--date", "date", "string"),
			option("--days", "days", "number"),
			option("--start-date", "start_date", "string"),
			option("--country", "country", "string"),
			option("--end-date", "end_date", "string"),
			option("--timestamp", "timestamp", "string"),
			option("--target-tz", "target_tz", "string"),
			option("--duration-string", "duration_string", "string"),
			option("--milliseconds", "milliseconds", "number"),
		]),
		build: ({ operation, ...operands }) => ({
			operation,
			operands: compactObject(operands),
		}),
	},
	command("add-business-days", "add_business_days", [
		option("--start-date", "start_date", "string", { required: true }),
		option("--days", "days", "number", { required: true }),
		option("--country", "country", "string", { defaultValue: "US" }),
	]),
	command("count-business-days", "count_business_days", [
		option("--start-date", "start_date", "string", { required: true }),
		option("--end-date", "end_date", "string", { required: true }),
		option("--country", "country", "string", { defaultValue: "US" }),
	]),
	command("pert-estimate", "pert_estimate", [
		option("--optimistic", "optimistic", "number", { required: true }),
		option("--most-likely", "most_likely", "number", { required: true }),
		option("--pessimistic", "pessimistic", "number", { required: true }),
		option("--unit", "unit", "string", { defaultValue: "hours" }),
	]),
	command("cocomo-estimate", "cocomo_estimate", [
		option("--kloc", "kloc", "number", { required: true }),
		option("--reasoning-complexity", "reasoning_complexity", "number"),
		option("--context-completeness", "context_completeness", "number"),
		option("--transformation-impact", "transformation_impact", "number"),
		option("--iterative-cycles", "iterative_cycles", "number"),
		option("--human-oversight", "human_oversight", "number"),
	]),
	command("sprint-forecast", "sprint_forecast", [
		option("--backlog-points", "backlog_points", "number", { required: true }),
		option("--velocity-history", "velocity_history", "csvNumbers", {
			required: true,
		}),
		option("--sprint-length-days", "sprint_length_days", "number"),
		option("--hours-per-sprint", "hours_per_sprint", "number"),
	]),
	command("critical-path", "critical_path", [
		option("--tasks", "tasks", "json", { required: true }),
	]),
	command("monte-carlo-schedule", "monte_carlo_schedule", [
		option("--tasks", "tasks", "json", { required: true }),
		option("--iterations", "iterations", "number"),
	]),
	command("reference-class-estimate", "reference_class_estimate", [
		option("--task-type", "task_type", "string", { required: true }),
		option("--complexity", "complexity", "number", { required: true }),
		option("--scope", "scope", "string"),
		option("--team-id", "team_id", "string"),
		option("--ai-native", "ai_native", "number"),
	]),
	command("calibrate-estimates", "calibrate_estimates", [
		option("--team-id", "team_id", "string", { required: true }),
		option("--period-days", "period_days", "number"),
	]),
	command("token-time-bridge", "token_time_bridge", [
		option("--tokens", "tokens", "number", { required: true }),
		option("--model", "model", "string", { required: true }),
		option("--tool-calls", "tool_calls", "number"),
		option("--reasoning-depth", "reasoning_depth", "string"),
	]),
	command("token-cost-estimate", "token_cost_estimate", [
		option("--tokens", "tokens", "number", { required: true }),
		option("--model", "model", "string", { required: true }),
		option("--tool-calls", "tool_calls", "number"),
		option("--reasoning-depth", "reasoning_depth", "string"),
	]),
	command("compare-models", "compare_models", [
		option("--tokens", "tokens", "number", { required: true }),
		option("--tool-calls", "tool_calls", "number"),
		option("--reasoning-depth", "reasoning_depth", "string"),
		option("--sort-by", "sort_by", "string", { defaultValue: "cost" }),
	]),
	command("accuracy-trend", "accuracy_trend", [
		option("--team-id", "team_id", "string"),
		option("--window-size", "window_size", "number"),
	]),
	command("schedule-risk", "schedule_risk", [
		option("--estimated-hours", "estimated_hours", "number", {
			required: true,
		}),
		option("--task-type", "task_type", "string"),
		option("--team-id", "team_id", "string"),
	]),
	command("cocomo-validate", "cocomo_validate", [
		option("--dataset-filter", "dataset_filter", "csvStrings"),
	]),
	command("cocomo-ground-truth", "cocomo_ground_truth", [
		option("--dataset-filter", "dataset_filter", "csvStrings"),
	]),
	command("record-actual", "record_actual", [
		option("--estimate-id", "estimate_id", "string", { required: true }),
		option("--actual-hours", "actual_hours", "number", { required: true }),
		option("--notes", "notes", "string"),
	]),
	command("get-pending-estimates", "get_pending_estimates", [
		option("--limit", "limit", "number", { defaultValue: 20 }),
	]),
	command("batch-record-actuals", "batch_record_actuals", [
		option("--entries", "entries", "json", { required: true }),
	]),
	command("feedback-health", "feedback_health", []),
	command("list-tools", "list_tools", [], { wrapOutput: false }),
	command("data where", "data_where", [], { wrapOutput: false }),
	command("data status", "data_status", [], { wrapOutput: false }),
	command("telemetry status", "telemetry_status", [], { wrapOutput: false }),
	command("telemetry preview", "telemetry_preview", [], { wrapOutput: false }),
	command("telemetry set-endpoint", "telemetry_set_endpoint", [
		option("--endpoint", "endpoint", "string", { required: true }),
	], { wrapOutput: false, rawOutputIndent: null }),
	command("telemetry disable", "telemetry_disable", [], {
		wrapOutput: false,
		rawOutputIndent: null,
	}),
];

const CLI_COMMANDS_BY_LENGTH = [...RUST_CLI_COMMANDS].sort(
	(left, right) => right.path.split(" ").length - left.path.split(" ").length,
);

function command(
	path: string,
	toolName: string,
	options: OptionSpec[],
	extra: Pick<CommandSpec, "wrapOutput" | "rawOutputIndent"> = {},
): CommandSpec {
	return { path, toolName, options, ...extra };
}

function option(
	flag: string,
	key: string,
	type: OptionType,
	extra: Omit<OptionSpec, "flag" | "key" | "type"> = {},
): OptionSpec {
	return { flag, key, type, ...extra };
}

export function packageRootFromEntrypoint(entrypointUrl = import.meta.url): string {
	const entrypoint = fileURLToPath(entrypointUrl);
	const dir = dirname(entrypoint);
	if (dir.endsWith(`${join("dist", "native")}`)) {
		return resolve(dir, "..", "..");
	}
	return resolve(dir, "..", "..");
}

export function planInvocation(
	argv: string[],
	env: NodeJS.ProcessEnv = process.env,
): LauncherPlan {
	const root = parseRootOptions(argv);
	const args = root.args;
	if (env["EPOCH_TRANSPORT"] === "http" || args[0] === "serve" || args[0] === "--http") {
		return { mode: "http", root, httpEnv: httpEnv(args) };
	}
	if (args.length === 0) {
		return { mode: "mcp", root };
	}

	const commandMatch = findRustCliCommand(args);
	const commandPath = commandMatch?.spec.path ?? args[0] ?? "";
	const spec = commandMatch?.spec;
	if (!spec || args.includes("--help") || args.includes("-h")) {
		return { mode: "typescript", root };
	}

	const input = parseToolInput(spec, args.slice(commandMatch.consumed));
	return {
		mode: "rust-cli",
		commandPath,
		toolName: spec.toolName,
		input,
		root,
		wrapRustOutput: spec.wrapOutput ?? true,
		rawRustOutputIndent: spec.rawOutputIndent,
	};
}

function findRustCliCommand(
	args: string[],
): { spec: CommandSpec; consumed: number } | null {
	for (const spec of CLI_COMMANDS_BY_LENGTH) {
		const parts = spec.path.split(" ");
		if (parts.every((part, index) => args[index] === part)) {
			return { spec, consumed: parts.length };
		}
	}
	return null;
}

function parseRootOptions(argv: string[]): RootOptions {
	const args = [...argv];
	let format: OutputFormat = "json";
	let quiet = false;
	while (args.length > 0) {
		const first = args[0];
		if (first === "--pretty") {
			args.shift();
			format = "table";
			continue;
		}
		if (first === "--quiet") {
			args.shift();
			quiet = true;
			continue;
		}
		if (first === "--format") {
			args.shift();
			const value = args.shift();
			format = parseOutputFormat(value);
			continue;
		}
		if (first?.startsWith("--format=")) {
			args.shift();
			format = parseOutputFormat(first.slice("--format=".length));
			continue;
		}
		break;
	}
	return { format, quiet, args };
}

function parseOutputFormat(value: string | undefined): OutputFormat {
	if (value === "json" || value === "table") return value;
	throw new Error(`--format must be one of json, table`);
}

function httpEnv(args: string[]): Record<string, string> {
	const out: Record<string, string> = {};
	const portIndex = args.indexOf("--port");
	if (portIndex >= 0) {
		const port = args[portIndex + 1];
		if (port) out["EPOCH_PORT"] = port;
	}
	return out;
}

export function parseToolInput(spec: CommandSpec, args: string[]): JsonObject {
	const defs = new Map(spec.options.map((def) => [def.flag, def]));
	const values: JsonObject = {};
	for (const def of spec.options) {
		if (def.defaultValue !== undefined) values[def.key] = def.defaultValue;
	}

	for (let index = 0; index < args.length; index += 1) {
		const token = args[index];
		if (!token?.startsWith("--")) {
			throw new Error(`Unexpected argument "${token ?? ""}" for ${spec.path}`);
		}
		const [flag, inlineValue] = token.split("=", 2) as [string, string?];
		const def = defs.get(flag);
		if (!def) throw new Error(`Unknown option ${flag} for ${spec.path}`);
		const rawValue = inlineValue ?? args[index + 1];
		if (rawValue === undefined || rawValue.startsWith("--")) {
			throw new Error(`${flag} requires a value`);
		}
		if (inlineValue === undefined) index += 1;
		values[def.key] = parseOptionValue(def, rawValue);
	}

	for (const def of spec.options) {
		if (def.required && values[def.key] === undefined) {
			throw new Error(`${def.flag} is required`);
		}
	}

	const compact = compactObject(values);
	return spec.build ? spec.build(compact) : compact;
}

function parseOptionValue(def: OptionSpec, raw: string): unknown {
	switch (def.type) {
		case "string":
			return raw;
		case "number": {
			const value = Number.parseFloat(raw);
			if (!Number.isFinite(value)) {
				throw new Error(`${def.flag} must be a number, got "${raw}"`);
			}
			return value;
		}
		case "json":
			try {
				return JSON.parse(raw) as unknown;
			} catch (error) {
				const message = error instanceof Error ? error.message : "Invalid JSON";
				throw new Error(`${def.flag} must be valid JSON: ${message}`, {
					cause: error,
				});
			}
		case "csvNumbers":
			return raw.split(",").map((part) => {
				const trimmed = part.trim();
				const value = Number.parseFloat(trimmed);
				if (!Number.isFinite(value)) {
					throw new Error(`${def.flag} contains non-numeric value "${trimmed}"`);
				}
				return value;
			});
		case "csvStrings":
			return raw.split(",").map((part) => part.trim());
	}
}

function compactObject(input: JsonObject): JsonObject {
	return Object.fromEntries(
		Object.entries(input).filter(([, value]) => value !== undefined),
	);
}

export function resolveRustBinary(
	packageRoot: string,
	name: "epoch-cli" | "epoch-mcp" | "epoch-http",
	env: NodeJS.ProcessEnv = process.env,
): string | null {
	const suffix = process.platform === "win32" ? ".exe" : "";
	const candidates = [];
	const explicitDir = env["EPOCH_RUST_BIN_DIR"];
	if (explicitDir) candidates.push(join(explicitDir, `${name}${suffix}`));
	candidates.push(join(packageRoot, "rust", "target", "release", `${name}${suffix}`));
	candidates.push(join(packageRoot, "prebuilds", platformTag(), `${name}${suffix}`));
	return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function platformTag(): string {
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `${process.platform}-${arch}`;
}

export function runPlannedInvocation(
	plan: LauncherPlan,
	packageRoot = packageRootFromEntrypoint(),
	env: NodeJS.ProcessEnv = process.env,
): number {
	if (plan.mode === "typescript") {
		return runTypeScriptEntrypoint(packageRoot, plan.root.args, env);
	}

	const binaryName =
		plan.mode === "http"
			? "epoch-http"
			: plan.mode === "mcp"
				? "epoch-mcp"
				: "epoch-cli";
	const binary = resolveRustBinary(packageRoot, binaryName, env);
	if (!binary) {
		return runTypeScriptEntrypoint(packageRoot, plan.root.args, env);
	}

	if (plan.mode === "rust-cli") {
		return runRustCli(binary, plan, env);
	}

	const child = spawnSync(binary, {
		stdio: "inherit",
		env: { ...process.env, ...env, ...(plan.httpEnv ?? {}) },
	});
	return child.status ?? 1;
}

function runRustCli(
	binary: string,
	plan: LauncherPlan,
	env: NodeJS.ProcessEnv,
): number {
	const commandPath = plan.commandPath;
	const toolName = plan.toolName;
	const input = plan.input;
	if (!commandPath || !toolName || !input) return 1;
	const child = spawnSync(binary, [commandPath, JSON.stringify(input)], {
		encoding: "utf8",
		env: { ...process.env, ...env },
	});

	if (child.status === 0) {
		const data = parseJson(child.stdout);
		if (plan.wrapRustOutput === false) {
			const rawOutput = normalizeRawRustOutput(commandPath, data);
			const indent = plan.rawRustOutputIndent === null
				? undefined
				: (plan.rawRustOutputIndent ?? 2);
			process.stdout.write(`${JSON.stringify(rawOutput, null, indent)}\n`);
			return 0;
		}
		const result = { ok: true as const, data };
		if (plan.root.format === "table") {
			if (!plan.root.quiet) process.stdout.write(formatTable(result, toolName));
			return 0;
		}
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		return 0;
	}

	const parsed = parseJson(child.stderr);
	const error = isObject(parsed) && "error" in parsed ? parsed["error"] : {
		isError: true,
		message: child.stderr.trim() || `Rust command failed: ${commandPath}`,
	};
	const result = { ok: false, error };
	process.stderr.write(`${JSON.stringify(result, null, 2)}\n`);
	return child.status ?? 2;
}

function runTypeScriptEntrypoint(
	packageRoot: string,
	args: string[],
	env: NodeJS.ProcessEnv,
): number {
	const entrypoint = join(packageRoot, "dist", "index.js");
	const child = spawnSync(process.execPath, [entrypoint, ...args], {
		stdio: "inherit",
		env: { ...process.env, ...env },
	});
	return child.status ?? 1;
}

function parseJson(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw.trim();
	}
}

function normalizeRawRustOutput(commandPath: string, data: unknown): unknown {
	if (commandPath === "list-tools" && Array.isArray(data)) {
		return data.map((tool) => {
			if (!isObject(tool)) return tool;
			return {
				name: tool["name"],
				description: tool["description"],
			};
		});
	}
	if (commandPath === "data where" && isObject(data)) {
		return {
			dataDir: data["dataDir"],
			config: data["config"],
			estimates: data["estimates"],
			actuals: data["actuals"],
			toolTelemetry: data["toolTelemetry"],
			referenceDatabase: data["referenceDatabase"],
			exportsDir: data["exportsDir"],
			receiverRecords: data["receiverRecords"],
			receiverReceipts: data["receiverReceipts"],
			receiverDedupeKeys: data["receiverDedupeKeys"],
		};
	}
	if (commandPath === "data status" && isObject(data)) {
		return {
			dataDir: data["dataDir"],
			exists: data["exists"],
			machine: normalizeMachine(data["machine"]),
			files: normalizeFiles(data["files"]),
			feedback: normalizeFeedback(data["feedback"]),
			telemetry: normalizeTelemetry(data["telemetry"]),
			referenceDatabase: normalizeReferenceDatabase(data["referenceDatabase"]),
			roleHints: normalizeRoleHints(data["roleHints"]),
		};
	}
	if (commandPath === "telemetry status" && isObject(data)) {
		return normalizeTelemetryStatus(data);
	}
	if (commandPath === "telemetry preview" && isObject(data)) {
		return normalizeTelemetryPreview(data);
	}
	if (commandPath === "telemetry set-endpoint" && isObject(data)) {
		return {
			ok: data["ok"],
			endpoint: data["endpoint"],
		};
	}
	if (commandPath === "telemetry disable" && isObject(data)) {
		return {
			ok: data["ok"],
			message: data["message"],
		};
	}
	return data;
}

function normalizeMachine(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		hostname: value["hostname"],
		platform: value["platform"],
		arch: value["arch"],
	};
}

function normalizeFiles(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		estimates: normalizeFileStatus(value["estimates"]),
		actuals: normalizeFileStatus(value["actuals"]),
		toolTelemetry: normalizeFileStatus(value["toolTelemetry"]),
		receiverRecords: normalizeFileStatus(value["receiverRecords"]),
		receiverReceipts: normalizeFileStatus(value["receiverReceipts"]),
	};
}

function normalizeFileStatus(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		path: value["path"],
		exists: value["exists"],
		lines: value["lines"],
	};
}

function normalizeFeedback(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		totalEstimates: value["totalEstimates"],
		totalActuals: value["totalActuals"],
		matchedPairs: value["matchedPairs"],
		matchRate: value["matchRate"],
	};
}

function normalizeTelemetry(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		enabled: value["enabled"],
		endpointConfigured: value["endpointConfigured"],
		queuedRecords: value["queuedRecords"],
		lastSubmissionAt: value["lastSubmissionAt"],
		totalRecordsAccepted: value["totalRecordsAccepted"],
		totalRecordsDeduplicated: value["totalRecordsDeduplicated"],
	};
}

function normalizeTelemetryStatus(value: Record<string, unknown>): unknown {
	return {
		enabled: value["enabled"],
		source: value["source"],
		endpoint: value["endpoint"],
		endpointSource: value["endpointSource"],
		endpointConfigured: value["endpointConfigured"],
		queuedRecords: value["queuedRecords"],
		lastSubmissionAt: value["lastSubmissionAt"],
		totalRecordsSubmitted: value["totalRecordsSubmitted"],
		lastSubmissionAcceptedCount: value["lastSubmissionAcceptedCount"],
		lastSubmissionDeduplicatedCount: value["lastSubmissionDeduplicatedCount"],
		totalRecordsAccepted: value["totalRecordsAccepted"],
		totalRecordsDeduplicated: value["totalRecordsDeduplicated"],
		installationId: value["installationId"],
	};
}

function normalizeTelemetryPreview(value: Record<string, unknown>): unknown {
	const sample = Array.isArray(value["sample"])
		? value["sample"].map((record) => normalizeAnonymizedTelemetryRecord(record))
		: value["sample"];
	return {
		totalRecords: value["totalRecords"],
		fields: value["fields"],
		strippedFields: value["strippedFields"],
		sample,
	};
}

function normalizeAnonymizedTelemetryRecord(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		task_type: value["task_type"],
		complexity: value["complexity"],
		tool: value["tool"],
		estimated_hours: value["estimated_hours"],
		actual_hours: value["actual_hours"],
		ratio: value["ratio"],
		date: value["date"],
		completed_at: value["completed_at"],
	};
}

function normalizeReferenceDatabase(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		loaded: value["loaded"],
		path: value["path"],
		source: value["source"],
		sampleSize: value["sampleSize"],
		generatedAt: value["generatedAt"],
	};
}

function normalizeRoleHints(value: unknown): unknown {
	if (!isObject(value)) return value;
	return {
		hasReceiverRecords: value["hasReceiverRecords"],
		likelyReceiver: value["likelyReceiver"],
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatTable(
	result: { ok: true; data: unknown } | { ok: false; error: unknown },
	toolName: string,
): string {
	if (!result.ok) return `Error (${toolName}): ${String(result.error)}\n`;
	const lines = [`=== ${toolName} ===`];
	formatValue(lines, result.data, 0);
	return `${lines.join("\n")}\n`;
}

function formatValue(lines: string[], value: unknown, depth: number): void {
	const indent = "  ".repeat(depth);
	if (value === null || value === undefined) {
		lines.push(`${indent}(empty)`);
		return;
	}
	if (Array.isArray(value)) {
		lines.push(`${indent}[${value.length} items]`);
		for (const item of value.slice(0, 3)) formatValue(lines, item, depth + 1);
		if (value.length > 3) lines.push(`${indent}  ... and ${value.length - 3} more`);
		return;
	}
	if (typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>);
		if (entries.length === 0) {
			lines.push(`${indent}(empty object)`);
			return;
		}
		const maxKeyLen = Math.max(...entries.map(([key]) => key.length));
		for (const [key, item] of entries) {
			if (item !== null && typeof item === "object" && !Array.isArray(item)) {
				lines.push(`${indent}${key}:`);
				formatValue(lines, item, depth + 1);
			} else if (Array.isArray(item)) {
				lines.push(`${indent}${key}: [${item.length} items]`);
				for (const child of item.slice(0, 3)) formatValue(lines, child, depth + 1);
				if (item.length > 3) {
					lines.push(`${indent}  ... and ${item.length - 3} more`);
				}
			} else {
				lines.push(`${indent}${key.padEnd(maxKeyLen)}  ${String(item)}`);
			}
		}
		return;
	}
	lines.push(`${indent}${String(value)}`);
}

function isEntrypoint(): boolean {
	const entrypoint = process.argv[1];
	if (!entrypoint) return false;
	return import.meta.url === pathToFileURL(resolve(entrypoint)).href;
}

function main(): void {
	const packageRoot = packageRootFromEntrypoint();
	try {
		const plan = planInvocation(process.argv.slice(2));
		process.exit(runPlannedInvocation(plan, packageRoot));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`${message}\n`);
		process.exit(1);
	}
}

if (isEntrypoint()) {
	main();
}
