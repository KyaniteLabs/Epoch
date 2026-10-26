// ---------------------------------------------------------------------------
// Epoch CLI Entry Point — Commander.js-based terminal interface
// Routes CLI subcommands to the dispatcher layer.
// ---------------------------------------------------------------------------

import { Command, Option } from "commander";
import { dispatch } from "../dispatcher/index.js";
import { formatJson, formatTable } from "../dispatcher/formatters.js";
import type { ToolResult } from "../types/index.js";
import { getVersion } from "../version.js";
import { setTransport } from "../lib/telemetry-context.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { TOOL_COMMANDS, type ToolCommandSpec, type ToolOptionSpec } from "./cli-tool-commands.js";

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

/**
 * Parse a --port value for `epoch serve`: an integer in the legal TCP range
 * (1-65535). Non-numeric, fractional, or out-of-range values exit 1 with a
 * clear message instead of crashing later inside the server's bind call.
 */
function parsePortArg(value: string): number {
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1 || n > 65535) {
		process.stderr.write(
			`Error: --port must be an integer between 1 and 65535, got "${value}"\n`,
		);
		process.exit(1);
	}
	return n;
}

/**
 * Parse --window-start/--window-end for `epoch auto-actuals`: epoch
 * milliseconds or an ISO timestamp. Both flags are optional but must be
 * given together; the window only powers the unstamped-estimate fallback
 * selection and never relaxes the sanity gates.
 */
function parseAutoActualsWindow(
	start: string | undefined,
	end: string | undefined,
): { startMs: number; endMs: number } | undefined {
	if (start === undefined && end === undefined) return undefined;
	if (start === undefined || end === undefined) {
		process.stderr.write(
			"Error: --window-start and --window-end must be given together\n",
		);
		process.exit(1);
	}
	const toMs = (raw: string, flagName: string): number => {
		const ms = /^\d+$/.test(raw) ? Number(raw) : Date.parse(raw);
		if (!Number.isFinite(ms)) {
			process.stderr.write(
				`Error: --${flagName} must be epoch milliseconds or an ISO timestamp, got "${raw}"\n`,
			);
			process.exit(1);
		}
		return ms;
	};
	const startMs = toMs(start, "window-start");
	const endMs = toMs(end, "window-end");
	if (endMs < startMs) {
		process.stderr.write(
			"Error: --window-end must not be earlier than --window-start\n",
		);
		process.exit(1);
	}
	return { startMs, endMs };
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
	return emitAndExit(result, toolName, format, quiet);
}

/**
 * Emit a ToolResult under the standard CLI result contract and exit:
 * failures go to stderr (exit 2 for tool errors, 1 otherwise); success writes
 * exactly ONE output document to stdout (JSON or table), with --quiet
 * suppressing only the human-oriented table form. No JSON+summary
 * double-writes.
 */
