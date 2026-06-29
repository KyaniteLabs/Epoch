#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust soak runner
//
// Repeatedly runs the local promotion packet and appends each measured packet
// to the cumulative soak ledger. This is orchestration only: the existing
// readiness scorer and ledger remain the source of truth for promotion.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import type {
	DeployReadinessDecision,
	ReadinessAssessment,
} from "../src/contract/rust-deploy-readiness.js";

type Target = "canary" | "replace";
type StopReason =
	| "target-reached"
	| "max-runs-exhausted"
	| "non-soak-gate-blocked";
type TargetHoursSource = "default" | "override";
type StopSatisfiedBy = "scorer" | "target-hours-override" | null;
type BenchmarkMode = "smoke" | "qualified";

type CliOptions = {
	target: Target;
	targetHoursOverride?: number;
	packetDir: string;
	ledgerPath: string;
	iterations: number;
	minSeconds: number;
	benchmarkMode: BenchmarkMode;
	maxRuns: number | null;
	untilTarget: boolean;
	releaseTag?: string;
	summaryOutput?: string;
	requireTarget: boolean;
	quiet: boolean;
};

type LedgerSummary = {
	generatedAt: string;
	readiness: ReadinessAssessment;
	runCount: number;
	totalSoakHours: number;
	continuousSoakHours: number;
	continuityLostHours: number;
	releaseTaggedSoakHours: number;
	qualifiedPerformanceEvidence: boolean;
	releaseE2ePass: boolean;
	publicSurfaceCoveragePercent: number;
	httpDeployEnvCoveragePercent: number;
	rustBinarySha256: string | null;
	continuousGapSeconds: number;
	canarySoakHoursRequired: number;
	replaceSoakHoursRequired: number;
	files: {
		ledger: string;
		cumulativeReadinessInput: string;
		cumulativeReadinessAssessment: string;
		cumulativeSummary: string;
	};
};

