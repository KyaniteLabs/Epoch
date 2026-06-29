#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch Rust promotion packet
//
// Runs the current promotion evidence chain and writes a local packet:
// parity, performance, release-binary e2e, shadow-soak, rollback, normalized
// readiness input, and a sanitized summary suitable for release review. Raw evidence can contain
// local artifact paths, so the default output directory is git-ignored.
// ---------------------------------------------------------------------------

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { basename, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

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
			releaseE2ePass: boolean;
			publicSurfaceCoveragePercent: number | null;
			httpDeployEnvCoveragePercent: number | null;
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
		deploy: {
			packageSmokePass: boolean;
			packageTarball: string | null;
			packageBinTarget: string | null;
			packagePrebuilds: string[];
			packageCliSha256: string | null;
			commandExitCode: number | null;
			packageCommands: PackageSmokeCommandEvidence[];
		};
	};
	files: {
		parity: string;
		perf: string;
		e2e: string;
		packageSmoke: string;
		shadowSoak: string;
		shadowSoakProgress: string;
		rollback: string;
		readinessInput: string;
		readinessAssessment: string;
		summary: string;
	};
};

const REPO_ROOT = resolve(new URL("..", import.meta.url).pathname);
const DEFAULT_OUTPUT_DIR = ".epoch-promotion/latest";
const RUST_BINARIES = ["epoch-cli", "epoch-mcp", "epoch-http"] as const;

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

function sha256File(path: string): string {
	return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function rel(path: string): string {
	return relative(REPO_ROOT, path);
}

function platformTag(): string {
	const arch = process.arch === "x64" ? "x64" : process.arch;
	return `${process.platform}-${arch}`;
}

function packagePrebuildPath(packageRoot: string, binary: string): string {
	const suffix = process.platform === "win32" ? ".exe" : "";
	const platform = platformTag();
	return join(packageRoot, "prebuilds", platform, `${binary}${suffix}`);
}

function packagePrebuildTarget(binary: string): string {
	const suffix = process.platform === "win32" ? ".exe" : "";
	return ["prebuilds", platformTag(), `${binary}${suffix}`].join("/");
}

function requiredPackagePrebuilds(packageRoot: string): string[] {
	return RUST_BINARIES.map((binary) => packagePrebuildPath(packageRoot, binary));
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

function numberValue(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function e2eCoveragePercent(report: unknown, category: string): number | null {
	if (!isObject(report) || !isObject(report.coverage)) return null;
	const coverage = report.coverage[category];
	if (!isObject(coverage)) return null;
	return numberValue(coverage.percent);
}

function e2eEvidence(e2eReport: unknown): {
	releaseE2ePass: boolean;
	publicSurfaceCoveragePercent: number | null;
	httpDeployEnvCoveragePercent: number | null;
} {
	return {
		releaseE2ePass: isObject(e2eReport) && e2eReport.pass === true,
		publicSurfaceCoveragePercent: isObject(e2eReport)
			? numberValue(e2eReport.overall_surface_percent)
			: null,
		httpDeployEnvCoveragePercent: e2eCoveragePercent(
			e2eReport,
			"http_deploy_env",
		),
	};
}

type PackageSmokeEvidence = {
	ok: boolean;
	reason: string;
	tarball: string | null;
	platform: string;
	binTarget: string | null;
	prebuilds: string[];
	packageCliSha256: string | null;
	commandExitCode: number | null;
	stdoutHead: string;
	stderrHead: string;
	commands: PackageSmokeCommandEvidence[];
};

type PackageSmokeCommandEvidence = {
	name: string;
	target: string;
	exitCode: number | null;
	signal: NodeJS.Signals | null;
	stdoutHead: string;
	stderrHead: string;
	error: string | null;
};

type PackageSmokeCommandResult = PackageSmokeCommandEvidence & {
	stdout: string;
	stderr: string;
};

function head(value: string): string {
	return value.split(/\r?\n/).slice(0, 3).join(" ").replace(/\s+/g, " ").trim();
}

function runSmokeCommand(
	name: string,
	target: string,
	binary: string,
	args: string[],
	options: {
		cwd: string;
		input?: string;
	},
): PackageSmokeCommandResult {
	const command = spawnSync(binary, args, {
		cwd: options.cwd,
		encoding: "utf8",
		input: options.input,
		env: { ...process.env, EPOCH_ALLOW_TYPESCRIPT_FALLBACK: "0" },
	});
	const stdout = typeof command.stdout === "string" ? command.stdout : "";
	const stderr = typeof command.stderr === "string" ? command.stderr : "";
	return {
		name,
		target,
		exitCode: command.status,
		signal: command.signal,
		stdout,
		stderr,
		stdoutHead: head(stdout),
		stderrHead: head(stderr),
		error: command.error instanceof Error ? command.error.message : null,
	};
}

function commandEvidence(
	command: PackageSmokeCommandResult,
): PackageSmokeCommandEvidence {
	return {
		name: command.name,
		target: command.target,
		exitCode: command.exitCode,
		signal: command.signal,
		stdoutHead: command.stdoutHead,
		stderrHead: command.stderrHead,
		error: command.error,
	};
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function getFreeLoopbackPort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (typeof address !== "object" || address === null) {
				server.close(() => reject(new Error("Could not allocate loopback port.")));
				return;
			}
			const port = address.port;
			server.close((error) => {
				if (error) reject(error);
				else resolvePort(port);
			});
		});
	});
}

