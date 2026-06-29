#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	buildReplacementScorecardFromJson,
	type ReplacementScorecard,
} from "./rust-deploy-readiness.js";

const USAGE =
	"Usage:\n" +
	"  tsx src/contract/rust-replacement-scorecard.ts <readiness.json> [output.json]\n" +
	"  tsx src/contract/rust-replacement-scorecard.ts <parity.json> <perf.json> [output.json]\n" +
	"\n" +
	"Emits a quantified Rust replacement scorecard: compatibility percent,\n" +
	"superiority metrics, gate pass count, first blocker, and deploy verdict.\n";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isSingleFileEvidence(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		(("parity" in value && "perf" in value) || "evidence" in value)
	);
}

function formatPercent(value: number): string {
	return `${value.toFixed(2)}%`;
}

export function formatReplacementScorecard(
	scorecard: ReplacementScorecard,
): string {
	return [
		"Epoch Rust replacement scorecard",
		`  verdict:                  ${scorecard.readyToReplace ? "REPLACE" : "BLOCKED"}`,
		`  readiness decision:       ${scorecard.decision}`,
		`  first blocker:            ${scorecard.failingGate ?? "none"}`,
		`  functional compatibility: ${formatPercent(scorecard.functionalCompatibilityPercent)}`,
		`  replacement gates:        ${scorecard.gatesPassed}/${scorecard.gatesTotal} (${formatPercent(scorecard.replacementGatePassPercent)})`,
		`  output parity:            ${formatPercent(scorecard.summary.outputParityPercent)}`,
		`  error compatibility:      ${formatPercent(scorecard.summary.errorCompatibilityPercent)}`,
		`  unclassified failures:    ${scorecard.summary.unclassifiedFailures}`,
		`  median improvement:       ${formatPercent(scorecard.summary.medianLatencyImprovementPercent)}`,
		`  p95 improvement:          ${formatPercent(scorecard.summary.p95LatencyImprovementPercent)}`,
		`  startup improvement:      ${formatPercent(scorecard.summary.startupImprovementPercent)}`,
		`  memory improvement:       ${formatPercent(scorecard.summary.memoryImprovementPercent)}`,
		`  continuous soak:          ${scorecard.summary.continuousSoakHours.toFixed(4)}h/${scorecard.summary.requiredContinuousSoakHours}h`,
		"",
	].join("\n");
}

function main(argv: string[]): number {
	const args = argv[0] === "--" ? argv.slice(1) : argv;
	const [inputPath, secondArg, thirdArg] = args;

	if (!inputPath) {
		process.stderr.write(USAGE);
		return 1;
	}

	const first = readJson(inputPath);
	let raw: unknown;
	let outputPath: string | undefined;

	if (isSingleFileEvidence(first)) {
		raw = first;
		outputPath = secondArg;
	} else {
		if (!secondArg) {
			process.stderr.write(
				`Input ${inputPath} is not a combined readiness file; a separate perf.json path is required.\n\n`,
			);
			process.stderr.write(USAGE);
			return 1;
		}
		raw = { parity: first, perf: readJson(secondArg) };
		outputPath = thirdArg;
	}

	const scorecard = buildReplacementScorecardFromJson(raw);
	const json = `${JSON.stringify(scorecard, null, 2)}\n`;

	if (outputPath) {
		writeFileSync(outputPath, json);
	} else {
		process.stdout.write(formatReplacementScorecard(scorecard));
		process.stdout.write(json);
	}

	return 0;
}

const isMain =
	process.argv[1] !== undefined &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
	process.exit(main(process.argv.slice(2)));
}
