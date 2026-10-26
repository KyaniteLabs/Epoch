/**
 * Characterization of the CLI adapter: for every tool command, the exact
 * (tool name, input) the CLI hands to dispatch(), plus how bad option values
 * are rejected. The snapshot was recorded from the hand-written CLI before it
 * was moved to a declarative spec, and must not change in that refactor.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../dispatcher/index.js", () => ({
	dispatch: vi.fn(async () => ({ ok: true, data: {} })),
	listTools: vi.fn(() => []),
}));
vi.mock("../version.js", () => ({
	getVersion: () => "0.0.0-contract",
	readPackageVersion: () => "0.0.0-contract",
}));

import { dispatch } from "../dispatcher/index.js";
import { createCliProgram } from "./cli.js";

class Exit extends Error {
	constructor(readonly code: number | undefined) {
		super(`exit ${code}`);
	}
}

const TASKS =
	'[{"name":"A","optimistic":1,"most_likely":2,"pessimistic":4},{"name":"B","optimistic":2,"most_likely":3,"pessimistic":5,"depends_on":["A"]}]';

/** argv (after "epoch") for every tool command: required-only and all options. */
const CASES: Record<string, string[][]> = {
	"get-current-time": [[], ["--timezone", "Asia/Tokyo"]],
	"convert-timezone": [["--timestamp", "2026-05-01T12:00:00Z", "--target-tz", "Asia/Tokyo"]],
	"parse-duration": [["--duration", "2h30m"]],
	"time-math": [
		["--operation", "add_days", "--date", "2026-05-01", "--days", "7"],
		["--operation", "add_business_days", "--start-date", "2026-05-01", "--days", "3", "--country", "DE"],
		["--operation", "diff", "--date", "2026-05-01", "--end-date", "2026-05-09"],
		["--operation", "convert_tz", "--timestamp", "2026-05-01T12:00:00Z", "--target-tz", "UTC"],
		["--operation", "parse_nl", "--duration-string", "two days"],
		["--operation", "format_duration", "--milliseconds", "90061000"],
	],
	"add-business-days": [
		["--start-date", "2026-05-01", "--days", "5"],
		["--start-date", "2026-05-01", "--days", "5", "--country", "UK"],
	],
	"count-business-days": [
		["--start-date", "2026-05-01", "--end-date", "2026-05-15"],
		["--start-date", "2026-05-01", "--end-date", "2026-05-15", "--country", "FR"],
	],
	"pert-estimate": [
		["--optimistic", "2", "--most-likely", "4", "--pessimistic", "12"],
		["--optimistic", "1.5", "--most-likely", "3", "--pessimistic", "9", "--unit", "days"],
	],
	"cocomo-estimate": [
		["--kloc", "15"],
		[
			"--kloc", "15", "--reasoning-complexity", "1.2", "--context-completeness", "0.9",
			"--transformation-impact", "1.1", "--iterative-cycles", "1.3", "--human-oversight", "0.8",
		],
	],
	"sprint-forecast": [
		["--backlog-points", "120", "--velocity-history", "20, 25,30"],
		["--backlog-points", "120", "--velocity-history", "20,25", "--sprint-length-days", "14", "--hours-per-sprint", "60"],
	],
	"critical-path": [["--tasks", TASKS]],
	"monte-carlo-schedule": [["--tasks", TASKS], ["--tasks", TASKS, "--iterations", "500"]],
	"reference-class-estimate": [
		["--task-type", "feature", "--complexity", "3"],
		["--task-type", "bugfix", "--complexity", "2", "--scope", "small", "--team-id", "t1", "--ai-native", "0.5"],
	],
	"calibrate-estimates": [["--team-id", "t1"], ["--team-id", "t1", "--period-days", "30"]],
	"wait-bound": [
		["--clock-class", "fleet"],
		[
			"--clock-class", "fleet", "--cycle-seconds", "30", "--cycles-k", "3", "--turn-optimistic-minutes", "10",
			"--turn-most-likely-minutes", "20", "--turn-pessimistic-minutes", "60",
			"--from-timestamp", "2026-05-01T00:00:00Z", "--time-zone", "UTC",
		],
		["--clock-class", "world", "--external-anchor", "vendor ships v2"],
		["--clock-class", "ceo", "--ceo-rung", "burst"],
	],
	"token-time-bridge": [
		["--tokens", "50000", "--model", "gpt-4o"],
		["--tokens", "50000", "--model", "gpt-4o", "--tool-calls", "4", "--reasoning-depth", "deep"],
	],
	"token-cost-estimate": [
		["--tokens", "50000", "--model", "gpt-4o"],
		["--tokens", "50000", "--model", "gpt-4o", "--tool-calls", "4", "--reasoning-depth", "shallow"],
	],
	"compare-models": [
		["--tokens", "50000"],
		["--tokens", "50000", "--tool-calls", "2", "--reasoning-depth", "moderate", "--sort-by", "cost"],
	],
	"accuracy-trend": [[], ["--team-id", "t1", "--window-size", "5"]],
	"schedule-risk": [["--estimated-hours", "40"], ["--estimated-hours", "40", "--task-type", "feature", "--team-id", "t1"]],
	"cocomo-validate": [[], ["--dataset-filter", "nasa93,cocomo81"]],
	"record-actual": [
		["--estimate-id", "e1", "--actual-hours", "3.5"],
		["--estimate-id", "e1", "--actual-hours", "3.5", "--notes", "took longer"],
	],
	"get-pending-estimates": [[], ["--limit", "5"]],
	"batch-record-actuals": [["--entries", '[{"estimate_id":"e1","actual_hours":2}]']],
	"feedback-health": [[]],
	"cocomo-ground-truth": [[], ["--dataset-filter", "nasa93"]],
	"estimate-from-context": [
		["--context", "add a login page"],
		["--context", "add a login page", "--task-type", "feature", "--complexity", "2", "--team-id", "t1"],
	],
};

