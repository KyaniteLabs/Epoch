#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust soak status
//
// Read-only operator view over the cumulative Rust soak ledger. This avoids
// treating the in-progress packet directory as durable evidence while a long
// replacement soak is running.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	assessDeployReadiness,
	type ReadinessAssessment,
	type ReadinessInput,
} from "./rust-deploy-readiness.js";
import {
	hasRequiredPackageCommands,
	packageCommandsFromUnknown,
	type PackageCommandEvidence,
} from "./rust-package-evidence.js";

type Target = "canary" | "replace";
type RunnerState = {
	pid: number | null;
	startedAt: string | null;
	currentRunStartedAt: string | null;
	target: Target | null;
	packetDir: string | null;
	ledger: string | null;
	releaseTag: string | null;
	runsStarted: number | null;
	maxRuns: number | null;
	untilTarget: boolean | null;
	benchmarkMode: string | null;
};
type ShadowSoakProgress = {
	status: "running" | "complete";
	updatedAt: string;
	startedAt: string;
	elapsedMs: number;
	iterationsRequested: number;
	iterationsCompleted: number;
	minSecondsRequested: number;
	minSecondsRemaining: number;
	output: string | null;
	releaseTag: string | null;
};
type PromotionPacketProgress = {
	status: "running" | "complete" | "failed";
	updatedAt: string;
	startedAt: string;
	elapsedMs: number;
	outputDir: string | null;
	releaseTag: string | null;
	benchmarkMode: string | null;
	currentStep: string | null;
	completedSteps: string[];
	error: string | null;
};
type BenchmarkProgress = {
	status: "running" | "complete" | "failed";
	updatedAt: string;
	startedAt: string;
	elapsedMs: number;
	output: string | null;
	smoke: boolean | null;
	iterationsScale: number;
	maxIterationsPerTool: number;
	toolsTotal: number;
	toolsCompleted: number;
	currentTool: string | null;
	currentToolIndex: number | null;
	currentToolIterations: number | null;
	completedTools: string[];
	error: string | null;
};
type ReplacementScorecardStatus = {
	decision: string | null;
	failingGate: string | null;
	readyToReplace: boolean;
	functionalCompatibilityPercent: number;
	replacementGatePassPercent: number;
	gatesPassed: number;
	gatesTotal: number;
	medianLatencyImprovementPercent: number;
	p95LatencyImprovementPercent: number;
	continuousSoakHours: number;
	requiredContinuousSoakHours: number;
};
type LedgerRun = {
	id: string;
	generatedAt: string;
	startedAt: string | null;
	endedAt: string | null;
	releaseTag: string | null;
	rustBinarySha256: string | null;
	publicSurfaceMatch: boolean;
	releaseE2ePass: boolean;
	publicSurfaceCoveragePercent: number;
	httpDeployEnvCoveragePercent: number;
	packageSmokePass: boolean;
	packageCommands: PackageCommandEvidence[];
	packageCliSha256: string | null;
	soakHours: number;
	continuousSoakHours: number;
	crashes: number;
	dataLossIncidents: number;
	unresolvedTelemetryAnomalies: number;
	rollbackValidated: boolean;
	rollbackRehearsed: boolean;
	outputParityPercent: number;
	errorCompatibilityPercent: number;
	unclassifiedFailures: number;
	observabilityLevel: string | null;
	medianLatencyImprovementPercent: number;
	p95LatencyImprovementPercent: number;
	startupImprovementPercent: number;
	memoryImprovementPercent: number;
	performanceEvidenceMode: "smoke" | "qualified";
	performanceToolsBenchmarked: number | null;
	performanceIterationsScale: number | null;
	readinessDecision: string | null;
	readinessFailingGate: string | null;
};
type SoakLedger = {
	version: 1;
	updatedAt: string;
	runs: LedgerRun[];
	ignoredRunCount: number;
};
type SoakStatus = {
	generatedAt: string;
	ledger: string;
	ledgerExists: boolean;
	runCount: number;
	ignoredRunCount: number;
	activeRunner: boolean;
	runnerState: RunnerState | null;
	activePromotionPacketProgress: PromotionPacketProgress | null;
	activeBenchmarkProgress: BenchmarkProgress | null;
	activeShadowSoakProgress: ShadowSoakProgress | null;
	activeReplacementScorecard: ReplacementScorecardStatus | null;
	totalCompletedSoakHours: number;
	continuousCleanSoakHours: number;
	continuityLostHours: number;
	continuousGapSeconds: number;
	releaseTaggedSoakHours: number;
	releaseContinuousSoakHours: number;
	releaseTag: string | null;
	qualifiedPerformanceEvidence: boolean;
	releaseE2ePass: boolean;
	publicSurfaceCoveragePercent: number;
	httpDeployEnvCoveragePercent: number;
	packageSmokePass: boolean;
	packageCommandEvidenceComplete: boolean;
	packageCliSha256: string | null;
	remainingCanaryHours: number;
	remainingReplaceHours: number;
	latestRun: LedgerRun | null;
	rustBinarySha256: string | null;
	readinessDecision: string | null;
	readinessFailingGate: string | null;
	warnings: string[];
};

