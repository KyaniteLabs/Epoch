#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch TS-vs-Rust Promotion Benchmark
//
// Measures representative public tools through both the TypeScript (Node)
// and Rust native CLIs. Reports median/p95/p99 latency, iteration counts,
// optional cold-start and RSS measurements, and a recommendation on whether
// Rust is measurably superior.
//
// Safe defaults:
//   - Uses a temporary EPOCH_DATA_DIR so no ~/.epoch state is touched.
//   - No network calls.
//   - Bounded iteration counts per tool.
//
// Usage:
//   pnpm run benchmark:rust-promotion
//   pnpm run benchmark:rust-promotion:smoke
//   pnpm exec tsx src/benchmarks/rust-promotion.ts --output report.json --smoke
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import {
	mkdtempSync,
	existsSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type BenchmarkTool = {
	name: string;
	category: string;
	iterations: number;
	input: Record<string, unknown>;
	tsArgs: string[];
	rustArgs: string[];
};

type LatencySample = {
	ms: number;
};

type ToolResult = {
	tool: string;
	category: string;
	iterations: number;
	ts: RuntimeMetrics;
	rust: RuntimeMetrics;
	speedup: number | null;
};

type RuntimeMetrics = {
	iterations: number;
	medianMs: number;
	p95Ms: number;
	p99Ms: number;
	minMs: number;
	maxMs: number;
	meanMs: number;
	stdDevMs: number;
	coldStartMs: number | null;
	maxRssKb: number | null;
	errors: number;
};

type BenchmarkReport = {
	meta: {
		generatedAt: string;
		repository: string;
		nodeVersion: string;
		commit?: string;
		tsCli: string;
		rustCli: string;
		dataDir: string;
		iterationsScale: number;
		maxIterationsPerTool: number;
		smoke: boolean;
	};
	summary: {
		toolsBenchmarked: number;
		tsMedianTotalMs: number;
		rustMedianTotalMs: number;
		geomeanSpeedup: number;
		wins: { ts: number; rust: number; ties: number };
		recommendation: string;
		confidence: "high" | "moderate" | "low";
		methodology: string;
	};
	tools: ToolResult[];
};

type CliOptions = {
	output?: string;
	format: "json" | "table";
	smoke: boolean;
	iterationsScale: number;
	maxIterationsPerTool: number;
	skipBuild: boolean;
	include?: string[];
};

const DEFAULT_TOOL_TIMEOUT_MS = 10_000;
const DEFAULT_QUALIFIED_MAX_ITERATIONS_PER_TOOL = 10;

// ---------------------------------------------------------------------------
// Tool registry
// ---------------------------------------------------------------------------

function toolRegistry(): BenchmarkTool[] {
	const tasks = [
		{ name: "A", duration: 2, predecessors: [] as string[] },
		{ name: "B", duration: 3, predecessors: ["A"] },
		{ name: "C", duration: 1, predecessors: ["A"] },
		{ name: "D", duration: 4, predecessors: ["B", "C"] },
	];

	const mcTasks = [
		{ name: "A", optimistic: 1, most_likely: 2, pessimistic: 4 },
		{ name: "B", optimistic: 2, most_likely: 3, pessimistic: 6 },
		{ name: "C", optimistic: 1, most_likely: 2, pessimistic: 5 },
		{ name: "D", optimistic: 2, most_likely: 4, pessimistic: 8 },
	];

	return [
		{
			name: "parse_duration",
			category: "temporal",
			iterations: 800,
			input: { duration_string: "2h30m15s" },
			tsArgs: ["--duration", "2h30m15s"],
			rustArgs: ['{"duration_string":"2h30m15s"}'],
		},
		{
			name: "add_business_days",
			category: "temporal",
			iterations: 600,
			input: { start_date: "2026-06-01", days: 10, country: "US" },
			tsArgs: [
				"--start-date",
				"2026-06-01",
				"--days",
				"10",
				"--country",
				"US",
			],
			rustArgs: ['{"start_date":"2026-06-01","days":10,"country":"US"}'],
		},
		{
			name: "count_business_days",
			category: "temporal",
			iterations: 600,
			input: {
				start_date: "2026-06-01",
				end_date: "2026-06-30",
				country: "US",
			},
			tsArgs: [
				"--start-date",
				"2026-06-01",
				"--end-date",
				"2026-06-30",
				"--country",
				"US",
			],
			rustArgs: [
				'{"start_date":"2026-06-01","end_date":"2026-06-30","country":"US"}',
			],
		},
		{
			name: "pert_estimate",
			category: "estimation",
			iterations: 800,
			input: {
				optimistic: 1,
				most_likely: 2,
				pessimistic: 4,
				unit: "hours",
			},
			tsArgs: [
				"--optimistic",
				"1",
				"--most-likely",
				"2",
				"--pessimistic",
				"4",
				"--unit",
				"hours",
			],
			rustArgs: [
				'{"optimistic":1,"most_likely":2,"pessimistic":4,"unit":"hours"}',
			],
		},
		{
			name: "cocomo_estimate",
			category: "estimation",
			iterations: 600,
			input: {
				kloc: 10,
				reasoning_complexity: 1.2,
				context_completeness: 1.0,
				transformation_impact: 1.1,
				iterative_cycles: 2,
				human_oversight: 1.0,
			},
			tsArgs: [
				"--kloc",
				"10",
				"--reasoning-complexity",
				"1.2",
				"--context-completeness",
				"1.0",
				"--transformation-impact",
				"1.1",
				"--iterative-cycles",
				"2",
				"--human-oversight",
				"1.0",
			],
			rustArgs: [
				'{"kloc":10,"reasoning_complexity":1.2,"context_completeness":1.0,"transformation_impact":1.1,"iterative_cycles":2,"human_oversight":1.0}',
			],
		},
		{
			name: "sprint_forecast",
			category: "estimation",
			iterations: 400,
			input: {
				backlog_points: 50,
				velocity_history: [10, 12, 11, 13, 12],
				sprint_length_days: 14,
				hours_per_sprint: 300,
			},
			tsArgs: [
				"--backlog-points",
				"50",
				"--velocity-history",
				"10,12,11,13,12",
				"--sprint-length-days",
				"14",
				"--hours-per-sprint",
				"300",
			],
			rustArgs: [
				'{"backlog_points":50,"velocity_history":[10,12,11,13,12],"sprint_length_days":14,"hours_per_sprint":300}',
			],
		},
		{
			name: "critical_path",
			category: "estimation",
			iterations: 300,
			input: { tasks },
			tsArgs: ["--tasks", JSON.stringify(tasks)],
			rustArgs: [`{"tasks":${JSON.stringify(tasks)}}`],
		},
		{
			name: "monte_carlo_schedule",
			category: "estimation",
			iterations: 80,
			input: { tasks: mcTasks, iterations: 1000 },
			tsArgs: [
				"--tasks",
				JSON.stringify(mcTasks),
				"--iterations",
				"1000",
			],
			rustArgs: [
				`{"tasks":${JSON.stringify(mcTasks)},"iterations":1000}`,
			],
		},
		{
			name: "reference_class_estimate",
			category: "analytics",
			iterations: 400,
			input: {
				task_type: "feature",
				complexity: 3,
				scope: "medium",
				ai_native: 0.8,
			},
			tsArgs: [
				"--task-type",
				"feature",
				"--complexity",
				"3",
				"--scope",
				"medium",
				"--ai-native",
				"0.8",
			],
			rustArgs: [
				'{"task_type":"feature","complexity":3,"scope":"medium","ai_native":0.8}',
			],
		},
		{
			name: "token_time_bridge",
			category: "analytics",
			iterations: 500,
			input: {
				tokens: 50000,
				model: "gpt-4o-mini",
				tool_calls: 5,
				reasoning_depth: "moderate",
			},
			tsArgs: [
				"--tokens",
				"50000",
				"--model",
				"gpt-4o-mini",
				"--tool-calls",
				"5",
				"--reasoning-depth",
				"moderate",
			],
			rustArgs: [
				'{"tokens":50000,"model":"gpt-4o-mini","tool_calls":5,"reasoning_depth":"moderate"}',
			],
		},
		{
			name: "compare_models",
			category: "cost",
			iterations: 300,
			input: {
				tokens: 50000,
				tool_calls: 5,
				reasoning_depth: "moderate",
				sort_by: "time",
			},
			tsArgs: [
				"--tokens",
				"50000",
				"--tool-calls",
				"5",
				"--reasoning-depth",
				"moderate",
				"--sort-by",
				"time",
			],
			rustArgs: [
				'{"tokens":50000,"tool_calls":5,"reasoning_depth":"moderate","sort_by":"time"}',
			],
		},
		{
			name: "schedule_risk",
			category: "risk",
			iterations: 300,
			input: {
				estimated_hours: 40,
				task_type: "feature",
				ai_native: 0.8,
				complexity: 3,
			},
			tsArgs: [
				"--estimated-hours",
				"40",
				"--task-type",
				"feature",
			],
			rustArgs: [
				'{"estimated_hours":40,"task_type":"feature","ai_native":0.8,"complexity":3}',
			],
		},
		{
			name: "cocomo_validate",
			category: "validation",
			iterations: 40,
			input: { dataset_filter: ["NASA93"] },
			tsArgs: ["--dataset-filter", "NASA93"],
			rustArgs: ['{"dataset_filter":["NASA93"]}'],
		},
		{
			name: "cocomo_ground_truth",
			category: "validation",
			iterations: 20,
			input: { dataset_filter: ["NASA93"] },
			tsArgs: ["--dataset-filter", "NASA93"],
			rustArgs: ['{"dataset_filter":["NASA93"]}'],
		},
		{
			name: "feedback_health",
			category: "feedback",
			iterations: 400,
			input: {},
			tsArgs: [],
			rustArgs: ["{}"],
		},
	];
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

function parseCliOptions(): CliOptions {
	const args = process.argv.slice(2);
	const options: CliOptions = {
		format: "json",
		smoke: false,
		iterationsScale: 1,
		maxIterationsPerTool: DEFAULT_QUALIFIED_MAX_ITERATIONS_PER_TOOL,
		skipBuild: false,
	};

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--output" || arg === "-o") {
			options.output = args[++i];
		} else if (arg === "--format") {
			const value = args[++i];
			if (value !== "json" && value !== "table") {
				throw new Error(`--format must be json or table, got ${value}`);
			}
			options.format = value;
		} else if (arg === "--smoke") {
			options.smoke = true;
		} else if (arg === "--iterations-scale") {
			options.iterationsScale = Number(args[++i]);
		} else if (arg === "--max-iterations-per-tool") {
			options.maxIterationsPerTool = Number(args[++i]);
		} else if (arg === "--skip-build") {
			options.skipBuild = true;
		} else if (arg === "--include") {
			options.include = args[++i]?.split(",").map((s) => s.trim());
		} else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
	}

	if (!Number.isFinite(options.iterationsScale) || options.iterationsScale <= 0) {
		throw new Error("--iterations-scale must be a positive number");
	}
	if (
		!Number.isFinite(options.maxIterationsPerTool) ||
		options.maxIterationsPerTool < 1
	) {
		throw new Error("--max-iterations-per-tool must be at least 1");
	}

	return options;
}

