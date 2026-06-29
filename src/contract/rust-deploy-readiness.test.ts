import { describe, expect, it } from "vitest";
import {
	assessDeployReadiness,
	assessDeployReadinessFromJson,
	buildReplacementScorecard,
	buildReplacementScorecardFromJson,
	normalizeReadinessEvidence,
	type ReadinessInput,
} from "./rust-deploy-readiness.js";

const RUST_BINARY_SHA256 =
	"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

/**
 * A fully replacement-ready evidence bundle. Individual tests clone this and
 * weaken exactly one dimension to assert how the ladder steps down.
 */
function replaceReadyInput(): ReadinessInput {
	return {
		parity: {
			publicSurfaceMatch: true,
			releaseE2ePass: true,
			publicSurfaceCoveragePercent: 100,
			httpDeployEnvCoveragePercent: 100,
			outputParityPercent: 100,
			errorCompatibilityPercent: 100,
			unclassifiedFailures: 0,
			rustBinarySha256: RUST_BINARY_SHA256,
			soakHours: 72,
			continuousSoakHours: 72,
			crashes: 0,
			dataLossIncidents: 0,
			rollbackValidated: true,
			rollbackRehearsed: true,
			observabilityLevel: "release",
			unresolvedTelemetryAnomalies: 0,
			compatibilityExceptionsApproved: true,
		},
		perf: {
			medianLatencyImprovementPercent: 25,
			p95LatencyImprovementPercent: 12,
			startupImprovementPercent: 5,
			memoryImprovementPercent: 4,
		},
	};
}

function withParity(
	overrides: Partial<ReadinessInput["parity"]>,
): ReadinessInput {
	const base = replaceReadyInput();
	return { ...base, parity: { ...base.parity, ...overrides } };
}

function withPerf(overrides: Partial<ReadinessInput["perf"]>): ReadinessInput {
	const base = replaceReadyInput();
	return { ...base, perf: { ...base.perf, ...overrides } };
}

function rawReplaceReadyParity(): Record<string, unknown> {
	return {
		toolsCovered: Array.from({ length: 24 }, (_, index) => `tool_${index}`),
		releaseE2ePass: true,
		publicSurfaceCoveragePercent: 100,
		httpDeployEnvCoveragePercent: 100,
		outputParityPercent: 100,
		errorCompatibilityPercent: 100,
		diffs: [],
		meta: { rustBinarySha256: RUST_BINARY_SHA256 },
		soakHours: 72,
		continuousSoakHours: 72,
		crashes: 0,
		dataLossIncidents: 0,
		rollbackValidated: true,
		rollbackRehearsed: true,
		observabilityLevel: "release",
		unresolvedTelemetryAnomalies: 0,
	};
}

