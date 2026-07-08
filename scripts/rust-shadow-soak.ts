#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust shadow-soak verifier
//
// Replays the TS-vs-Rust parity corpus repeatedly in hidden-comparison mode and
// emits deploy-readiness parity evidence. This proves the measurement path for
// the soak, observability, and local-state safety gates without pretending a
// short local run is a 24h production soak.
// ---------------------------------------------------------------------------

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { runRustParity, type ParityDiff, type ParityReport } from "../src/contract/rust-parity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const EXPECTED_TOOL_COUNT = 24;
const STATEFUL_TOOLS = new Set([
	"record_actual",
	"batch_record_actuals",
	"get_pending_estimates",
	"feedback_health",
]);

type CliOptions = {
	iterations: number;
	minSeconds: number;
	output?: string;
	releaseTag?: string;
	noBuild: boolean;
	quiet: boolean;
};

type IterationSummary = {
	iteration: number;
	outputParityPercent: number;
	errorCompatibilityPercent: number;
	diffCount: number;
	narrativeDiffCount: number;
	toolsCovered: number;
	crashed: boolean;
};

type ToolAttribution = {
	diffCount: number;
	narrativeDiffCount: number;
};

type ShadowSoakReport = {
	meta: {
		startedAt: string;
		endedAt: string;
		elapsedMs: number;
		iterationsRequested: number;
		iterationsCompleted: number;
		minSecondsRequested: number;
		rustBinary: string | null;
		rustBinarySha256: string | null;
		releaseTag: string | null;
	};
	publicSurfaceMatch: boolean;
	outputParityPercent: number;
	errorCompatibilityPercent: number;
	unclassifiedFailures: number;
	soakHours: number;
	continuousSoakHours: number;
	crashes: number;
	dataLossIncidents: number;
	rollbackValidated: false;
	rollbackRehearsed: false;
	observabilityLevel: "tool" | "release";
	unresolvedTelemetryAnomalies: number;
	compatibilityExceptionsApproved: boolean;
	iterations: IterationSummary[];
	toolAttribution: Record<string, ToolAttribution>;
	failures: Array<{
		iteration: number;
		case: string;
		tool: string;
		kind: ParityDiff["kind"] | "harness-crash";
		detail: string;
	}>;
};

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		iterations: 3,
		minSeconds: 0,
		noBuild: false,
		quiet: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--iterations") {
			options.iterations = positiveInteger(args[++i], "--iterations");
		} else if (arg === "--min-seconds") {
			options.minSeconds = nonNegativeNumber(args[++i], "--min-seconds");
		} else if (arg === "--output" || arg === "-o") {
			options.output = args[++i];
		} else if (arg === "--release-tag") {
			options.releaseTag = nonEmptyString(args[++i], "--release-tag");
		} else if (arg === "--no-build") {
			options.noBuild = true;
		} else if (arg === "--quiet") {
			options.quiet = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
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
		"Usage: tsx scripts/rust-shadow-soak.ts [options]",
		"",
		"Options:",
		"  --iterations <n>     Minimum parity-loop iterations to complete (default: 3)",
		"  --min-seconds <n>    Minimum wall-clock soak seconds to observe (default: 0)",
		"  --output, -o <path>  Write JSON readiness evidence to a file",
		"  --release-tag <tag>  Mark comparisons as release-tagged observability evidence",
		"  --no-build           Do not build the release Rust CLI before running",
		"  --quiet              Suppress the human summary",
		"",
	].join("\n");
}

function buildReleaseCli(): void {
	execFileSync(
		"cargo",
		["build", "--manifest-path", "rust/Cargo.toml", "--release", "-p", "epoch-cli"],
		{ cwd: REPO_ROOT, stdio: "inherit" },
	);
}

const sleep = (ms: number): Promise<void> =>
	new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function recordToolDiff(
	toolAttribution: Map<string, ToolAttribution>,
	tool: string,
	field: keyof ToolAttribution,
): void {
	const current = toolAttribution.get(tool) ?? {
		diffCount: 0,
		narrativeDiffCount: 0,
	};
	current[field] += 1;
	toolAttribution.set(tool, current);
}

function dataLossIncidentCount(diffs: readonly ParityDiff[]): number {
	return diffs.filter((diff) => STATEFUL_TOOLS.has(diff.tool)).length;
}