type RunnerSummary = {
	generatedAt: string;
	target: Target;
	targetHours: number;
	targetHoursSource: TargetHoursSource;
	targetReached: boolean;
	targetSatisfiedBy: "scorer" | null;
	smokeTargetReached: boolean;
	stopReason: StopReason;
	runsStarted: number;
	maxRuns: number | null;
	untilTarget: boolean;
	iterationsPerPacket: number;
	minSecondsPerPacket: number;
	benchmarkMode: BenchmarkMode;
	releaseTag: string | null;
	readiness: ReadinessAssessment;
	totalSoakHours: number;
	continuousSoakHours: number;
	continuityLostHours: number;
	releaseTaggedSoakHours: number;
	qualifiedPerformanceEvidence: boolean;
	releaseE2ePass: boolean;
	publicSurfaceCoveragePercent: number;
	httpDeployEnvCoveragePercent: number;
	rustBinarySha256: string | null;
	remainingSoakHours: number;
	files: {
		packetDir: string;
		ledger: string;
		ledgerSummary: string;
		runnerSummary: string;
	};
};

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_PACKET_DIR = ".epoch-promotion/latest";
const DEFAULT_LEDGER = ".epoch-promotion/soak-ledger.json";
const RUNNER_LOCK = ".epoch-promotion/soak-runner.lock";
const RUNNER_STATE = ".epoch-promotion/soak-runner-state.json";
const DEFAULT_ITERATIONS = 3;
const DEFAULT_MIN_SECONDS = 60;
const DEFAULT_MAX_RUNS = 1;
const REQUIRED_SOAK_HOURS: Record<Target, number> = {
	canary: 24,
	replace: 72,
};
const DECISION_RANK: Record<DeployReadinessDecision, number> = {
	NO: 0,
	SHADOW: 1,
	CANARY: 2,
	REPLACE: 3,
};

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		target: "canary",
		packetDir: DEFAULT_PACKET_DIR,
		ledgerPath: DEFAULT_LEDGER,
		iterations: DEFAULT_ITERATIONS,
		minSeconds: DEFAULT_MIN_SECONDS,
		benchmarkMode: "smoke",
		maxRuns: DEFAULT_MAX_RUNS,
		untilTarget: false,
		requireTarget: false,
		quiet: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	let maxRunsProvided = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--target") {
			options.target = parseTarget(args[++i]);
		} else if (arg === "--target-hours") {
			options.targetHoursOverride = positiveNumber(args[++i], "--target-hours");
		} else if (arg === "--packet-dir") {
			options.packetDir = nonEmptyString(args[++i], "--packet-dir");
		} else if (arg === "--ledger") {
			options.ledgerPath = nonEmptyString(args[++i], "--ledger");
		} else if (arg === "--iterations") {
			options.iterations = positiveInteger(args[++i], "--iterations");
		} else if (arg === "--min-seconds") {
			options.minSeconds = nonNegativeNumber(args[++i], "--min-seconds");
		} else if (arg === "--benchmark-mode") {
			const mode = args[++i];
			if (mode !== "smoke" && mode !== "qualified") {
				throw new Error("--benchmark-mode must be smoke or qualified.");
			}
			options.benchmarkMode = mode;
		} else if (arg === "--max-runs") {
			options.maxRuns = positiveInteger(args[++i], "--max-runs");
			maxRunsProvided = true;
		} else if (arg === "--until-target") {
			options.untilTarget = true;
		} else if (arg === "--release-tag") {
			options.releaseTag = nonEmptyString(args[++i], "--release-tag");
		} else if (arg === "--summary-output") {
			options.summaryOutput = nonEmptyString(args[++i], "--summary-output");
		} else if (arg === "--require-target") {
			options.requireTarget = true;
		} else if (arg === "--quiet") {
			options.quiet = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
	}

	if (options.target === "replace" && !options.releaseTag) {
		throw new Error(
			"--target replace requires --release-tag so replacement evidence can reach release observability.",
		);
	}
	if (options.untilTarget && !maxRunsProvided) {
		options.maxRuns = null;
	}

	return options;
}

function parseTarget(raw: string | undefined): Target {
	if (raw === "canary" || raw === "replace") return raw;
	throw new Error("--target must be either canary or replace.");
}

function positiveInteger(raw: string | undefined, label: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be an integer >= 1.`);
	}
	return value;
}

function positiveNumber(raw: string | undefined, label: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value <= 0) {
		throw new Error(`${label} must be a number > 0.`);
	}
	return value;
}

function nonNegativeNumber(raw: string | undefined, label: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a number >= 0.`);
	}
	return value;
}

function nonEmptyString(raw: string | undefined, label: string): string {
	if (!raw?.trim()) {
		throw new Error(`${label} must not be empty.`);
	}
	return raw;
}

function usage(): string {
	return [
		"Usage: tsx scripts/rust-soak-runner.ts [options]",
		"",
		"Options:",
		"  --target <canary|replace>  Promotion target to prove (default: canary)",
		"  --target-hours <n>         Override soak target for smoke tests only",
		"  --packet-dir <dir>         Local packet directory (default: .epoch-promotion/latest)",
		"  --ledger <path>            Cumulative ledger file (default: .epoch-promotion/soak-ledger.json)",
		"  --iterations <n>           Shadow-soak iterations per packet (default: 3)",
		"  --min-seconds <n>          Minimum shadow-soak seconds per packet (default: 60)",
		"  --benchmark-mode <m>       Performance benchmark mode per packet: smoke or qualified (default: smoke)",
		"  --max-runs <n>             Maximum packets to run this invocation (default: 1)",
		"  --until-target             Keep starting packets until the target is reached",
		"  --release-tag <tag>        Mark packet comparisons as release evidence",
		"  --summary-output <path>    Runner summary JSON path",
		"  --require-target           Exit non-zero when target is not reached",
		"  --quiet                    Suppress progress and human summary output",
		"",
	].join("\n");
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmpPath, path);
}

