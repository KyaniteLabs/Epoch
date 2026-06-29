#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust promotion gate
//
// Final machine-readable guard for deployment automation. It accepts the
// soak-runner summary and exits 0 only when the strict deploy-readiness scorer,
// not a smoke override, has reached the requested target.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import {
	assessDeployReadiness,
	deployReadinessDecisionSchema,
	type ReadinessInput,
} from "./rust-deploy-readiness.js";

type Target = "canary" | "replace";

export type PromotionGateResult = {
	ok: boolean;
	target: Target;
	decision: z.infer<typeof deployReadinessDecisionSchema>;
	failingGate: string | null;
	reason: string;
	deploySurface?: DeploySurfaceEvidence;
};

type CliOptions = {
	target: Target;
	summaryPath: string;
	ledgerSummaryPath?: string;
	ledgerPath?: string;
	rustBinaryPath: string;
	json: boolean;
};

export type PromotionGateOptions = {
	currentRustBinarySha256?: string | null;
	deploySurface?: DeploySurfaceEvidence;
};

export type DeploySurfaceEvidence = {
	ok: boolean;
	reasons: string[];
	packageBinEntrypoint: string | null;
	packageFiles: string[];
	dockerEntrypoint: string | null;
	checks: {
		packageBinRoutesToRust: boolean;
		packageFilesIncludeRustArtifacts: boolean;
		dockerEntrypointRoutesToRust: boolean;
	};
};

const DEFAULT_SUMMARY = ".epoch-promotion/latest/soak-runner-summary.json";
const DEFAULT_LEDGER = ".epoch-promotion/soak-ledger.json";
const DEFAULT_RUST_BINARY = "rust/target/release/epoch-cli";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const MAX_CONTINUOUS_GAP_MS = 15 * 60_000;
const REQUIRED_SOAK_HOURS: Record<Target, number> = {
	canary: 24,
	replace: 72,
};
const DECISION_RANK: Record<
	z.infer<typeof deployReadinessDecisionSchema>,
	number
> = {
	NO: 0,
	SHADOW: 1,
	CANARY: 2,
	REPLACE: 3,
};

const runnerSummarySchema = z.object({
	target: z.enum(["canary", "replace"]),
	targetHoursSource: z.enum(["default", "override"]),
	targetReached: z.boolean(),
	targetSatisfiedBy: z.literal("scorer").nullable(),
	smokeTargetReached: z.boolean().default(false),
	qualifiedPerformanceEvidence: z.boolean().default(false),
	releaseE2ePass: z.boolean().default(false),
	publicSurfaceCoveragePercent: z.number().min(0).max(100).default(0),
	httpDeployEnvCoveragePercent: z.number().min(0).max(100).default(0),
	releaseTag: z.string().nullable().default(null),
	rustBinarySha256: z.string().regex(SHA256_HEX).nullable(),
	readiness: z.object({
		decision: deployReadinessDecisionSchema,
		failingGate: z.string().nullable(),
		rationale: z.string().default(""),
	}),
});

const ledgerRunSchema = z.object({
	id: z.string(),
	generatedAt: z.string(),
	startedAt: z.string(),
	endedAt: z.string(),
	releaseTag: z.string().nullable().default(null),
	rustBinarySha256: z.string().regex(SHA256_HEX).nullable(),
	publicSurfaceMatch: z.boolean(),
	releaseE2ePass: z.boolean().default(false),
	publicSurfaceCoveragePercent: z.number().min(0).max(100).default(0),
	httpDeployEnvCoveragePercent: z.number().min(0).max(100).default(0),
	outputParityPercent: z.number().min(0).max(100),
	errorCompatibilityPercent: z.number().min(0).max(100),
	unclassifiedFailures: z.number().int().nonnegative(),
	soakHours: z.number().nonnegative(),
	continuousSoakHours: z.number().nonnegative(),
	crashes: z.number().int().nonnegative(),
	dataLossIncidents: z.number().int().nonnegative(),
	unresolvedTelemetryAnomalies: z.number().int().nonnegative(),
	rollbackValidated: z.boolean(),
	rollbackRehearsed: z.boolean(),
	observabilityLevel: z.enum(["basic", "tool", "release"]),
	medianLatencyImprovementPercent: z.number(),
	p95LatencyImprovementPercent: z.number(),
	startupImprovementPercent: z.number(),
	memoryImprovementPercent: z.number(),
	performanceEvidenceMode: z.enum(["smoke", "qualified"]).default("smoke"),
});

