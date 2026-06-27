#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust cumulative soak ledger
//
// Accumulates repeated promotion-packet runs into one readiness evidence file.
// This lets canary/replace soak gates be earned over time without manually
// editing JSON or weakening the deploy-readiness scorer.
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

import {
	assessDeployReadiness,
	normalizeReadinessEvidence,
	type ReadinessAssessment,
	type ReadinessInput,
} from "../src/contract/rust-deploy-readiness.js";

type CliOptions = {
	packetDir: string;
	ledgerPath: string;
	output?: string;
	assessmentOutput?: string;
	summaryOutput?: string;
	quiet: boolean;
};

type LedgerRun = {
	id: string;
	generatedAt: string;
	releaseTag: string | null;
	publicSurfaceMatch: boolean;
	outputParityPercent: number;
	errorCompatibilityPercent: number;
	unclassifiedFailures: number;
	soakHours: number;
	crashes: number;
	dataLossIncidents: number;
	unresolvedTelemetryAnomalies: number;
	rollbackValidated: boolean;
	rollbackRehearsed: boolean;
	observabilityLevel: "basic" | "tool" | "release";
	medianLatencyImprovementPercent: number;
	p95LatencyImprovementPercent: number;
	startupImprovementPercent: number;
	memoryImprovementPercent: number;
	readinessDecision: string;
	readinessFailingGate: string | null;
};

type SoakLedger = {
	version: 1;
	updatedAt: string;
	runs: LedgerRun[];
};

type LedgerSummary = {
	generatedAt: string;
	ledger: string;
	readiness: ReadinessAssessment;
	runCount: number;
	totalSoakHours: number;
	releaseTaggedSoakHours: number;
	canarySoakHoursRequired: number;
	replaceSoakHoursRequired: number;
	latestRun: LedgerRun;
	files: {
		ledger: string;
		cumulativeReadinessInput: string;
		cumulativeReadinessAssessment: string;
		cumulativeSummary: string;
	};
};

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_PACKET_DIR = ".epoch-promotion/latest";
const DEFAULT_LEDGER = ".epoch-promotion/soak-ledger.json";

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		packetDir: DEFAULT_PACKET_DIR,
		ledgerPath: DEFAULT_LEDGER,
		quiet: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--packet-dir") {
			options.packetDir = args[++i] ?? "";
		} else if (arg === "--ledger") {
			options.ledgerPath = args[++i] ?? "";
		} else if (arg === "--output" || arg === "-o") {
			options.output = args[++i];
		} else if (arg === "--assessment-output") {
			options.assessmentOutput = args[++i];
		} else if (arg === "--summary-output") {
			options.summaryOutput = args[++i];
		} else if (arg === "--quiet") {
			options.quiet = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
	}

	if (!options.packetDir) throw new Error("--packet-dir must not be empty.");
	if (!options.ledgerPath) throw new Error("--ledger must not be empty.");
	return options;
}