function rel(path: string): string {
	return relative(REPO_ROOT, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDecision(value: unknown): value is DeployReadinessDecision {
	return (
		value === "NO" ||
		value === "SHADOW" ||
		value === "CANARY" ||
		value === "REPLACE"
	);
}

function parseReadinessAssessment(value: unknown): ReadinessAssessment {
	if (!isObject(value) || !isDecision(value.decision)) {
		throw new Error("Ledger summary readiness decision is missing or invalid.");
	}
	return {
		decision: value.decision,
		failingGate:
			typeof value.failingGate === "string" ? value.failingGate : null,
		rationale:
			typeof value.rationale === "string" ? value.rationale : "",
	};
}

function parseLedgerSummary(path: string): LedgerSummary {
	const raw = readJson(path);
	if (!isObject(raw)) {
		throw new Error(`Ledger summary is not an object: ${rel(path)}`);
	}
	if (
		typeof raw.generatedAt !== "string" ||
		typeof raw.runCount !== "number" ||
		typeof raw.totalSoakHours !== "number" ||
		typeof raw.continuousSoakHours !== "number" ||
		typeof raw.releaseTaggedSoakHours !== "number" ||
		typeof raw.qualifiedPerformanceEvidence !== "boolean" ||
		typeof raw.continuousGapSeconds !== "number" ||
		typeof raw.canarySoakHoursRequired !== "number" ||
		typeof raw.replaceSoakHoursRequired !== "number" ||
		!isObject(raw.files)
	) {
		throw new Error(`Ledger summary is missing required fields: ${rel(path)}`);
	}

	return {
		generatedAt: raw.generatedAt,
		readiness: parseReadinessAssessment(raw.readiness),
		runCount: raw.runCount,
		totalSoakHours: raw.totalSoakHours,
		continuousSoakHours: raw.continuousSoakHours,
		continuityLostHours:
			typeof raw.continuityLostHours === "number"
				? raw.continuityLostHours
				: Math.max(0, raw.totalSoakHours - raw.continuousSoakHours),
		releaseTaggedSoakHours: raw.releaseTaggedSoakHours,
		qualifiedPerformanceEvidence: raw.qualifiedPerformanceEvidence,
		releaseE2ePass: raw.releaseE2ePass === true,
		publicSurfaceCoveragePercent:
			typeof raw.publicSurfaceCoveragePercent === "number"
				? raw.publicSurfaceCoveragePercent
				: 0,
		httpDeployEnvCoveragePercent:
			typeof raw.httpDeployEnvCoveragePercent === "number"
				? raw.httpDeployEnvCoveragePercent
				: 0,
		rustBinarySha256:
			typeof raw.rustBinarySha256 === "string" ? raw.rustBinarySha256 : null,
		continuousGapSeconds: raw.continuousGapSeconds,
		canarySoakHoursRequired: raw.canarySoakHoursRequired,
		replaceSoakHoursRequired: raw.replaceSoakHoursRequired,
		files: {
			ledger:
				typeof raw.files.ledger === "string" ? raw.files.ledger : "",
			cumulativeReadinessInput:
				typeof raw.files.cumulativeReadinessInput === "string"
					? raw.files.cumulativeReadinessInput
					: "",
			cumulativeReadinessAssessment:
				typeof raw.files.cumulativeReadinessAssessment === "string"
					? raw.files.cumulativeReadinessAssessment
					: "",
			cumulativeSummary:
				typeof raw.files.cumulativeSummary === "string"
					? raw.files.cumulativeSummary
					: "",
		},
	};
}

function runStep(
	label: string,
	binary: string,
	args: string[],
	options: { quiet: boolean },
): void {
	if (!options.quiet) {
		process.stderr.write(`[soak-runner] ${label}...\n`);
	}

	const result = spawnSync(binary, args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});

	if (!options.quiet) {
		if (result.stdout) process.stdout.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
	}

	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = result.stderr?.trim() || result.stdout?.trim();
		throw new Error(
			`${label} failed with exit code ${result.status ?? "unknown"}${
				detail ? `\n${detail}` : ""
			}`,
		);
	}
}

