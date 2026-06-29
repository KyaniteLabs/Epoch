import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const RUST_BINARY_SHA256 =
	"eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const CURRENT_PLATFORM =
	`${process.platform}-${process.arch === "x64" ? "x64" : process.arch}`;

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function packageCommands() {
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
				? '{"ok": true}'
				: name === "epoch-mcp"
					? 'Content-Length: 36 {"result":{}}'
					: 'health {"status":"ok","tools":24}',
		stderrHead: "",
		error: null,
	}));
}

function packet(
	dir: string,
	options: {
		generatedAt: string;
		startedAt: string;
		endedAt: string;
		performanceEvidenceMode: "qualified" | "smoke";
	},
): void {
	writeJson(join(dir, "readiness-input.json"), {
		parity: {
			publicSurfaceMatch: true,
			releaseE2ePass: true,
			publicSurfaceCoveragePercent: 100,
			httpDeployEnvCoveragePercent: 100,
			packageSmokePass: true,
			outputParityPercent: 100,
			errorCompatibilityPercent: 100,
			unclassifiedFailures: 0,
			rustBinarySha256: RUST_BINARY_SHA256,
			soakHours: 1,
			continuousSoakHours: 1,
			crashes: 0,
			dataLossIncidents: 0,
			rollbackValidated: true,
			rollbackRehearsed: true,
			observabilityLevel: "release",
			unresolvedTelemetryAnomalies: 0,
			compatibilityExceptionsApproved: true,
		},
		perf: {
			medianLatencyImprovementPercent: 90,
			p95LatencyImprovementPercent: 90,
			startupImprovementPercent: 90,
			memoryImprovementPercent: 90,
		},
	});
	writeJson(join(dir, "promotion-packet.json"), {
		generatedAt: options.generatedAt,
		readiness: {
			decision: "SHADOW",
			failingGate: "soak",
			rationale: "Still accumulating soak.",
		},
		evidence: {
			observability: { releaseTag: "candidate-1" },
			performance: { evidenceMode: options.performanceEvidenceMode },
			deploy: {
				packageCommands: packageCommands(),
			},
		},
	});
	writeJson(join(dir, "shadow-soak.json"), {
		meta: {
			startedAt: options.startedAt,
			endedAt: options.endedAt,
			rustBinary: "rust/target/release/epoch-cli",
			rustBinarySha256: RUST_BINARY_SHA256,
		},
	});
}

function runLedger(packetDir: string, ledgerPath: string, summaryPath: string): void {
	execFileSync(
		"pnpm",
		[
			"exec",
			"tsx",
			"scripts/rust-soak-ledger.ts",
			"--",
			"--packet-dir",
			packetDir,
			"--ledger",
			ledgerPath,
			"--summary-output",
			summaryPath,
			"--quiet",
		],
		{ cwd: REPO_ROOT, maxBuffer: 16 * 1024 * 1024, stdio: "pipe" },
	);
}

describe("rust-soak-ledger CLI", () => {
	it("preserves release E2E fields when appending to an existing ledger", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-ledger-cli-"));
		const firstPacket = join(root, "packet-1");
		const secondPacket = join(root, "packet-2");
		const ledgerPath = join(root, "soak-ledger.json");
		const firstSummary = join(root, "summary-1.json");
		const secondSummary = join(root, "summary-2.json");
		mkdirSync(firstPacket, { recursive: true });
		mkdirSync(secondPacket, { recursive: true });
		packet(firstPacket, {
			generatedAt: "2026-06-29T00:01:00.000Z",
			startedAt: "2026-06-29T00:00:00.000Z",
			endedAt: "2026-06-29T01:00:00.000Z",
			performanceEvidenceMode: "qualified",
		});
		packet(secondPacket, {
			generatedAt: "2026-06-29T01:01:00.000Z",
			startedAt: "2026-06-29T01:00:30.000Z",
			endedAt: "2026-06-29T02:00:30.000Z",
			performanceEvidenceMode: "smoke",
		});

		runLedger(firstPacket, ledgerPath, firstSummary);
		runLedger(secondPacket, ledgerPath, secondSummary);

		const summary = JSON.parse(readFileSync(secondSummary, "utf8")) as {
			continuousSoakHours: number;
			qualifiedPerformanceEvidence: boolean;
			releaseE2ePass: boolean;
			publicSurfaceCoveragePercent: number;
			httpDeployEnvCoveragePercent: number;
			readiness: { failingGate: string | null };
		};
		expect(summary.continuousSoakHours).toBe(2);
		expect(summary.qualifiedPerformanceEvidence).toBe(true);
		expect(summary.releaseE2ePass).toBe(true);
		expect(summary.publicSurfaceCoveragePercent).toBe(100);
		expect(summary.httpDeployEnvCoveragePercent).toBe(100);
		expect(summary.readiness.failingGate).toBe("soak");
	});
});