/** Inputs that must be rejected before dispatch, with the exit code and message. */
const REJECTS: string[][] = [
	["pert-estimate", "--optimistic", "abc", "--most-likely", "4", "--pessimistic", "12"],
	["add-business-days", "--start-date", "2026-05-01", "--days", "x"],
	["sprint-forecast", "--backlog-points", "10", "--velocity-history", "5,abc"],
	["critical-path", "--tasks", "{not json"],
	["batch-record-actuals", "--entries", "nope"],
	["wait-bound", "--clock-class", "fleet", "--cycles-k", "NaN"],
	["pert-estimate", "--most-likely", "4", "--pessimistic", "12"],
];

let stderr = "";
const realExit = process.exit;
const realStderr = process.stderr.write.bind(process.stderr);
const realStdout = process.stdout.write.bind(process.stdout);

beforeEach(() => {
	vi.mocked(dispatch).mockClear();
	stderr = "";
	process.exit = ((code?: number) => {
		throw new Exit(code);
	}) as typeof process.exit;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	process.stdout.write = (() => true) as typeof process.stdout.write;
});

afterEach(() => {
	process.exit = realExit;
	process.stderr.write = realStderr as typeof process.stderr.write;
	process.stdout.write = realStdout as typeof process.stdout.write;
});

async function run(argv: string[]): Promise<{ code: number | undefined; calls: unknown[][]; stderr: string }> {
	vi.mocked(dispatch).mockClear();
	stderr = "";
	const program = createCliProgram();
	program.exitOverride();
	program.configureOutput({ writeErr: (text) => { stderr += text; }, writeOut: () => {} });
	let code: number | undefined;
	try {
		await program.parseAsync(["node", "epoch", ...argv]);
	} catch (error) {
		code = error instanceof Exit ? error.code : ((error as { exitCode?: number }).exitCode ?? -1);
	}
	return { code, calls: vi.mocked(dispatch).mock.calls.map((call) => [...call]), stderr: stderr.trim() };
}

describe("CLI -> dispatch contract", () => {
	it("hands every tool command's options to dispatch unchanged", async () => {
		const recorded: Record<string, unknown> = {};
		for (const [command, variants] of Object.entries(CASES)) {
			for (const args of variants) {
				const { code, calls } = await run([command, ...args]);
				recorded[[command, ...args].join(" ")] = { code, calls };
			}
		}
		expect(recorded).toMatchSnapshot();
	});

	it("rejects bad option values before dispatch", async () => {
		const recorded: Record<string, unknown> = {};
		for (const argv of REJECTS) recorded[argv.join(" ")] = await run(argv);
		expect(recorded).toMatchSnapshot();
	});
});