function packageManagerCommand(args: string[]): { binary: string; args: string[] } {
	if (process.env.npm_execpath) {
		return {
			binary: process.execPath,
			args: [process.env.npm_execpath, ...args],
		};
	}
	return { binary: "pnpm", args };
}

function runPackageManagerStep(
	label: string,
	args: string[],
	options: { quiet: boolean },
): void {
	const command = packageManagerCommand(args);
	runStep(label, command.binary, command.args, options);
}

function removeIfExists(path: string): void {
	try {
		unlinkSync(path);
	} catch (error) {
		if (!isObject(error) || error.code !== "ENOENT") {
			throw error;
		}
	}
}

function assertNoUncleanState(statePath: string): void {
	if (!existsSync(statePath)) return;
	throw new Error(
		[
			`Unclean Rust soak runner state found at ${rel(statePath)}.`,
			"Investigate the previous run before starting new soak credit; a killed runner may hide a crash, data-loss incident, or blind telemetry gap.",
		].join(" "),
	);
}

function assertLedgerOutsidePacketDir(packetDir: string, ledgerPath: string): void {
	const ledgerRelativeToPacket = relative(packetDir, ledgerPath);
	if (
		ledgerRelativeToPacket === "" ||
		(!ledgerRelativeToPacket.startsWith("..") &&
			!ledgerRelativeToPacket.startsWith("/"))
	) {
		throw new Error(
			"--ledger must be outside --packet-dir because promotion packets clean the packet directory before each run.",
		);
	}
}

function acquireLock(lockPath: string): () => void {
	mkdirSync(dirname(lockPath), { recursive: true });
	let fd: number;
	try {
		fd = openSync(lockPath, "wx");
	} catch (error) {
		if (isObject(error) && error.code === "EEXIST") {
			throw new Error(
				`Another Rust soak runner appears to be active at ${rel(lockPath)}.`,
				{ cause: error },
			);
		}
		throw error;
	}
	writeFileSync(
		fd,
		`${JSON.stringify(
			{
				pid: process.pid,
				startedAt: new Date().toISOString(),
			},
			null,
			2,
		)}\n`,
	);
	return () => {
		closeSync(fd);
		removeIfExists(lockPath);
	};
}

function writeRunState(
	statePath: string,
	options: CliOptions,
	runsStarted: number,
): void {
	writeJson(statePath, {
		pid: process.pid,
		startedAt: new Date().toISOString(),
		target: options.target,
		packetDir: options.packetDir,
		ledger: options.ledgerPath,
		releaseTag: options.releaseTag ?? null,
		runsStarted,
		maxRuns: options.maxRuns,
		untilTarget: options.untilTarget,
		benchmarkMode: options.benchmarkMode,
	});
}

function packetArgs(options: CliOptions): string[] {
	const args = [
		"run",
		"promotion:rust-packet",
		"--",
		"--output-dir",
		options.packetDir,
		"--iterations",
		String(options.iterations),
		"--min-seconds",
		String(options.minSeconds),
		"--benchmark-mode",
		options.benchmarkMode,
		"--quiet",
	];
	if (options.releaseTag) {
		args.push("--release-tag", options.releaseTag);
	}
	return args;
}

function ledgerArgs(options: CliOptions, summaryPath: string): string[] {
	return [
		"run",
		"promotion:rust-soak-ledger",
		"--",
		"--packet-dir",
		options.packetDir,
		"--ledger",
		options.ledgerPath,
		"--summary-output",
		rel(summaryPath),
		"--quiet",
	];
}

function requiredDecision(target: Target): DeployReadinessDecision {
	return target === "replace" ? "REPLACE" : "CANARY";
}