describe("assessDeployReadiness", () => {
	it("returns NO when public surface parity is missing", () => {
		const result = assessDeployReadiness(
			withParity({ publicSurfaceMatch: false }),
		);

		expect(result.decision).toBe("NO");
		expect(result.failingGate).toBe("public-surface");
	});

	it("quantifies a replacement-ready Rust candidate", () => {
		const scorecard = buildReplacementScorecard(
			replaceReadyInput(),
			"2026-06-27T00:00:00.000Z",
		);

		expect(scorecard.generatedAt).toBe("2026-06-27T00:00:00.000Z");
		expect(scorecard.readyToReplace).toBe(true);
		expect(scorecard.decision).toBe("REPLACE");
		expect(scorecard.failingGate).toBeNull();
		expect(scorecard.functionalCompatibilityPercent).toBe(100);
		expect(scorecard.replacementGatePassPercent).toBe(100);
		expect(scorecard.gatesPassed).toBe(scorecard.gatesTotal);
		expect(scorecard.summary).toMatchObject({
			outputParityPercent: 100,
			errorCompatibilityPercent: 100,
			unclassifiedFailures: 0,
			medianLatencyImprovementPercent: 25,
			p95LatencyImprovementPercent: 12,
			continuousSoakHours: 72,
			requiredContinuousSoakHours: 72,
		});
	});

	it("keeps short-soak Rust blocked while preserving compatibility and superiority metrics", () => {
		const scorecard = buildReplacementScorecard(
			withParity({ soakHours: 1, continuousSoakHours: 1 }),
			"2026-06-27T00:00:00.000Z",
		);

		expect(scorecard.readyToReplace).toBe(false);
		expect(scorecard.decision).toBe("SHADOW");
		expect(scorecard.failingGate).toBe("soak");
		expect(scorecard.functionalCompatibilityPercent).toBe(100);
		expect(scorecard.replacementGatePassPercent).toBeLessThan(100);
		expect(scorecard.summary.medianLatencyImprovementPercent).toBe(25);
		expect(scorecard.summary.continuousSoakHours).toBe(1);
		expect(
			scorecard.categories.reliability.find(
				(gate) => gate.gate === "continuous-soak-hours",
			),
		).toMatchObject({ ok: false, actual: 1, required: 72 });
	});

	it("quantifies final promotion-packet summaries directly", () => {
		const scorecard = buildReplacementScorecardFromJson(
			{
				evidence: {
					compatibility: {
						publicSurfaceMatch: true,
						releaseE2ePass: true,
						publicSurfaceCoveragePercent: 100,
						httpDeployEnvCoveragePercent: 100,
						outputParityPercent: 100,
						errorCompatibilityPercent: 100,
						unclassifiedFailures: 0,
					},
					performance: {
						medianLatencyImprovementPercent: 99,
						p95LatencyImprovementPercent: 98,
						startupImprovementPercent: 97,
						memoryImprovementPercent: 96,
					},
					reliability: {
						soakHours: 72,
						continuousSoakHours: 72,
						crashes: 0,
						dataLossIncidents: 0,
						unresolvedTelemetryAnomalies: 0,
					},
					rollback: {
						validated: true,
						rehearsed: true,
					},
					observability: {
						level: "release",
					},
					binary: {
						rustBinarySha256: RUST_BINARY_SHA256,
					},
					deploy: {
						packageSmokePass: true,
					},
				},
			},
			"2026-06-27T00:00:00.000Z",
		);

		expect(scorecard.readyToReplace).toBe(true);
		expect(scorecard.functionalCompatibilityPercent).toBe(100);
		expect(scorecard.replacementGatePassPercent).toBe(100);
		expect(scorecard.summary.medianLatencyImprovementPercent).toBe(99);
	});

	it("returns SHADOW when compatibility is incomplete", () => {
		const result = assessDeployReadiness({
			parity: {
				publicSurfaceMatch: true,
				releaseE2ePass: true,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
				outputParityPercent: 98.9,
				errorCompatibilityPercent: 97.9,
				unclassifiedFailures: 1,
				rustBinarySha256: RUST_BINARY_SHA256,
				soakHours: 12,
				continuousSoakHours: 12,
				crashes: 0,
				dataLossIncidents: 0,
				rollbackValidated: false,
				rollbackRehearsed: false,
				observabilityLevel: "basic",
				unresolvedTelemetryAnomalies: 1,
				compatibilityExceptionsApproved: false,
			},
			perf: {
				medianLatencyImprovementPercent: 5,
				p95LatencyImprovementPercent: 0,
				startupImprovementPercent: 0,
				memoryImprovementPercent: 0,
			},
		});

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("compatibility");
	});

	it("stays SHADOW when compatibility is canary-grade but soak is too short", () => {
		const result = assessDeployReadiness(withParity({ soakHours: 12 }));

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("soak");
	});

	it("stays SHADOW when rollback has not been validated", () => {
		const result = assessDeployReadiness(
			withParity({ rollbackValidated: false }),
		);

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("rollback");
	});

	it("stays SHADOW when observability is only basic", () => {
		const result = assessDeployReadiness(
			withParity({ observabilityLevel: "basic" }),
		);

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("observability");
	});

	it("stays SHADOW when latency improvement is below the canary bar", () => {
		const result = assessDeployReadiness(
			withPerf({ medianLatencyImprovementPercent: 5 }),
		);

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("performance");
	});

	it("keeps otherwise-ready evidence in SHADOW without a binary identity", () => {
		const result = assessDeployReadiness(
			withParity({ rustBinarySha256: null }),
		);

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("binary-identity");
	});

	it("stays SHADOW when release E2E proof is missing", () => {
		const result = assessDeployReadiness(
			withParity({
				releaseE2ePass: false,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
			}),
		);

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("release-e2e");
	});

	it("never promotes to CANARY without rollback, soak, or observability evidence", () => {
		// Regression guard: shadow-grade compatibility alone must not clear canary.
		const result = assessDeployReadiness({
			parity: {
				publicSurfaceMatch: true,
				releaseE2ePass: true,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
				outputParityPercent: 99.6,
				errorCompatibilityPercent: 99.6,
				unclassifiedFailures: 0,
				rustBinarySha256: RUST_BINARY_SHA256,
				soakHours: 0,
				continuousSoakHours: 0,
				crashes: 0,
				dataLossIncidents: 0,
				rollbackValidated: false,
				rollbackRehearsed: false,
				observabilityLevel: "basic",
				unresolvedTelemetryAnomalies: 0,
				compatibilityExceptionsApproved: false,
			},
			perf: {
				medianLatencyImprovementPercent: 15,
				p95LatencyImprovementPercent: 0,
				startupImprovementPercent: 0,
				memoryImprovementPercent: 0,
			},
		});

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("soak");
	});

	it("returns CANARY when parity is strong but replacement parity is not complete", () => {
		const result = assessDeployReadiness(
			withParity({
				outputParityPercent: 99.7,
				errorCompatibilityPercent: 99.6,
				soakHours: 24,
				continuousSoakHours: 24,
				rollbackRehearsed: false,
				observabilityLevel: "tool",
				compatibilityExceptionsApproved: false,
			}),
		);

		expect(result.decision).toBe("CANARY");
		expect(result.failingGate).toBe("compatibility");
	});

	it("returns CANARY when only the rehearsed-rollback gate blocks replacement", () => {
		const result = assessDeployReadiness(
			withParity({ rollbackRehearsed: false }),
		);

		expect(result.decision).toBe("CANARY");
		expect(result.failingGate).toBe("rollback");
	});

	it("returns REPLACE when all thresholds are met", () => {
		const result = assessDeployReadiness(replaceReadyInput());

		expect(result.decision).toBe("REPLACE");
		expect(result.failingGate).toBeNull();
	});
});