function printHelp(): void {
	console.log(`Epoch TS-vs-Rust Promotion Benchmark

Options:
  --output <path>         Write JSON report to file (stdout still gets output)
  --format <json|table>   Output format (default: json)
  --smoke                 Run with minimal iterations for a quick smoke test
  --iterations-scale <n>  Multiply default iteration counts (default: 1)
  --max-iterations-per-tool <n>
                          Cap non-smoke cold CLI invocations per tool (default: ${DEFAULT_QUALIFIED_MAX_ITERATIONS_PER_TOOL})
  --skip-build            Assume binaries exist; do not build
  --include <tool1,tool2> Benchmark only the listed tools
  --help, -h              Show this help
`);
}

// ---------------------------------------------------------------------------
// Build / binary discovery
// ---------------------------------------------------------------------------

function repositoryRoot(): string {
	// This file is at src/benchmarks/rust-promotion.ts
	return resolve(import.meta.dirname, "../..");
}

function findTsCli(): string {
	const root = repositoryRoot();
	const candidate = join(root, "dist", "index.js");
	if (!existsSync(candidate)) {
		throw new Error(
			`TS CLI not found at ${candidate}. Run 'pnpm run build' first or omit --skip-build.`,
		);
	}
	return realpathSync(candidate);
}

function findRustCli(): string {
	const root = repositoryRoot();
	const candidate = join(root, "rust", "target", "release", "epoch-cli");
	if (!existsSync(candidate)) {
		throw new Error(
			`Rust CLI not found at ${candidate}. Run 'cargo build --release -p epoch-cli' first or omit --skip-build.`,
		);
	}
	return realpathSync(candidate);
}

