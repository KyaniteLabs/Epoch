import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import type { ReplacementScorecard } from "./rust-deploy-readiness.js";
import { formatReplacementScorecard } from "./rust-replacement-scorecard.js";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUST_BINARY_SHA256 =
	"ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

describe("formatReplacementScorecard", () => {
	it("renders the replacement verdict and quantified proof metrics", () => {
		const rendered = formatReplacementScorecard({
			generatedAt: "2026-06-27T00:00:00.000Z",
			decision: "CANARY",
			failingGate: "soak",
			readyToReplace: false,
			functionalCompatibilityPercent: 100,
			replacementGatePassPercent: 90.909090909,
			gatesPassed: 20,
			gatesTotal: 22,
			categories: {
				compatibility: [],
				performance: [],
				reliability: [],
				deploy: [],
			},
			summary: {
				outputParityPercent: 100,
				errorCompatibilityPercent: 100,
				unclassifiedFailures: 0,
				medianLatencyImprovementPercent: 93.2,
				p95LatencyImprovementPercent: 87.1,
				startupImprovementPercent: 12,
				memoryImprovementPercent: 3,
				continuousSoakHours: 1,
				requiredContinuousSoakHours: 72,
			},
		} satisfies ReplacementScorecard);

		expect(rendered).toContain("verdict:                  BLOCKED");
		expect(rendered).toContain("readiness decision:       CANARY");
		expect(rendered).toContain("first blocker:            soak");
		expect(rendered).toContain("functional compatibility: 100.00%");
		expect(rendered).toContain("replacement gates:        20/22 (90.91%)");
		expect(rendered).toContain("median improvement:       93.20%");
		expect(rendered).toContain("continuous soak:          1.0000h/72h");
	});

	it("accepts durable soak ledgers as single-file scorecard input", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-scorecard-ledger-"));
		const ledgerPath = join(root, "soak-ledger.json");
		writeJson(ledgerPath, {
			version: 1,
			runs: [
				{
					id: "run-1",
					generatedAt: "2026-06-30T00:00:00.000Z",
					startedAt: "2026-06-27T00:00:00.000Z",
					endedAt: "2026-06-30T00:00:00.000Z",
					releaseTag: "candidate-1",
					rustBinarySha256: RUST_BINARY_SHA256,
					publicSurfaceMatch: true,
					releaseE2ePass: true,
					publicSurfaceCoveragePercent: 100,
					httpDeployEnvCoveragePercent: 100,
					packageSmokePass: true,
					packageCommands: ["epoch-cli", "epoch-mcp", "epoch-http"].map(
						(name) => ({
							name,
							target:
								name === "epoch-cli"
									? "node_modules/.bin/epoch"
									: `prebuilds/${process.platform}-${process.arch === "x64" ? "x64" : process.arch}/${name}${process.platform === "win32" ? ".exe" : ""}`,
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
						}),
					),
					packageCliSha256: RUST_BINARY_SHA256,
					outputParityPercent: 100,
					errorCompatibilityPercent: 100,
					unclassifiedFailures: 0,
					soakHours: 72,
					continuousSoakHours: 72,
					crashes: 0,
					dataLossIncidents: 0,
					unresolvedTelemetryAnomalies: 0,
					rollbackValidated: true,
					rollbackRehearsed: true,
					observabilityLevel: "release",
					medianLatencyImprovementPercent: 95,
					p95LatencyImprovementPercent: 94,
					startupImprovementPercent: 93,
					memoryImprovementPercent: 92,
					performanceEvidenceMode: "qualified",
					performanceToolsBenchmarked: 24,
					performanceIterationsScale: 1,
				},
			],
		});

		const output = execFileSync(
			"pnpm",
			[
				"exec",
				"tsx",
				"src/contract/rust-replacement-scorecard.ts",
				"--",
				ledgerPath,
			],
			{ cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 1024 * 1024 },
		);

		expect(output).toContain("verdict:                  REPLACE");
		expect(output).toContain("functional compatibility: 100.00%");
		expect(output).toContain("replacement gates:        22/22 (100.00%)");
		expect(output).toContain('"readyToReplace": true');
	});
});