function scorerMeetsTarget(readiness: ReadinessAssessment, target: Target): boolean {
	return (
		DECISION_RANK[readiness.decision] >= DECISION_RANK[requiredDecision(target)]
	);
}

function hasRequiredPerformanceEvidence(
	summary: LedgerSummary,
	target: Target,
): boolean {
	return target !== "replace" || summary.qualifiedPerformanceEvidence;
}

function targetStatus(
	summary: LedgerSummary,
	target: Target,
	targetHours: number,
	usesTargetHoursOverride: boolean,
): { reached: boolean; satisfiedBy: StopSatisfiedBy } {
	if (summary.continuousSoakHours < targetHours) {
		return { reached: false, satisfiedBy: null };
	}
	if (
		scorerMeetsTarget(summary.readiness, target) &&
		hasRequiredPerformanceEvidence(summary, target)
	) {
		return { reached: true, satisfiedBy: "scorer" };
	}
	if (usesTargetHoursOverride && summary.readiness.failingGate === "soak") {
		return { reached: true, satisfiedBy: "target-hours-override" };
	}
	return { reached: false, satisfiedBy: null };
}

function canMoreSoakReachTarget(summary: LedgerSummary): boolean {
	return summary.readiness.failingGate === "soak";
}

function buildRunnerSummary(
	options: CliOptions,
	ledgerSummary: LedgerSummary,
	summaryPath: string,
	runsStarted: number,
	stopReason: StopReason,
): RunnerSummary {
	const targetHours =
		options.targetHoursOverride ?? REQUIRED_SOAK_HOURS[options.target];
	const targetHoursSource: TargetHoursSource =
		options.targetHoursOverride === undefined ? "default" : "override";
	const status = targetStatus(
		ledgerSummary,
		options.target,
		targetHours,
		targetHoursSource === "override",
	);
	const targetReached =
		scorerMeetsTarget(ledgerSummary.readiness, options.target) &&
		hasRequiredPerformanceEvidence(ledgerSummary, options.target);

	return {
		generatedAt: new Date().toISOString(),
		target: options.target,
		targetHours,
		targetHoursSource,
		targetReached,
		targetSatisfiedBy: targetReached ? "scorer" : null,
		smokeTargetReached:
			!targetReached && status.satisfiedBy === "target-hours-override",
		stopReason,
		runsStarted,
		maxRuns: options.maxRuns,
		untilTarget: options.untilTarget,
		iterationsPerPacket: options.iterations,
		minSecondsPerPacket: options.minSeconds,
		benchmarkMode: options.benchmarkMode,
		releaseTag: options.releaseTag ?? null,
		readiness: ledgerSummary.readiness,
		totalSoakHours: ledgerSummary.totalSoakHours,
		continuousSoakHours: ledgerSummary.continuousSoakHours,
		continuityLostHours: ledgerSummary.continuityLostHours,
		releaseTaggedSoakHours: ledgerSummary.releaseTaggedSoakHours,
		qualifiedPerformanceEvidence: ledgerSummary.qualifiedPerformanceEvidence,
		releaseE2ePass: ledgerSummary.releaseE2ePass,
		publicSurfaceCoveragePercent: ledgerSummary.publicSurfaceCoveragePercent,
		httpDeployEnvCoveragePercent: ledgerSummary.httpDeployEnvCoveragePercent,
		rustBinarySha256: ledgerSummary.rustBinarySha256,
		remainingSoakHours: Math.max(
			0,
			targetHours - ledgerSummary.continuousSoakHours,
		),
		files: {
			packetDir: options.packetDir,
			ledger: options.ledgerPath,
			ledgerSummary: ledgerSummary.files.cumulativeSummary,
			runnerSummary: rel(summaryPath),
		},
	};
}