type CliOptions = {
	ledgerPath: string;
	statePath: string;
	json: boolean;
	strict: boolean;
};

const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);
const DEFAULT_LEDGER = ".epoch-promotion/soak-ledger.json";
const DEFAULT_STATE = ".epoch-promotion/soak-runner-state.json";
const MAX_CONTINUOUS_GAP_MS = 15 * 60_000;
const CANARY_SOAK_HOURS = 24;
const REPLACE_SOAK_HOURS = 72;
const REQUIRED_QUALIFIED_BENCHMARK_TOOLS = 24;
const MIN_QUALIFIED_ITERATIONS_SCALE = 1;
const REPLACEMENT_NEEDS_QUALIFIED_PERFORMANCE_WARNING =
	"Replacement runner has not recorded release-tagged qualified non-smoke performance evidence; soak time may continue, but replacement remains gated until a release-tagged qualified benchmark run is in the ledger.";

function usage(): string {
	return [
		"Usage: tsx src/contract/rust-soak-status.ts [options]",
		"",
		"Options:",
		`  --ledger <path>  Cumulative soak ledger (default: ${DEFAULT_LEDGER})`,
		`  --state <path>   Soak runner state file (default: ${DEFAULT_STATE})`,
		"  --json           Emit machine-readable status JSON",
		"  --strict         Exit 2 when the report includes warnings",
		"  --help, -h       Show this help",
		"",
	].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		ledgerPath: DEFAULT_LEDGER,
		statePath: DEFAULT_STATE,
		json: false,
		strict: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--ledger") {
			options.ledgerPath = args[++i] ?? "";
		} else if (arg === "--state") {
			options.statePath = args[++i] ?? "";
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--strict") {
			options.strict = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
	}

	if (!options.ledgerPath.trim()) throw new Error("--ledger must not be empty.");
	if (!options.statePath.trim()) throw new Error("--state must not be empty.");
	return options;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonIfExists(path: string): unknown | null {
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function numberField(
	object: Record<string, unknown>,
	key: string,
	fallback = 0,
): number {
	const value = object[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringField(
	object: Record<string, unknown>,
	key: string,
): string | null {
	const value = object[key];
	return typeof value === "string" ? value : null;
}

function booleanField(
	object: Record<string, unknown>,
	key: string,
): boolean | null {
	const value = object[key];
	return typeof value === "boolean" ? value : null;
}

function parseLedgerRun(raw: unknown): LedgerRun | null {
	if (!isObject(raw)) return null;
	if (
		typeof raw.id !== "string" ||
		typeof raw.generatedAt !== "string" ||
		typeof raw.soakHours !== "number"
	) {
		return null;
	}
	return {
		id: raw.id,
		generatedAt: raw.generatedAt,
		startedAt: stringField(raw, "startedAt"),
		endedAt: stringField(raw, "endedAt"),
		releaseTag: stringField(raw, "releaseTag"),
		rustBinarySha256: stringField(raw, "rustBinarySha256"),
		publicSurfaceMatch: raw.publicSurfaceMatch === true,
		releaseE2ePass: raw.releaseE2ePass === true,
		publicSurfaceCoveragePercent: numberField(
			raw,
			"publicSurfaceCoveragePercent",
		),
		httpDeployEnvCoveragePercent: numberField(
			raw,
			"httpDeployEnvCoveragePercent",
		),
		packageSmokePass: raw.packageSmokePass === true,
		packageCommands: packageCommandsFromUnknown(raw.packageCommands),
		packageCliSha256: stringField(raw, "packageCliSha256"),
		soakHours: numberField(raw, "soakHours"),
		continuousSoakHours: numberField(raw, "continuousSoakHours"),
		crashes: numberField(raw, "crashes"),
		dataLossIncidents: numberField(raw, "dataLossIncidents"),
		unresolvedTelemetryAnomalies: numberField(
			raw,
			"unresolvedTelemetryAnomalies",
		),
		rollbackValidated: raw.rollbackValidated === true,
		rollbackRehearsed: raw.rollbackRehearsed === true,
		outputParityPercent: numberField(raw, "outputParityPercent"),
		errorCompatibilityPercent: numberField(raw, "errorCompatibilityPercent"),
		unclassifiedFailures: numberField(raw, "unclassifiedFailures"),
		observabilityLevel: stringField(raw, "observabilityLevel"),
		medianLatencyImprovementPercent: numberField(
			raw,
			"medianLatencyImprovementPercent",
		),
		p95LatencyImprovementPercent: numberField(
			raw,
			"p95LatencyImprovementPercent",
		),
		startupImprovementPercent: numberField(
			raw,
			"startupImprovementPercent",
		),
		memoryImprovementPercent: numberField(raw, "memoryImprovementPercent"),
		performanceEvidenceMode:
			raw.performanceEvidenceMode === "qualified" ? "qualified" : "smoke",
		performanceToolsBenchmarked:
			typeof raw.performanceToolsBenchmarked === "number"
				? raw.performanceToolsBenchmarked
				: null,
		performanceIterationsScale:
			typeof raw.performanceIterationsScale === "number"
				? raw.performanceIterationsScale
				: null,
		readinessDecision: stringField(raw, "readinessDecision"),
		readinessFailingGate: stringField(raw, "readinessFailingGate"),
	};
}

function parseLedger(raw: unknown): SoakLedger {
	if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.runs)) {
		throw new Error("Invalid Rust soak ledger.");
	}
	const runs = raw.runs
		.map(parseLedgerRun)
		.filter((run): run is LedgerRun => run !== null);
	return {
		version: 1,
		updatedAt: stringField(raw, "updatedAt") ?? new Date(0).toISOString(),
		runs,
		ignoredRunCount: raw.runs.length - runs.length,
	};
}

function parseRunnerState(raw: unknown): RunnerState | null {
	if (!isObject(raw)) return null;
	const target = stringField(raw, "target");
	return {
		pid: Number.isInteger(raw.pid) ? Number(raw.pid) : null,
		startedAt: stringField(raw, "startedAt"),
		currentRunStartedAt: stringField(raw, "currentRunStartedAt"),
		target: target === "canary" || target === "replace" ? target : null,
		packetDir: stringField(raw, "packetDir"),
		ledger: stringField(raw, "ledger"),
		releaseTag: stringField(raw, "releaseTag"),
		runsStarted: Number.isInteger(raw.runsStarted)
			? Number(raw.runsStarted)
			: null,
		maxRuns:
			Number.isInteger(raw.maxRuns) || raw.maxRuns === null
				? (raw.maxRuns as number | null)
				: null,
		untilTarget: booleanField(raw, "untilTarget"),
		benchmarkMode: stringField(raw, "benchmarkMode"),
	};
}

function parseShadowSoakProgress(raw: unknown): ShadowSoakProgress | null {
	if (!isObject(raw)) return null;
	const status = stringField(raw, "status");
	if (status !== "running" && status !== "complete") return null;
	const updatedAt = stringField(raw, "updatedAt");
	const startedAt = stringField(raw, "startedAt");
	if (!updatedAt || !startedAt) return null;
	return {
		status,
		updatedAt,
		startedAt,
		elapsedMs: numberField(raw, "elapsedMs"),
		iterationsRequested: numberField(raw, "iterationsRequested"),
		iterationsCompleted: numberField(raw, "iterationsCompleted"),
		minSecondsRequested: numberField(raw, "minSecondsRequested"),
		minSecondsRemaining: numberField(raw, "minSecondsRemaining"),
		output: stringField(raw, "output"),
		releaseTag: stringField(raw, "releaseTag"),
	};
}

function parsePromotionPacketProgress(raw: unknown): PromotionPacketProgress | null {
	if (!isObject(raw)) return null;
	const status = stringField(raw, "status");
	if (status !== "running" && status !== "complete" && status !== "failed") {
		return null;
	}
	const updatedAt = stringField(raw, "updatedAt");
	const startedAt = stringField(raw, "startedAt");
	if (!updatedAt || !startedAt) return null;
	return {
		status,
		updatedAt,
		startedAt,
		elapsedMs: numberField(raw, "elapsedMs"),
		outputDir: stringField(raw, "outputDir"),
		releaseTag: stringField(raw, "releaseTag"),
		benchmarkMode: stringField(raw, "benchmarkMode"),
		currentStep: stringField(raw, "currentStep"),
		completedSteps: Array.isArray(raw.completedSteps)
			? raw.completedSteps.filter((step): step is string => typeof step === "string")
			: [],
		error: stringField(raw, "error"),
	};
}

function parseBenchmarkProgress(raw: unknown): BenchmarkProgress | null {
	if (!isObject(raw)) return null;
	const status = stringField(raw, "status");
	if (status !== "running" && status !== "complete" && status !== "failed") {
		return null;
	}
	const updatedAt = stringField(raw, "updatedAt");
	const startedAt = stringField(raw, "startedAt");
	if (!updatedAt || !startedAt) return null;
	return {
		status,
		updatedAt,
		startedAt,
		elapsedMs: numberField(raw, "elapsedMs"),
		output: stringField(raw, "output"),
		smoke: booleanField(raw, "smoke"),
		iterationsScale: numberField(raw, "iterationsScale"),
		maxIterationsPerTool: numberField(raw, "maxIterationsPerTool"),
		toolsTotal: numberField(raw, "toolsTotal"),
		toolsCompleted: numberField(raw, "toolsCompleted"),
		currentTool: stringField(raw, "currentTool"),
		currentToolIndex:
			typeof raw.currentToolIndex === "number" ? raw.currentToolIndex : null,
		currentToolIterations:
			typeof raw.currentToolIterations === "number"
				? raw.currentToolIterations
				: null,
		completedTools: Array.isArray(raw.completedTools)
			? raw.completedTools.filter((tool): tool is string => typeof tool === "string")
			: [],
		error: stringField(raw, "error"),
	};
}

function parseReplacementScorecard(
	raw: unknown,
): ReplacementScorecardStatus | null {
	if (!isObject(raw)) return null;
	const summary = isObject(raw.summary) ? raw.summary : {};
	const gatesPassed = numberField(raw, "gatesPassed", -1);
	const gatesTotal = numberField(raw, "gatesTotal", -1);
	const replacementGatePassPercent = numberField(
		raw,
		"replacementGatePassPercent",
		-1,
	);
	const functionalCompatibilityPercent = numberField(
		raw,
		"functionalCompatibilityPercent",
		-1,
	);
	if (
		gatesPassed < 0 ||
		gatesTotal < 0 ||
		replacementGatePassPercent < 0 ||
		functionalCompatibilityPercent < 0
	) {
		return null;
	}
	return {
		decision: stringField(raw, "decision"),
		failingGate: stringField(raw, "failingGate"),
		readyToReplace: raw.readyToReplace === true,
		functionalCompatibilityPercent,
		replacementGatePassPercent,
		gatesPassed,
		gatesTotal,
		medianLatencyImprovementPercent: numberField(
			summary,
			"medianLatencyImprovementPercent",
		),
		p95LatencyImprovementPercent: numberField(
			summary,
			"p95LatencyImprovementPercent",
		),
		continuousSoakHours: numberField(summary, "continuousSoakHours"),
		requiredContinuousSoakHours: numberField(
			summary,
			"requiredContinuousSoakHours",
			REPLACE_SOAK_HOURS,
		),
	};
}

function numberSum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function numberMin(values: number[]): number {
	return values.length ? Math.min(...values) : 0;
}

function boolAll(values: boolean[]): boolean {
	return values.length > 0 && values.every(Boolean);
}

function boolSome(values: boolean[]): boolean {
	return values.some(Boolean);
}

function hasReleaseQualifiedPerformanceEvidence(run: LedgerRun): boolean {
	return (
		run.performanceEvidenceMode === "qualified" &&
		(run.performanceToolsBenchmarked ?? 0) >=
			REQUIRED_QUALIFIED_BENCHMARK_TOOLS &&
		(run.performanceIterationsScale ?? 0) >= MIN_QUALIFIED_ITERATIONS_SCALE &&
		run.observabilityLevel === "release" &&
		run.releaseTag !== null
	);
}

function releaseIdentitySet(runs: LedgerRun[]): Set<string> {
	return new Set(
		runs
			.filter(
				(run) => run.observabilityLevel === "release" && run.releaseTag !== null,
			)
			.map((run) => run.releaseTag)
			.filter((releaseTag): releaseTag is string => releaseTag !== null),
	);
}

function cleanIntervalForRun(
	run: LedgerRun,
): { startMs: number; endMs: number } | null {
	if (
		!run.publicSurfaceMatch ||
		!run.releaseE2ePass ||
		!run.packageSmokePass ||
		!hasRequiredPackageCommands(run.packageCommands) ||
		run.publicSurfaceCoveragePercent < 100 ||
		run.httpDeployEnvCoveragePercent < 100 ||
		run.unclassifiedFailures > 0 ||
		run.crashes > 0 ||
		run.dataLossIncidents > 0 ||
		run.unresolvedTelemetryAnomalies > 0
	) {
		return null;
	}
	const startMs = run.startedAt ? Date.parse(run.startedAt) : Number.NaN;
	const endMs = run.endedAt ? Date.parse(run.endedAt) : Number.NaN;
	if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) {
		return null;
	}
	const observedMs = Math.min(
		run.continuousSoakHours * 3_600_000,
		endMs - startMs,
	);
	if (observedMs <= 0) return null;
	return { startMs, endMs: startMs + observedMs };
}

