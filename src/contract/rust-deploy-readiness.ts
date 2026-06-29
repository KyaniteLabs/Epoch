import { z } from "zod";

export const deployReadinessDecisionSchema = z.enum([
	"NO",
	"SHADOW",
	"CANARY",
	"REPLACE",
]);

export type DeployReadinessDecision = z.infer<typeof deployReadinessDecisionSchema>;

export const parityEvidenceSchema = z.object({
	publicSurfaceMatch: z.boolean(),
	releaseE2ePass: z.boolean().default(false),
	publicSurfaceCoveragePercent: z.number().min(0).max(100).default(0),
	httpDeployEnvCoveragePercent: z.number().min(0).max(100).default(0),
	packageSmokePass: z.boolean().default(false),
	outputParityPercent: z.number().min(0).max(100),
	errorCompatibilityPercent: z.number().min(0).max(100),
	unclassifiedFailures: z.number().int().nonnegative(),
	rustBinarySha256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
	soakHours: z.number().nonnegative(),
	continuousSoakHours: z.number().nonnegative(),
	crashes: z.number().int().nonnegative(),
	dataLossIncidents: z.number().int().nonnegative(),
	rollbackValidated: z.boolean(),
	rollbackRehearsed: z.boolean(),
	observabilityLevel: z.enum(["basic", "tool", "release"]),
	unresolvedTelemetryAnomalies: z.number().int().nonnegative().default(0),
	compatibilityExceptionsApproved: z.boolean().default(false),
});

export const perfEvidenceSchema = z.object({
	medianLatencyImprovementPercent: z.number(),
	p95LatencyImprovementPercent: z.number(),
	startupImprovementPercent: z.number(),
	memoryImprovementPercent: z.number(),
});

export const readinessInputSchema = z.object({
	parity: parityEvidenceSchema,
	perf: perfEvidenceSchema,
});

export type ReadinessInput = z.infer<typeof readinessInputSchema>;

export type ReadinessAssessment = {
	decision: DeployReadinessDecision;
	failingGate: string | null;
	rationale: string;
};

type Gate = { gate: string; ok: boolean };
type JsonObject = Record<string, unknown>;

const MISSING_PERFORMANCE_EVIDENCE_PERCENT = -100;

