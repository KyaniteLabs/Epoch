import { describe, expect, it } from "vitest";
import {
	assessPromotionGate,
	assessPromotionGateFromLedger,
	assessPromotionGateFromLedgerSummary,
	buildGateLedgerSummary,
} from "./rust-promotion-gate.js";

const RUST_BINARY_SHA256 =
	"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function runnerSummary(overrides: Record<string, unknown> = {}) {
	return {
		target: "canary",
		targetHoursSource: "default",
		targetReached: true,
		targetSatisfiedBy: "scorer",
		smokeTargetReached: false,
		releaseE2ePass: true,
		publicSurfaceCoveragePercent: 100,
		httpDeployEnvCoveragePercent: 100,
		releaseTag: "candidate-1",
		rustBinarySha256: RUST_BINARY_SHA256,
		readiness: {
			decision: "CANARY",
			failingGate: "compatibility",
			rationale: "Ready for canary.",
		},
		...overrides,
	};
}

function ledgerSummary(overrides: Record<string, unknown> = {}) {
	return {
		totalSoakHours: 24,
		continuousSoakHours: 24,
		releaseTaggedSoakHours: 24,
		releaseE2ePass: true,
		publicSurfaceCoveragePercent: 100,
		httpDeployEnvCoveragePercent: 100,
		rustBinarySha256: RUST_BINARY_SHA256,
		readiness: {
			decision: "CANARY",
			failingGate: "soak",
			rationale: "Ready for canary.",
		},
		...overrides,
	};
}

function ledgerRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		generatedAt: "2026-06-27T00:00:00.000Z",
		startedAt: "2026-06-27T00:00:00.000Z",
		endedAt: "2026-06-28T00:00:00.000Z",
		releaseTag: "candidate-1",
		rustBinarySha256: RUST_BINARY_SHA256,
		publicSurfaceMatch: true,
		releaseE2ePass: true,
		publicSurfaceCoveragePercent: 100,
		httpDeployEnvCoveragePercent: 100,
		outputParityPercent: 100,
		errorCompatibilityPercent: 100,
		unclassifiedFailures: 0,
		soakHours: 24,
		continuousSoakHours: 24,
		crashes: 0,
		dataLossIncidents: 0,
		unresolvedTelemetryAnomalies: 0,
		rollbackValidated: true,
		rollbackRehearsed: true,
		observabilityLevel: "release",
		medianLatencyImprovementPercent: 90,
		p95LatencyImprovementPercent: 90,
		startupImprovementPercent: 90,
		memoryImprovementPercent: 90,
		performanceEvidenceMode: "qualified",
		...overrides,
	};
}

function ledger(runs: unknown[]) {
	return {
		version: 1,
		updatedAt: "2026-06-27T00:00:00.000Z",
		runs,
	};
}

describe("assessPromotionGate", () => {
	it("passes when strict scorer reached the canary target", () => {
		const result = assessPromotionGate(runnerSummary(), "canary", {
			currentRustBinarySha256: RUST_BINARY_SHA256,
		});

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict scorer reached canary");
	});

	it("blocks smoke target overrides even when the smoke path completed", () => {
		const result = assessPromotionGate(
			runnerSummary({
				targetHoursSource: "override",
				targetReached: false,
				targetSatisfiedBy: null,
				smokeTargetReached: true,
				readiness: {
					decision: "SHADOW",
					failingGate: "soak",
					rationale: "Smoke only.",
				},
			}),
			"canary",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("smoke target override");
	});

	it("blocks weaker runner summaries for stronger requested targets", () => {
		const result = assessPromotionGate(
			runnerSummary({ target: "canary" }),
			"replace",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("below requested replace");
	});

	it("accepts replacement-target summaries for canary once the strict scorer reaches canary", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				targetReached: false,
				targetSatisfiedBy: null,
				readiness: {
					decision: "CANARY",
					failingGate: "soak",
					rationale: "Ready for canary; still soaking for replacement.",
				},
			}),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict scorer reached canary");
	});

	it("blocks replacement-target summaries for canary until the strict scorer reaches canary", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				targetReached: false,
				targetSatisfiedBy: null,
				readiness: {
					decision: "SHADOW",
					failingGate: "soak",
					rationale: "Still soaking.",
				},
			}),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Readiness decision SHADOW is below CANARY");
	});

	it("blocks missing Rust binary identity", () => {
		const result = assessPromotionGate(
			runnerSummary({ rustBinarySha256: null }),
			"canary",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("missing the Rust binary SHA-256");
	});

	it("blocks when the current Rust binary does not match soak evidence", () => {
		const result = assessPromotionGate(runnerSummary(), "canary", {
			currentRustBinarySha256:
				"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("does not match soak evidence");
	});

	it("blocks when the current Rust binary hash is unavailable", () => {
		const result = assessPromotionGate(runnerSummary(), "canary", {
			currentRustBinarySha256: null,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("could not be verified");
	});

	it("blocks replacement without a release tag", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				releaseTag: null,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-tagged");
	});

	it("blocks replacement runner summaries without qualified performance proof", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				qualifiedPerformanceEvidence: false,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("qualified non-smoke performance");
	});

	it("blocks runner summaries without release E2E proof", () => {
		const result = assessPromotionGate(
			runnerSummary({
				releaseE2ePass: false,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
			}),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-binary E2E coverage");
	});

	it("passes replacement when strict scorer, release evidence, and qualified performance agree", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict scorer reached replace");
	});
});

describe("assessPromotionGateFromLedgerSummary", () => {
	it("passes canary from cumulative ledger evidence while a replacement runner is still active", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary(),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict ledger scorer reached canary");
	});

	it("blocks cumulative evidence until the required continuous soak window is present", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 0.3334,
				continuousSoakHours: 0.3334,
				readiness: {
					decision: "SHADOW",
					failingGate: "soak",
					rationale: "Still soaking.",
				},
			}),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("canary requires 24");
	});

	it("blocks replacement from cumulative evidence without release-tagged soak", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 0,
				readiness: {
					decision: "CANARY",
					failingGate: "observability",
					rationale: "Missing release evidence.",
				},
			}),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-tagged cumulative soak evidence");
	});

	it("blocks replacement from cumulative evidence without qualified performance proof", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				qualifiedPerformanceEvidence: false,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("qualified non-smoke performance");
	});

	it("blocks cumulative summaries without release E2E proof", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				releaseE2ePass: false,
				publicSurfaceCoveragePercent: 100,
				httpDeployEnvCoveragePercent: 100,
			}),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-binary E2E coverage");
	});

	it("passes replacement from cumulative summary with qualified performance proof", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict ledger scorer reached replace");
	});

	it("blocks cumulative evidence when the current binary hash differs", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary(),
			"canary",
			{
				currentRustBinarySha256:
					"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("does not match soak evidence");
	});
});