function httpGet(path: string, timeoutMs: number): Promise<string> {
	return new Promise((resolveBody, reject) => {
		const req = request(path, { timeout: timeoutMs }, (res) => {
			let body = "";
			res.setEncoding("utf8");
			res.on("data", (chunk) => {
				body += chunk;
			});
			res.on("end", () => {
				if (res.statusCode !== 200) {
					reject(new Error(`HTTP ${res.statusCode ?? "unknown"}: ${head(body)}`));
					return;
				}
				resolveBody(body);
			});
		});
		req.on("timeout", () => {
			req.destroy(new Error("HTTP health request timed out."));
		});
		req.on("error", reject);
		req.end();
	});
}

async function waitForHttpHealth(port: number): Promise<string> {
	const deadline = Date.now() + 5_000;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		try {
			const body = await httpGet(`http://127.0.0.1:${port}/health`, 500);
			const parsed = JSON.parse(body) as unknown;
			if (
				isObject(parsed) &&
				parsed.status === "ok" &&
				parsed.tools === 24
			) {
				return body;
			}
			throw new Error(`Unexpected health response: ${head(body)}`);
		} catch (error) {
			lastError = error;
			await sleep(100);
		}
	}
	throw lastError instanceof Error
		? lastError
		: new Error("HTTP health check did not pass.");
}

async function runHttpServerSmoke(
	name: string,
	target: string,
	binary: string,
	options: { cwd: string },
): Promise<PackageSmokeCommandResult> {
	const port = await getFreeLoopbackPort();
	const child = spawn(binary, [`127.0.0.1:${port}`], {
		cwd: options.cwd,
		env: { ...process.env, EPOCH_ALLOW_TYPESCRIPT_FALLBACK: "0" },
		stdio: ["ignore", "pipe", "pipe"],
	});
	let stdout = "";
	let stderr = "";
	child.stdout.setEncoding("utf8");
	child.stderr.setEncoding("utf8");
	child.stdout.on("data", (chunk) => {
		stdout += chunk;
	});
	child.stderr.on("data", (chunk) => {
		stderr += chunk;
	});

	let exitCode: number | null = null;
	let signal: NodeJS.Signals | null = null;
	const exited = new Promise<void>((resolveExit) => {
		child.once("exit", (code, exitSignal) => {
			exitCode = code;
			signal = exitSignal;
			resolveExit();
		});
	});

	let error: string | null = null;
	let healthOk = false;
	try {
		const healthBody = await waitForHttpHealth(port);
		stdout += `\nhealth ${head(healthBody)}`;
		healthOk = true;
		exitCode = 0;
		signal = null;
	} catch (caught) {
		error = caught instanceof Error ? caught.message : String(caught);
	} finally {
		if (!child.killed) child.kill("SIGTERM");
		await Promise.race([exited, sleep(1_000)]);
		if (exitCode === null && !child.killed) child.kill("SIGKILL");
	}
	if (healthOk) {
		exitCode = 0;
		signal = null;
	}

	return {
		name,
		target,
		exitCode,
		signal,
		stdout,
		stderr,
		stdoutHead: head(stdout),
		stderrHead: head(stderr),
		error,
	};
}