function usage(): string {
	return [
		"Usage: tsx scripts/rust-soak-ledger.ts [options]",
		"",
		"Options:",
		"  --packet-dir <dir>        Promotion packet directory (default: .epoch-promotion/latest)",
		"  --ledger <path>           Cumulative ledger file (default: .epoch-promotion/soak-ledger.json)",
		"  --output, -o <path>       Cumulative readiness input JSON",
		"  --assessment-output <p>   Cumulative readiness assessment JSON",
		"  --summary-output <path>   Cumulative ledger summary JSON",
		"  --quiet                   Suppress human summary output",
		"",
	].join("\n");
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function tryReadJson(path: string): unknown | null {
	try {
		return readJson(path);
	} catch {
		return null;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rel(path: string): string {
	return relative(REPO_ROOT, path);
}

function numberMin(values: number[]): number {
	return values.length ? Math.min(...values) : 0;
}

function numberSum(values: number[]): number {
	return values.reduce((total, value) => total + value, 0);
}

function boolAll(values: boolean[]): boolean {
	return values.length > 0 && values.every(Boolean);
}

function boolSome(values: boolean[]): boolean {
	return values.some(Boolean);
}

function parseLedger(path: string): SoakLedger {
	const raw = tryReadJson(path);
	if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.runs)) {
		return { version: 1, updatedAt: new Date(0).toISOString(), runs: [] };
	}
	return {
		version: 1,
		updatedAt:
			typeof raw.updatedAt === "string"
				? raw.updatedAt
				: new Date(0).toISOString(),
		runs: raw.runs.filter(isLedgerRun),
	};
}

function isLedgerRun(value: unknown): value is LedgerRun {
	return (
		isObject(value) &&
		typeof value.id === "string" &&
		typeof value.generatedAt === "string" &&
		typeof value.soakHours === "number"
	);
}

function packetReleaseTag(summary: unknown): string | null {
	if (!isObject(summary)) return null;
	const evidence = summary.evidence;
	if (!isObject(evidence)) return null;
	const observability = evidence.observability;
	if (!isObject(observability)) return null;
	return typeof observability.releaseTag === "string"
		? observability.releaseTag
		: null;
}

function packetGeneratedAt(summary: unknown): string {
	if (isObject(summary) && typeof summary.generatedAt === "string") {
		return summary.generatedAt;
	}
	return new Date().toISOString();
}

function packetReadiness(summary: unknown): {
	decision: string;
	failingGate: string | null;
} {
	if (!isObject(summary)) return { decision: "UNKNOWN", failingGate: null };
	const readiness = summary.readiness;
	if (!isObject(readiness)) return { decision: "UNKNOWN", failingGate: null };
	return {
		decision:
			typeof readiness.decision === "string"
				? readiness.decision
				: "UNKNOWN",
		failingGate:
			typeof readiness.failingGate === "string" ? readiness.failingGate : null,
	};
}

function ledgerRunFromPacket(
	readinessInput: ReadinessInput,
	summary: unknown,
): LedgerRun {
	const generatedAt = packetGeneratedAt(summary);
	const releaseTag = packetReleaseTag(summary);
	const readiness = packetReadiness(summary);
	return {
		id: `${generatedAt}:${releaseTag ?? "tool"}`,
		generatedAt,
		releaseTag,
		publicSurfaceMatch: readinessInput.parity.publicSurfaceMatch,
		outputParityPercent: readinessInput.parity.outputParityPercent,
		errorCompatibilityPercent: readinessInput.parity.errorCompatibilityPercent,
		unclassifiedFailures: readinessInput.parity.unclassifiedFailures,
		soakHours: readinessInput.parity.soakHours,
		crashes: readinessInput.parity.crashes,
		dataLossIncidents: readinessInput.parity.dataLossIncidents,
		unresolvedTelemetryAnomalies:
			readinessInput.parity.unresolvedTelemetryAnomalies,
		rollbackValidated: readinessInput.parity.rollbackValidated,
		rollbackRehearsed: readinessInput.parity.rollbackRehearsed,
		observabilityLevel: readinessInput.parity.observabilityLevel,
		medianLatencyImprovementPercent:
			readinessInput.perf.medianLatencyImprovementPercent,
		p95LatencyImprovementPercent:
			readinessInput.perf.p95LatencyImprovementPercent,
		startupImprovementPercent: readinessInput.perf.startupImprovementPercent,
		memoryImprovementPercent: readinessInput.perf.memoryImprovementPercent,
		readinessDecision: readiness.decision,
		readinessFailingGate: readiness.failingGate,
	};
}

function upsertRun(ledger: SoakLedger, run: LedgerRun): SoakLedger {
	const runs = ledger.runs.filter((entry) => entry.id !== run.id);
	runs.push(run);
	runs.sort((a, b) => a.generatedAt.localeCompare(b.generatedAt));
	return {
		version: 1,
		updatedAt: new Date().toISOString(),
		runs,
	};
}

function cumulativeInput(runs: LedgerRun[]): ReadinessInput {
	const totalSoakHours = numberSum(runs.map((run) => run.soakHours));
	const releaseSoakHours = numberSum(
		runs
			.filter((run) => run.observabilityLevel === "release")
			.map((run) => run.soakHours),
	);
	const allSoakIsRelease =
		totalSoakHours > 0 && Math.abs(releaseSoakHours - totalSoakHours) < 1e-9;
	const outputParityPercent = numberMin(
		runs.map((run) => run.outputParityPercent),
	);
	const errorCompatibilityPercent = numberMin(
		runs.map((run) => run.errorCompatibilityPercent),
	);
	const unclassifiedFailures = numberSum(
		runs.map((run) => run.unclassifiedFailures),
	);

	return normalizeReadinessEvidence({
		parity: {
			publicSurfaceMatch: boolAll(runs.map((run) => run.publicSurfaceMatch)),
			outputParityPercent,
			errorCompatibilityPercent,
			unclassifiedFailures,
			soakHours: totalSoakHours,
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
	});
}

function buildSummary(
	ledgerPath: string,
	readinessInputPath: string,
	assessmentPath: string,
	summaryPath: string,
	ledger: SoakLedger,
	latestRun: LedgerRun,
	readiness: ReadinessAssessment,
): LedgerSummary {
	const releaseTaggedSoakHours = numberSum(
		ledger.runs
			.filter((run) => run.observabilityLevel === "release")
			.map((run) => run.soakHours),
	);
	return {
		generatedAt: new Date().toISOString(),
		ledger: rel(ledgerPath),
		readiness,
		runCount: ledger.runs.length,
		totalSoakHours: numberSum(ledger.runs.map((run) => run.soakHours)),
		releaseTaggedSoakHours,
		canarySoakHoursRequired: 24,
		replaceSoakHoursRequired: 72,
		latestRun,
		files: {
			ledger: rel(ledgerPath),
			cumulativeReadinessInput: rel(readinessInputPath),
			cumulativeReadinessAssessment: rel(assessmentPath),
			cumulativeSummary: rel(summaryPath),
		},
	};
}

function printSummary(summary: LedgerSummary): void {
	process.stderr.write(
		[
			"Rust cumulative soak ledger",
			`  runs:                ${summary.runCount}`,
			`  total soak hours:    ${summary.totalSoakHours.toFixed(4)}`,
			`  release soak hours:  ${summary.releaseTaggedSoakHours.toFixed(4)}`,
			`  decision:            ${summary.readiness.decision}`,
			`  failing gate:        ${summary.readiness.failingGate ?? "none"}`,
			`  ledger:              ${summary.files.ledger}`,
			"",
		].join("\n"),
	);
}

try {
	const options = parseArgs(process.argv.slice(2));
	const packetDir = resolve(REPO_ROOT, options.packetDir);
	const ledgerPath = resolve(REPO_ROOT, options.ledgerPath);
	const readinessInputPath = resolve(
		REPO_ROOT,
		options.output ?? join(options.packetDir, "readiness-input-cumulative.json"),
	);
	const assessmentPath = resolve(
		REPO_ROOT,
		options.assessmentOutput ??
			join(options.packetDir, "readiness-assessment-cumulative.json"),
	);
	const summaryPath = resolve(
		REPO_ROOT,
		options.summaryOutput ?? join(options.packetDir, "soak-ledger-summary.json"),
	);

	const packetReadinessInput = normalizeReadinessEvidence(
		readJson(join(packetDir, "readiness-input.json")),
	);
	const packetSummary = readJson(join(packetDir, "promotion-packet.json"));
	const latestRun = ledgerRunFromPacket(packetReadinessInput, packetSummary);
	const ledger = upsertRun(parseLedger(ledgerPath), latestRun);
	const cumulative = cumulativeInput(ledger.runs);
	const assessment = assessDeployReadiness(cumulative);
	const summary = buildSummary(
		ledgerPath,
		readinessInputPath,
		assessmentPath,
		summaryPath,
		ledger,
		latestRun,
		assessment,
	);

	writeJson(ledgerPath, ledger);
	writeJson(readinessInputPath, cumulative);
	writeJson(assessmentPath, assessment);
	writeJson(summaryPath, summary);

	if (!options.quiet) printSummary(summary);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
