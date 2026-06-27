#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust promotion packet
//
// Runs the current promotion evidence chain and writes a local packet:
// parity, performance, shadow-soak, rollback, normalized readiness input, and
// a sanitized summary suitable for release review. Raw evidence can contain
// local artifact paths, so the default output directory is git-ignored.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

import {
	assessDeployReadiness,
	normalizeReadinessEvidence,
	type ReadinessAssessment,
	type ReadinessInput,
} from "../src/contract/rust-deploy-readiness.js";

type CliOptions = {
	outputDir: string;
	iterations: number;
	minSeconds: number;
	benchmarkMode: "smoke" | "qualified";
	releaseTag?: string;
	keepExisting: boolean;
	quiet: boolean;
};

type PacketSummary = {
	generatedAt: string;
	readiness: ReadinessAssessment;
	evidence: {
		compatibility: {
			publicSurfaceMatch: boolean;
			outputParityPercent: number;
			errorCompatibilityPercent: number;
			unclassifiedFailures: number;
		};
		performance: {
			medianLatencyImprovementPercent: number;
			p95LatencyImprovementPercent: number;
			startupImprovementPercent: number;
			memoryImprovementPercent: number;
			evidenceMode: "smoke" | "qualified";
			smoke: boolean;
			toolsBenchmarked: number | null;
			iterationsScale: number | null;
		};
		reliability: {
			soakHours: number;
			continuousSoakHours: number;
			canarySoakHoursRequired: number;
			replaceSoakHoursRequired: number;
			crashes: number;
			dataLossIncidents: number;
			unresolvedTelemetryAnomalies: number;
		};
		rollback: {
			validated: boolean;
			rehearsed: boolean;
		};
		observability: {
			level: string;
			releaseTag: string | null;
			canaryRequires: "tool";
			replaceRequires: "release";
		};
		binary: {
			rustBinary: string | null;
			rustBinarySha256: string | null;
		};
	};
	files: {
		parity: string;
		perf: string;
		shadowSoak: string;
		rollback: string;
		readinessInput: string;
		readinessAssessment: string;
		summary: string;
	};
};

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_OUTPUT_DIR = ".epoch-promotion/latest";

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		outputDir: DEFAULT_OUTPUT_DIR,
		iterations: 3,
		minSeconds: 0,
		benchmarkMode: "smoke",
		keepExisting: false,
		quiet: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--output-dir" || arg === "-o") {
			options.outputDir = args[++i] ?? "";
		} else if (arg === "--iterations") {
			options.iterations = positiveInteger(args[++i], "--iterations");
		} else if (arg === "--min-seconds") {
			options.minSeconds = nonNegativeNumber(args[++i], "--min-seconds");
		} else if (arg === "--benchmark-mode") {
			const mode = args[++i];
			if (mode !== "smoke" && mode !== "qualified") {
				throw new Error("--benchmark-mode must be smoke or qualified.");
			}
			options.benchmarkMode = mode;
		} else if (arg === "--release-tag") {
			options.releaseTag = nonEmptyString(args[++i], "--release-tag");
		} else if (arg === "--keep-existing") {
			options.keepExisting = true;
		} else if (arg === "--quiet") {
			options.quiet = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
	}

	if (!options.outputDir) {
		throw new Error("--output-dir must not be empty.");
	}

	return options;
}

function positiveInteger(raw: string | undefined, label: string): number {
	const value = Number(raw);
	if (!Number.isInteger(value) || value < 1) {
		throw new Error(`${label} must be an integer >= 1.`);
	}
	return value;
}

function nonNegativeNumber(raw: string | undefined, label: string): number {
	const value = Number(raw);
	if (!Number.isFinite(value) || value < 0) {
		throw new Error(`${label} must be a number >= 0.`);
	}
	return value;
}

function nonEmptyString(raw: string | undefined, label: string): string {
	if (!raw?.trim()) {
		throw new Error(`${label} must not be empty.`);
	}
	return raw;
}

function usage(): string {
	return [
		"Usage: tsx scripts/rust-promotion-packet.ts [options]",
		"",
		"Options:",
		"  --output-dir, -o <dir>  Local packet directory (default: .epoch-promotion/latest)",
		"  --iterations <n>        Shadow-soak parity iterations (default: 3)",
		"  --min-seconds <n>       Minimum shadow-soak wall time (default: 0)",
		"  --benchmark-mode <m>    Performance benchmark mode: smoke or qualified (default: smoke)",
		"  --release-tag <tag>     Mark TS-oracle comparisons as release observability evidence",
		"  --keep-existing         Do not remove the output directory before writing",
		"  --quiet                 Suppress progress and summary output",
		"",
	].join("\n");
}