async function buildBinaries(): Promise<{ tsCli: string; rustCli: string }> {
	const root = repositoryRoot();

	console.error("[bench] building TypeScript CLI...");
	await runCommand("pnpm", ["run", "build"], { cwd: root, env: {} });
	const tsCli = findTsCli();

	console.error("[bench] building Rust CLI (release)...");
	await runCommand(
		"cargo",
		["build", "--release", "-p", "epoch-cli", "--manifest-path", "rust/Cargo.toml"],
		{ cwd: root, env: {} },
	);
	const rustCli = findRustCli();

	return { tsCli, rustCli };
}

function runCommand(
	command: string,
	args: string[],
	options: { cwd: string; env: Record<string, string> },
): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: { ...process.env, ...options.env },
			stdio: ["ignore", "inherit", "inherit"],
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) {
				resolve();
			} else {
				reject(new Error(`Command ${command} exited with code ${code}`));
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Execution & measurement
// ---------------------------------------------------------------------------

function invokeTool(
	binary: string,
	args: string[],
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number; ms: number }> {
	return new Promise((resolve, reject) => {
		const start = process.hrtime.bigint();
		const timeoutMs = benchmarkToolTimeoutMs();
		const child = spawn(binary, args, {
			env: { ...process.env, ...env },
			stdio: ["ignore", "pipe", "pipe"],
		});

		let stdout = "";
		let stderr = "";
		let timedOut = false;
		const timeout = setTimeout(() => {
			timedOut = true;
			stderr += `\nTimed out after ${timeoutMs}ms: ${binary} ${args.join(" ")}`;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});

		child.on("error", (error) => {
			clearTimeout(timeout);
			reject(error);
		});
		child.on("close", (exitCode) => {
			clearTimeout(timeout);
			const end = process.hrtime.bigint();
			const ms = Number(end - start) / 1_000_000;
			resolve({ stdout, stderr, exitCode: timedOut ? 124 : (exitCode ?? 1), ms });
		});
	});
}

function benchmarkToolTimeoutMs(): number {
	const raw = process.env["EPOCH_BENCHMARK_TOOL_TIMEOUT_MS"];
	if (!raw) return DEFAULT_TOOL_TIMEOUT_MS;
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed > 0
		? Math.round(parsed)
		: DEFAULT_TOOL_TIMEOUT_MS;
}

async function measureTool(
	tsCli: string,
	rustCli: string,
	tool: BenchmarkTool,
	dataDir: string,
	smoke: boolean,
	iterationsScale: number,
	maxIterationsPerTool: number,
): Promise<ToolResult> {
	const scaledIterations = Math.round(tool.iterations * iterationsScale);
	const iterations = smoke
		? 2
		: Math.max(1, Math.min(scaledIterations, maxIterationsPerTool));
	const tsSamples: LatencySample[] = [];
	const rustSamples: LatencySample[] = [];
	let tsErrors = 0;
	let rustErrors = 0;

	// Warmup + verify correctness once.
	const tsWarmup = await invokeTool(
		"node",
		[tsCli, tool.name.replace(/_/g, "-"), ...tool.tsArgs],
		{ EPOCH_DATA_DIR: dataDir },
	);
	const rustWarmup = await invokeTool(
		rustCli,
		[tool.name.replace(/_/g, "-"), ...tool.rustArgs],
		{ EPOCH_DATA_DIR: dataDir },
	);

	if (tsWarmup.exitCode !== 0) {
		throw new Error(
			`TS warmup failed for ${tool.name}: ${tsWarmup.stderr || tsWarmup.stdout}`,
		);
	}
	if (rustWarmup.exitCode !== 0) {
		throw new Error(
			`Rust warmup failed for ${tool.name}: ${rustWarmup.stderr || rustWarmup.stdout}`,
		);
	}

	// Benchmark loop.
	for (let i = 0; i < iterations; i++) {
		const tsResult = await invokeTool(
			"node",
			[tsCli, tool.name.replace(/_/g, "-"), ...tool.tsArgs],
			{ EPOCH_DATA_DIR: dataDir },
		);
		const rustResult = await invokeTool(
			rustCli,
			[tool.name.replace(/_/g, "-"), ...tool.rustArgs],
			{ EPOCH_DATA_DIR: dataDir },
		);

		if (tsResult.exitCode === 0) {
			tsSamples.push({ ms: tsResult.ms });
		} else {
			tsErrors++;
		}
		if (rustResult.exitCode === 0) {
			rustSamples.push({ ms: rustResult.ms });
		} else {
			rustErrors++;
		}
	}

	return {
		tool: tool.name,
		category: tool.category,
		iterations,
		ts: computeMetrics(tsSamples, tsWarmup.ms, tsErrors),
		rust: computeMetrics(rustSamples, rustWarmup.ms, rustErrors),
		speedup:
			tsSamples.length > 0 && rustSamples.length > 0
				? median(tsSamples.map((s) => s.ms)) / median(rustSamples.map((s) => s.ms))
				: null,
	};
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) {
		const first = sorted[0];
		return first === undefined ? 0 : first;
	}
	const index = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(index);
	const upper = Math.ceil(index);
	const weight = index - lower;
	const lowerValue = sorted[lower];
	const upperValue = sorted[upper];
	if (lowerValue === undefined || upperValue === undefined) return 0;
	return lowerValue * (1 - weight) + upperValue * weight;
}

