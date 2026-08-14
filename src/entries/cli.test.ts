// ---------------------------------------------------------------------------
// Epoch CLI Entry Point — Tests
// Commander.js program construction, command registration, argument parsing,
// tool dispatch, and output formatting.
// ---------------------------------------------------------------------------

import {
	describe,
	it,
	expect,
	vi,
	beforeEach,
	afterEach,
	beforeAll,
	afterAll,
} from "vitest";
import { Command } from "commander";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCliProgram, maybeShowFirstRunTelemetryNudge } from "./cli.js";
import { dispatch } from "../dispatcher/index.js";

// ---- Sentinel error for process.exit mock -----------------------------------

/** Sentinel error thrown by the mocked process.exit to halt execution. */
class ExitCalled extends Error {
	readonly exitCode: number;
	constructor(code: number) {
		super(`process.exit(${code})`);
		this.exitCode = code;
	}
}

// Suppress unhandled rejections from ExitCalled throws that escape async
// Commander action handlers (detached promises). Install before all tests.
const rejectionListener = (reason: unknown) => {
	if (reason instanceof ExitCalled) return; // expected — swallow
};

// ---- Mocks ------------------------------------------------------------------

vi.mock("../dispatcher/index.js", () => ({
	dispatch: vi.fn(),
	listTools: vi.fn(() => [
		{ name: "pert_estimate", description: "PERT estimate" },
		{ name: "get_current_time", description: "Current time" },
	]),
}));

vi.mock("../version.js", () => ({
	getVersion: () => "0.1.2-test",
}));

vi.mock("../lib/auto-actuals.js", () => ({
	runAutoActuals: vi.fn(),
}));

import { runAutoActuals } from "../lib/auto-actuals.js";
import type { AutoActualsResult } from "../lib/auto-actuals.js";

// ---- Helpers ----------------------------------------------------------------

const TEST_DIR = join(tmpdir(), `epoch-cli-test-${Date.now()}`);

/** Captured writes to stdout/stderr and exit codes. */
interface Capture {
	stdout: string[];
	stderr: string[];
	exitCode: number | null;
}

/**
 * Run a Commander program with the given user-facing args and capture output.
 *
 * @param argv - Arguments *after* the program name (e.g. ["get-current-time", "--timezone", "UTC"])
 */
async function runWithCapture(
	program: Command,
	argv: string[],
): Promise<Capture> {
	const capture: Capture = { stdout: [], stderr: [], exitCode: null };

	const origStdoutWrite = process.stdout.write;
	const origStderrWrite = process.stderr.write;
	const origExit = process.exit;

	process.stdout.write = ((chunk: unknown) => {
		if (typeof chunk === "string") capture.stdout.push(chunk);
		return true;
	}) as typeof process.stdout.write;

	process.stderr.write = ((chunk: unknown) => {
		if (typeof chunk === "string") capture.stderr.push(chunk);
		return true;
	}) as typeof process.stderr.write;

	// Throw a sentinel so execution halts — same behavior as real process.exit.
	process.exit = ((code?: number) => {
		const c = code ?? 0;
		capture.exitCode = c;
		throw new ExitCalled(c);
	}) as typeof process.exit;

	try {
		program.parse(argv, { from: "user" });
		// Flush microtask queue for async actions that call process.exit.
		await new Promise((resolve) => setTimeout(resolve, 200));
	} catch (e: unknown) {
		// Swallow ExitCalled — the exit code is captured above.
		if (!(e instanceof ExitCalled)) {
			throw e;
		}
	} finally {
		process.stdout.write = origStdoutWrite;
		process.stderr.write = origStderrWrite;
		process.exit = origExit;
	}

	return capture;
}

/** Configure dispatch mock to return a successful result. */
function mockDispatchSuccess(data: Record<string, unknown>): void {
	(dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: true,
		data,
	});
}

