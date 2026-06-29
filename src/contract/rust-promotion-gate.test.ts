import { describe, expect, it } from "vitest";
import {
	auditDeploySurface,
	assessPromotionGate,
	assessPromotionGateFromLedger,
	assessPromotionGateFromLedgerSummary,
	buildGateLedgerSummary,
} from "./rust-promotion-gate.js";

const RUST_BINARY_SHA256 =
	"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const CURRENT_PLATFORM =
	`${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;
const REQUIRED_PACKAGE_ARTIFACTS = ["epoch-cli", "epoch-mcp", "epoch-http"].map(
	(binary) => `prebuilds/${CURRENT_PLATFORM}/${binary}${process.platform === "win32" ? ".exe" : ""}`,
);

function packageCommands(overrides: Record<string, unknown> = {}) {
	return ["epoch-cli", "epoch-mcp", "epoch-http"].map((name) => ({
		name,
		target:
			name === "epoch-cli"
				? "node_modules/.bin/epoch"
				: `prebuilds/${CURRENT_PLATFORM}/${name}${process.platform === "win32" ? ".exe" : ""}`,
		exitCode: 0,
		signal: null,
		stdoutHead:
			name === "epoch-cli"
				? '{ "ok": true, "data": {'
				: name === "epoch-mcp"
					? 'Content-Length: 36 {"id":1,"jsonrpc":"2.0","result":{}}'
					: 'health {"status":"ok","tools":24,"uptime":0.0,"version":"0.1.0"}',
		stderrHead: "",
		error: null,
		...overrides,
	}));
}

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
		packageSmokePass: true,
		packageCommandEvidenceComplete: true,
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
		releaseContinuousSoakHours: 24,
		releaseTag: "candidate-1",
		releaseE2ePass: true,
		publicSurfaceCoveragePercent: 100,
		httpDeployEnvCoveragePercent: 100,
		packageSmokePass: true,
		packageCommandEvidenceComplete: true,
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
		packageSmokePass: true,
		packageCommands: packageCommands(),
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

const rustDeploySurface = {
	ok: true,
	reasons: [],
	packageBinEntrypoint: "bin/epoch-rust-launcher.js",
	packageFiles: ["dist", "data", "bin", "prebuilds"],
	packageArtifactFiles: REQUIRED_PACKAGE_ARTIFACTS,
	dockerEntrypoint: 'ENTRYPOINT ["epoch-http"]',
	checks: {
		packageBinRoutesToRust: true,
		packageFilesIncludeRustArtifacts: true,
		dockerEntrypointRoutesToRust: true,
	},
};

describe("auditDeploySurface", () => {
	it("reports the current TypeScript-routed package and Docker shape as not replacement-ready", () => {
		const surface = auditDeploySurface({
			packageJson: {
				bin: { epoch: "dist/index.js" },
				files: ["dist", "data"],
			},
			dockerfile:
				'FROM node:22-slim\nENTRYPOINT ["node", "/app/dist/index.js"]\n',
		});

		expect(surface.ok).toBe(false);
		expect(surface.checks.packageBinRoutesToRust).toBe(false);
		expect(surface.checks.packageFilesIncludeRustArtifacts).toBe(false);
		expect(surface.checks.dockerEntrypointRoutesToRust).toBe(false);
		expect(surface.reasons.join(" ")).toContain("dist/index.js");
	});

	it("accepts an explicitly Rust-routed package and Docker shape", () => {
		const surface = auditDeploySurface({
			packageJson: {
				bin: { epoch: "bin/epoch-rust-launcher.js" },
				files: ["dist", "data", "prebuilds"],
			},
			packageArtifactFiles: REQUIRED_PACKAGE_ARTIFACTS,
			dockerfile: 'FROM scratch\nENTRYPOINT ["epoch-http"]\n',
		});

		expect(surface.ok).toBe(true);
		expect(surface.reasons).toEqual([]);
	});

	it("rejects declared prebuilds when the actual package artifacts are missing", () => {
		const surface = auditDeploySurface({
			packageJson: {
				bin: { epoch: "dist/native/epoch-rust-launcher.js" },
				files: ["dist", "data", "prebuilds"],
			},
			packageArtifactFiles: [],
			dockerfile: 'FROM scratch\nENTRYPOINT ["epoch-http"]\n',
		});

		expect(surface.ok).toBe(false);
		expect(surface.checks.packageBinRoutesToRust).toBe(true);
		expect(surface.checks.packageFilesIncludeRustArtifacts).toBe(false);
		expect(surface.reasons.join(" ")).toContain("prebuild binaries are missing");
	});
});

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

	it("blocks replacement when runner summary release identity differs from the current candidate", () => {
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-2",
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("does not match soak evidence");
	});

	it("blocks replacement when runner summary is not checked against a current release identity", () => {
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Current release identity could not be verified");
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
			},
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

	it("blocks runner summaries without installable package smoke proof", () => {
		const result = assessPromotionGate(
			runnerSummary({ packageSmokePass: false }),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("package smoke evidence");
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
				deploySurface: rustDeploySurface,
			},
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
				releaseContinuousSoakHours: 0,
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

	it("blocks replacement from cumulative evidence without continuous release-tagged soak", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 108,
				continuousSoakHours: 108,
				releaseTaggedSoakHours: 72,
				releaseContinuousSoakHours: 36,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("continuous release-tagged soak");
	});

	it("blocks replacement from cumulative summary without a durable release identity", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				releaseContinuousSoakHours: 72,
				releaseTag: null,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release identity");
	});

	it("blocks replacement from cumulative summary when release identity differs from the current candidate", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				releaseContinuousSoakHours: 72,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-2",
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("does not match soak evidence");
	});

	it("blocks replacement from cumulative summary without checking the current release identity", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				releaseContinuousSoakHours: 72,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Current release identity could not be verified");
	});

	it("blocks replacement from cumulative evidence without qualified performance proof", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				releaseContinuousSoakHours: 72,
				qualifiedPerformanceEvidence: false,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
			},
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

	it("blocks cumulative summaries without installable package smoke proof", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({ packageSmokePass: false }),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("package smoke evidence");
	});

	it("passes replacement from cumulative summary with qualified performance proof", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				releaseContinuousSoakHours: 72,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict ledger scorer reached replace");
	});

	it("blocks replacement from cumulative summary when deploy entrypoints still route to TypeScript", () => {
		const result = assessPromotionGateFromLedgerSummary(
			ledgerSummary({
				totalSoakHours: 72,
				continuousSoakHours: 72,
				releaseTaggedSoakHours: 72,
				releaseContinuousSoakHours: 72,
				qualifiedPerformanceEvidence: true,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
				deploySurface: auditDeploySurface({
					packageJson: {
						bin: { epoch: "dist/index.js" },
						files: ["dist", "data"],
					},
					dockerfile:
						'FROM node:22-slim\nENTRYPOINT ["node", "/app/dist/index.js"]\n',
				}),
			},
		);

		expect(result.ok).toBe(false);
		expect(result.failingGate).toBe("deploy-surface");
		expect(result.reason).toContain("TypeScript-routed");
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict ledger scorer reached replace");
	});

	it("blocks replacement from direct ledger evidence when release identity differs from the current candidate", () => {
		const result = assessPromotionGateFromLedger(
			ledger([
				ledgerRun({
					endedAt: "2026-06-30T00:00:00.000Z",
					soakHours: 72,
					continuousSoakHours: 72,
				}),
			]),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-2",
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("does not match soak evidence");
	});

	it("blocks replacement from direct ledger evidence without checking the current release identity", () => {
		const result = assessPromotionGateFromLedger(
			ledger([
				ledgerRun({
					endedAt: "2026-06-30T00:00:00.000Z",
					soakHours: 72,
					continuousSoakHours: 72,
				}),
			]),
			"replace",
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				deploySurface: rustDeploySurface,
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Current release identity could not be verified");
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
			},
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

	it("blocks direct ledger evidence without installable package smoke proof", () => {
		const result = assessPromotionGateFromLedger(
			ledger([ledgerRun({ packageSmokePass: false })]),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("package smoke evidence");
	});

	it("blocks direct ledger evidence without per-binary package command proof", () => {
		const rawLedger = ledger([ledgerRun({ packageCommands: [] })]);
		const summary = buildGateLedgerSummary(rawLedger);
		const result = assessPromotionGateFromLedger(
			rawLedger,
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(summary.packageCommandEvidenceComplete).toBe(false);
		expect(summary.packageSmokePass).toBe(false);
		expect(result.ok).toBe(false);
		expect(result.reason).toContain("package smoke evidence");
	});

	it("blocks package command proof with the wrong HTTP runtime signature", () => {
		const rawLedger = ledger([
			ledgerRun({
				packageCommands: packageCommands().map((command) =>
					command.name === "epoch-http"
						? { ...command, stdoutHead: "Usage: epoch-http [HOST:PORT]" }
						: command,
				),
			}),
		]);
		const summary = buildGateLedgerSummary(rawLedger);

		expect(summary.packageCommandEvidenceComplete).toBe(false);
		expect(summary.packageSmokePass).toBe(false);
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
			},
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

	it("preserves direct ledger continuity across bounded promotion-verification gaps", () => {
		const summary = buildGateLedgerSummary(
			ledger([
				ledgerRun({
					id: "run-1",
					generatedAt: "2026-06-27T01:00:00.000Z",
					startedAt: "2026-06-27T00:00:00.000Z",
					endedAt: "2026-06-27T01:00:00.000Z",
					soakHours: 1,
					continuousSoakHours: 1,
				}),
				ledgerRun({
					id: "run-2",
					generatedAt: "2026-06-27T02:03:00.000Z",
					startedAt: "2026-06-27T01:03:00.000Z",
					endedAt: "2026-06-27T02:03:00.000Z",
					soakHours: 1,
					continuousSoakHours: 1,
				}),
			]),
		);

		expect(summary.totalSoakHours).toBe(2);
		expect(summary.continuousSoakHours).toBe(2);
		expect(summary.releaseContinuousSoakHours).toBe(2);
	});

	it("does not treat release-tagged soak split by untagged soak as continuous replacement evidence", () => {
		const summary = buildGateLedgerSummary(
			ledger([
				ledgerRun({
					id: "run-1",
					generatedAt: "2026-06-27T12:00:00.000Z",
					startedAt: "2026-06-27T00:00:00.000Z",
					endedAt: "2026-06-28T12:00:00.000Z",
					soakHours: 36,
					continuousSoakHours: 36,
				}),
				ledgerRun({
					id: "run-2",
					generatedAt: "2026-06-29T00:00:00.000Z",
					startedAt: "2026-06-28T12:00:00.000Z",
					endedAt: "2026-06-30T00:00:00.000Z",
					releaseTag: null,
					observabilityLevel: "tool",
					soakHours: 36,
					continuousSoakHours: 36,
				}),
				ledgerRun({
					id: "run-3",
					generatedAt: "2026-06-30T12:00:00.000Z",
					startedAt: "2026-06-30T00:00:00.000Z",
					endedAt: "2026-07-01T12:00:00.000Z",
					soakHours: 36,
					continuousSoakHours: 36,
				}),
			]),
		);

		expect(summary.continuousSoakHours).toBe(108);
		expect(summary.releaseTaggedSoakHours).toBe(72);
		expect(summary.releaseContinuousSoakHours).toBe(36);
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
			{
				currentRustBinarySha256: RUST_BINARY_SHA256,
				currentReleaseTag: "candidate-1",
			},
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-tagged cumulative soak evidence");
	});

	it("fails closed when a durable ledger mixes release identities", () => {
		expect(() =>
			buildGateLedgerSummary(
				ledger([
					ledgerRun({
						id: "run-1",
						releaseTag: "candidate-1",
						endedAt: "2026-06-28T00:00:00.000Z",
					}),
					ledgerRun({
						id: "run-2",
						releaseTag: "candidate-2",
						generatedAt: "2026-06-28T00:01:00.000Z",
						startedAt: "2026-06-28T00:00:00.000Z",
						endedAt: "2026-06-29T00:00:00.000Z",
					}),
				]),
			),
		).toThrow("Mixed release identities");
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