describe("assessDeployReadinessFromJson", () => {
	it("normalizes raw parity and benchmark reports with conservative ops defaults", () => {
		const input = normalizeReadinessEvidence({
			parity: {
				toolsCovered: Array.from({ length: 24 }, (_, index) => `tool_${index}`),
				outputParityPercent: 100,
				errorCompatibilityPercent: 100,
				diffs: [],
			},
			perf: {
				summary: {
					tsMedianTotalMs: 1000,
					rustMedianTotalMs: 100,
				},
				tools: [
					{
						ts: { p95Ms: 600, coldStartMs: 700, maxRssKb: 200_000 },
						rust: { p95Ms: 60, coldStartMs: 70, maxRssKb: 20_000 },
					},
					{
						ts: { p95Ms: 400, coldStartMs: 300, maxRssKb: 180_000 },
						rust: { p95Ms: 40, coldStartMs: 30, maxRssKb: 18_000 },
					},
				],
			},
		});

		expect(input).toMatchObject({
			parity: {
				publicSurfaceMatch: true,
				releaseE2ePass: false,
				publicSurfaceCoveragePercent: 0,
				httpDeployEnvCoveragePercent: 0,
				outputParityPercent: 100,
				errorCompatibilityPercent: 100,
				unclassifiedFailures: 0,
				rustBinarySha256: null,
				soakHours: 0,
				continuousSoakHours: 0,
				rollbackValidated: false,
				observabilityLevel: "basic",
				compatibilityExceptionsApproved: true,
			},
			perf: {
				medianLatencyImprovementPercent: 90,
				p95LatencyImprovementPercent: 90,
				startupImprovementPercent: 90,
				memoryImprovementPercent: 90,
			},
		});

		const result = assessDeployReadiness(input);
		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("binary-identity");
	});

	it("does not promote when cumulative soak lacks a continuous clean window", () => {
		const result = assessDeployReadinessFromJson({
			parity: {
				publicSurfaceMatch: true,
				outputParityPercent: 100,
				errorCompatibilityPercent: 100,
				unclassifiedFailures: 0,
				rustBinarySha256: RUST_BINARY_SHA256,
				soakHours: 72,
				crashes: 0,
				dataLossIncidents: 0,
				rollbackValidated: true,
				rollbackRehearsed: true,
				observabilityLevel: "release",
				releaseE2ePass: true,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
				unresolvedTelemetryAnomalies: 0,
			},
			perf: {
				medianLatencyImprovementPercent: 25,
				p95LatencyImprovementPercent: 12,
				startupImprovementPercent: 5,
				memoryImprovementPercent: 4,
			},
		});

		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("soak");
	});

	it("fails performance closed when raw benchmark reports omit required metrics", () => {
		const input = normalizeReadinessEvidence({
			parity: rawReplaceReadyParity(),
			perf: {
				summary: {
					tsMedianTotalMs: 1000,
					rustMedianTotalMs: 100,
				},
				tools: [],
			},
		});

		expect(input.perf).toMatchObject({
			medianLatencyImprovementPercent: 90,
			p95LatencyImprovementPercent: -100,
			startupImprovementPercent: -100,
			memoryImprovementPercent: -100,
		});

		const result = assessDeployReadiness(input);
		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("performance");
	});

	it("fails performance closed when raw benchmark reports omit memory evidence", () => {
		const input = normalizeReadinessEvidence({
			parity: rawReplaceReadyParity(),
			perf: {
				summary: {
					tsMedianTotalMs: 1000,
					rustMedianTotalMs: 100,
				},
				tools: [
					{
						ts: { p95Ms: 1000, coldStartMs: 1000 },
						rust: { p95Ms: 100, coldStartMs: 100 },
					},
				],
			},
		});

		expect(input.perf).toMatchObject({
			medianLatencyImprovementPercent: 90,
			p95LatencyImprovementPercent: 90,
			startupImprovementPercent: 90,
			memoryImprovementPercent: -100,
		});

		const result = assessDeployReadiness(input);
		expect(result.decision).toBe("SHADOW");
		expect(result.failingGate).toBe("performance");
	});

	it("lets explicit ops evidence in raw reports promote beyond shadow", () => {
		const result = assessDeployReadinessFromJson({
			parity: {
				toolsCovered: Array.from({ length: 24 }, (_, index) => `tool_${index}`),
				outputParityPercent: 100,
				errorCompatibilityPercent: 100,
				releaseE2ePass: true,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
				diffs: [],
				meta: { rustBinarySha256: RUST_BINARY_SHA256 },
				soakHours: 72,
				continuousSoakHours: 72,
				crashes: 0,
				dataLossIncidents: 0,
				rollbackValidated: true,
				rollbackRehearsed: true,
				observabilityLevel: "release",
				unresolvedTelemetryAnomalies: 0,
			},
			perf: {
				summary: {
					tsMedianTotalMs: 1000,
					rustMedianTotalMs: 100,
				},
				tools: [
					{
						ts: { p95Ms: 1000, coldStartMs: 1000, maxRssKb: 200_000 },
						rust: { p95Ms: 100, coldStartMs: 100, maxRssKb: 20_000 },
					},
				],
			},
		});

		expect(result.decision).toBe("REPLACE");
		expect(result.failingGate).toBeNull();
	});

	it("parses raw JSON and applies schema defaults", () => {
		// unresolvedTelemetryAnomalies and compatibilityExceptionsApproved are
		// omitted; the schema defaults must keep the input out of REPLACE.
		const result = assessDeployReadinessFromJson({
			parity: {
				publicSurfaceMatch: true,
				releaseE2ePass: true,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
				outputParityPercent: 100,
				errorCompatibilityPercent: 100,
				unclassifiedFailures: 0,
				rustBinarySha256: RUST_BINARY_SHA256,
				soakHours: 72,
				continuousSoakHours: 72,
				crashes: 0,
				dataLossIncidents: 0,
				rollbackValidated: true,
				rollbackRehearsed: true,
				observabilityLevel: "release",
			},
			perf: {
				medianLatencyImprovementPercent: 25,
				p95LatencyImprovementPercent: 12,
				startupImprovementPercent: 5,
				memoryImprovementPercent: 4,
			},
		});

		expect(result.decision).toBe("CANARY");
		expect(result.failingGate).toBe("compatibility");
	});

	it("throws when binary identity is malformed", () => {
		const ready = replaceReadyInput();

		expect(() =>
			assessDeployReadinessFromJson({
				parity: { ...ready.parity, rustBinarySha256: "not-a-sha256" },
				perf: ready.perf,
			}),
		).toThrow();
	});

	it("throws on structurally invalid evidence", () => {
		expect(() => assessDeployReadinessFromJson({ parity: {} })).toThrow();
	});
});