function run(
	label: string,
	binary: string,
	args: string[],
	options: { quiet: boolean },
): string {
	if (!options.quiet) process.stderr.write(`[promotion] ${label}...\n`);
	return execFileSync(binary, args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		stdio: ["ignore", "pipe", "pipe"],
	});
}

function packageManagerCommand(args: string[]): { binary: string; args: string[] } {
	if (process.env.npm_execpath) {
		return {
			binary: process.execPath,
			args: [process.env.npm_execpath, ...args],
		};
	}
	return { binary: "pnpm", args };
}

function runPackageManager(
	label: string,
	args: string[],
	options: { quiet: boolean },
): string {
	const command = packageManagerCommand(args);
	return run(label, command.binary, command.args, options);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function writeJson(path: string, value: unknown): void {
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function rel(path: string): string {
	return relative(REPO_ROOT, path);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function binaryEvidence(shadowSoak: unknown): PacketSummary["evidence"]["binary"] {
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

function performanceEvidence(
	readinessInput: ReadinessInput,
	perfReport: unknown,
): PacketSummary["evidence"]["performance"] {
	const meta =
		isObject(perfReport) && isObject(perfReport.meta) ? perfReport.meta : null;
	const summary =
		isObject(perfReport) && isObject(perfReport.summary) ? perfReport.summary : null;
	const smoke = meta ? meta.smoke === true : true;
	return {
		...readinessInput.perf,
		evidenceMode: smoke ? "smoke" : "qualified",
		smoke,
		toolsBenchmarked:
			summary && typeof summary.toolsBenchmarked === "number"
				? summary.toolsBenchmarked
				: null,
		iterationsScale:
			meta && typeof meta.iterationsScale === "number"
				? meta.iterationsScale
				: null,
	};
}

function buildSummary(
	outputDir: string,
	readinessInput: ReadinessInput,
	readiness: ReadinessAssessment,
	releaseTag: string | undefined,
	shadowSoak: unknown,
	perfReport: unknown,
): PacketSummary {
	return {
		generatedAt: new Date().toISOString(),
		readiness,
		evidence: {
			compatibility: {
				publicSurfaceMatch: readinessInput.parity.publicSurfaceMatch,
				outputParityPercent: readinessInput.parity.outputParityPercent,
				errorCompatibilityPercent:
					readinessInput.parity.errorCompatibilityPercent,
				unclassifiedFailures: readinessInput.parity.unclassifiedFailures,
			},
			performance: performanceEvidence(readinessInput, perfReport),
			reliability: {
				soakHours: readinessInput.parity.soakHours,
				continuousSoakHours: readinessInput.parity.continuousSoakHours,
				canarySoakHoursRequired: 24,
				replaceSoakHoursRequired: 72,
				crashes: readinessInput.parity.crashes,
				dataLossIncidents: readinessInput.parity.dataLossIncidents,
				unresolvedTelemetryAnomalies:
					readinessInput.parity.unresolvedTelemetryAnomalies,
			},
			rollback: {
				validated: readinessInput.parity.rollbackValidated,
				rehearsed: readinessInput.parity.rollbackRehearsed,
			},
			observability: {
				level: readinessInput.parity.observabilityLevel,
				releaseTag: releaseTag ?? null,
				canaryRequires: "tool",
				replaceRequires: "release",
			},
			binary: binaryEvidence(shadowSoak),
		},
		files: {
			parity: rel(resolve(outputDir, "parity.json")),
			perf: rel(resolve(outputDir, "perf.json")),
			shadowSoak: rel(resolve(outputDir, "shadow-soak.json")),
			rollback: rel(resolve(outputDir, "shadow-soak-rollback.json")),
			readinessInput: rel(resolve(outputDir, "readiness-input.json")),
			readinessAssessment: rel(resolve(outputDir, "readiness-assessment.json")),
			summary: rel(resolve(outputDir, "promotion-packet.json")),
		},
	};
}

function printSummary(summary: PacketSummary): void {
	process.stderr.write(
		[
			"Rust promotion packet",
			`  decision:            ${summary.readiness.decision}`,
			`  failing gate:        ${summary.readiness.failingGate ?? "none"}`,
			`  output parity:       ${summary.evidence.compatibility.outputParityPercent}%`,
			`  error compatibility: ${summary.evidence.compatibility.errorCompatibilityPercent}%`,
			`  median improvement:  ${summary.evidence.performance.medianLatencyImprovementPercent.toFixed(2)}%`,
			`  p95 improvement:     ${summary.evidence.performance.p95LatencyImprovementPercent.toFixed(2)}%`,
			`  perf evidence:       ${summary.evidence.performance.evidenceMode}`,
			`  soak hours:          ${summary.evidence.reliability.soakHours.toFixed(4)}`,
			`  continuous soak:     ${summary.evidence.reliability.continuousSoakHours.toFixed(4)}`,
			`  rollback rehearsed:  ${summary.evidence.rollback.rehearsed}`,
			`  observability:       ${summary.evidence.observability.level}`,
			`  release tag:         ${summary.evidence.observability.releaseTag ?? "none"}`,
			`  binary sha256:       ${summary.evidence.binary.rustBinarySha256?.slice(0, 16) ?? "unavailable"}`,
			`  summary file:        ${summary.files.summary}`,
			"",
		].join("\n"),
	);
}

async function main(): Promise<void> {
	const options = parseArgs(process.argv.slice(2));
	const outputDir = resolve(REPO_ROOT, options.outputDir);
	if (!options.keepExisting) {
		rmSync(outputDir, { recursive: true, force: true });
	}
	mkdirSync(outputDir, { recursive: true });

	const parityPath = resolve(outputDir, "parity.json");
	const perfPath = resolve(outputDir, "perf.json");
	const shadowPath = resolve(outputDir, "shadow-soak.json");
	const rollbackPath = resolve(outputDir, "shadow-soak-rollback.json");
	const readinessInputPath = resolve(outputDir, "readiness-input.json");
	const readinessAssessmentPath = resolve(outputDir, "readiness-assessment.json");
	const summaryPath = resolve(outputDir, "promotion-packet.json");

	run("build Rust release CLI", "cargo", [
		"build",
		"--manifest-path",
		"rust/Cargo.toml",
		"--release",
		"-p",
		"epoch-cli",
	], options);

	const parity = runPackageManager("strict parity", [
		"exec",
		"tsx",
		"src/contract/rust-parity-cli.ts",
		"--quiet",
	], options);
	writeFileSync(parityPath, parity);

	const benchmarkArgs = [
		"exec",
		"tsx",
		"src/benchmarks/rust-promotion.ts",
		"--output",
		perfPath,
	];
	if (options.benchmarkMode === "smoke") {
		benchmarkArgs.push("--smoke");
	}
	runPackageManager(
		`promotion benchmark ${options.benchmarkMode}`,
		benchmarkArgs,
		options,
	);

	const shadowArgs = [
		"exec",
		"tsx",
		"scripts/rust-shadow-soak.ts",
		"--iterations",
		String(options.iterations),
		"--min-seconds",
		String(options.minSeconds),
		"--output",
		shadowPath,
		"--no-build",
		"--quiet",
	];
	if (options.releaseTag) {
		shadowArgs.push("--release-tag", options.releaseTag);
	}
	runPackageManager("shadow soak evidence", shadowArgs, options);

	runPackageManager("rollback rehearsal", [
		"exec",
		"tsx",
		"scripts/rust-rollback-rehearsal.ts",
		"--parity",
		shadowPath,
		"--output",
		rollbackPath,
		"--no-build",
		"--quiet",
	], options);

	const readinessInput = normalizeReadinessEvidence({
		parity: readJson(rollbackPath),
		perf: readJson(perfPath),
	});
	const perfReport = readJson(perfPath);
	const shadowSoak = readJson(shadowPath);
	const readiness = assessDeployReadiness(readinessInput);
	const summary = buildSummary(
		outputDir,
		readinessInput,
		readiness,
		options.releaseTag,
		shadowSoak,
		perfReport,
	);

	writeJson(readinessInputPath, readinessInput);
	writeJson(readinessAssessmentPath, readiness);
	writeJson(summaryPath, summary);

	if (!options.quiet) printSummary(summary);
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});