const soakLedgerSchema = z.object({
	version: z.literal(1),
	runs: z.array(ledgerRunSchema),
});

type LedgerRun = z.infer<typeof ledgerRunSchema>;

const ledgerSummarySchema = z.object({
	totalSoakHours: z.number().nonnegative(),
	continuousSoakHours: z.number().nonnegative(),
	releaseTaggedSoakHours: z.number().nonnegative(),
	qualifiedPerformanceEvidence: z.boolean().default(false),
	releaseE2ePass: z.boolean().default(false),
	publicSurfaceCoveragePercent: z.number().min(0).max(100).default(0),
	httpDeployEnvCoveragePercent: z.number().min(0).max(100).default(0),
	rustBinarySha256: z.string().regex(SHA256_HEX).nullable(),
	readiness: z.object({
		decision: deployReadinessDecisionSchema,
		failingGate: z.string().nullable(),
		rationale: z.string().default(""),
	}),
});

function usage(): string {
	return [
		"Usage: tsx src/contract/rust-promotion-gate.ts --target <canary|replace> [options]",
		"",
		"Options:",
		`  --summary <path>          Soak runner summary JSON (default: ${DEFAULT_SUMMARY})`,
		"  --ledger-summary <path>   Cumulative soak ledger summary JSON",
		`  --ledger <path>           Cumulative soak ledger JSON (example: ${DEFAULT_LEDGER})`,
		`  --rust-binary <p>        Current Rust CLI binary to hash (default: ${DEFAULT_RUST_BINARY})`,
		"  --target <target>         Required promotion target: canary or replace",
		"  --json                    Emit machine-readable result JSON",
		"  --help, -h                Show this help",
		"",
	].join("\n");
}

function parseTarget(raw: string | undefined): Target {
	if (raw === "canary" || raw === "replace") return raw;
	throw new Error("--target must be either canary or replace.");
}

function parseArgs(argv: string[]): CliOptions {
	const options: Partial<CliOptions> = {
		summaryPath: DEFAULT_SUMMARY,
		rustBinaryPath: DEFAULT_RUST_BINARY,
		json: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	let summaryProvided = false;
	let ledgerSummaryProvided = false;
	let ledgerProvided = false;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--target") {
			options.target = parseTarget(args[++i]);
		} else if (arg === "--summary") {
			const summaryPath = args[++i];
			if (!summaryPath?.trim()) throw new Error("--summary must not be empty.");
			options.summaryPath = summaryPath;
			summaryProvided = true;
		} else if (arg === "--ledger-summary") {
			const ledgerSummaryPath = args[++i];
			if (!ledgerSummaryPath?.trim()) {
				throw new Error("--ledger-summary must not be empty.");
			}
			options.ledgerSummaryPath = ledgerSummaryPath;
			ledgerSummaryProvided = true;
		} else if (arg === "--ledger") {
			const ledgerPath = args[++i];
			if (!ledgerPath?.trim()) throw new Error("--ledger must not be empty.");
			options.ledgerPath = ledgerPath;
			ledgerProvided = true;
		} else if (arg === "--rust-binary") {
			const rustBinaryPath = args[++i];
			if (!rustBinaryPath?.trim()) {
				throw new Error("--rust-binary must not be empty.");
			}
			options.rustBinaryPath = rustBinaryPath;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
	}

	if (!options.target) {
		throw new Error(`--target is required.\n\n${usage()}`);
	}
	if (
		[summaryProvided, ledgerSummaryProvided, ledgerProvided].filter(Boolean)
			.length > 1
	) {
		throw new Error(
			"--summary, --ledger-summary, and --ledger are mutually exclusive.",
		);
	}

	return options as CliOptions;
}

function requiredDecision(target: Target): "CANARY" | "REPLACE" {
	return target === "replace" ? "REPLACE" : "CANARY";
}

function targetRank(target: Target): number {
	return DECISION_RANK[requiredDecision(target)];
}

function result(
	ok: boolean,
	target: Target,
	decision: z.infer<typeof deployReadinessDecisionSchema>,
	failingGate: string | null,
	reason: string,
	deploySurface?: DeploySurfaceEvidence,
): PromotionGateResult {
	return { ok, target, decision, failingGate, reason, deploySurface };
}

