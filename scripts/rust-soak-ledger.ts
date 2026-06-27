#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust cumulative soak ledger
//
// Accumulates repeated promotion-packet runs into one readiness evidence file.
// This lets canary/replace soak gates be earned over time without manually
// editing JSON or weakening the deploy-readiness scorer.
// ---------------------------------------------------------------------------

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
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
	startedAt: string;
	endedAt: string;
	releaseTag: string | null;
	rustBinary: string | null;
	rustBinarySha256: string | null;
	publicSurfaceMatch: boolean;
	outputParityPercent: number;
	errorCompatibilityPercent: number;
	unclassifiedFailures: number;
	soakHours: number;
	continuousSoakHours: number;
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
	continuousSoakHours: number;
	continuityLostHours: number;
	releaseTaggedSoakHours: number;
	rustBinarySha256: string | null;
	continuousGapSeconds: number;
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
const MAX_CONTINUOUS_GAP_MS = 30_000;

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

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	const tmpPath = `${path}.${process.pid}.tmp`;
	writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
	renameSync(tmpPath, path);
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
	if (!existsSync(path)) {
		return { version: 1, updatedAt: new Date(0).toISOString(), runs: [] };
	}
	const raw = readJson(path);
	if (!isObject(raw) || raw.version !== 1 || !Array.isArray(raw.runs)) {
		throw new Error(`Invalid soak ledger: ${rel(path)}`);
	}
	return {
		version: 1,
		updatedAt:
			typeof raw.updatedAt === "string"
				? raw.updatedAt
				: new Date(0).toISOString(),
		runs: raw.runs
			.map(parseLedgerRun)
			.filter((run): run is LedgerRun => run !== null),
	};
}

