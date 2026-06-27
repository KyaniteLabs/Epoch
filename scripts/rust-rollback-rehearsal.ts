#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust rollback rehearsal
//
// Enriches existing Rust promotion parity evidence with rollback proof. The
// rehearsal exercises a deterministic read-only command through Rust first,
// then falls back to the TypeScript CLI and verifies both outputs match.
// ---------------------------------------------------------------------------

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { firstDiff, normalize } from "../src/contract/rust-parity.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..");
const TS_CLI = join(REPO_ROOT, "dist", "index.js");
const RUST_CLI = join(REPO_ROOT, "rust", "target", "release", "epoch-cli");
const COMMAND = "parse-duration";
const TS_ARGS = [COMMAND, "--duration", "1h"];
const RUST_ARGS = [COMMAND, JSON.stringify({ duration_string: "1h" })];

type CliOptions = {
	parityPath?: string;
	output?: string;
	noBuild: boolean;
	quiet: boolean;
};

type CommandOutcome = {
	exitCode: number;
	stdout: string;
	stderr: string;
	parsed: unknown;
};

type RollbackResult = {
	validated: boolean;
	diff: string | null;
	rust: {
		exitCode: number;
	};
	typescript: {
		exitCode: number;
	};
};

function parseArgs(argv: string[]): CliOptions {
	const options: CliOptions = {
		noBuild: false,
		quiet: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--parity") {
			options.parityPath = args[++i];
		} else if (arg === "--output" || arg === "-o") {
			options.output = args[++i];
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

	if (!options.parityPath) {
		throw new Error(`--parity is required.\n\n${usage()}`);
	}

	return options;
}

function usage(): string {
	return [
		"Usage: tsx scripts/rust-rollback-rehearsal.ts --parity <evidence.json> [options]",
		"",
		"Options:",
		"  --output, -o <path>  Write enriched readiness evidence to a file",
		"  --no-build           Do not rebuild TypeScript and Rust CLIs before running",
		"  --quiet              Suppress the human summary",
		"",
	].join("\n");
}

function buildRuntimes(): void {
	execFileSync("pnpm", ["run", "build"], { cwd: REPO_ROOT, stdio: "inherit" });
	execFileSync(
		"cargo",
		["build", "--manifest-path", "rust/Cargo.toml", "--release", "-p", "epoch-cli"],
		{ cwd: REPO_ROOT, stdio: "inherit" },
	);
}

function run(binary: string, args: string[]): CommandOutcome {
	const result = spawnSync(binary, args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		maxBuffer: 8 * 1024 * 1024,
	});
	const stdout = result.stdout ?? "";
	const stderr = result.stderr ?? "";
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		parsed = null;
	}
	return {
		exitCode: result.status ?? 1,
		stdout,
		stderr,
		parsed,
	};
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapTypeScriptCli(value: unknown): unknown {
	if (isObject(value) && value.ok === true && "data" in value) {
		return value.data;
	}
	return value;
}

function rehearseRollback(): RollbackResult {
	const rust = run(RUST_CLI, RUST_ARGS);
	const typescript = run("node", [TS_CLI, ...TS_ARGS]);

	const diff =
		rust.exitCode !== 0
			? `Rust command failed: ${rust.stderr || rust.stdout}`
			: typescript.exitCode !== 0
				? `TypeScript rollback command failed: ${typescript.stderr || typescript.stdout}`
				: firstDiff(
						normalize(unwrapTypeScriptCli(typescript.parsed)),
						normalize(rust.parsed),
					);

	return {
		validated: diff === null,
		diff,
		rust: { exitCode: rust.exitCode },
		typescript: { exitCode: typescript.exitCode },
	};
}

function readJson(path: string): Record<string, unknown> {
	const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
	if (!isObject(parsed)) {
		throw new Error(`Expected ${path} to contain a JSON object.`);
	}
	return parsed;
}

function enrichEvidence(
	evidence: Record<string, unknown>,
	rollback: RollbackResult,
): Record<string, unknown> {
	const unresolvedTelemetryAnomalies =
		typeof evidence.unresolvedTelemetryAnomalies === "number"
			? evidence.unresolvedTelemetryAnomalies
			: 0;

	return {
		...evidence,
		rollbackValidated: rollback.validated,
		rollbackRehearsed: rollback.validated,
		unresolvedTelemetryAnomalies: rollback.validated
			? unresolvedTelemetryAnomalies
			: unresolvedTelemetryAnomalies + 1,
		rollbackEvidence: {
			command: COMMAND,
			mode: "rust-to-typescript-cli",
			steps: ["rust", "typescript"],
			oneStepFallback: true,
			validated: rollback.validated,
			diff: rollback.diff,
			rustExitCode: rollback.rust.exitCode,
			typescriptExitCode: rollback.typescript.exitCode,
			rehearsedAt: new Date().toISOString(),
		},
	};
}

function printSummary(rollback: RollbackResult): void {
	process.stderr.write(
		[
			"Rust rollback rehearsal",
			`  validated:       ${rollback.validated}`,
			`  rust exit:       ${rollback.rust.exitCode}`,
			`  typescript exit: ${rollback.typescript.exitCode}`,
			`  diff:            ${rollback.diff ?? "none"}`,
			"",
		].join("\n"),
	);
}

try {
	const options = parseArgs(process.argv.slice(2));
	if (!options.noBuild) buildRuntimes();
	const rollback = rehearseRollback();
	const evidence = enrichEvidence(readJson(options.parityPath!), rollback);
	const rendered = `${JSON.stringify(evidence, null, 2)}\n`;

	if (options.output) {
		mkdirSync(dirname(options.output), { recursive: true });
		writeFileSync(options.output, rendered);
	} else {
		process.stdout.write(rendered);
	}
	if (!options.quiet) printSummary(rollback);
	process.exit(rollback.validated ? 0 : 1);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