function longestContinuousCleanSoakHours(runs: LedgerRun[]): number {
	const intervals = runs
		.map(cleanIntervalForRun)
		.filter((interval): interval is { startMs: number; endMs: number } =>
			Boolean(interval),
		)
		.sort((left, right) => left.startMs - right.startMs);

	let currentEndMs = 0;
	let currentObservedMs = 0;
	let longestObservedMs = 0;

	for (const interval of intervals) {
		if (
			currentObservedMs === 0 ||
			interval.startMs > currentEndMs + MAX_CONTINUOUS_GAP_MS
		) {
			currentEndMs = interval.endMs;
			currentObservedMs = interval.endMs - interval.startMs;
		} else {
			const observedStartMs = Math.max(interval.startMs, currentEndMs);
			const extensionMs = Math.max(0, interval.endMs - observedStartMs);
			currentEndMs = Math.max(currentEndMs, interval.endMs);
			currentObservedMs += extensionMs;
		}
		longestObservedMs = Math.max(longestObservedMs, currentObservedMs);
	}

	return longestObservedMs / 3_600_000;
}

function releaseTaggedRuns(runs: LedgerRun[]): LedgerRun[] {
	return runs.filter(
		(run) => run.observabilityLevel === "release" && run.releaseTag !== null,
	);
}