/** Configure dispatch mock to return an error result. */
function mockDispatchError(message: string, isError = true): void {
	(dispatch as ReturnType<typeof vi.fn>).mockResolvedValue({
		ok: false,
		error: { isError, message },
	});
}

// ---- Tests ------------------------------------------------------------------

describe("CLI tests", () => {
	beforeAll(() => {
		process.on("unhandledRejection", rejectionListener);
	});

	afterAll(() => {
		process.off("unhandledRejection", rejectionListener);
	});

	describe("createCliProgram", () => {
		it("returns a Commander instance", () => {
			const program = createCliProgram();
			expect(program).toBeInstanceOf(Command);
		});

		it("sets program name to 'epoch'", () => {
			const program = createCliProgram();
			expect(program.name()).toBe("epoch");
		});

		it("sets description", () => {
			const program = createCliProgram();
			expect(program.description()).toBe("Time Estimation CLI");
		});

		it("registers --format option with json/table choices", () => {
			const program = createCliProgram();
			const formatOption = program.options.find((o) => o.long === "--format");
			expect(formatOption).toBeDefined();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(formatOption!.argChoices).toEqual(["json", "table"]);
		});

		it("registers --pretty option", () => {
			const program = createCliProgram();
			const prettyOption = program.options.find((o) => o.long === "--pretty");
			expect(prettyOption).toBeDefined();
		});

		it("registers --quiet option", () => {
			const program = createCliProgram();
			const quietOption = program.options.find((o) => o.long === "--quiet");
			expect(quietOption).toBeDefined();
		});
	});

	describe("CLI command registration", () => {
		const EXPECTED_COMMANDS = [
			"get-current-time",
			"convert-timezone",
			"parse-duration",
			"time-math",
			"add-business-days",
			"count-business-days",
			"pert-estimate",
			"cocomo-estimate",
			"sprint-forecast",
			"critical-path",
			"monte-carlo-schedule",
			"reference-class-estimate",
			"calibrate-estimates",
			"token-time-bridge",
			"token-cost-estimate",
			"compare-models",
			"accuracy-trend",
			"schedule-risk",
			"cocomo-validate",
			"record-actual",
			"get-pending-estimates",
			"batch-record-actuals",
			"feedback-health",
			"cocomo-ground-truth",
			"estimate-from-context",
			"list-tools",
			"auto-actuals",
			"self-improve",
			"serve",
			"telemetry",
			"share-data",
			"data",
		];

		it("registers all expected commands", () => {
			const program = createCliProgram();
			const commandNames = program.commands.map((c) => c.name());
			for (const name of EXPECTED_COMMANDS) {
				expect(commandNames).toContain(name);
			}
			expect(program.commands).toHaveLength(EXPECTED_COMMANDS.length);
		});

		it("every command has a non-empty description", () => {
			const program = createCliProgram();
			for (const cmd of program.commands) {
				expect(cmd.description().length).toBeGreaterThan(0);
			}
		});

		it("get-current-time has --timezone optional argument defaulting to UTC", () => {
			const program = createCliProgram();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const cmd = program.commands.find(
				(c) => c.name() === "get-current-time",
			)!;
			const tzOption = cmd.options.find((o) => o.long === "--timezone");
			expect(tzOption).toBeDefined();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(tzOption!.defaultValue).toBe("UTC");
		});

		it("auto-actuals has required --session and optional --dry-run", () => {
			const program = createCliProgram();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const cmd = program.commands.find((c) => c.name() === "auto-actuals")!;
			const requiredFlags = cmd.options.filter((o) => o.required).map((o) => o.long);
			expect(requiredFlags).toContain("--session");
			const dryRunOption = cmd.options.find((o) => o.long === "--dry-run");
			expect(dryRunOption).toBeDefined();
			expect(dryRunOption?.required).toBe(false);
		});

		it("convert-timezone has required --timestamp and --target-tz", () => {
			const program = createCliProgram();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const cmd = program.commands.find(
				(c) => c.name() === "convert-timezone",
			)!;
			const requiredFlags = cmd.options
				.filter((o) => o.required)
				.map((o) => o.long);
			expect(requiredFlags).toContain("--timestamp");
			expect(requiredFlags).toContain("--target-tz");
		});

		it("pert-estimate has required --optimistic, --most-likely, --pessimistic", () => {
			const program = createCliProgram();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const cmd = program.commands.find((c) => c.name() === "pert-estimate")!;
			const requiredFlags = cmd.options
				.filter((o) => o.required)
				.map((o) => o.long);
			expect(requiredFlags).toContain("--optimistic");
			expect(requiredFlags).toContain("--most-likely");
			expect(requiredFlags).toContain("--pessimistic");
		});

		it("critical-path has required --tasks argument", () => {
			const program = createCliProgram();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const cmd = program.commands.find((c) => c.name() === "critical-path")!;
			const requiredFlags = cmd.options
				.filter((o) => o.required)
				.map((o) => o.long);
			expect(requiredFlags).toContain("--tasks");
		});

		it("telemetry exposes endpoint configuration and submit subcommands", () => {
			const program = createCliProgram();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const telemetry = program.commands.find((c) => c.name() === "telemetry")!;
			const subcommands = telemetry.commands.map((c) => c.name());
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const enable = telemetry.commands.find((c) => c.name() === "enable")!;

			expect(subcommands).toContain("set-endpoint");
			expect(subcommands).toContain("submit");
			expect(enable.options.map((o) => o.long)).toContain("--endpoint");
		});
	});

	describe("CLI tool execution", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("get-current-time dispatches with timezone from flag", async () => {
			mockDispatchSuccess({ iso: "2026-01-01T00:00:00Z", timezone: "UTC" });
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"get-current-time",
				"--timezone",
				"America/New_York",
			]);

			expect(dispatch).toHaveBeenCalledWith("get_current_time", {
				timezone: "America/New_York",
			});
			expect(capture.exitCode).toBe(0);
		});

		it("pert-estimate dispatches with parsed numeric args", async () => {
			mockDispatchSuccess({
				expected: 5,
				stdDeviation: 1.67,
				unit: "hours",
			});
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"pert-estimate",
				"--optimistic",
				"2",
				"--most-likely",
				"4",
				"--pessimistic",
				"12",
			]);

			expect(dispatch).toHaveBeenCalledWith("pert_estimate", {
				optimistic: 2,
				most_likely: 4,
				pessimistic: 12,
				unit: "hours",
			});
			expect(capture.exitCode).toBe(0);
		});

		it("dispatches convert-timezone with correct arg mapping", async () => {
			mockDispatchSuccess({ iso: "2026-01-01T05:00:00Z" });
			const program = createCliProgram();
			await runWithCapture(program, [
				"convert-timezone",
				"--timestamp",
				"2026-01-01T00:00:00-05:00",
				"--target-tz",
				"UTC",
			]);

			expect(dispatch).toHaveBeenCalledWith("convert_timezone", {
				timestamp: "2026-01-01T00:00:00-05:00",
				target_tz: "UTC",
			});
		});

		it("dispatches parse-duration with duration_string", async () => {
			mockDispatchSuccess({ totalSeconds: 9000 });
			const program = createCliProgram();
			await runWithCapture(program, ["parse-duration", "--duration", "2h30m"]);

			expect(dispatch).toHaveBeenCalledWith("parse_duration", {
				duration_string: "2h30m",
			});
		});

		it("dispatches time-math with operation and operands", async () => {
			mockDispatchSuccess({ days: 5 });
			const program = createCliProgram();
			await runWithCapture(program, [
				"time-math",
				"--operation",
				"add_days",
				"--date",
				"2026-01-01",
				"--days",
				"5",
			]);

			expect(dispatch).toHaveBeenCalledWith(
				"time_math",
				expect.objectContaining({
					operation: "add_days",
					operands: expect.objectContaining({ date: "2026-01-01", days: 5 }),
				}),
			);
		});

		it("dispatches add-business-days with correct field mapping", async () => {
			mockDispatchSuccess({ endDate: "2026-05-08", businessDays: 5 });
			const program = createCliProgram();
			await runWithCapture(program, [
				"add-business-days",
				"--start-date",
				"2026-05-01",
				"--days",
				"5",
			]);

			expect(dispatch).toHaveBeenCalledWith("add_business_days", {
				start_date: "2026-05-01",
				days: 5,
				country: "US",
			});
		});

		it("exits with code 2 when dispatch returns isError", async () => {
			mockDispatchError("Something went wrong", true);
			const program = createCliProgram();
			const capture = await runWithCapture(program, ["get-current-time"]);

			expect(capture.exitCode).toBe(2);
		});

		it("exits with code 1 when dispatch returns non-isError failure", async () => {
			mockDispatchError("Validation failed", false);
			const program = createCliProgram();
			const capture = await runWithCapture(program, ["get-current-time"]);

			expect(capture.exitCode).toBe(1);
		});
	});

	describe("CLI output formatting", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("default format outputs valid JSON to stdout", async () => {
			mockDispatchSuccess({ iso: "2026-01-01T00:00:00Z" });
			const program = createCliProgram();
			const capture = await runWithCapture(program, ["get-current-time"]);

			const output = capture.stdout.join("").trim();
			expect(() => JSON.parse(output)).not.toThrow();
			const parsed = JSON.parse(output) as { ok: boolean; data: unknown };
			expect(parsed.ok).toBe(true);
		});

		it("--pretty flag triggers table output format", async () => {
			mockDispatchSuccess({ iso: "2026-01-01T00:00:00Z", timezone: "UTC" });
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"--pretty",
				"get-current-time",
			]);

			const output = capture.stdout.join("");
			expect(output).toContain("get_current_time");
		});

		it("--format table produces table output", async () => {
			mockDispatchSuccess({ expected: 5, unit: "hours" });
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"--format",
				"table",
				"pert-estimate",
				"--optimistic",
				"2",
				"--most-likely",
				"4",
				"--pessimistic",
				"12",
			]);

			const output = capture.stdout.join("");
			expect(output).toContain("pert_estimate");
		});

		it("--quiet suppresses table output", async () => {
			mockDispatchSuccess({ expected: 5 });
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"--quiet",
				"--format",
				"table",
				"pert-estimate",
				"--optimistic",
				"2",
				"--most-likely",
				"4",
				"--pessimistic",
				"12",
			]);

			expect(capture.stdout.join("")).toBe("");
		});
	});

	describe("CLI error handling", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("critical-path --tasks rejects invalid JSON", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"critical-path",
				"--tasks",
				"not-json",
			]);

			expect(capture.stderr.join("")).toContain("--tasks must be valid JSON");
			expect(capture.exitCode).toBe(1);
		});

		it("critical-path --tasks accepts valid JSON array", async () => {
			mockDispatchSuccess({ critical_path: [], total_duration: 0 });
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"critical-path",
				"--tasks",
				'[{"name":"a","duration":5,"predecessors":[]}]',
			]);

			expect(dispatch).toHaveBeenCalledWith(
				"critical_path",
				expect.objectContaining({
					tasks: [{ name: "a", duration: 5, predecessors: [] }],
				}),
			);
			expect(capture.exitCode).toBe(0);
		});

		it("sprint-forecast --velocity-history rejects non-numeric value", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"sprint-forecast",
				"--backlog-points",
				"100",
				"--velocity-history",
				"10,abc,20",
			]);

			expect(capture.stderr.join("")).toContain("non-numeric value");
			expect(capture.exitCode).toBe(1);
		});
	});

	describe("CLI serve command", () => {
		it("is listed in the root help output", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, ["--help"]);

			expect(capture.stdout.join("")).toContain("serve");
			expect(capture.exitCode).toBe(0);
		});

		it("serve --help shows port/host options without starting a server", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, ["serve", "--help"]);
			const output = capture.stdout.join("");

			expect(output).toContain("--port");
			expect(output).toContain("--host");
			expect(output.toLowerCase()).not.toContain("listening");
			expect(capture.exitCode).toBe(0);
		});

		it("rejects a non-numeric --port with a clear error", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"serve",
				"--port",
				"abc",
			]);

			expect(capture.stderr.join("")).toContain(
				"--port must be an integer between 1 and 65535",
			);
			expect(capture.exitCode).toBe(1);
		});

		it("rejects an out-of-range --port instead of crashing in the bind call", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"serve",
				"--port",
				"99999",
			]);

			expect(capture.stderr.join("")).toContain(
				"--port must be an integer between 1 and 65535",
			);
			expect(capture.exitCode).toBe(1);
		});

		it("rejects a fractional and a zero --port", async () => {
			const program = createCliProgram();
			for (const bad of ["80.5", "0", "-1"]) {
				const capture = await runWithCapture(program, ["serve", "--port", bad]);
				expect(capture.exitCode).toBe(1);
				expect(capture.stderr.join("")).toContain("--port must be an integer");
			}
		});

		it("registers --port and --host options on the serve command", () => {
			const program = createCliProgram();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const cmd = program.commands.find((c) => c.name() === "serve")!;
			expect(cmd.options.map((o) => o.long)).toContain("--port");
			expect(cmd.options.map((o) => o.long)).toContain("--host");
			// No commander default values: unspecified flags must fall through to
			// the documented $EPOCH_PORT/$PORT/$EPOCH_HOST env defaults.
			const port = cmd.options.find((o) => o.long === "--port");
			expect(port?.defaultValue).toBeUndefined();
			const host = cmd.options.find((o) => o.long === "--host");
			expect(host?.defaultValue).toBeUndefined();
		});
	});

	describe("CLI auto-actuals result contract", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			mkdirSync(TEST_DIR, { recursive: true });
			process.env["EPOCH_DATA_DIR"] = TEST_DIR;
		});

		afterEach(() => {
			delete process.env["EPOCH_DATA_DIR"];
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		function mockAutoActualsResult(overrides: Partial<AutoActualsResult>): AutoActualsResult {
			return {
				sessionId: "sess-1",
				dryRun: false,
				candidates: 2,
				recorded: [{ estimateId: "est-1", wallClockHours: 2.5 }],
				skipped: [],
				summary: "auto-actuals: session sess-1 -- 1 actual(s) recorded, 0 skipped (of 2 candidates).",
				...overrides,
			};
		}

		it("writes exactly one JSON document to stdout and exits 0 on success", async () => {
			const result = mockAutoActualsResult({});
			(runAutoActuals as ReturnType<typeof vi.fn>).mockReturnValue(result);
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"auto-actuals",
				"--session",
				"sess-1",
			]);

			expect(capture.exitCode).toBe(0);
			// Single write: stdout is EXACTLY the one JSON envelope — no
			// JSON+summary double-write (the summary lives inside data).
			expect(capture.stdout.join("")).toBe(
				JSON.stringify({ ok: true, data: result }, null, 2) + "\n",
			);
			expect(runAutoActuals).toHaveBeenCalledWith("sess-1", false);
		});

		it("forwards --dry-run", async () => {
			(runAutoActuals as ReturnType<typeof vi.fn>).mockReturnValue(
				mockAutoActualsResult({ dryRun: true }),
			);
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"auto-actuals",
				"--session",
				"sess-1",
				"--dry-run",
			]);

			expect(runAutoActuals).toHaveBeenCalledWith("sess-1", true);
			expect(capture.exitCode).toBe(0);
		});

		it("exits 2 with the error envelope on stderr when entries were skipped with write_failed", async () => {
			(runAutoActuals as ReturnType<typeof vi.fn>).mockReturnValue(
				mockAutoActualsResult({
					candidates: 2,
					recorded: [],
					skipped: [{ estimateId: "est-2", reason: "write_failed", wallClockHours: 3 }],
				}),
			);
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"auto-actuals",
				"--session",
				"sess-1",
			]);

			expect(capture.exitCode).toBe(2);
			expect(capture.stdout.join("")).toBe("");
			const stderr = capture.stderr.join("");
			expect(stderr).toContain("write failed");
			expect(stderr).toContain("est-2");
			const parsed = JSON.parse(stderr) as { ok: boolean; error: { retryHint?: string } };
			expect(parsed.ok).toBe(false);
			expect(parsed.error.retryHint).toBeDefined();
		});

		it("non-write-failure skips (sanity bounds) stay exit 0", async () => {
			(runAutoActuals as ReturnType<typeof vi.fn>).mockReturnValue(
				mockAutoActualsResult({
					skipped: [{ estimateId: "est-2", reason: "auto_wallclock_out_of_bounds", wallClockHours: 9000 }],
				}),
			);
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"auto-actuals",
				"--session",
				"sess-1",
			]);

			expect(capture.exitCode).toBe(0);
		});

		it("honors --format table and --quiet like other commands", async () => {
			(runAutoActuals as ReturnType<typeof vi.fn>).mockReturnValue(
				mockAutoActualsResult({}),
			);
			const program = createCliProgram();

			const table = await runWithCapture(program, [
				"--format",
				"table",
				"auto-actuals",
				"--session",
				"sess-1",
			]);
			expect(table.stdout.join("")).toContain("auto-actuals");

			const quietTable = await runWithCapture(program, [
				"--quiet",
				"--format",
				"table",
				"auto-actuals",
				"--session",
				"sess-1",
			]);
			expect(quietTable.stdout.join("")).toBe("");
		});
	});

	describe("CLI cocomo-estimate optional args", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("sends only kloc when no optional multipliers provided", async () => {
			mockDispatchSuccess({ kloc: 10 });
			const program = createCliProgram();
			await runWithCapture(program, ["cocomo-estimate", "--kloc", "10"]);

			expect(dispatch).toHaveBeenCalledWith(
				"cocomo_estimate",
				expect.objectContaining({ kloc: 10 }),
			);
			// Should NOT contain optional multipliers
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			const callArgs = (dispatch as ReturnType<typeof vi.fn>).mock
				.calls[0]![1] as Record<string, unknown>;
			expect(callArgs).not.toHaveProperty("reasoning_complexity");
			expect(callArgs).not.toHaveProperty("context_completeness");
		});

		it("sends optional multipliers when provided", async () => {
			mockDispatchSuccess({ kloc: 10 });
			const program = createCliProgram();
			await runWithCapture(program, [
				"cocomo-estimate",
				"--kloc",
				"10",
				"--reasoning-complexity",
				"1.5",
				"--human-oversight",
				"0.8",
			]);

			expect(dispatch).toHaveBeenCalledWith(
				"cocomo_estimate",
				expect.objectContaining({
					kloc: 10,
					reasoning_complexity: 1.5,
					human_oversight: 0.8,
				}),
			);
		});
	});

	describe("CLI list-tools command", () => {
		beforeEach(() => {
			vi.clearAllMocks();
		});

		it("outputs JSON array of tools", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, ["list-tools"]);

			const output = capture.stdout.join("").trim();
			expect(() => JSON.parse(output)).not.toThrow();
			const tools = JSON.parse(output) as Array<{
				name: string;
				description: string;
			}>;
			expect(tools.length).toBeGreaterThan(0);
			expect(capture.exitCode).toBe(0);
		});
	});

	describe("CLI telemetry commands", () => {
		beforeEach(() => {
			vi.clearAllMocks();
			mkdirSync(TEST_DIR, { recursive: true });
			process.env["EPOCH_DATA_DIR"] = TEST_DIR;
			delete process.env["EPOCH_TELEMETRY"];
			delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
		});

		afterEach(() => {
			delete process.env["EPOCH_DATA_DIR"];
			delete process.env["EPOCH_TELEMETRY"];
			delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		it("sets endpoint while enabling telemetry", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"telemetry",
				"enable",
				"--yes",
				"--endpoint",
				"https://collector.example.net/v1/telemetry",
			]);

			const output = JSON.parse(capture.stdout.join("")) as {
				ok: boolean;
				endpoint: string;
			};
			expect(capture.exitCode).toBe(0);
			expect(output.ok).toBe(true);
			expect(output.endpoint).toBe(
				"https://collector.example.net/v1/telemetry",
			);
		});

		it("non-interactive enable without --yes fails loudly instead of a silent exit-0 on EOF", async () => {
			// Force the non-interactive branch regardless of how vitest's own
			// stdin is connected (piped stdin resolves the prompt with "" on
			// EOF, which previously "Cancelled."d its way to exit 0).
			const stdin = process.stdin as { isTTY?: boolean };
			const originalIsTTY = stdin.isTTY;
			stdin.isTTY = undefined;
			try {
				const program = createCliProgram();
				const capture = await runWithCapture(program, ["telemetry", "enable"]);

				expect(capture.exitCode).toBe(1);
				const stderr = capture.stderr.join("");
				expect(stderr).toContain("interactive");
				expect(stderr).toContain("--yes");
				// No silent success shape on stdout, and telemetry stays off.
				expect(capture.stdout.join("")).not.toContain("\"ok\": true");
				const { loadConfig } = await import("../lib/config.js");
				expect(loadConfig().telemetry.enabled).toBe(false);
			} finally {
				stdin.isTTY = originalIsTTY;
			}
		});

		it("rejects non-HTTPS telemetry endpoints except localhost", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"telemetry",
				"set-endpoint",
				"--endpoint",
				"http://collector.example.net/v1/telemetry",
			]);

			expect(capture.exitCode).toBe(1);
			expect(capture.stderr.join("")).toContain("https://");
		});

		it("allows Tailscale private HTTP telemetry endpoints", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, [
				"telemetry",
				"set-endpoint",
				"--endpoint",
				"http://100.66.225.85:3099/v1/telemetry",
			]);

			const output = JSON.parse(capture.stdout.join("")) as {
				ok: boolean;
				endpoint: string;
			};
			expect(capture.exitCode).toBe(0);
			expect(output.ok).toBe(true);
			expect(output.endpoint).toBe("http://100.66.225.85:3099/v1/telemetry");
		});

		it("reports placeholder endpoint as not configured in telemetry status", async () => {
			const { saveConfig } = await import("../lib/config.js");
			saveConfig({
				telemetry: {
					enabled: true,
					endpoint: "https://example.com/v1/telemetry",
					lastSubmissionAt: null,
					lastSubmissionRecordCount: 0,
					installationId: "test-id",
				},
			});

			const program = createCliProgram();
			const capture = await runWithCapture(program, ["telemetry", "status"]);
			const output = JSON.parse(capture.stdout.join("")) as {
				endpoint: string;
				endpointConfigured: boolean;
				queuedRecords: number;
			};

			expect(capture.exitCode).toBe(0);
			expect(output.endpoint).toBe("(not configured)");
			expect(output.endpointConfigured).toBe(false);
			expect(typeof output.queuedRecords).toBe("number");
		});

		it("reports EPOCH_TELEMETRY=0 override as disabled in telemetry status", async () => {
			const { saveConfig } = await import("../lib/config.js");
			saveConfig({
				telemetry: {
					enabled: true,
					endpoint: "https://collector.example.net/v1/telemetry",
					lastSubmissionAt: null,
					lastSubmissionRecordCount: 0,
					installationId: "test-id",
				},
			});
			process.env["EPOCH_TELEMETRY"] = "0";

			const program = createCliProgram();
			const capture = await runWithCapture(program, ["telemetry", "status"]);
			const output = JSON.parse(capture.stdout.join("")) as {
				enabled: boolean;
			};

			expect(capture.exitCode).toBe(0);
			expect(output.enabled).toBe(false);
		});

		it("preview reports 'nothing to send' when no records are queued", async () => {
			const program = createCliProgram();
			const capture = await runWithCapture(program, ["telemetry", "preview"]);
			const output = JSON.parse(capture.stdout.join("")) as {
				message?: string;
			};

			expect(capture.exitCode).toBe(0);
			expect(output.message).toBe("nothing to send");
		});

		it("preview prints the exact schema_version 2 payload that submit would send", async () => {
			const { recordEstimate, recordActual } = await import(
				"../lib/feedback.js"
			);
			const estimateId = recordEstimate(
				"pert_estimate",
				{ task_type: "feature", complexity: 3 },
				{ expected: 2, unit: "hours" },
			);
			recordActual(estimateId, 3);

			const program = createCliProgram();
			const capture = await runWithCapture(program, ["telemetry", "preview"]);
			const output = JSON.parse(capture.stdout.join("")) as {
				schema_version: number;
				installation_id: string;
				records: unknown[];
				client_name: string | null;
				transport: string | null;
				runtime_hint: string;
			};

			expect(capture.exitCode).toBe(0);
			expect(output.schema_version).toBe(2);
			expect(output.records).toHaveLength(1);
			expect(typeof output.installation_id).toBe("string");
			expect(output.client_name).toBeNull();
			expect(["cli", null]).toContain(output.transport);
		});
	});

	describe("maybeShowFirstRunTelemetryNudge", () => {
		beforeEach(() => {
			mkdirSync(TEST_DIR, { recursive: true });
			process.env["EPOCH_DATA_DIR"] = TEST_DIR;
		});

		afterEach(() => {
			delete process.env["EPOCH_DATA_DIR"];
			rmSync(TEST_DIR, { recursive: true, force: true });
		});

		it("prints the nudge once, then never again", async () => {
			const capture1 = await runWithCapture(
				{ parse: () => maybeShowFirstRunTelemetryNudge([]) } as unknown as Command,
				[],
			);
			expect(capture1.stderr.join("")).toContain("telemetry is OFF");

			const capture2 = await runWithCapture(
				{ parse: () => maybeShowFirstRunTelemetryNudge([]) } as unknown as Command,
				[],
			);
			expect(capture2.stderr.join("")).toBe("");
		});

		it("stays silent under --quiet", async () => {
			const capture = await runWithCapture(
				{
					parse: () => maybeShowFirstRunTelemetryNudge(["--quiet"]),
				} as unknown as Command,
				[],
			);
			expect(capture.stderr.join("")).toBe("");
		});

		it("stays silent while managing telemetry explicitly", async () => {
			const capture = await runWithCapture(
				{
					parse: () => maybeShowFirstRunTelemetryNudge(["telemetry", "status"]),
				} as unknown as Command,
				[],
			);
			expect(capture.stderr.join("")).toBe("");
		});

		it("stays silent once telemetry has been explicitly enabled", async () => {
			const { saveConfig } = await import("../lib/config.js");
			saveConfig({
				telemetry: {
					enabled: true,
					endpoint: "",
					lastSubmissionAt: null,
					lastSubmissionRecordCount: 0,
					installationId: "test-id",
				},
			});

			const capture = await runWithCapture(
				{ parse: () => maybeShowFirstRunTelemetryNudge([]) } as unknown as Command,
				[],
			);
			expect(capture.stderr.join("")).toBe("");

			const { loadConfig } = await import("../lib/config.js");
			expect(loadConfig().telemetry.nudgeShown).toBe(true);
		});
	});
});