function valueAsString(value: unknown): string | null {
	return typeof value === "string" && value.trim() ? value : null;
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value)
		? value.filter((item): item is string => typeof item === "string")
		: [];
}

function routesToRust(value: string | null): boolean {
	if (!value) return false;
	if (/dist\/index\.js|src\/index\.ts/.test(value)) return false;
	return /\b(epoch-(cli|mcp|http)|rust\/target|rust\b|native|prebuilds?)\b/i.test(
		value,
	);
}

function filesIncludeRustArtifacts(files: string[]): boolean {
	return files.some((entry) =>
		/^(rust|bin|native|prebuilds?|platforms?)(\/|$)/i.test(entry),
	);
}

function dockerEntrypoint(text: string | null): string | null {
	if (!text) return null;
	return (
		text
			.split(/\r?\n/)
			.map((line) => line.trim())
			.find((line) => /^(ENTRYPOINT|CMD)\b/.test(line) && !line.startsWith("#")) ??
		null
	);
}

export function auditDeploySurface(raw: {
	packageJson: unknown;
	dockerfile?: string | null;
}): DeploySurfaceEvidence {
	const packageJson =
		typeof raw.packageJson === "object" &&
		raw.packageJson !== null &&
		!Array.isArray(raw.packageJson)
			? (raw.packageJson as Record<string, unknown>)
			: {};
	const bin =
		typeof packageJson["bin"] === "object" &&
		packageJson["bin"] !== null &&
		!Array.isArray(packageJson["bin"])
			? (packageJson["bin"] as Record<string, unknown>)
			: {};
	const packageBinEntrypoint = valueAsString(bin["epoch"]);
	const packageFiles = stringArray(packageJson["files"]);
	const dockerEntry = dockerEntrypoint(raw.dockerfile ?? null);
	const checks = {
		packageBinRoutesToRust: routesToRust(packageBinEntrypoint),
		packageFilesIncludeRustArtifacts: filesIncludeRustArtifacts(packageFiles),
		dockerEntrypointRoutesToRust: raw.dockerfile
			? routesToRust(dockerEntry)
			: true,
	};
	const reasons = [];
	if (!checks.packageBinRoutesToRust) {
		reasons.push(
			`package bin epoch points to ${packageBinEntrypoint ?? "(missing)"}, not a Rust wrapper or binary`,
		);
	}
	if (!checks.packageFilesIncludeRustArtifacts) {
		reasons.push("package files do not include Rust/native binary artifacts");
	}
	if (!checks.dockerEntrypointRoutesToRust) {
		reasons.push(
			`Docker entrypoint points to ${dockerEntry ?? "(missing)"}, not a Rust server binary`,
		);
	}

	return {
		ok: Object.values(checks).every(Boolean),
		reasons,
		packageBinEntrypoint,
		packageFiles,
		dockerEntrypoint: dockerEntry,
		checks,
	};
}

function auditDeploySurfaceFromRepo(repoRoot = process.cwd()): DeploySurfaceEvidence {
	const packageJson = readJson(join(repoRoot, "package.json"));
	const dockerfilePath = join(repoRoot, "Dockerfile");
	const dockerfile = existsSync(dockerfilePath)
		? readFileSync(dockerfilePath, "utf8")
		: null;
	return auditDeploySurface({ packageJson, dockerfile });
}

function deploySurfaceGate(
	target: Target,
	decision: z.infer<typeof deployReadinessDecisionSchema>,
	failingGate: string | null,
	options: PromotionGateOptions,
): PromotionGateResult | null {
	if (target !== "replace" || !options.deploySurface) return null;
	if (options.deploySurface.ok) return null;
	return result(
		false,
		target,
		decision,
		"deploy-surface",
		`Replacement deploy surface is still TypeScript-routed: ${options.deploySurface.reasons.join("; ")}.`,
		options.deploySurface,
	);
}