function isRunnerProcessAlive(state: RunnerState | null): boolean {
	if (!state?.pid) return false;
	try {
		process.kill(state.pid, 0);
		return true;
	} catch {
		return false;
	}
}

function rel(path: string): string {
	return relative(REPO_ROOT, path);
}

function runnerPathBaseFromStatePath(statePath: string): string {
	const stateDir = dirname(statePath);
	return basename(stateDir) === ".epoch-promotion" ? dirname(stateDir) : stateDir;
}

function resolveStatusPath(base: string, path: string): string {
	return resolve(base, path);
}

function statusPathForOutput(path: string | null, base: string): string | null {
	if (path === null || !isAbsolute(path)) return path;
	const relativePath = relative(base, path);
	if (relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
		return relativePath;
	}
	return rel(path);
}

function cumulativeReadiness(
	runs: LedgerRun[],
	rustBinarySha256: string | null,
	totalCompletedSoakHours: number,
	continuousCleanSoakHours: number,
	releaseTaggedSoakHours: number,
	releaseE2ePass: boolean,
	publicSurfaceCoveragePercent: number,
	httpDeployEnvCoveragePercent: number,
	packageSmokePass: boolean,
): ReadinessAssessment | null {
	if (runs.length === 0) return null;
	const outputParityPercent = numberMin(
		runs.map((run) => run.outputParityPercent),
	);
	const errorCompatibilityPercent = numberMin(
		runs.map((run) => run.errorCompatibilityPercent),
	);
	const unclassifiedFailures = numberSum(
		runs.map((run) => run.unclassifiedFailures),
	);
	const allSoakIsRelease =
		totalCompletedSoakHours > 0 &&
		Math.abs(releaseTaggedSoakHours - totalCompletedSoakHours) < 1e-9;
	const input: ReadinessInput = {
		parity: {
			publicSurfaceMatch: boolAll(runs.map((run) => run.publicSurfaceMatch)),
			releaseE2ePass,
			publicSurfaceCoveragePercent,
			httpDeployEnvCoveragePercent,
			packageSmokePass,
			outputParityPercent,
			errorCompatibilityPercent,
			unclassifiedFailures,
			rustBinarySha256,
			soakHours: totalCompletedSoakHours,
			continuousSoakHours: continuousCleanSoakHours,
			crashes: numberSum(runs.map((run) => run.crashes)),
			dataLossIncidents: numberSum(runs.map((run) => run.dataLossIncidents)),
			rollbackValidated: boolSome(runs.map((run) => run.rollbackValidated)),
			rollbackRehearsed: boolSome(runs.map((run) => run.rollbackRehearsed)),
			observabilityLevel: allSoakIsRelease ? "release" : "tool",
			unresolvedTelemetryAnomalies: numberSum(
				runs.map((run) => run.unresolvedTelemetryAnomalies),
			),
			compatibilityExceptionsApproved:
				outputParityPercent >= 100 &&
				errorCompatibilityPercent >= 100 &&
				unclassifiedFailures === 0,
		},
		perf: {
			medianLatencyImprovementPercent: numberMin(
				runs.map((run) => run.medianLatencyImprovementPercent),
			),
			p95LatencyImprovementPercent: numberMin(
				runs.map((run) => run.p95LatencyImprovementPercent),
			),
			startupImprovementPercent: numberMin(
				runs.map((run) => run.startupImprovementPercent),
			),
			memoryImprovementPercent: numberMin(
				runs.map((run) => run.memoryImprovementPercent),
			),
		},
	};
	return assessDeployReadiness(input);
}

