import { readFileSync, writeFileSync } from "node:fs";
import { assessDeployReadinessFromJson } from "./rust-deploy-readiness.js";

const USAGE =
	"Usage:\n" +
	"  tsx src/contract/rust-deploy-readiness-cli.ts <readiness.json> [output.json]\n" +
	"  tsx src/contract/rust-deploy-readiness-cli.ts <parity.json> <perf.json> [output.json]\n" +
	"\n" +
	"<readiness.json> combines { parity, perf }; the two-file form supplies the\n" +
	"parity and performance evidence separately. Raw parity harness and promotion\n" +
	"benchmark reports are accepted and normalized with conservative ops defaults.\n";

function readJson(path: string): unknown {
	return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function isCombinedReadiness(value: unknown): boolean {
	return (
		typeof value === "object" &&
		value !== null &&
		"parity" in value &&
		"perf" in value
	);
}

function main(argv: string[]): number {
	const [inputPath, secondArg, thirdArg] = argv;

	if (!inputPath) {
		process.stderr.write(USAGE);
		return 1;
	}

	const first = readJson(inputPath);

	let raw: unknown;
	let outputPath: string | undefined;

	if (isCombinedReadiness(first)) {
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

	const assessment = assessDeployReadinessFromJson(raw);
	const rendered = `${JSON.stringify(assessment, null, 2)}\n`;

	if (outputPath) {
		writeFileSync(outputPath, rendered);
	} else {
		process.stdout.write(rendered);
	}

	return 0;
}

process.exit(main(process.argv.slice(2)));