export function assessPromotionGate(
	rawSummary: unknown,
	target: Target,
	options: PromotionGateOptions = {},
): PromotionGateResult {
	const summary = runnerSummarySchema.parse(rawSummary);
	const decision = summary.readiness.decision;
	const failingGate = summary.readiness.failingGate;
	const checksCurrentBinary = "currentRustBinarySha256" in options;
	const requestedTargetRank = targetRank(target);
	const summaryTargetRank = targetRank(summary.target);

	if (summaryTargetRank < requestedTargetRank) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Runner summary target is ${summary.target}, which is below requested ${target}.`,
		);
	}
	if (summary.targetHoursSource !== "default" || summary.smokeTargetReached) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Runner summary used a local smoke target override; this is not deployment evidence.",
		);
	}
	if (!summary.rustBinarySha256) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Runner summary is missing the Rust binary SHA-256.",
		);
	}
	if (checksCurrentBinary && !options.currentRustBinarySha256) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Current Rust binary SHA-256 could not be verified.",
		);
	}
	if (
		checksCurrentBinary &&
		options.currentRustBinarySha256 !== summary.rustBinarySha256
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Current Rust binary SHA-256 ${options.currentRustBinarySha256} does not match soak evidence ${summary.rustBinarySha256}.`,
		);
	}
	const deploySurfaceBlocker = deploySurfaceGate(
		target,
		decision,
		failingGate,
		options,
	);
	if (deploySurfaceBlocker) return deploySurfaceBlocker;
	if (target === "replace" && !summary.releaseTag) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Replacement requires a release-tagged runner summary.",
		);
	}
	if (target === "replace" && !summary.qualifiedPerformanceEvidence) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Replacement requires qualified non-smoke performance benchmark evidence.",
		);
	}
	if (
		!summary.releaseE2ePass ||
		summary.publicSurfaceCoveragePercent < 100 ||
		summary.httpDeployEnvCoveragePercent < 100
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Promotion requires release-binary E2E coverage for public surfaces and deploy environment parity.",
		);
	}
	if (
		summary.target === target &&
		(!summary.targetReached || summary.targetSatisfiedBy !== "scorer")
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Strict scorer has not reached ${target}; first blocker is ${failingGate ?? "unknown"}.`,
		);
	}
	if (DECISION_RANK[decision] < requestedTargetRank) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Readiness decision ${decision} is below ${requiredDecision(target)}.`,
		);
	}

	return result(
		true,
		target,
		decision,
		null,
		`Strict scorer reached ${target} for Rust binary ${summary.rustBinarySha256}.`,
	);
}