export function buildSoakStatus(input: {
	ledgerPath: string;
	ledgerRaw: unknown | null;
	stateRaw?: unknown | null;
	runnerPathBase?: string;
	activePromotionPacketProgressRaw?: unknown | null;
	activeBenchmarkProgressRaw?: unknown | null;
	activeShadowSoakProgressRaw?: unknown | null;
	activeReplacementScorecardRaw?: unknown | null;
	generatedAt?: string;
	runnerAlive?: boolean;
}): SoakStatus {
	const ledger = input.ledgerRaw === null ? null : parseLedger(input.ledgerRaw);
	const runs = ledger?.runs ?? [];
	const latestRun = runs.at(-1) ?? null;
	const runnerState = parseRunnerState(input.stateRaw ?? null);
	const runnerProcessAlive =
		input.runnerAlive ?? (runnerState ? isRunnerProcessAlive(runnerState) : false);
	const ledgerPath = resolve(REPO_ROOT, input.ledgerPath);
	const runnerPathBase = input.runnerPathBase ?? REPO_ROOT;
	const runnerLedgerPath = runnerState?.ledger
		? resolveStatusPath(runnerPathBase, runnerState.ledger)
		: null;
	const runnerLedgerMatches =
		runnerLedgerPath !== null && runnerLedgerPath === ledgerPath;
	const activeRunner = runnerProcessAlive && runnerLedgerMatches;
	const activePromotionPacketProgress = activeRunner
		? parsePromotionPacketProgress(input.activePromotionPacketProgressRaw ?? null)
		: null;
	const activeBenchmarkProgress = activeRunner
		? parseBenchmarkProgress(input.activeBenchmarkProgressRaw ?? null)
		: null;
	const activeShadowSoakProgress = activeRunner
		? parseShadowSoakProgress(input.activeShadowSoakProgressRaw ?? null)
		: null;
	if (activePromotionPacketProgress) {
		activePromotionPacketProgress.outputDir = statusPathForOutput(
			activePromotionPacketProgress.outputDir,
			runnerPathBase,
		);
	}
	if (activeBenchmarkProgress) {
		activeBenchmarkProgress.output = statusPathForOutput(
			activeBenchmarkProgress.output,
			runnerPathBase,
		);
	}
	if (activeShadowSoakProgress) {
		activeShadowSoakProgress.output = statusPathForOutput(
			activeShadowSoakProgress.output,
			runnerPathBase,
		);
	}
	const activeReplacementScorecard = activeRunner
		? parseReplacementScorecard(input.activeReplacementScorecardRaw ?? null)
		: null;
	const identities = new Set(
		runs
			.map((run) => run.rustBinarySha256)
			.filter((value): value is string => Boolean(value)),
	);
	const totalCompletedSoakHours = numberSum(runs.map((run) => run.soakHours));
	const continuousCleanSoakHours = longestContinuousCleanSoakHours(runs);
	const releaseTaggedSoakHours = numberSum(
		releaseTaggedRuns(runs).map((run) => run.soakHours),
	);
	const releaseContinuousSoakHours = longestContinuousCleanSoakHours(
		releaseTaggedRuns(runs),
	);
	const releaseTags = releaseIdentitySet(runs);
	const releaseTag =
		releaseTags.size === 1 ? Array.from(releaseTags)[0] ?? null : null;
	const qualifiedPerformanceEvidence = runs.some(
		hasReleaseQualifiedPerformanceEvidence,
	);
	const releaseE2ePass =
		runs.length > 0 &&
		runs.every(
			(run) =>
				run.releaseE2ePass &&
				run.publicSurfaceCoveragePercent >= 100 &&
				run.httpDeployEnvCoveragePercent >= 100,
		);
	const packageSmokePass =
		runs.length > 0 &&
		runs.every(
			(run) =>
				run.packageSmokePass && hasRequiredPackageCommands(run.packageCommands),
		);
	const packageCommandEvidenceComplete =
		runs.length > 0 &&
		runs.every((run) => hasRequiredPackageCommands(run.packageCommands));
	const packageCliIdentities = new Set(
		runs
			.map((run) => run.packageCliSha256)
			.filter((value): value is string => Boolean(value)),
	);
	const packageCliSha256 =
		packageCliIdentities.size === 1
			? Array.from(packageCliIdentities)[0] ?? null
			: null;
	const publicSurfaceCoveragePercent = numberMin(
		runs.map((run) => run.publicSurfaceCoveragePercent),
	);
	const httpDeployEnvCoveragePercent = numberMin(
		runs.map((run) => run.httpDeployEnvCoveragePercent),
	);
	const rustBinarySha256 =
		identities.size === 1 ? Array.from(identities)[0] ?? null : null;
	const readiness = cumulativeReadiness(
		runs,
		rustBinarySha256,
		totalCompletedSoakHours,
		continuousCleanSoakHours,
		releaseTaggedSoakHours,
		releaseE2ePass,
		publicSurfaceCoveragePercent,
		httpDeployEnvCoveragePercent,
		packageSmokePass,
	);
	const warnings: string[] = [];

	if ((ledger?.ignoredRunCount ?? 0) > 0) {
		warnings.push("Ledger includes malformed or incomplete run records that were not credited.");
	}
	if (runs.some((run) => !run.rustBinarySha256)) {
		warnings.push("At least one soak run is missing rustBinarySha256.");
	}
	if (identities.size > 1) {
		warnings.push("Soak ledger contains multiple Rust binary identities.");
	}
	if (runs.some((run) => !run.packageCliSha256)) {
		warnings.push("At least one soak run is missing packageCliSha256.");
	}
	if (packageCliIdentities.size > 1) {
		warnings.push("Soak ledger contains multiple packaged CLI identities.");
	}
	if (
		rustBinarySha256 !== null &&
		packageCliSha256 !== null &&
		rustBinarySha256 !== packageCliSha256
	) {
		warnings.push("Packaged CLI SHA-256 does not match the soaked Rust binary.");
	}
	if (releaseTags.size > 1) {
		warnings.push("Soak ledger contains multiple release identities.");
	}
	if (!runnerProcessAlive && runnerState !== null) {
		warnings.push("Runner state exists, but the recorded process is not alive.");
	}
	if (runnerProcessAlive && runnerState?.ledger === null) {
		warnings.push(
			"Runner state is missing its ledger path; cannot prove it is writing this ledger.",
		);
	}
	if (runnerProcessAlive && runnerState?.ledger && !runnerLedgerMatches) {
		warnings.push(
			`Runner is active for ${rel(runnerLedgerPath ?? resolveStatusPath(runnerPathBase, runnerState.ledger))}, not ${rel(ledgerPath)}.`,
		);
	}
	if (activeRunner && runnerState?.target === "replace" && !runnerState.releaseTag) {
		warnings.push(
			"Replacement runner state is missing releaseTag; cannot prove which candidate is still soaking.",
		);
	}
	if (
		activeRunner &&
		runnerState?.releaseTag &&
		latestRun?.releaseTag &&
		runnerState.releaseTag !== latestRun.releaseTag
	) {
		warnings.push(
			`Runner release tag ${runnerState.releaseTag} does not match latest ledger run ${latestRun.releaseTag}.`,
		);
	}
	if (
		activeRunner &&
		runnerState?.target === "replace" &&
		!qualifiedPerformanceEvidence
	) {
		warnings.push(REPLACEMENT_NEEDS_QUALIFIED_PERFORMANCE_WARNING);
	}
	if (
		runs.some(
			(run) =>
				run.crashes > 0 ||
				run.dataLossIncidents > 0 ||
				run.unresolvedTelemetryAnomalies > 0,
		)
	) {
		warnings.push("Ledger includes crashes, data-loss incidents, or telemetry anomalies.");
	}
	if (
		runs.some(
			(run) =>
				!run.publicSurfaceMatch ||
				!run.releaseE2ePass ||
				!run.packageSmokePass ||
				!hasRequiredPackageCommands(run.packageCommands) ||
				run.publicSurfaceCoveragePercent < 100 ||
				run.httpDeployEnvCoveragePercent < 100 ||
				run.outputParityPercent < 100 ||
				run.errorCompatibilityPercent < 100 ||
				run.unclassifiedFailures > 0,
		)
	) {
		warnings.push(
			"Ledger includes public-surface, release-E2E, package-smoke, parity, or unclassified failures.",
		);
	}

	return {
		generatedAt: input.generatedAt ?? new Date().toISOString(),
		ledger: rel(ledgerPath),
		ledgerExists: input.ledgerRaw !== null,
		runCount: runs.length,
		ignoredRunCount: ledger?.ignoredRunCount ?? 0,
		activeRunner,
		runnerState,
		activePromotionPacketProgress,
		activeBenchmarkProgress,
		activeShadowSoakProgress,
		activeReplacementScorecard,
		totalCompletedSoakHours,
		continuousCleanSoakHours,
		continuityLostHours: Math.max(
			0,
			totalCompletedSoakHours - continuousCleanSoakHours,
		),
		continuousGapSeconds: MAX_CONTINUOUS_GAP_MS / 1000,
		releaseTaggedSoakHours,
		releaseContinuousSoakHours,
		releaseTag,
		qualifiedPerformanceEvidence,
		releaseE2ePass,
		publicSurfaceCoveragePercent,
		httpDeployEnvCoveragePercent,
		packageSmokePass,
		packageCommandEvidenceComplete,
		packageCliSha256,
		remainingCanaryHours: Math.max(0, CANARY_SOAK_HOURS - continuousCleanSoakHours),
		remainingReplaceHours: Math.max(
			0,
			REPLACE_SOAK_HOURS - releaseContinuousSoakHours,
		),
		latestRun,
		rustBinarySha256,
		readinessDecision: readiness?.decision ?? null,
		readinessFailingGate: readiness?.failingGate ?? null,
		warnings,
	};
}