describe("assessPromotionGateFromLedger", () => {
	it("passes canary from durable cumulative ledger records", () => {
		const result = assessPromotionGateFromLedger(
			ledger([ledgerRun()]),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict ledger scorer reached canary");
	});

	it("derives replacement readiness from 72 release-tagged ledger hours", () => {
		const result = assessPromotionGateFromLedger(
			ledger([
				ledgerRun({
					endedAt: "2026-06-30T00:00:00.000Z",
					soakHours: 72,
					continuousSoakHours: 72,
				}),
			]),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict ledger scorer reached replace");
	});

	it("blocks replacement when 72-hour ledger evidence only has smoke performance proof", () => {
		const result = assessPromotionGateFromLedger(
			ledger([
				ledgerRun({
					endedAt: "2026-06-30T00:00:00.000Z",
					soakHours: 72,
					continuousSoakHours: 72,
					performanceEvidenceMode: "smoke",
				}),
			]),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("qualified non-smoke performance");
	});

	it("blocks direct ledger evidence without release E2E proof", () => {
		const result = assessPromotionGateFromLedger(
			ledger([ledgerRun({ releaseE2ePass: false })]),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-binary E2E coverage");
	});

	it("blocks replacement when qualified performance evidence is not release-tagged", () => {
		const result = assessPromotionGateFromLedger(
			ledger([
				ledgerRun({
					endedAt: "2026-06-30T00:00:00.000Z",
					soakHours: 72,
					continuousSoakHours: 72,
					performanceEvidenceMode: "smoke",
				}),
				ledgerRun({
					id: "run-2",
					generatedAt: "2026-06-30T00:01:00.000Z",
					startedAt: "2026-06-30T00:01:00.000Z",
					endedAt: "2026-06-30T00:01:00.000Z",
					releaseTag: null,
					observabilityLevel: "tool",
					soakHours: 0,
					continuousSoakHours: 0,
					performanceEvidenceMode: "qualified",
				}),
			]),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("qualified non-smoke performance");
	});

	it("blocks direct ledger evidence before the required continuous soak window", () => {
		const result = assessPromotionGateFromLedger(
			ledger([
				ledgerRun({
					endedAt: "2026-06-27T00:20:00.000Z",
					soakHours: 0.3334,
					continuousSoakHours: 0.3334,
				}),
			]),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("canary requires 24");
	});

	it("blocks replacement when release observability lacks a durable release tag", () => {
		const result = assessPromotionGateFromLedger(
			ledger([
				ledgerRun({
					endedAt: "2026-06-30T00:00:00.000Z",
					releaseTag: null,
					soakHours: 72,
					continuousSoakHours: 72,
				}),
			]),
			"replace",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-tagged cumulative soak evidence");
	});

	it("fails closed when a durable ledger mixes Rust binary identities", () => {
		expect(() =>
			buildGateLedgerSummary(
				ledger([
					ledgerRun({ id: "run-1" }),
					ledgerRun({
						id: "run-2",
						generatedAt: "2026-06-28T00:00:00.000Z",
						startedAt: "2026-06-28T00:00:00.000Z",
						endedAt: "2026-06-29T00:00:00.000Z",
						rustBinarySha256:
							"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
					}),
				]),
			),
		).toThrow("Mixed Rust binary identities");
	});
});
