import { describe, expect, it } from "vitest";
import { buildSoakStatus, formatSoakStatus } from "./rust-soak-status.js";

const RUST_BINARY_SHA256 =
	"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";

function run(overrides: Record<string, unknown> = {}) {
	return {
		id: "run-1",
		generatedAt: "2026-06-27T01:00:00.000Z",
		startedAt: "2026-06-27T00:00:00.000Z",
		endedAt: "2026-06-27T01:00:00.000Z",
		releaseTag: "candidate-1",
		rustBinarySha256: RUST_BINARY_SHA256,
		publicSurfaceMatch: true,
		soakHours: 1,
		continuousSoakHours: 1,
		crashes: 0,
		dataLossIncidents: 0,
		unresolvedTelemetryAnomalies: 0,
		outputParityPercent: 100,
		errorCompatibilityPercent: 100,
		unclassifiedFailures: 0,
		observabilityLevel: "release",
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
		expect(status.continuousGapSeconds).toBe(120);
		expect(status.releaseTaggedSoakHours).toBe(1);
		expect(status.remainingCanaryHours).toBe(23);
		expect(status.remainingReplaceHours).toBe(71);
		expect(status.rustBinarySha256).toBe(RUST_BINARY_SHA256);
		expect(status.warnings).toEqual([]);
		expect(formatSoakStatus(status)).toContain("runner:              active");
		expect(formatSoakStatus(status)).toContain("max clean gap:       120s");
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

	it("preserves continuity across bounded runner bookkeeping gaps", () => {
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
					generatedAt: "2026-06-27T02:00:39.000Z",
					startedAt: "2026-06-27T01:00:39.000Z",
					endedAt: "2026-06-27T02:00:39.000Z",
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-27T02:00:39.000Z",
		});

		expect(status.totalCompletedSoakHours).toBe(2);
		expect(status.continuousCleanSoakHours).toBe(2);
		expect(status.continuityLostHours).toBe(0);
	});

	it("breaks continuity when the runner bookkeeping gap exceeds the bound", () => {
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
					generatedAt: "2026-06-27T02:02:01.000Z",
					startedAt: "2026-06-27T01:02:01.000Z",
					endedAt: "2026-06-27T02:02:01.000Z",
				}),
			]),
			runnerAlive: false,
			generatedAt: "2026-06-27T02:02:01.000Z",
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