function formatHours(value: number): string {
	return value.toFixed(4);
}

function formatFailingGate(status: SoakStatus): string {
	return status.readinessFailingGate ?? (status.readinessDecision ? "none" : "unknown");
}

export function formatSoakStatus(status: SoakStatus): string {
	const latest = status.latestRun;
	const lines = [
		"Epoch Rust soak status",
		`  runner:              ${status.activeRunner ? "active" : "inactive"}`,
		`  ledger:              ${status.ledger}${status.ledgerExists ? "" : " (missing)"}`,
		`  runs recorded:       ${status.runCount}`,
		...(status.ignoredRunCount > 0
			? [`  runs ignored:        ${status.ignoredRunCount}`]
			: []),
		`  completed soak:      ${formatHours(status.totalCompletedSoakHours)}h`,
		`  continuous clean:    ${formatHours(status.continuousCleanSoakHours)}h`,
		`  continuity lost:     ${formatHours(status.continuityLostHours)}h`,
		`  max clean gap:       ${status.continuousGapSeconds}s`,
		`  release-tagged soak: ${formatHours(status.releaseTaggedSoakHours)}h`,
		`  release continuous:  ${formatHours(status.releaseContinuousSoakHours)}h`,
		`  release identity:    ${status.releaseTag ?? "none"}`,
		`  qualified perf:      ${status.qualifiedPerformanceEvidence}`,
		`  release e2e:         ${status.releaseE2ePass} (${status.publicSurfaceCoveragePercent}%)`,
		`  package smoke:       ${status.packageSmokePass}`,
		`  package cli sha256:  ${status.packageCliSha256?.slice(0, 16) ?? "unavailable"}`,
		`  canary remaining:    ${formatHours(status.remainingCanaryHours)}h`,
		`  replace remaining:   ${formatHours(status.remainingReplaceHours)}h`,
		`  binary sha256:       ${status.rustBinarySha256?.slice(0, 16) ?? "unavailable"}`,
		`  readiness:           ${status.readinessDecision ?? "unknown"}`,
		`  failing gate:        ${formatFailingGate(status)}`,
		`  latest run:          ${latest?.endedAt ?? "none"}`,
	];

	if (status.runnerState) {
		lines.push(
			`  runner target:       ${status.runnerState.target ?? "unknown"}`,
			`  runner started:      ${status.runnerState.startedAt ?? "unknown"}`,
			`  current run started: ${status.runnerState.currentRunStartedAt ?? "none"}`,
			`  runner release tag:  ${status.runnerState.releaseTag ?? "unknown"}`,
		);
	}
	if (status.activePromotionPacketProgress) {
		lines.push(
			`  packet progress:     ${status.activePromotionPacketProgress.status}`,
			`  packet step:         ${status.activePromotionPacketProgress.currentStep ?? "none"}`,
			`  packet completed:    ${status.activePromotionPacketProgress.completedSteps.length}`,
			`  packet updated:      ${status.activePromotionPacketProgress.updatedAt}`,
		);
	}
	if (status.activeReplacementScorecard) {
		lines.push(
			`  scorecard decision:  ${status.activeReplacementScorecard.decision ?? "unknown"}`,
			`  scorecard blocker:   ${status.activeReplacementScorecard.failingGate ?? "none"}`,
			`  scorecard compat:    ${status.activeReplacementScorecard.functionalCompatibilityPercent.toFixed(2)}%`,
			`  scorecard gates:     ${status.activeReplacementScorecard.gatesPassed}/${status.activeReplacementScorecard.gatesTotal} (${status.activeReplacementScorecard.replacementGatePassPercent.toFixed(2)}%)`,
			`  scorecard p50 perf:  ${status.activeReplacementScorecard.medianLatencyImprovementPercent.toFixed(2)}%`,
			`  scorecard p95 perf:  ${status.activeReplacementScorecard.p95LatencyImprovementPercent.toFixed(2)}%`,
			`  scorecard soak:      ${status.activeReplacementScorecard.continuousSoakHours.toFixed(4)}h/${status.activeReplacementScorecard.requiredContinuousSoakHours}h`,
		);
	}
	if (status.activeBenchmarkProgress) {
		lines.push(
			`  bench progress:      ${status.activeBenchmarkProgress.status}`,
			`  bench tool:          ${status.activeBenchmarkProgress.currentTool ?? "none"}`,
			`  bench completed:     ${status.activeBenchmarkProgress.toolsCompleted}/${status.activeBenchmarkProgress.toolsTotal}`,
			`  bench updated:       ${status.activeBenchmarkProgress.updatedAt}`,
		);
	}
	if (status.activeShadowSoakProgress) {
		lines.push(
			`  shadow progress:     ${status.activeShadowSoakProgress.status}`,
			`  shadow iterations:   ${status.activeShadowSoakProgress.iterationsCompleted}/${status.activeShadowSoakProgress.iterationsRequested}`,
			`  shadow remaining:    ${status.activeShadowSoakProgress.minSecondsRemaining.toFixed(1)}s`,
			`  shadow updated:      ${status.activeShadowSoakProgress.updatedAt}`,
		);
	}
	for (const warning of status.warnings) {
		lines.push(`  warning:             ${warning}`);
	}
	return `${lines.join("\n")}\n`;
}