export function assessPromotionGateFromLedgerSummary(
	rawSummary: unknown,
	target: Target,
	options: PromotionGateOptions = {},
): PromotionGateResult {
	const summary = ledgerSummarySchema.parse(rawSummary);
	const decision = summary.readiness.decision;
	const failingGate = summary.readiness.failingGate;
	const requiredHours = REQUIRED_SOAK_HOURS[target];
	const checksCurrentBinary = "currentRustBinarySha256" in options;

	if (!summary.rustBinarySha256) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Ledger summary is missing the Rust binary SHA-256.",
		);
	}
	if (checksCurrentBinary && !options.currentRustBinarySha256) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Current Rust binary SHA-256 could not be verified.",
		);
	}
	if (
		checksCurrentBinary &&
		options.currentRustBinarySha256 !== summary.rustBinarySha256
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Current Rust binary SHA-256 ${options.currentRustBinarySha256} does not match soak evidence ${summary.rustBinarySha256}.`,
		);
	}
	const deploySurfaceBlocker = deploySurfaceGate(
		target,
		decision,
		failingGate,
		options,
	);
	if (deploySurfaceBlocker) return deploySurfaceBlocker;
	if (
		!summary.releaseE2ePass ||
		summary.publicSurfaceCoveragePercent < 100 ||
		summary.httpDeployEnvCoveragePercent < 100
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Promotion requires release-binary E2E coverage for public surfaces and deploy environment parity.",
		);
	}
	if (
		summary.totalSoakHours < requiredHours ||
		summary.continuousSoakHours < requiredHours
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Ledger summary has ${summary.continuousSoakHours.toFixed(4)} continuous soak hours; ${target} requires ${requiredHours}.`,
		);
	}
	if (
		target === "replace" &&
		summary.releaseTaggedSoakHours < REQUIRED_SOAK_HOURS.replace
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Replacement requires release-tagged cumulative soak evidence.",
		);
	}
	if (target === "replace" && !summary.qualifiedPerformanceEvidence) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Replacement requires qualified non-smoke performance benchmark evidence.",
		);
	}
	if (DECISION_RANK[decision] < targetRank(target)) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Readiness decision ${decision} is below ${requiredDecision(target)}.`,
		);
	}

	return result(
		true,
		target,
		decision,
		null,
		`Strict ledger scorer reached ${target} for Rust binary ${summary.rustBinarySha256}.`,
	);
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
		run.observabilityLevel === "release" &&
		run.releaseTag !== null
	);
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

function cleanInterval(run: LedgerRun): { startMs: number; endMs: number } | null {
	if (
		!run.publicSurfaceMatch ||
		!run.releaseE2ePass ||
		run.unclassifiedFailures > 0 ||
		run.crashes > 0 ||
		run.dataLossIncidents > 0 ||
		run.unresolvedTelemetryAnomalies > 0
	) {
		return null;
	}
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

export function buildGateLedgerSummary(
	rawLedger: unknown,
): z.infer<typeof ledgerSummarySchema> {
	const ledger = soakLedgerSchema.parse(rawLedger);
	const runs = [...ledger.runs].sort((left, right) =>
		left.generatedAt.localeCompare(right.generatedAt),
	);
	const totalSoakHours = numberSum(runs.map((run) => run.soakHours));
	const continuousSoakHours = longestContinuousCleanSoakHours(runs);
	const releaseTaggedSoakHours = numberSum(
		runs
			.filter(
				(run) => run.observabilityLevel === "release" && run.releaseTag !== null,
			)
			.map((run) => run.soakHours),
	);
	const allSoakIsRelease =
		totalSoakHours > 0 &&
		Math.abs(releaseTaggedSoakHours - totalSoakHours) < 1e-9;
	const outputParityPercent = numberMin(
		runs.map((run) => run.outputParityPercent),
	);
	const errorCompatibilityPercent = numberMin(
		runs.map((run) => run.errorCompatibilityPercent),
	);
	const unclassifiedFailures = numberSum(
		runs.map((run) => run.unclassifiedFailures),
	);
	const readinessInput: ReadinessInput = {
		parity: {
			publicSurfaceMatch: boolAll(runs.map((run) => run.publicSurfaceMatch)),
			releaseE2ePass: boolAll(runs.map((run) => run.releaseE2ePass)),
			publicSurfaceCoveragePercent: numberMin(
				runs.map((run) => run.publicSurfaceCoveragePercent),
			),
			httpDeployEnvCoveragePercent: numberMin(
				runs.map((run) => run.httpDeployEnvCoveragePercent),
			),
			outputParityPercent,
			errorCompatibilityPercent,
			unclassifiedFailures,
			rustBinarySha256: ledgerBinarySha256(runs),
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
	};

	return {
		totalSoakHours,
		continuousSoakHours,
		releaseTaggedSoakHours,
		qualifiedPerformanceEvidence: runs.some(
			hasReleaseQualifiedPerformanceEvidence,
		),
		releaseE2ePass: readinessInput.parity.releaseE2ePass,
		publicSurfaceCoveragePercent:
			readinessInput.parity.publicSurfaceCoveragePercent,
		httpDeployEnvCoveragePercent:
			readinessInput.parity.httpDeployEnvCoveragePercent,
		rustBinarySha256: readinessInput.parity.rustBinarySha256,
		readiness: assessDeployReadiness(readinessInput),
	};
}

export function assessPromotionGateFromLedger(
	rawLedger: unknown,
	target: Target,
	options: PromotionGateOptions = {},
): PromotionGateResult {
	return assessPromotionGateFromLedgerSummary(
		buildGateLedgerSummary(rawLedger),
		target,
		options,
	);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function main(argv: string[]): number {
	try {
		const options = parseArgs(argv);
		const rawEvidence = readJson(
			resolve(
				options.ledgerPath ?? options.ledgerSummaryPath ?? options.summaryPath,
			),
		);
		const currentRustBinarySha256 = sha256File(resolve(options.rustBinaryPath));
		const deploySurface = auditDeploySurfaceFromRepo();
		const gate = options.ledgerPath
			? assessPromotionGateFromLedger(rawEvidence, options.target, {
					currentRustBinarySha256,
					deploySurface,
				})
			: options.ledgerSummaryPath
			? assessPromotionGateFromLedgerSummary(rawEvidence, options.target, {
					currentRustBinarySha256,
					deploySurface,
				})
			: assessPromotionGate(rawEvidence, options.target, {
					currentRustBinarySha256,
					deploySurface,
				});
		if (options.json) {
			process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
		} else {
			process.stdout.write(
				`Rust promotion gate ${gate.ok ? "PASS" : "BLOCKED"}: ${gate.reason}\n`,
			);
		}
		return gate.ok ? 0 : 2;
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