function emitAndExit(
	result: ToolResult<unknown>,
	toolName: string,
	format: "json" | "table",
	quiet: boolean,
): never {
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

/** Long flag without dashes, as used in CLI error messages ("--most-likely" -> "most-likely"). */
function flagLabel(option: ToolOptionSpec): string {
	const longFlag = option.flags.split(" ")[0] ?? option.flags;
	return longFlag.slice(2);
}

/** Apply an option's post-parse conversion; bad values exit 1 with a message. */
function convertOptionValue(raw: string, option: ToolOptionSpec): unknown {
	const label = flagLabel(option);
	switch (option.after) {
		case "json":
			return parseJsonArg(raw, label);
		case "csvStrings":
			return raw.split(",").map((s) => s.trim());
		case "csvNumbers":
			return raw.split(",").map((s) => {
				const n = Number.parseFloat(s.trim());
				if (Number.isNaN(n)) {
					process.stderr.write(`Error: --${label} contains non-numeric value "${s.trim()}"\n`);
					process.exit(1);
				}
				return n;
			});
		default:
			return raw;
	}
}

/**
 * Register one data-described tool command: build its options from the spec,
 * map parsed option values onto the tool input, and dispatch.
 */
function registerToolCommand(program: Command, spec: ToolCommandSpec): void {
	const command = program.command(spec.name).description(spec.description);
	for (const option of spec.options) {
		const commanderOption = new Option(option.flags, option.description);
		if (option.parse === "float") commanderOption.argParser(safeFloat(flagLabel(option)));
		// Commander calls parsers as fn(value, previous), so a bare parseInt
		// receives the default as its radix. Kept as-is here; see the CHANGELOG.
		if (option.parse === "intLegacyRadix") commanderOption.argParser(parseInt);
		if (option.defaultValue !== undefined) commanderOption.default(option.defaultValue);
		if (option.required) commanderOption.makeOptionMandatory();
		command.addOption(commanderOption);
	}
	command.action(async (opts: Record<string, unknown>, cmd: Command) => {
		const rootOpts = getRootOpts(cmd);
		const input: Record<string, unknown> = {};
		for (const option of spec.options) {
			if (option.into !== undefined) input[option.into] ??= {};
		}
		for (const option of spec.options) {
			const raw = opts[new Option(option.flags).attributeName()];
			if (raw === undefined) continue;
			if (option.include === "truthy" && !raw) continue;
			const value = option.after ? convertOptionValue(raw as string, option) : raw;
			const target = option.into !== undefined ? (input[option.into] as Record<string, unknown>) : input;
			target[option.key] = value;
		}
		await runAndExit(spec.tool, input, resolveFormat(rootOpts), isQuiet(rootOpts));
	});
}

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

	// The 26 dispatcher tool commands are data (cli-tool-commands.ts).
	for (const spec of TOOL_COMMANDS) registerToolCommand(program, spec);

	program
		.command("auto-actuals")
		.description(
			"Auto-record wall-clock-derived actuals (provenance: auto_wallclock) for a session's pending estimates.",
		)
		.requiredOption("--session <id>", "Session identifier to match pending estimates against")
		.option("--dry-run", "Preview what would be recorded without writing", false)
		.option(
			"--window-start <ts>",
			"Fallback window start (epoch ms or ISO): when the session_id join is empty, select pending estimates with no session_id whose estimatedAt falls in the window",
		)
		.option(
			"--window-end <ts>",
			"Fallback window end (epoch ms or ISO); must be given together with --window-start",
		)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			const window = parseAutoActualsWindow(opts.windowStart, opts.windowEnd);
			const { runAutoActuals } = await import("../lib/auto-actuals.js");
			const result = runAutoActuals(opts.session, opts.dryRun === true, new Date(), window);

			// Standard CLI result contract (ticket 10): one output document,
			// --format/--quiet honored, and a non-zero exit when any entry was
			// skipped with a write failure — automation must never record
			// silent success over lost writes. The summary stays a field of the
			// single JSON document instead of a second stdout write.
			const writeFailed = result.skipped.filter((s) => s.reason === "write_failed");
			const toolResult: ToolResult<unknown> = writeFailed.length > 0
				? {
						ok: false,
						error: {
							isError: true,
							message:
								`auto-actuals: ${writeFailed.length} of ${result.candidates} candidate estimate(s) could not be recorded (write failed): ` +
								`${writeFailed.map((s) => s.estimateId).join(", ")}. ` +
								`${result.recorded.length} actual(s) were recorded before the failure.`,
							retryHint:
								"Re-run 'epoch auto-actuals --session <id>' (already-recorded estimates are skipped as duplicates). If failures persist, check that the Epoch data directory's feedback.jsonl is writable.",
						},
					}
				: { ok: true, data: result };

			emitAndExit(toolResult, "auto-actuals", format, quiet);
		});

	program
		.command("mine-git")
		.description(
			"Mine local git history and auto-record cycle-time actuals (provenance: git_derived / git_derived_review_inclusive) for pending estimates matched via task_label/branch/issue_ref. On an empty ledger, bootstraps a reference-class cold-start corpus instead (baseline-estimate vs cycle-time pairs). Offline and read-only by construction.",
		)
		.requiredOption("--repo <path>", "Path to a local git repository to mine (never cloned or fetched)")
		.requiredOption("--since <date>", "Only mine work merged on/after this date (ISO or YYYY-MM-DD)")
		.option("--dry-run", "Preview matches and windows without writing actuals", false)
		.option(
			"--window <window>",
			"Which cycle-time window becomes the recorded actual: 'dev' (first-commit to merge, provenance git_derived) or 'review-inclusive' (open to merge, provenance git_derived_review_inclusive). Both are always reported separately, never blended",
			"dev",
		)
		.action(async (opts, cmd) => {
			const rootOpts = getRootOpts(cmd);
			const format = resolveFormat(rootOpts);
			const quiet = isQuiet(rootOpts);
			if (opts.window !== "dev" && opts.window !== "review-inclusive") {
				program.error(`error: --window must be 'dev' or 'review-inclusive', got '${opts.window}'`);
			}
			const { runMineGit, MineGitError } = await import("../lib/mine-git.js");
			let result;
			try {
				result = runMineGit({
					repo: opts.repo,
					since: opts.since,
					dryRun: opts.dryRun === true,
					window: opts.window as "dev" | "review-inclusive",
				});
			} catch (err) {
				if (err instanceof MineGitError) {
					program.error(`error: ${err.message}`);
				}
				throw err;
			}

			// Standard CLI result contract (ticket 10): one output document,
			// --format/--quiet honored, non-zero exit on write failures —
			// automation must never record silent success over lost writes.
			// Bootstrap write/mint failures count the same way (S1.2): a lost
			// baseline pair is a lost ledger write, not a soft skip.
			const writeFailed = result.skipped.filter((s) => s.reason === "write_failed");
			const bootstrapWriteFailures =
				(result.bootstrap.skippedByReason["write_failed"] ?? 0) + (result.bootstrap.skippedByReason["mint_failed"] ?? 0);
			const toolResult: ToolResult<unknown> = writeFailed.length > 0 || bootstrapWriteFailures > 0
				? {
						ok: false,
						error: {
							isError: true,
							message:
								`mine-git: ${writeFailed.length} matched estimate(s) could not be recorded (write failed): ` +
								`${writeFailed.map((s) => s.estimateId).join(", ")}. ` +
								`${result.estimates.recorded} actual(s) were recorded before the failure.` +
								(bootstrapWriteFailures > 0
									? ` Bootstrap mode additionally failed to persist ${bootstrapWriteFailures} reference-class baseline pair(s) (write/mint failure).`
									: ""),
							retryHint:
								"Re-run 'epoch mine-git --repo <path> --since <date>' (already-recorded estimates are skipped as duplicates). Note: bootstrap engages only on an empty ledger, so a partially-bootstrapped run will not re-mint its missed units. If failures persist, check that the Epoch data directory's estimates.jsonl and feedback.jsonl are writable.",
						},
					}
				: { ok: true, data: result };

			emitAndExit(toolResult, "mine-git", format, quiet);
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
		.description(
			"Print the exact payload that 'epoch telemetry submit' would send next (or 'nothing to send')",
		)
		.action(async () => {
			const { loadConfig } = await import("../lib/config.js");
			const { extractAnonymizedRecords, buildPayload } = await import(
				"../lib/telemetry-submit.js"
			);
			const config = loadConfig();
			const records = extractAnonymizedRecords(
				config.telemetry.lastSubmissionAt ?? undefined,
			);
			if (records.length === 0) {
				process.stdout.write(
					JSON.stringify({ message: "nothing to send" }, null, 2) + "\n",
				);
				process.exit(0);
			}
			// Mirror submitTelemetry(): the first HTTPS request sends at most 100
			// records; remaining records queue for the next submission/chunk.
			const payload = buildPayload(records.slice(0, 100));
			process.stdout.write(JSON.stringify(payload, null, 2) + "\n");
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
				// Loud failure for non-interactive callers (ticket 10): without
				// this guard, a piped/EOF'd stdin resolves the prompt with ""
				// and the command "Cancelled."s its way to a silent exit 0 —
				// automation records success while nothing was enabled.
				if (!process.stdin.isTTY) {
					process.stderr.write(
						"Error: 'epoch telemetry enable' needs an interactive terminal to show the consent prompt.\n" +
						"Re-run with --yes to opt in non-interactively (e.g. 'epoch telemetry enable --yes'), or run it in a TTY.\n",
					);
					process.exit(1);
				}

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
					process.stderr.write("Cancelled — telemetry was NOT enabled.\n");
					process.exit(1);
				}
			}

			const config = loadConfig();
			config.telemetry.enabled = true;
			config.telemetry.nudgeShown = true;
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
			config.telemetry.nudgeShown = true;
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
		.command("serve")
		.description(
			"Start the Epoch HTTP API server (REST endpoints for tools, feedback, telemetry, and docs).",
		)
		.option(
			"--port <n>",
			"TCP port to listen on (1-65535; default: $EPOCH_PORT, $PORT, or 3000)",
			parsePortArg,
		)
		.option(
			"--host <host>",
			"Interface to bind (default: $EPOCH_HOST or 127.0.0.1)",
		)
		.action(async (opts) => {
			const { startHttpServer } = await import("../entries/http.js");
			// Pass through only what the caller supplied so the documented
			// env-var defaults ($EPOCH_PORT/$PORT/$EPOCH_HOST) keep working.
			startHttpServer(opts.port, opts.host);
		});

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

/**
 * One-line, once-ever nudge shown on CLI use when telemetry has never been
 * explicitly configured. Silent under --quiet and while the user is
 * actively managing telemetry themselves (`epoch telemetry ...`). Never
 * repeats once telemetry has been explicitly enabled/disabled (see the
 * `enable`/`disable` command actions below, which also set `nudgeShown`).
 */
export function maybeShowFirstRunTelemetryNudge(args: string[]): void {
	if (args.includes("--quiet") || args[0] === "telemetry") return;

	const config = loadConfig();
	if (config.telemetry.nudgeShown) return;

	if (!config.telemetry.enabled) {
		process.stderr.write(
			"epoch: anonymous calibration telemetry is OFF; run 'epoch telemetry enable' to contribute -- see docs/TELEMETRY.md\n",
		);
	}
	config.telemetry.nudgeShown = true;
	saveConfig(config);
}

export function runCli(): void {
	setTransport("cli");
	maybeShowFirstRunTelemetryNudge(process.argv.slice(2));
	createCliProgram().parse(process.argv);
}