export function soakStatusExitCode(
	status: Pick<SoakStatus, "warnings">,
	options: { strict: boolean },
): number {
	return options.strict && status.warnings.length > 0 ? 2 : 0;
}

export function main(argv: string[]): number {
	try {
		const options = parseArgs(argv);
		const ledgerPath = resolve(REPO_ROOT, options.ledgerPath);
		const statePath = resolve(REPO_ROOT, options.statePath);
		const runnerPathBase = runnerPathBaseFromStatePath(statePath);
		const stateRaw = readJsonIfExists(statePath);
		const runnerState = parseRunnerState(stateRaw);
		const activeShadowSoakProgressRaw = runnerState?.packetDir
			? readJsonIfExists(
					resolve(runnerPathBase, runnerState.packetDir, "shadow-soak-progress.json"),
				)
			: null;
		const activePromotionPacketProgressRaw = runnerState?.packetDir
			? readJsonIfExists(
					resolve(
						runnerPathBase,
						runnerState.packetDir,
						"promotion-packet-progress.json",
					),
				)
			: null;
		const activeBenchmarkProgressRaw = runnerState?.packetDir
			? readJsonIfExists(resolve(runnerPathBase, runnerState.packetDir, "perf-progress.json"))
			: null;
		const activeReplacementScorecardRaw = runnerState?.packetDir
			? readJsonIfExists(
					resolve(runnerPathBase, runnerState.packetDir, "replacement-scorecard.json"),
				)
			: null;
		const status = buildSoakStatus({
			ledgerPath,
			ledgerRaw: readJsonIfExists(ledgerPath),
			stateRaw,
			runnerPathBase,
			activePromotionPacketProgressRaw,
			activeBenchmarkProgressRaw,
			activeShadowSoakProgressRaw,
			activeReplacementScorecardRaw,
			runnerAlive: runnerState ? isRunnerProcessAlive(runnerState) : false,
		});
		process.stdout.write(
			options.json
				? `${JSON.stringify(status, null, 2)}\n`
				: formatSoakStatus(status),
		);
		return soakStatusExitCode(status, { strict: options.strict });
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

const isMain =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	process.exit(main(process.argv.slice(2)));
}