function printSummary(summary: RunnerSummary): void {
	process.stderr.write(
		[
			"Rust soak runner",
			`  target:              ${summary.target}`,
			`  target reached:      ${summary.targetReached}`,
			`  satisfied by:        ${summary.targetSatisfiedBy ?? "none"}`,
			`  smoke target:        ${summary.smokeTargetReached}`,
			`  stop reason:         ${summary.stopReason}`,
			`  runs started:        ${summary.runsStarted}`,
			`  until target:        ${summary.untilTarget}`,
			`  benchmark mode:      ${summary.benchmarkMode}`,
			`  total soak hours:    ${summary.totalSoakHours.toFixed(4)}`,
			`  continuous soak:     ${summary.continuousSoakHours.toFixed(4)}`,
			`  continuity lost:     ${summary.continuityLostHours.toFixed(4)}`,
			`  qualified perf:      ${summary.qualifiedPerformanceEvidence}`,
			`  release e2e:         ${summary.releaseE2ePass} (${summary.publicSurfaceCoveragePercent}%)`,
			`  binary sha256:       ${summary.rustBinarySha256?.slice(0, 16) ?? "unavailable"}`,
			`  remaining hours:     ${summary.remainingSoakHours.toFixed(4)}`,
			`  readiness:           ${summary.readiness.decision}`,
			`  failing gate:        ${summary.readiness.failingGate ?? "none"}`,
			`  runner summary:      ${summary.files.runnerSummary}`,
			"",
		].join("\n"),
	);
}

try {
	const options = parseArgs(process.argv.slice(2));
	const packetDir = resolve(REPO_ROOT, options.packetDir);
	const ledgerPath = resolve(REPO_ROOT, options.ledgerPath);
	assertLedgerOutsidePacketDir(packetDir, ledgerPath);
	const ledgerSummaryPath = resolve(packetDir, "soak-ledger-summary.json");
	const runnerSummaryPath = resolve(
		REPO_ROOT,
		options.summaryOutput ?? join(options.packetDir, "soak-runner-summary.json"),
	);
	const lockPath = resolve(REPO_ROOT, RUNNER_LOCK);
	const statePath = resolve(REPO_ROOT, RUNNER_STATE);
	assertNoUncleanState(statePath);
	const releaseLock = acquireLock(lockPath);
	let exitCode = 0;

	try {
		let runsStarted = 0;
		let latestLedgerSummary: LedgerSummary | null = null;
		let latestStatus: ReturnType<typeof targetStatus> = {
			reached: false,
			satisfiedBy: null,
		};
		let stopReason: StopReason = "max-runs-exhausted";

		while (options.maxRuns === null || runsStarted < options.maxRuns) {
			writeRunState(statePath, options, runsStarted);
			runPackageManagerStep("promotion packet", packetArgs(options), options);
			runPackageManagerStep(
				"append packet to soak ledger",
				ledgerArgs(options, ledgerSummaryPath),
				options,
			);
			runsStarted += 1;
			latestLedgerSummary = parseLedgerSummary(ledgerSummaryPath);
			latestStatus = targetStatus(
				latestLedgerSummary,
				options.target,
				options.targetHoursOverride ?? REQUIRED_SOAK_HOURS[options.target],
				options.targetHoursOverride !== undefined,
			);
			if (latestStatus.reached) {
				stopReason = "target-reached";
				break;
			}
			if (options.untilTarget && !canMoreSoakReachTarget(latestLedgerSummary)) {
				stopReason = "non-soak-gate-blocked";
				break;
			}
		}

		if (!latestLedgerSummary) {
			throw new Error("No soak runs were started.");
		}

		const runnerSummary = buildRunnerSummary(
			options,
			latestLedgerSummary,
			runnerSummaryPath,
			runsStarted,
			stopReason,
		);

		writeJson(runnerSummaryPath, runnerSummary);
		if (!options.quiet) printSummary(runnerSummary);

		if (
			options.requireTarget &&
			!runnerSummary.targetReached &&
			!runnerSummary.smokeTargetReached
		) {
			exitCode = 2;
		}
	} finally {
		removeIfExists(statePath);
		releaseLock();
	}

	if (exitCode !== 0) {
		process.exit(exitCode);
	}
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
