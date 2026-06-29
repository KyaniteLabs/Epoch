import { describe, expect, it } from "vitest";
import { buildSoakStatus, formatSoakStatus } from "./rust-soak-status.js";

const RUST_BINARY_SHA256 =
	"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
const REPLACEMENT_NEEDS_QUALIFIED_PERFORMANCE_WARNING =
	"Replacement runner has not recorded release-tagged qualified non-smoke performance evidence; soak time may continue, but replacement remains gated until a release-tagged qualified benchmark run is in the ledger.";

function run(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		generatedAt: "2026-06-27T01:00:00.000Z",
		startedAt: "2026-06-27T00:00:00.000Z",
		endedAt: "2026-06-27T01:00:00.000Z",
		releaseTag: "candidate-1",
		rustBinarySha256: RUST_BINARY_SHA256,
		publicSurfaceMatch: true,
		releaseE2ePass: true,
		publicSurfaceCoveragePercent: 100,
		httpDeployEnvCoveragePercent: 100,
		soakHours: 1,
		continuousSoakHours: 1,
		crashes: 0,
		dataLossIncidents: 0,
		unresolvedTelemetryAnomalies: 0,
		rollbackValidated: true,
		rollbackRehearsed: true,
		outputParityPercent: 100,
		errorCompatibilityPercent: 100,
		unclassifiedFailures: 0,
		observabilityLevel: "release",
		medianLatencyImprovementPercent: 90,
		p95LatencyImprovementPercent: 90,
		startupImprovementPercent: 90,
		memoryImprovementPercent: 90,
		readinessDecision: "SHADOW",
		readinessFailingGate: "soak",
		...overrides,
	};
}

function ledger(runs: unknown[]) {
	return {
		version: 1,
		updatedAt: "2026-06-27T01:00:00.000Z",
		runs,
	};
}