function isObject(value: unknown): value is JsonObject {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberField(object: JsonObject, key: string): number | undefined {
	const value = object[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(object: JsonObject, key: string): boolean | undefined {
	const value = object[key];
	return typeof value === "boolean" ? value : undefined;
}

function objectField(object: JsonObject, key: string): JsonObject | undefined {
	const value = object[key];
	return isObject(value) ? value : undefined;
}

function stringField(object: JsonObject, key: string): string | undefined {
	const value = object[key];
	return typeof value === "string" ? value : undefined;
}

function arrayField(object: JsonObject, key: string): unknown[] | undefined {
	const value = object[key];
	return Array.isArray(value) ? value : undefined;
}

function improvementPercent(baseline: number, candidate: number): number {
	if (!Number.isFinite(baseline) || !Number.isFinite(candidate) || baseline <= 0) {
		return 0;
	}
	return ((baseline - candidate) / baseline) * 100;
}

function improvementOrMissingEvidence(
	baseline: number | undefined,
	candidate: number | undefined,
): number {
	if (
		baseline === undefined ||
		candidate === undefined ||
		baseline <= 0 ||
		candidate < 0
	) {
		return MISSING_PERFORMANCE_EVIDENCE_PERCENT;
	}
	return improvementPercent(baseline, candidate);
}

function sumMetricsIfComplete(
	tools: unknown[],
	runtime: "ts" | "rust",
	metric: string,
): number | undefined {
	if (tools.length === 0) return undefined;

	let total = 0;
	for (const tool of tools) {
		if (!isObject(tool)) return undefined;
		const runtimeMetrics = objectField(tool, runtime);
		if (!runtimeMetrics) return undefined;
		const metricValue = numberField(runtimeMetrics, metric);
		if (metricValue === undefined || metricValue < 0) return undefined;
		total += metricValue;
	}
	return total;
}

function maxMetricsIfComplete(
	tools: unknown[],
	runtime: "ts" | "rust",
	metric: string,
): number | undefined {
	if (tools.length === 0) return undefined;

	let max = 0;
	for (const tool of tools) {
		if (!isObject(tool)) return undefined;
		const runtimeMetrics = objectField(tool, runtime);
		if (!runtimeMetrics) return undefined;
		const metricValue = numberField(runtimeMetrics, metric);
		if (metricValue === undefined || metricValue < 0) return undefined;
		max = Math.max(max, metricValue);
	}
	return max;
}

function normalizeParityEvidence(raw: unknown): ReadinessInput["parity"] {
	const parsed = parityEvidenceSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	if (!isObject(raw)) return parityEvidenceSchema.parse(raw);

	const diffs = arrayField(raw, "diffs") ?? [];
	const outputParityPercent = numberField(raw, "outputParityPercent") ?? 0;
	const errorCompatibilityPercent = numberField(raw, "errorCompatibilityPercent") ?? 0;
	const toolsCovered = arrayField(raw, "toolsCovered") ?? [];
	const unclassifiedFailures = numberField(raw, "unclassifiedFailures") ?? diffs.length;
	const meta = objectField(raw, "meta");
	const rustBinarySha256 =
		stringField(raw, "rustBinarySha256") ??
		(meta ? stringField(meta, "rustBinarySha256") : undefined) ??
		null;
	const soakHours = numberField(raw, "soakHours") ?? 0;
	const continuousSoakHours =
		numberField(raw, "continuousSoakHours") ??
		(meta ? soakHours : 0);

	return parityEvidenceSchema.parse({
		publicSurfaceMatch:
			booleanField(raw, "publicSurfaceMatch") ?? toolsCovered.length >= 24,
		releaseE2ePass: booleanField(raw, "releaseE2ePass") ?? false,
		publicSurfaceCoveragePercent:
			numberField(raw, "publicSurfaceCoveragePercent") ?? 0,
		httpDeployEnvCoveragePercent:
			numberField(raw, "httpDeployEnvCoveragePercent") ?? 0,
		packageSmokePass: booleanField(raw, "packageSmokePass") ?? false,
		outputParityPercent,
		errorCompatibilityPercent,
		unclassifiedFailures,
		rustBinarySha256,
		soakHours,
		continuousSoakHours,
		crashes: numberField(raw, "crashes") ?? 0,
		dataLossIncidents: numberField(raw, "dataLossIncidents") ?? 0,
		rollbackValidated: booleanField(raw, "rollbackValidated") ?? false,
		rollbackRehearsed: booleanField(raw, "rollbackRehearsed") ?? false,
		observabilityLevel:
			typeof raw.observabilityLevel === "string"
				? raw.observabilityLevel
				: "basic",
		unresolvedTelemetryAnomalies:
			numberField(raw, "unresolvedTelemetryAnomalies") ?? 0,
		compatibilityExceptionsApproved:
			booleanField(raw, "compatibilityExceptionsApproved") ??
			(outputParityPercent >= 100 &&
				errorCompatibilityPercent >= 100 &&
				unclassifiedFailures === 0),
	});
}

function normalizePerfEvidence(raw: unknown): ReadinessInput["perf"] {
	const parsed = perfEvidenceSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	if (!isObject(raw)) return perfEvidenceSchema.parse(raw);

	const summary = objectField(raw, "summary");
	const tools = arrayField(raw, "tools") ?? [];
	const tsMedianTotal = summary
		? numberField(summary, "tsMedianTotalMs")
		: undefined;
	const rustMedianTotal = summary
		? numberField(summary, "rustMedianTotalMs")
		: undefined;
	const tsP95Total = sumMetricsIfComplete(tools, "ts", "p95Ms");
	const rustP95Total = sumMetricsIfComplete(tools, "rust", "p95Ms");
	const tsStartupTotal = sumMetricsIfComplete(tools, "ts", "coldStartMs");
	const rustStartupTotal = sumMetricsIfComplete(tools, "rust", "coldStartMs");
	const tsMemoryMax = maxMetricsIfComplete(tools, "ts", "maxRssKb");
	const rustMemoryMax = maxMetricsIfComplete(tools, "rust", "maxRssKb");

	return perfEvidenceSchema.parse({
		medianLatencyImprovementPercent: improvementOrMissingEvidence(
			tsMedianTotal,
			rustMedianTotal,
		),
		p95LatencyImprovementPercent: improvementOrMissingEvidence(
			tsP95Total,
			rustP95Total,
		),
		startupImprovementPercent: improvementOrMissingEvidence(
			tsStartupTotal,
			rustStartupTotal,
		),
		memoryImprovementPercent: improvementOrMissingEvidence(
			tsMemoryMax,
			rustMemoryMax,
		),
	});
}

export function normalizeReadinessEvidence(raw: unknown): ReadinessInput {
	const parsed = readinessInputSchema.safeParse(raw);
	if (parsed.success) return parsed.data;
	if (!isObject(raw)) return readinessInputSchema.parse(raw);

	return readinessInputSchema.parse({
		parity: normalizeParityEvidence(raw.parity),
		perf: normalizePerfEvidence(raw.perf),
	});
}

/**
 * Returns the name of the first gate in the list that is not satisfied, or
 * null when every gate holds. Gates are ordered most-actionable-first so the
 * reported gate is the blocker an operator should fix next.
 */
function firstFailingGate(gates: Gate[]): string | null {
	for (const gate of gates) {
		if (!gate.ok) {
			return gate.gate;
		}
	}
	return null;
}

/**
 * Gates that must ALL hold before Rust may serve a limited canary slice.
 *
 * These thresholds are strictly weaker than the replacement thresholds, which
 * keeps the decision ladder monotonic: anything that clears REPLACE also clears
 * CANARY, so the function can never promote past a gate it has not met.
 */
function canaryGates(input: ReadinessInput): Gate[] {
	const { parity, perf } = input;
	return [
		{
			gate: "compatibility",
			ok:
				parity.outputParityPercent >= 99.5 &&
				parity.errorCompatibilityPercent >= 99.5 &&
				parity.unclassifiedFailures === 0,
		},
		{
			gate: "binary-identity",
			ok: parity.rustBinarySha256 !== null,
		},
		{
			gate: "release-e2e",
			ok:
				parity.releaseE2ePass &&
				parity.publicSurfaceCoveragePercent >= 100 &&
				parity.httpDeployEnvCoveragePercent >= 100,
		},
		{ gate: "package-smoke", ok: parity.packageSmokePass },
		{
			gate: "performance",
			ok:
				perf.medianLatencyImprovementPercent >= 10 &&
				perf.p95LatencyImprovementPercent >= -5 &&
				perf.memoryImprovementPercent >= -5,
		},
		{
			gate: "soak",
			ok:
				parity.soakHours >= 24 &&
				parity.continuousSoakHours >= 24 &&
				parity.crashes === 0 &&
				parity.dataLossIncidents === 0,
		},
		{ gate: "rollback", ok: parity.rollbackValidated },
		{ gate: "observability", ok: parity.observabilityLevel !== "basic" },
	];
}

/**
 * Gates that must ALL hold before Rust may replace TypeScript as the default
 * implementation. Full parity plus an explicit compatibility sign-off, a 72h
 * soak, a rehearsed rollback, and release-grade observability.
 */
function replaceGates(input: ReadinessInput): Gate[] {
	const { parity, perf } = input;
	return [
		{
			gate: "compatibility",
			ok:
				parity.outputParityPercent >= 100 &&
				parity.errorCompatibilityPercent >= 100 &&
				parity.unclassifiedFailures === 0 &&
				parity.compatibilityExceptionsApproved,
		},
		{
			gate: "binary-identity",
			ok: parity.rustBinarySha256 !== null,
		},
		{
			gate: "release-e2e",
			ok:
				parity.releaseE2ePass &&
				parity.publicSurfaceCoveragePercent >= 100 &&
				parity.httpDeployEnvCoveragePercent >= 100,
		},
		{ gate: "package-smoke", ok: parity.packageSmokePass },
		{
			gate: "performance",
			ok:
				perf.medianLatencyImprovementPercent >= 20 &&
				perf.p95LatencyImprovementPercent >= 10 &&
				perf.startupImprovementPercent >= 0 &&
				perf.memoryImprovementPercent >= 0,
		},
		{
			gate: "soak",
			ok:
				parity.soakHours >= 72 &&
				parity.continuousSoakHours >= 72 &&
				parity.crashes === 0 &&
				parity.dataLossIncidents === 0 &&
				parity.unresolvedTelemetryAnomalies === 0,
		},
		{
			gate: "rollback",
			ok: parity.rollbackValidated && parity.rollbackRehearsed,
		},
		{ gate: "observability", ok: parity.observabilityLevel === "release" },
	];
}

/**
 * Turns parity and performance evidence into a single deploy-readiness
 * decision. The ladder is NO -> SHADOW -> CANARY -> REPLACE, and the function
 * returns the highest tier whose gates are fully satisfied along with the
 * first gate blocking the next promotion. A null `failingGate` only ever
 * accompanies a REPLACE decision.
 */
export function assessDeployReadiness(input: ReadinessInput): ReadinessAssessment {
	if (!input.parity.publicSurfaceMatch) {
		return {
			decision: "NO",
			failingGate: "public-surface",
			rationale:
				"Rust does not yet match the TypeScript public contract, so it cannot be exposed in any mode.",
		};
	}

	const canaryBlocker = firstFailingGate(canaryGates(input));
	if (canaryBlocker) {
		return {
			decision: "SHADOW",
			failingGate: canaryBlocker,
			rationale: `Rust may run in hidden shadow comparison mode only; the ${canaryBlocker} gate is still below the canary threshold.`,
		};
	}

	const replaceBlocker = firstFailingGate(replaceGates(input));
	if (replaceBlocker) {
		return {
			decision: "CANARY",
			failingGate: replaceBlocker,
			rationale: `Rust may serve a limited canary slice with rollback in place; the ${replaceBlocker} gate is still below the replacement threshold.`,
		};
	}

	return {
		decision: "REPLACE",
		failingGate: null,
		rationale:
			"Rust meets every parity, release-E2E, package-smoke, performance, soak, rollback, and observability gate, so it may become the default implementation.",
	};
}

export function assessDeployReadinessFromJson(
	raw: unknown,
): ReadinessAssessment {
	return assessDeployReadiness(normalizeReadinessEvidence(raw));
}