function numberField(
	object: Record<string, unknown>,
	key: string,
	fallback: number,
): number {
	const value = object[key];
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanField(
	object: Record<string, unknown>,
	key: string,
	fallback: boolean,
): boolean {
	const value = object[key];
	return typeof value === "boolean" ? value : fallback;
}

function stringField(
	object: Record<string, unknown>,
	key: string,
	fallback: string,
): string {
	const value = object[key];
	return typeof value === "string" ? value : fallback;
}

function observabilityLevel(value: unknown): LedgerRun["observabilityLevel"] {
	return value === "release" || value === "tool" ? value : "basic";
}

function parseLedgerRun(value: unknown): LedgerRun | null {
	if (
		!isObject(value) ||
		typeof value.id !== "string" ||
		typeof value.generatedAt !== "string" ||
		typeof value.soakHours !== "number"
	) {
		return null;
	}

	return {
		id: value.id,
		generatedAt: value.generatedAt,
		startedAt: stringField(value, "startedAt", value.generatedAt),
		endedAt: stringField(value, "endedAt", value.generatedAt),
		releaseTag: typeof value.releaseTag === "string" ? value.releaseTag : null,
		rustBinary: typeof value.rustBinary === "string" ? value.rustBinary : null,
		rustBinarySha256:
			typeof value.rustBinarySha256 === "string"
				? value.rustBinarySha256
				: null,
		publicSurfaceMatch: booleanField(value, "publicSurfaceMatch", false),
		outputParityPercent: numberField(value, "outputParityPercent", 0),
		errorCompatibilityPercent: numberField(
			value,
			"errorCompatibilityPercent",
			0,
		),
		unclassifiedFailures: numberField(value, "unclassifiedFailures", 0),
		soakHours: value.soakHours,
		continuousSoakHours: numberField(value, "continuousSoakHours", 0),
		crashes: numberField(value, "crashes", 0),
		dataLossIncidents: numberField(value, "dataLossIncidents", 0),
		unresolvedTelemetryAnomalies: numberField(
			value,
			"unresolvedTelemetryAnomalies",
			0,
		),
		rollbackValidated: booleanField(value, "rollbackValidated", false),
		rollbackRehearsed: booleanField(value, "rollbackRehearsed", false),
		observabilityLevel: observabilityLevel(value.observabilityLevel),
		medianLatencyImprovementPercent: numberField(
			value,
			"medianLatencyImprovementPercent",
			0,
		),
		p95LatencyImprovementPercent: numberField(
			value,
			"p95LatencyImprovementPercent",
			0,
		),
		startupImprovementPercent: numberField(
			value,
			"startupImprovementPercent",
			0,
		),
		memoryImprovementPercent: numberField(
			value,
			"memoryImprovementPercent",
			0,
		),
		readinessDecision: stringField(value, "readinessDecision", "UNKNOWN"),
		readinessFailingGate:
			typeof value.readinessFailingGate === "string"
				? value.readinessFailingGate
				: null,
	};
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

function packetBinaryIdentity(shadowSoak: unknown): {
	rustBinary: string | null;
	rustBinarySha256: string | null;
} {
	if (!isObject(shadowSoak) || !isObject(shadowSoak.meta)) {
		return { rustBinary: null, rustBinarySha256: null };
	}
	return {
		rustBinary:
			typeof shadowSoak.meta.rustBinary === "string"
				? shadowSoak.meta.rustBinary
				: null,
		rustBinarySha256:
			typeof shadowSoak.meta.rustBinarySha256 === "string"
				? shadowSoak.meta.rustBinarySha256
				: null,
	};
}

function packetWindow(
	shadowSoak: unknown,
	generatedAt: string,
	soakHours: number,
): { startedAt: string; endedAt: string } {
	if (isObject(shadowSoak) && isObject(shadowSoak.meta)) {
		const startedAt =
			typeof shadowSoak.meta.startedAt === "string"
				? shadowSoak.meta.startedAt
				: null;
		const endedAt =
			typeof shadowSoak.meta.endedAt === "string"
				? shadowSoak.meta.endedAt
				: null;
		if (startedAt && endedAt) {
			return { startedAt, endedAt };
		}
	}

	const endedAtMs = Date.parse(generatedAt);
	if (Number.isFinite(endedAtMs)) {
		return {
			startedAt: new Date(endedAtMs - soakHours * 3_600_000).toISOString(),
			endedAt: new Date(endedAtMs).toISOString(),
		};
	}
	return { startedAt: generatedAt, endedAt: generatedAt };
}

function ledgerRunFromPacket(
	readinessInput: ReadinessInput,
	summary: unknown,
	shadowSoak: unknown,
): LedgerRun {
	const generatedAt = packetGeneratedAt(summary);
	const releaseTag = packetReleaseTag(summary);
	const readiness = packetReadiness(summary);
	const binary = packetBinaryIdentity(shadowSoak);
	const window = packetWindow(
		shadowSoak,
		generatedAt,
		readinessInput.parity.soakHours,
	);
	return {
		id: `${generatedAt}:${releaseTag ?? "tool"}`,
		generatedAt,
		startedAt: window.startedAt,
		endedAt: window.endedAt,
		releaseTag,
		rustBinary: binary.rustBinary,
		rustBinarySha256: binary.rustBinarySha256,
		publicSurfaceMatch: readinessInput.parity.publicSurfaceMatch,
		outputParityPercent: readinessInput.parity.outputParityPercent,
		errorCompatibilityPercent: readinessInput.parity.errorCompatibilityPercent,
		unclassifiedFailures: readinessInput.parity.unclassifiedFailures,
		soakHours: readinessInput.parity.soakHours,
		continuousSoakHours: readinessInput.parity.continuousSoakHours,
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

function ledgerBinarySha256(runs: LedgerRun[]): string | null {
	if (runs.length === 0) return null;
	const missingIdentity = runs.find((run) => !run.rustBinarySha256);
	if (missingIdentity) {
		throw new Error(
			`Soak run ${missingIdentity.id} is missing rustBinarySha256; start a fresh ledger or regenerate the packet with current tooling.`,
		);
	}
	const identities = new Set(runs.map((run) => run.rustBinarySha256));
	if (identities.size > 1) {
		throw new Error(
			`Mixed Rust binary identities in soak ledger: ${Array.from(identities).join(", ")}. Use a separate ledger per binary build.`,
		);
	}
	return runs[0]?.rustBinarySha256 ?? null;
}

type SoakInterval = { startMs: number; endMs: number };

function isCleanRun(run: LedgerRun): boolean {
	return (
		run.publicSurfaceMatch &&
		run.unclassifiedFailures === 0 &&
		run.crashes === 0 &&
		run.dataLossIncidents === 0 &&
		run.unresolvedTelemetryAnomalies === 0
	);
}

function cleanInterval(run: LedgerRun): SoakInterval | null {
	if (!isCleanRun(run)) return null;
	const startMs = Date.parse(run.startedAt);
	const endMs = Date.parse(run.endedAt);
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
		.map(cleanInterval)
		.filter((interval): interval is SoakInterval => interval !== null)
		.sort((a, b) => a.startMs - b.startMs);

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

function cumulativeInput(runs: LedgerRun[]): ReadinessInput {
	const totalSoakHours = numberSum(runs.map((run) => run.soakHours));
	const continuousSoakHours = longestContinuousCleanSoakHours(runs);
	const rustBinarySha256 = ledgerBinarySha256(runs);
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
			rustBinarySha256,
			soakHours: totalSoakHours,
			continuousSoakHours,
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
	const totalSoakHours = numberSum(ledger.runs.map((run) => run.soakHours));
	const continuousSoakHours = longestContinuousCleanSoakHours(ledger.runs);
	const rustBinarySha256 = ledgerBinarySha256(ledger.runs);
	return {
		generatedAt: new Date().toISOString(),
		ledger: rel(ledgerPath),
		readiness,
		runCount: ledger.runs.length,
		totalSoakHours,
		continuousSoakHours,
		continuityLostHours: Math.max(0, totalSoakHours - continuousSoakHours),
		releaseTaggedSoakHours,
		rustBinarySha256,
		continuousGapSeconds: MAX_CONTINUOUS_GAP_MS / 1000,
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
			`  continuous soak:     ${summary.continuousSoakHours.toFixed(4)}`,
			`  continuity lost:     ${summary.continuityLostHours.toFixed(4)}`,
			`  release soak hours:  ${summary.releaseTaggedSoakHours.toFixed(4)}`,
			`  binary sha256:       ${summary.rustBinarySha256?.slice(0, 16) ?? "unavailable"}`,
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
	const packetShadowSoak = readJson(join(packetDir, "shadow-soak.json"));
	const latestRun = ledgerRunFromPacket(
		packetReadinessInput,
		packetSummary,
		packetShadowSoak,
	);
	const ledger = upsertRun(parseLedger(ledgerPath), latestRun);
	ledgerBinarySha256(ledger.runs);
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