describe("buildSoakStatus", () => {
	it("summarizes clean release-tagged soak and remaining replacement time", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([run()]),
			stateRaw: {
				pid: 123,
				startedAt: "2026-06-27T00:00:00.000Z",
				target: "replace",
				packetDir: ".epoch-promotion/latest",
				ledger: ".epoch-promotion/soak-ledger.json",
				releaseTag: "candidate-1",
				runsStarted: 1,
				maxRuns: null,
				untilTarget: true,
			},
			runnerAlive: true,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.activeRunner).toBe(true);
		expect(status.runCount).toBe(1);
		expect(status.totalCompletedSoakHours).toBe(1);
		expect(status.continuousCleanSoakHours).toBe(1);
		expect(status.continuousGapSeconds).toBe(900);
		expect(status.releaseTaggedSoakHours).toBe(1);
		expect(status.qualifiedPerformanceEvidence).toBe(false);
		expect(status.releaseE2ePass).toBe(true);
		expect(status.publicSurfaceCoveragePercent).toBe(100);
		expect(status.httpDeployEnvCoveragePercent).toBe(100);
		expect(status.remainingCanaryHours).toBe(23);
		expect(status.remainingReplaceHours).toBe(71);
		expect(status.rustBinarySha256).toBe(RUST_BINARY_SHA256);
		expect(status.warnings).toEqual([
			REPLACEMENT_NEEDS_QUALIFIED_PERFORMANCE_WARNING,
		]);
		expect(formatSoakStatus(status)).toContain("runner:              active");
		expect(formatSoakStatus(status)).toContain("max clean gap:       900s");
		expect(formatSoakStatus(status)).toContain("qualified perf:      false");
		expect(formatSoakStatus(status)).toContain("release e2e:         true (100%)");
		expect(formatSoakStatus(status)).toContain(
			"runner release tag:  candidate-1",
		);
		expect(formatSoakStatus(status)).toContain(
			`warning:             ${REPLACEMENT_NEEDS_QUALIFIED_PERFORMANCE_WARNING}`,
		);
	});

	it("clears the replacement performance warning when qualified evidence exists", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([run({ performanceEvidenceMode: "qualified" })]),
			stateRaw: {
				pid: 123,
				startedAt: "2026-06-27T00:00:00.000Z",
				target: "replace",
				packetDir: ".epoch-promotion/latest",
				ledger: ".epoch-promotion/soak-ledger.json",
				releaseTag: "candidate-1",
				runsStarted: 1,
				maxRuns: null,
				untilTarget: true,
				benchmarkMode: "qualified",
			},
			runnerAlive: true,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.qualifiedPerformanceEvidence).toBe(true);
		expect(status.warnings).toEqual([]);
	});

	it("reports cumulative canary readiness instead of the latest packet readiness", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([
				run({
					soakHours: 24,
					continuousSoakHours: 24,
					endedAt: "2026-06-28T00:00:00.000Z",
					readinessDecision: "SHADOW",
					readinessFailingGate: "soak",
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-28T00:00:00.000Z",
		});

		expect(status.readinessDecision).toBe("CANARY");
		expect(status.readinessFailingGate).toBe("soak");
		expect(formatSoakStatus(status)).toContain("readiness:           CANARY");
	});

	it("reports cumulative replacement readiness when the ledger satisfies all scorer gates", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([
				run({
					soakHours: 72,
					continuousSoakHours: 72,
					endedAt: "2026-06-30T00:00:00.000Z",
					performanceEvidenceMode: "qualified",
					readinessDecision: "SHADOW",
					readinessFailingGate: "soak",
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-30T00:00:00.000Z",
		});

		expect(status.readinessDecision).toBe("REPLACE");
		expect(status.readinessFailingGate).toBeNull();
		expect(formatSoakStatus(status)).toContain("readiness:           REPLACE");
		expect(formatSoakStatus(status)).toContain("failing gate:        none");
	});

	it("does not count untagged qualified evidence for replacement status", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([
				run({
					releaseTag: null,
					observabilityLevel: "tool",
					performanceEvidenceMode: "qualified",
				}),
			]),
			stateRaw: {
				pid: 123,
				startedAt: "2026-06-27T00:00:00.000Z",
				target: "replace",
				packetDir: ".epoch-promotion/latest",
				ledger: ".epoch-promotion/soak-ledger.json",
				releaseTag: "candidate-1",
				runsStarted: 1,
				maxRuns: null,
				untilTarget: true,
				benchmarkMode: "qualified",
			},
			runnerAlive: true,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.qualifiedPerformanceEvidence).toBe(false);
		expect(status.warnings).toContain(
			REPLACEMENT_NEEDS_QUALIFIED_PERFORMANCE_WARNING,
		);
	});

	it("does not count release-observable runs without release tags as release-tagged soak", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([run({ releaseTag: null })]),
			runnerAlive: false,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.totalCompletedSoakHours).toBe(1);
		expect(status.continuousCleanSoakHours).toBe(1);
		expect(status.releaseTaggedSoakHours).toBe(0);
		expect(status.remainingReplaceHours).toBe(71);
	});

	it("preserves continuity across bounded promotion-verification gaps", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([
				run({
					id: "run-1",
					generatedAt: "2026-06-27T01:00:00.000Z",
					startedAt: "2026-06-27T00:00:00.000Z",
					endedAt: "2026-06-27T01:00:00.000Z",
				}),
				run({
					id: "run-2",
					generatedAt: "2026-06-27T02:03:00.000Z",
					startedAt: "2026-06-27T01:03:00.000Z",
					endedAt: "2026-06-27T02:03:00.000Z",
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-27T02:03:00.000Z",
		});

		expect(status.totalCompletedSoakHours).toBe(2);
		expect(status.continuousCleanSoakHours).toBe(2);
		expect(status.continuityLostHours).toBe(0);
	});

	it("breaks continuity when the promotion-verification gap exceeds the bound", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([
				run({
					id: "run-1",
					generatedAt: "2026-06-27T01:00:00.000Z",
					startedAt: "2026-06-27T00:00:00.000Z",
					endedAt: "2026-06-27T01:00:00.000Z",
				}),
				run({
					id: "run-2",
					generatedAt: "2026-06-27T02:15:01.000Z",
					startedAt: "2026-06-27T01:15:01.000Z",
					endedAt: "2026-06-27T02:15:01.000Z",
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-27T02:15:01.000Z",
		});

		expect(status.totalCompletedSoakHours).toBe(2);
		expect(status.continuousCleanSoakHours).toBe(1);
		expect(status.continuityLostHours).toBe(1);
	});

	it("does not credit broken runs toward continuous clean soak", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([
				run({
					crashes: 1,
					endedAt: "2026-06-27T02:00:00.000Z",
					soakHours: 2,
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-27T02:00:00.000Z",
		});

		expect(status.totalCompletedSoakHours).toBe(2);
		expect(status.continuousCleanSoakHours).toBe(0);
		expect(status.remainingReplaceHours).toBe(72);
		expect(status.warnings).toContain(
			"Ledger includes crashes, data-loss incidents, or telemetry anomalies.",
		);
	});

	it("does not credit runs without release E2E toward continuous clean soak", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([
				run({
					releaseE2ePass: false,
					publicSurfaceCoveragePercent: 100,
					httpDeployEnvCoveragePercent: 100,
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.totalCompletedSoakHours).toBe(1);
		expect(status.continuousCleanSoakHours).toBe(0);
		expect(status.releaseE2ePass).toBe(false);
		expect(status.remainingReplaceHours).toBe(72);
		expect(status.warnings).toContain(
			"Ledger includes public-surface, release-E2E, parity, or unclassified failures.",
		);
	});

	it("warns when a state file remains but the runner process is dead", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([run()]),
			stateRaw: { pid: 999, target: "replace" },
			runnerAlive: false,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.activeRunner).toBe(false);
		expect(status.warnings).toContain(
			"Runner state exists, but the recorded process is not alive.",
		);
	});

	it("does not mark a live runner active for a different ledger", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger-a.json",
			ledgerRaw: ledger([run()]),
			stateRaw: {
				pid: 123,
				target: "replace",
				ledger: ".epoch-promotion/soak-ledger-b.json",
			},
			runnerAlive: true,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.activeRunner).toBe(false);
		expect(status.warnings).toContain(
			"Runner is active for .epoch-promotion/soak-ledger-b.json, not .epoch-promotion/soak-ledger-a.json.",
		);
	});

	it("warns when a live runner state cannot be tied to the requested ledger", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([run()]),
			stateRaw: {
				pid: 123,
				target: "replace",
			},
			runnerAlive: true,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.activeRunner).toBe(false);
		expect(status.warnings).toContain(
			"Runner state is missing its ledger path; cannot prove it is writing this ledger.",
		);
	});

	it("warns when an active replacement runner state is missing a release tag", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([run({ performanceEvidenceMode: "qualified" })]),
			stateRaw: {
				pid: 123,
				target: "replace",
				ledger: ".epoch-promotion/soak-ledger.json",
			},
			runnerAlive: true,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.activeRunner).toBe(true);
		expect(status.warnings).toContain(
			"Replacement runner state is missing releaseTag; cannot prove which candidate is still soaking.",
		);
	});

	it("warns when active runner and latest ledger release tags diverge", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([run({ performanceEvidenceMode: "qualified" })]),
			stateRaw: {
				pid: 123,
				target: "replace",
				ledger: ".epoch-promotion/soak-ledger.json",
				releaseTag: "candidate-2",
			},
			runnerAlive: true,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.activeRunner).toBe(true);
		expect(status.warnings).toContain(
			"Runner release tag candidate-2 does not match latest ledger run candidate-1.",
		);
	});

	it("ignores malformed ledger entries instead of crediting soak", () => {
		const status = buildSoakStatus({
			ledgerPath: ".epoch-promotion/soak-ledger.json",
			ledgerRaw: ledger([{ startedAt: "2026-06-27T00:00:00.000Z" }]),
			runnerAlive: false,
			generatedAt: "2026-06-27T01:00:00.000Z",
		});

		expect(status.runCount).toBe(0);
		expect(status.ignoredRunCount).toBe(1);
		expect(status.totalCompletedSoakHours).toBe(0);
		expect(status.warnings).toContain(
			"Ledger includes malformed or incomplete run records that were not credited.",
		);
	});
});