function median(values: number[]): number {
	const sorted = [...values].sort((a, b) => a - b);
	if (sorted.length === 0) return 0;
	if (sorted.length % 2 === 1) {
		const middle = sorted[Math.floor(sorted.length / 2)];
		return middle === undefined ? 0 : middle;
	}
	const lower = sorted[sorted.length / 2 - 1];
	const upper = sorted[sorted.length / 2];
	if (lower === undefined || upper === undefined) return 0;
	return (lower + upper) / 2;
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

function stdDev(values: number[]): number {
	if (values.length < 2) return 0;
	const m = mean(values);
	const variance = values.reduce((sum, v) => sum + (v - m) ** 2, 0) / (values.length - 1);
	return Math.sqrt(variance);
}

function computeMetrics(
	samples: LatencySample[],
	coldStartMs: number,
	errors: number,
): RuntimeMetrics {
	const values = samples.map((s) => s.ms).sort((a, b) => a - b);
	return {
		iterations: samples.length,
		medianMs: median(values),
		p95Ms: percentile(values, 95),
		p99Ms: percentile(values, 99),
		minMs: values[0] ?? 0,
		maxMs: values[values.length - 1] ?? 0,
		meanMs: mean(values),
		stdDevMs: stdDev(values),
		coldStartMs: samples.length > 0 ? coldStartMs : null,
		maxRssKb: null,
		errors,
	};
}

// ---------------------------------------------------------------------------
// Optional RSS measurement
// ---------------------------------------------------------------------------

async function measureRss(
	binary: string,
	args: string[],
	env: Record<string, string>,
): Promise<number | null> {
	const timeBin = "/usr/bin/time";
	if (!existsSync(timeBin)) return null;

	const platform = process.platform;
	const timeArgs =
		platform === "darwin"
			? ["-l", binary, ...args]
			: ["-v", binary, ...args];

	try {
		const result = await invokeTool(timeBin, timeArgs, env);
		if (result.exitCode !== 0) return null;

		if (platform === "darwin") {
			const match = result.stderr.match(/(\d+)\s+maximum resident set size/);
			if (match) {
				// Darwin reports in bytes, convert to KB.
				return Math.round(Number(match[1]) / 1024);
			}
		} else {
			const match = result.stderr.match(/Maximum resident set size \(kbytes\):\s*(\d+)/);
			if (match) {
				return Number(match[1]);
			}
		}
		return null;
	} catch {
		return null;
	}
}

async function attachRssMeasurements(
	tsCli: string,
	rustCli: string,
	tool: BenchmarkTool,
	dataDir: string,
	result: ToolResult,
): Promise<void> {
	const tsRss = await measureRss(
		"node",
		[tsCli, tool.name.replace(/_/g, "-"), ...tool.tsArgs],
		{ EPOCH_DATA_DIR: dataDir },
	);
	const rustRss = await measureRss(
		rustCli,
		[tool.name.replace(/_/g, "-"), ...tool.rustArgs],
		{ EPOCH_DATA_DIR: dataDir },
	);
	result.ts.maxRssKb = tsRss;
	result.rust.maxRssKb = rustRss;
}

// ---------------------------------------------------------------------------
// Recommendation logic
// ---------------------------------------------------------------------------

function buildRecommendation(tools: ToolResult[]): {
	recommendation: string;
	confidence: "high" | "moderate" | "low";
	geomeanSpeedup: number;
	wins: { ts: number; rust: number; ties: number };
} {
	let winsTs = 0;
	let winsRust = 0;
	let ties = 0;
	let logSpeedupSum = 0;
	let validTools = 0;

	for (const tool of tools) {
		if (tool.speedup === null) continue;
		const ratio = tool.speedup;
		if (ratio > 1.1) {
			winsRust++;
		} else if (ratio < 0.9) {
			winsTs++;
		} else {
			ties++;
		}
		logSpeedupSum += Math.log(ratio);
		validTools++;
	}

	const geomeanSpeedup =
		validTools > 0 ? Math.exp(logSpeedupSum / validTools) : 1;

	let recommendation: string;
	let confidence: "high" | "moderate" | "low";

	if (validTools === 0) {
		recommendation =
			"No tools completed successfully in both runtimes; cannot make a recommendation.";
		confidence = "low";
	} else if (geomeanSpeedup >= 1.5 && winsRust >= validTools * 0.6) {
		recommendation = `Rust is measurably superior: geomean speedup ${geomeanSpeedup.toFixed(
			2,
		)}x across ${validTools} representative tools, with Rust winning ${winsRust}/${validTools} head-to-head comparisons.`;
		confidence = "high";
	} else if (geomeanSpeedup >= 1.2 && winsRust > winsTs) {
		recommendation = `Rust shows a consistent performance advantage (geomean ${geomeanSpeedup.toFixed(
			2,
		)}x), but the margin is not large enough to declare universal superiority.`;
		confidence = "moderate";
	} else if (geomeanSpeedup > 0.95 && geomeanSpeedup < 1.05) {
		recommendation = `Rust and TypeScript are effectively tied on this workload (geomean ${geomeanSpeedup.toFixed(
			2,
		)}x). Runtime choice should be driven by ecosystem fit, not raw speed.`;
		confidence = "high";
	} else if (geomeanSpeedup < 0.9) {
		recommendation = `TypeScript is faster on this benchmark (geomean ${geomeanSpeedup.toFixed(
			2,
		)}x). Rust is not measurably superior here.`;
		confidence = "moderate";
	} else {
		recommendation = `Results are mixed (geomean ${geomeanSpeedup.toFixed(
			2,
		)}x). No clear runtime winner across the sampled tools.`;
		confidence = "low";
	}

	return { recommendation, confidence, geomeanSpeedup, wins: { ts: winsTs, rust: winsRust, ties } };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

function formatTable(report: BenchmarkReport): string {
	const lines: string[] = [];
	lines.push("Epoch TS-vs-Rust Promotion Benchmark");
	lines.push("=".repeat(80));
	lines.push(`Generated: ${report.meta.generatedAt}`);
	lines.push(`Node:      ${report.meta.nodeVersion}`);
	lines.push(`TS CLI:    ${report.meta.tsCli}`);
	lines.push(`Rust CLI:  ${report.meta.rustCli}`);
	lines.push("");
	lines.push(
		`${"Tool".padEnd(24)} ${"Iters".padStart(6)} ${"TS median".padStart(12)} ${"Rust median".padStart(12)} ${"Speedup".padStart(10)}`,
	);
	lines.push("-".repeat(80));
	for (const tool of report.tools) {
		const speedup =
			tool.speedup === null ? "N/A" : `${tool.speedup.toFixed(2)}x`;
		lines.push(
			`${tool.tool.padEnd(24)} ${String(tool.iterations).padStart(6)} ${tool.ts.medianMs
				.toFixed(3)
				.padStart(12)} ${tool.rust.medianMs.toFixed(3).padStart(12)} ${speedup.padStart(10)}`,
		);
	}
	lines.push("-".repeat(80));
	lines.push("");
	lines.push(`Tools benchmarked: ${report.summary.toolsBenchmarked}`);
	lines.push(`TS median total:   ${report.summary.tsMedianTotalMs.toFixed(3)} ms`);
	lines.push(`Rust median total: ${report.summary.rustMedianTotalMs.toFixed(3)} ms`);
	lines.push(`Geomean speedup:   ${report.summary.geomeanSpeedup.toFixed(2)}x`);
	lines.push(
		`Wins:              TS ${report.summary.wins.ts}, Rust ${report.summary.wins.rust}, Ties ${report.summary.wins.ties}`,
	);
	lines.push("");
	lines.push(`Confidence: ${report.summary.confidence}`);
	lines.push(`Recommendation: ${report.summary.recommendation}`);
	return lines.join("\n");
}

function buildReport(
	tools: ToolResult[],
	tsCli: string,
	rustCli: string,
	dataDir: string,
	options: CliOptions,
): BenchmarkReport {
	const tsTotal = tools.reduce((sum, t) => sum + t.ts.medianMs, 0);
	const rustTotal = tools.reduce((sum, t) => sum + t.rust.medianMs, 0);
	const { recommendation, confidence, geomeanSpeedup, wins } =
		buildRecommendation(tools);

	const methodology =
		"Each data point is a complete CLI invocation (process spawn to exit), capturing " +
		"real-world latency including runtime startup, module/data loading, computation, and JSON serialization. " +
		"TypeScript is invoked as 'node dist/index.js <command> ...' and Rust as 'epoch-cli <command> \"json\"'. " +
		"EPOCH_DATA_DIR is set to a fresh temporary directory for isolation. " +
		"For long-running MCP/HTTP servers the per-call gap is smaller because startup is amortized; " +
		"this benchmark emphasizes CLI/serverless cold-path latency.";

	return {
		meta: {
			generatedAt: new Date().toISOString(),
			repository: "@kyanitelabs/epoch",
			nodeVersion: process.version,
			commit: process.env["COMMIT_SHA"],
			tsCli,
			rustCli,
			dataDir,
			iterationsScale: options.iterationsScale,
			maxIterationsPerTool: options.maxIterationsPerTool,
			smoke: options.smoke,
		},
		summary: {
			toolsBenchmarked: tools.length,
			tsMedianTotalMs: tsTotal,
			rustMedianTotalMs: rustTotal,
			geomeanSpeedup,
			wins,
			recommendation,
			confidence,
			methodology,
		},
		tools,
	};
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const options = parseCliOptions();
	const dataDir = mkdtempSync(join(tmpdir(), "epoch-bench-"));

	try {
		const { tsCli, rustCli } = options.skipBuild
			? { tsCli: findTsCli(), rustCli: findRustCli() }
			: await buildBinaries();

		let tools = toolRegistry();
		const includeFilter = options.include;
		if (includeFilter && includeFilter.length > 0) {
			tools = tools.filter((t) => includeFilter.includes(t.name));
		}

		console.error(
			`[bench] benchmarking ${tools.length} tools (smoke=${options.smoke})...`,
		);

		const results: ToolResult[] = [];
		for (const tool of tools) {
			process.stderr.write(`[bench] ${tool.name} ... `);
			const result = await measureTool(
				tsCli,
				rustCli,
				tool,
				dataDir,
				options.smoke,
				options.iterationsScale,
				options.maxIterationsPerTool,
			);
			await attachRssMeasurements(tsCli, rustCli, tool, dataDir, result);
			results.push(result);
			process.stderr.write(
				`TS ${result.ts.medianMs.toFixed(3)}ms / Rust ${result.rust.medianMs.toFixed(3)}ms (${
					result.speedup === null ? "N/A" : `${result.speedup.toFixed(2)}x`
				})\n`,
			);
		}

		const report = buildReport(results, tsCli, rustCli, dataDir, options);

		if (options.output) {
			writeFileSync(options.output, JSON.stringify(report, null, 2));
		}

		if (options.format === "table") {
			console.log(formatTable(report));
		} else {
			console.log(JSON.stringify(report, null, 2));
		}
	} finally {
		// Temporary directory is left in place for post-mortem inspection;
		// it contains no sensitive data and is in the system temp path.
	}
}

main().catch((error) => {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