async function runPackageSmoke(options: { quiet: boolean }): Promise<PackageSmokeEvidence> {
	if (!options.quiet) process.stderr.write("[promotion] package install smoke...\n");
	const root = mkdtempSync(join(tmpdir(), "epoch-package-smoke-"));
	const packDir = join(root, "pack");
	const appDir = join(root, "app");
	mkdirSync(packDir, { recursive: true });
	mkdirSync(appDir, { recursive: true });
	try {
		const packOutput = execFileSync("npm", ["pack", "--pack-destination", packDir], {
			cwd: REPO_ROOT,
			encoding: "utf8",
			maxBuffer: 64 * 1024 * 1024,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const tarballName = packOutput.trim().split(/\r?\n/).at(-1) ?? "";
		const tarball = resolve(packDir, tarballName);
		execFileSync("npm", ["init", "-y"], {
			cwd: appDir,
			stdio: "ignore",
		});
		execFileSync("npm", ["install", tarball, "--ignore-scripts"], {
			cwd: appDir,
			stdio: "ignore",
		});
		const packageRoot = join(appDir, "node_modules", "@kyanitelabs", "epoch");
		const prebuilds = requiredPackagePrebuilds(packageRoot)
			.filter((file) => existsSync(file))
			.map((file) => relative(packageRoot, file).replaceAll("\\", "/"));
		const packageCliPath = packagePrebuildPath(packageRoot, "epoch-cli");
		const packageCliSha256 = existsSync(packageCliPath)
			? sha256File(packageCliPath)
			: null;
		const binPath = join(
			appDir,
			"node_modules",
			".bin",
			process.platform === "win32" ? "epoch.cmd" : "epoch",
		);
		let binTarget: string | null = null;
		try {
			binTarget = readlinkSync(binPath);
		} catch {
			binTarget = existsSync(binPath) ? binPath : null;
		}
		const cliCommand = runSmokeCommand(
			"epoch-cli",
			"node_modules/.bin/epoch",
			binPath,
			[
				"pert-estimate",
				"--optimistic",
				"1",
				"--most-likely",
				"2",
				"--pessimistic",
				"4",
			],
			{ cwd: appDir },
		);
		const mcpCommand = runSmokeCommand(
			"epoch-mcp",
			packagePrebuildTarget("epoch-mcp"),
			packagePrebuildPath(packageRoot, "epoch-mcp"),
			[],
			{
				cwd: appDir,
				input: '{"jsonrpc":"2.0","id":1,"method":"ping"}\n',
			},
		);
		const httpCommand = await runHttpServerSmoke(
			"epoch-http",
			packagePrebuildTarget("epoch-http"),
			packagePrebuildPath(packageRoot, "epoch-http"),
			{ cwd: appDir },
		);
		const commandChecks = [
			{
				name: cliCommand.name,
				ok:
					cliCommand.exitCode === 0 &&
					cliCommand.stdout.includes('"ok": true'),
			},
			{
				name: mcpCommand.name,
				ok:
					mcpCommand.exitCode === 0 &&
					mcpCommand.stdout.startsWith("Content-Length:") &&
					mcpCommand.stdout.includes('"result":{}'),
			},
			{
				name: httpCommand.name,
				ok:
					httpCommand.exitCode === 0 &&
					httpCommand.stdout.includes('"status":"ok"') &&
					httpCommand.stdout.includes('"tools":24'),
			},
		];
		const failedCommands = commandChecks
			.filter((check) => !check.ok)
			.map((check) => check.name);
		const commands = [cliCommand, mcpCommand, httpCommand].map(commandEvidence);
		const requiredCount = RUST_BINARIES.length;
		const ok = prebuilds.length === requiredCount && failedCommands.length === 0;
		const reason = ok
			? "Packed package installed and executed CLI, MCP, and HTTP Rust prebuilds."
			: `Package smoke failed: ${prebuilds.length}/${requiredCount} Rust prebuilds present${
					failedCommands.length > 0
						? `, failed commands: ${failedCommands.join(", ")}`
						: ""
				}.`;
		return {
			ok,
			reason,
			tarball: basename(tarball),
			platform: platformTag(),
			binTarget,
			prebuilds,
			packageCliSha256,
			commandExitCode: cliCommand.exitCode,
			stdoutHead: cliCommand.stdoutHead,
			stderrHead: cliCommand.stderrHead,
			commands,
		};
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function buildSummary(
	outputDir: string,
	readinessInput: ReadinessInput,
	readiness: ReadinessAssessment,
	releaseTag: string | undefined,
	shadowSoak: unknown,
	perfReport: unknown,
	e2eReport: unknown,
	packageSmoke: PackageSmokeEvidence,
): PacketSummary {
	const e2e = e2eEvidence(e2eReport);
	return {
		generatedAt: new Date().toISOString(),
		readiness,
		evidence: {
			compatibility: {
				publicSurfaceMatch: readinessInput.parity.publicSurfaceMatch,
				...e2e,
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
			deploy: {
				packageSmokePass: packageSmoke.ok,
				packageTarball: packageSmoke.tarball,
				packageBinTarget: packageSmoke.binTarget,
				packagePrebuilds: packageSmoke.prebuilds,
				packageCliSha256: packageSmoke.packageCliSha256,
				commandExitCode: packageSmoke.commandExitCode,
				packageCommands: packageSmoke.commands,
			},
		},
		files: {
			parity: rel(resolve(outputDir, "parity.json")),
			perf: rel(resolve(outputDir, "perf.json")),
			e2e: rel(resolve(outputDir, "e2e.json")),
			packageSmoke: rel(resolve(outputDir, "package-smoke.json")),
			shadowSoak: rel(resolve(outputDir, "shadow-soak.json")),
			shadowSoakProgress: rel(resolve(outputDir, "shadow-soak-progress.json")),
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
			`  release e2e:         ${summary.evidence.compatibility.releaseE2ePass ? "pass" : "fail"} (${summary.evidence.compatibility.publicSurfaceCoveragePercent ?? "unknown"}%)`,
			`  output parity:       ${summary.evidence.compatibility.outputParityPercent}%`,
			`  error compatibility: ${summary.evidence.compatibility.errorCompatibilityPercent}%`,
			`  median improvement:  ${summary.evidence.performance.medianLatencyImprovementPercent.toFixed(2)}%`,
			`  p95 improvement:     ${summary.evidence.performance.p95LatencyImprovementPercent.toFixed(2)}%`,
			`  perf evidence:       ${summary.evidence.performance.evidenceMode}`,
			`  package smoke:       ${summary.evidence.deploy.packageSmokePass ? "pass" : "fail"}`,
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
	const e2ePath = resolve(outputDir, "e2e.json");
	const packageSmokePath = resolve(outputDir, "package-smoke.json");
	const shadowPath = resolve(outputDir, "shadow-soak.json");
	const shadowProgressPath = resolve(outputDir, "shadow-soak-progress.json");
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

	runPackageManager("release e2e public surface", [
		"run",
		"promotion:rust-e2e",
	], options);
	copyFileSync(
		resolve(REPO_ROOT, "docs/superpowers/reports/rust-promotion-e2e.json"),
		e2ePath,
	);

	const packageSmoke = await runPackageSmoke(options);
	writeJson(packageSmokePath, packageSmoke);
	if (!packageSmoke.ok) {
		throw new Error(packageSmoke.reason);
	}

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
		"--progress-output",
		shadowProgressPath,
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

	const perfReport = readJson(perfPath);
	const e2eReport = readJson(e2ePath);
	const e2e = e2eEvidence(e2eReport);
	const readinessInput = normalizeReadinessEvidence({
		parity: {
			...(readJson(rollbackPath) as Record<string, unknown>),
			releaseE2ePass: e2e.releaseE2ePass,
			publicSurfaceCoveragePercent: e2e.publicSurfaceCoveragePercent ?? 0,
			httpDeployEnvCoveragePercent: e2e.httpDeployEnvCoveragePercent ?? 0,
			packageSmokePass: packageSmoke.ok,
		},
		perf: perfReport,
	});
	const shadowSoak = readJson(shadowPath);
	const readiness = assessDeployReadiness(readinessInput);
	const summary = buildSummary(
		outputDir,
		readinessInput,
		readiness,
		options.releaseTag,
		shadowSoak,
		perfReport,
		e2eReport,
		packageSmoke,
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