function sha256File(path: string | null): string | null {
	if (!path) return null;
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function relOrNull(path: string | null): string | null {
	return path ? relative(REPO_ROOT, path) : null;
}

async function runShadowSoak(options: CliOptions): Promise<ShadowSoakReport> {
	if (!options.noBuild) buildReleaseCli();

	const startedAtMs = Date.now();
	const startedAt = new Date(startedAtMs).toISOString();
	const minElapsedMs = options.minSeconds * 1000;
	const iterations: IterationSummary[] = [];
	const failures: ShadowSoakReport["failures"] = [];
	const toolAttribution = new Map<string, ToolAttribution>();
	let outputParityPercent = 100;
	let errorCompatibilityPercent = 100;
	let publicSurfaceMatch = true;
	let unclassifiedFailures = 0;
	let crashes = 0;
	let dataLossIncidents = 0;
	let rustBinary: string | null = null;

	while (
		iterations.length < options.iterations ||
		Date.now() - startedAtMs < minElapsedMs
	) {
		const iterationNumber = iterations.length + 1;
		let report: ParityReport | undefined;
		try {
			report = runRustParity();
			rustBinary = report.rustBinary;
			outputParityPercent = Math.min(
				outputParityPercent,
				report.outputParityPercent,
			);
			errorCompatibilityPercent = Math.min(
				errorCompatibilityPercent,
				report.errorCompatibilityPercent,
			);
			publicSurfaceMatch =
				publicSurfaceMatch && report.toolsCovered.length >= EXPECTED_TOOL_COUNT;
			unclassifiedFailures += report.diffs.length;
			dataLossIncidents += dataLossIncidentCount(report.diffs);

			for (const diff of report.diffs) {
				recordToolDiff(toolAttribution, diff.tool, "diffCount");
				failures.push({
					iteration: iterationNumber,
					case: diff.case,
					tool: diff.tool,
					kind: diff.kind,
					detail: diff.detail,
				});
			}
			for (const diff of report.narrativeDiffs) {
				recordToolDiff(toolAttribution, diff.tool, "narrativeDiffCount");
			}

			iterations.push({
				iteration: iterationNumber,
				outputParityPercent: report.outputParityPercent,
				errorCompatibilityPercent: report.errorCompatibilityPercent,
				diffCount: report.diffs.length,
				narrativeDiffCount: report.narrativeDiffs.length,
				toolsCovered: report.toolsCovered.length,
				crashed: false,
			});
		} catch (error) {
			crashes += 1;
			unclassifiedFailures += 1;
			const detail = error instanceof Error ? error.message : String(error);
			failures.push({
				iteration: iterationNumber,
				case: "harness",
				tool: "harness",
				kind: "harness-crash",
				detail,
			});
			iterations.push({
				iteration: iterationNumber,
				outputParityPercent: 0,
				errorCompatibilityPercent: 0,
				diffCount: 1,
				narrativeDiffCount: 0,
				toolsCovered: 0,
				crashed: true,
			});
		}

		if (
			iterations.length >= options.iterations &&
			Date.now() - startedAtMs >= minElapsedMs
		) {
			break;
		}
		await sleep(250);
	}

	const endedAtMs = Date.now();
	const endedAt = new Date(endedAtMs).toISOString();
	const unresolvedTelemetryAnomalies =
		crashes + unclassifiedFailures + dataLossIncidents;
	const rustBinarySha256 = sha256File(rustBinary);

	return {
		meta: {
			startedAt,
			endedAt,
			elapsedMs: endedAtMs - startedAtMs,
			iterationsRequested: options.iterations,
			iterationsCompleted: iterations.length,
			minSecondsRequested: options.minSeconds,
			rustBinary: relOrNull(rustBinary),
			rustBinarySha256,
			releaseTag: options.releaseTag ?? null,
		},
		publicSurfaceMatch,
		outputParityPercent,
		errorCompatibilityPercent,
		unclassifiedFailures,
		soakHours: (endedAtMs - startedAtMs) / 3_600_000,
		continuousSoakHours: (endedAtMs - startedAtMs) / 3_600_000,
		crashes,
		dataLossIncidents,
		rollbackValidated: false,
		rollbackRehearsed: false,
		observabilityLevel: options.releaseTag ? "release" : "tool",
		unresolvedTelemetryAnomalies,
		compatibilityExceptionsApproved:
			outputParityPercent >= 100 &&
			errorCompatibilityPercent >= 100 &&
			unclassifiedFailures === 0,
		iterations,
		toolAttribution: Object.fromEntries(toolAttribution.entries()),
		failures,
	};
}

function printSummary(report: ShadowSoakReport): void {
	process.stderr.write(
		[
			"Rust shadow-soak evidence",
			`  iterations:          ${report.meta.iterationsCompleted}`,
			`  soak hours:          ${report.soakHours.toFixed(4)}`,
			`  output parity:       ${report.outputParityPercent}%`,
			`  error compatibility: ${report.errorCompatibilityPercent}%`,
			`  failures:            ${report.unclassifiedFailures}`,
			`  crashes:             ${report.crashes}`,
			`  data loss incidents: ${report.dataLossIncidents}`,
			`  observability:       ${report.observabilityLevel}`,
			`  release tag:         ${report.meta.releaseTag ?? "none"}`,
			`  rust binary:         ${report.meta.rustBinary ?? "unavailable"}`,
			`  binary sha256:       ${report.meta.rustBinarySha256?.slice(0, 16) ?? "unavailable"}`,
			"",
		].join("\n"),
	);
}

try {
	const options = parseArgs(process.argv.slice(2));
	const report = await runShadowSoak(options);
	const rendered = `${JSON.stringify(report, null, 2)}\n`;
	if (options.output) {
		mkdirSync(dirname(options.output), { recursive: true });
		writeFileSync(options.output, rendered);
	} else {
		process.stdout.write(rendered);
	}
	if (!options.quiet) printSummary(report);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
