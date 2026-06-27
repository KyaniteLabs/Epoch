#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust promotion gate
//
// Final machine-readable guard for deployment automation. It accepts the
// soak-runner summary and exits 0 only when the strict deploy-readiness scorer,
// not a smoke override, has reached the requested target.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

import { deployReadinessDecisionSchema } from "./rust-deploy-readiness.js";

type Target = "canary" | "replace";

export type PromotionGateResult = {
	ok: boolean;
	target: Target;
	decision: z.infer<typeof deployReadinessDecisionSchema>;
	failingGate: string | null;
	reason: string;
};

type CliOptions = {
	target: Target;
	summaryPath: string;
	rustBinaryPath: string;
	json: boolean;
};

export type PromotionGateOptions = {
	currentRustBinarySha256?: string | null;
};

const DEFAULT_SUMMARY = ".epoch-promotion/latest/soak-runner-summary.json";
const DEFAULT_RUST_BINARY = "rust/target/release/epoch-cli";
const SHA256_HEX = /^[a-f0-9]{64}$/;
const DECISION_RANK: Record<
	z.infer<typeof deployReadinessDecisionSchema>,
	number
> = {
	NO: 0,
	SHADOW: 1,
	CANARY: 2,
	REPLACE: 3,
};

const runnerSummarySchema = z.object({
	target: z.enum(["canary", "replace"]),
	targetHoursSource: z.enum(["default", "override"]),
	targetReached: z.boolean(),
	targetSatisfiedBy: z.literal("scorer").nullable(),
	smokeTargetReached: z.boolean().default(false),
	releaseTag: z.string().nullable().default(null),
	rustBinarySha256: z.string().regex(SHA256_HEX).nullable(),
	readiness: z.object({
		decision: deployReadinessDecisionSchema,
		failingGate: z.string().nullable(),
		rationale: z.string().default(""),
	}),
});

function usage(): string {
	return [
		"Usage: tsx src/contract/rust-promotion-gate.ts --target <canary|replace> [options]",
		"",
		"Options:",
		`  --summary <path>   Soak runner summary JSON (default: ${DEFAULT_SUMMARY})`,
		`  --rust-binary <p> Current Rust CLI binary to hash (default: ${DEFAULT_RUST_BINARY})`,
		"  --target <target>  Required promotion target: canary or replace",
		"  --json             Emit machine-readable result JSON",
		"  --help, -h         Show this help",
		"",
	].join("\n");
}

function parseTarget(raw: string | undefined): Target {
	if (raw === "canary" || raw === "replace") return raw;
	throw new Error("--target must be either canary or replace.");
}

function parseArgs(argv: string[]): CliOptions {
	const options: Partial<CliOptions> = {
		summaryPath: DEFAULT_SUMMARY,
		rustBinaryPath: DEFAULT_RUST_BINARY,
		json: false,
	};
	const args = argv[0] === "--" ? argv.slice(1) : argv;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--target") {
			options.target = parseTarget(args[++i]);
		} else if (arg === "--summary") {
			const summaryPath = args[++i];
			if (!summaryPath?.trim()) throw new Error("--summary must not be empty.");
			options.summaryPath = summaryPath;
		} else if (arg === "--rust-binary") {
			const rustBinaryPath = args[++i];
			if (!rustBinaryPath?.trim()) {
				throw new Error("--rust-binary must not be empty.");
			}
			options.rustBinaryPath = rustBinaryPath;
		} else if (arg === "--json") {
			options.json = true;
		} else if (arg === "--help" || arg === "-h") {
			process.stdout.write(usage());
			process.exit(0);
		} else {
			throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
		}
	}

	if (!options.target) {
		throw new Error(`--target is required.\n\n${usage()}`);
	}

	return options as CliOptions;
}

function requiredDecision(target: Target): "CANARY" | "REPLACE" {
	return target === "replace" ? "REPLACE" : "CANARY";
}

function result(
	ok: boolean,
	target: Target,
	decision: z.infer<typeof deployReadinessDecisionSchema>,
	failingGate: string | null,
	reason: string,
): PromotionGateResult {
	return { ok, target, decision, failingGate, reason };
}

export function assessPromotionGate(
	rawSummary: unknown,
	target: Target,
	options: PromotionGateOptions = {},
): PromotionGateResult {
	const summary = runnerSummarySchema.parse(rawSummary);
	const decision = summary.readiness.decision;
	const failingGate = summary.readiness.failingGate;
	const checksCurrentBinary = "currentRustBinarySha256" in options;

	if (summary.target !== target) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Runner summary target is ${summary.target}, not ${target}.`,
		);
	}
	if (summary.targetHoursSource !== "default" || summary.smokeTargetReached) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Runner summary used a local smoke target override; this is not deployment evidence.",
		);
	}
	if (!summary.rustBinarySha256) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Runner summary is missing the Rust binary SHA-256.",
		);
	}
	if (checksCurrentBinary && !options.currentRustBinarySha256) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Current Rust binary SHA-256 could not be verified.",
		);
	}
	if (
		checksCurrentBinary &&
		options.currentRustBinarySha256 !== summary.rustBinarySha256
	) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Current Rust binary SHA-256 ${options.currentRustBinarySha256} does not match soak evidence ${summary.rustBinarySha256}.`,
		);
	}
	if (target === "replace" && !summary.releaseTag) {
		return result(
			false,
			target,
			decision,
			failingGate,
			"Replacement requires a release-tagged runner summary.",
		);
	}
	if (!summary.targetReached || summary.targetSatisfiedBy !== "scorer") {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Strict scorer has not reached ${target}; first blocker is ${failingGate ?? "unknown"}.`,
		);
	}
	if (DECISION_RANK[decision] < DECISION_RANK[requiredDecision(target)]) {
		return result(
			false,
			target,
			decision,
			failingGate,
			`Readiness decision ${decision} is below ${requiredDecision(target)}.`,
		);
	}

	return result(
		true,
		target,
		decision,
		null,
		`Strict scorer reached ${target} for Rust binary ${summary.rustBinarySha256}.`,
	);
}

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function main(argv: string[]): number {
	try {
		const options = parseArgs(argv);
		const rawSummary = readJson(resolve(options.summaryPath));
		const currentRustBinarySha256 = sha256File(resolve(options.rustBinaryPath));
		const gate = assessPromotionGate(rawSummary, options.target, {
			currentRustBinarySha256,
		});
		if (options.json) {
			process.stdout.write(`${JSON.stringify(gate, null, 2)}\n`);
		} else {
			process.stdout.write(
				`Rust promotion gate ${gate.ok ? "PASS" : "BLOCKED"}: ${gate.reason}\n`,
			);
		}
		return gate.ok ? 0 : 2;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

const isMain =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	process.exit(main(process.argv.slice(2)));
}
