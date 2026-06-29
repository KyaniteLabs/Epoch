import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	planInvocation,
	resolveRustBinary,
	runPlannedInvocation,
} from "./epoch-rust-launcher.js";

describe("epoch-rust-launcher", () => {
	it("routes no-arg invocation to the Rust MCP stdio server", () => {
		expect(planInvocation([]).mode).toBe("mcp");
	});

	it("routes serve invocations to the Rust HTTP server and maps --port", () => {
		const plan = planInvocation(["serve", "--port", "8787"]);

		expect(plan.mode).toBe("http");
		expect(plan.httpEnv).toEqual({ EPOCH_PORT: "8787" });
	});

	it("routes parity-proven tool commands to Rust CLI with TypeScript flag shape", () => {
		const plan = planInvocation([
			"pert-estimate",
			"--optimistic",
			"2",
			"--most-likely",
			"4",
			"--pessimistic",
			"12",
		]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.commandPath).toBe("pert-estimate");
		expect(plan.toolName).toBe("pert_estimate");
		expect(plan.input).toEqual({
			optimistic: 2,
			most_likely: 4,
			pessimistic: 12,
			unit: "hours",
		});
	});

	it("preserves root output options for Rust-backed tool commands", () => {
		const plan = planInvocation([
			"--pretty",
			"--quiet",
			"get-current-time",
			"--timezone",
			"UTC",
		]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.root.format).toBe("table");
		expect(plan.root.quiet).toBe(true);
		expect(plan.input).toEqual({ timezone: "UTC" });
	});

	it("routes telemetry enable consent prompts through the Rust launcher", () => {
		const plain = planInvocation(["telemetry", "enable"]);
		const withEndpoint = planInvocation([
			"telemetry",
			"enable",
			"--endpoint",
			"https://collector.example.net/v1/telemetry",
		]);

		expect(plain.mode).toBe("rust-cli");
		expect(plain.commandPath).toBe("telemetry enable");
		expect(plain.input).toEqual({});
		expect(plain.requiresTelemetryConsent).toBe(true);
		expect(withEndpoint.mode).toBe("rust-cli");
		expect(withEndpoint.commandPath).toBe("telemetry enable");
		expect(withEndpoint.input).toEqual({
			endpoint: "https://collector.example.net/v1/telemetry",
		});
		expect(withEndpoint.requiresTelemetryConsent).toBe(true);
	});

	it("routes root meta help commands to Rust as TypeScript-shaped failures", () => {
		const telemetry = planInvocation(["telemetry"]);
		const data = planInvocation(["data"]);

		expect(telemetry.mode).toBe("rust-cli");
		expect(telemetry.commandPath).toBe("telemetry");
		expect(telemetry.wrapRustOutput).toBe(false);
		expect((telemetry as { rawRustOutputFormat?: string }).rawRustOutputFormat)
			.toBe("text");
		expect((telemetry as { rawRustFailureStream?: string }).rawRustFailureStream)
			.toBe("stderr");
		expect((telemetry as { exitByPayloadOk?: boolean }).exitByPayloadOk).toBe(
			true,
		);

		expect(data.mode).toBe("rust-cli");
		expect(data.commandPath).toBe("data");
		expect(data.wrapRustOutput).toBe(false);
		expect((data as { rawRustOutputFormat?: string }).rawRustOutputFormat)
			.toBe("text");
		expect((data as { rawRustFailureStream?: string }).rawRustFailureStream)
			.toBe("stderr");
		expect((data as { exitByPayloadOk?: boolean }).exitByPayloadOk).toBe(true);
	});

	it("routes self-improve to Rust with TypeScript compact output shape", () => {
		const plan = planInvocation(["self-improve"]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.commandPath).toBe("self-improve");
		expect(plan.toolName).toBe("self_improve");
		expect(plan.input).toEqual({});
		expect(plan.wrapRustOutput).toBe(false);
		expect(plan.rawRustOutputIndent).toBeNull();
	});

	it("routes shape-compatible list-tools to Rust without wrapping output", () => {
		const plan = planInvocation(["list-tools"]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.commandPath).toBe("list-tools");
		expect(plan.wrapRustOutput).toBe(false);
		expect(plan.input).toEqual({});
	});

	it("routes shape-compatible data inspection subcommands to Rust", () => {
		const where = planInvocation(["data", "where"]);
		const status = planInvocation(["data", "status"]);

		expect(where.mode).toBe("rust-cli");
		expect(where.commandPath).toBe("data where");
		expect(where.wrapRustOutput).toBe(false);
		expect(status.mode).toBe("rust-cli");
		expect(status.commandPath).toBe("data status");
		expect(status.wrapRustOutput).toBe(false);
	});

	it("routes shape-compatible telemetry inspection subcommands to Rust", () => {
		const status = planInvocation(["telemetry", "status"]);
		const preview = planInvocation(["telemetry", "preview"]);
		const exportTelemetry = planInvocation([
			"telemetry",
			"export",
			"--output",
			"/tmp/epoch-export.json",
		]);
		const enable = planInvocation([
			"telemetry",
			"enable",
			"--yes",
			"--endpoint",
			"https://collector.example.net/v1/telemetry",
		]);
		const setEndpoint = planInvocation([
			"telemetry",
			"set-endpoint",
			"--endpoint",
			"https://collector.example.net/v1/telemetry",
		]);
		const disable = planInvocation(["telemetry", "disable"]);
		const deleteData = planInvocation(["telemetry", "delete-data", "--confirm"]);

		expect(status.mode).toBe("rust-cli");
		expect(status.commandPath).toBe("telemetry status");
		expect(status.wrapRustOutput).toBe(false);
		expect(preview.mode).toBe("rust-cli");
		expect(preview.commandPath).toBe("telemetry preview");
		expect(preview.wrapRustOutput).toBe(false);
		expect(exportTelemetry.mode).toBe("rust-cli");
		expect(exportTelemetry.commandPath).toBe("telemetry export");
		expect(exportTelemetry.input).toEqual({ output: "/tmp/epoch-export.json" });
		expect(exportTelemetry.wrapRustOutput).toBe(false);
		expect(exportTelemetry.rawRustOutputIndent).toBeNull();
		expect(enable.mode).toBe("rust-cli");
		expect(enable.commandPath).toBe("telemetry enable");
		expect(enable.input).toEqual({
			endpoint: "https://collector.example.net/v1/telemetry",
		});
		expect(enable.wrapRustOutput).toBe(false);
		expect(enable.rawRustOutputIndent).toBeNull();
		expect(setEndpoint.mode).toBe("rust-cli");
		expect(setEndpoint.commandPath).toBe("telemetry set-endpoint");
		expect(setEndpoint.input).toEqual({
			endpoint: "https://collector.example.net/v1/telemetry",
		});
		expect(setEndpoint.wrapRustOutput).toBe(false);
		expect(setEndpoint.rawRustOutputIndent).toBeNull();
		expect(disable.mode).toBe("rust-cli");
		expect(disable.commandPath).toBe("telemetry disable");
		expect(disable.wrapRustOutput).toBe(false);
		expect(disable.rawRustOutputIndent).toBeNull();
		expect(deleteData.mode).toBe("rust-cli");
		expect(deleteData.commandPath).toBe("telemetry delete-data");
		expect(deleteData.input).toEqual({});
		expect(deleteData.wrapRustOutput).toBe(false);
		expect(deleteData.rawRustOutputFormat).toBe("text");
	});

	it("routes telemetry submit to Rust with TypeScript submit options", () => {
		const plan = planInvocation([
			"telemetry",
			"submit",
			"--endpoint",
			"https://collector.example.net/v1/telemetry",
			"--force",
			"--min-interval-hours",
			"0",
		]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.commandPath).toBe("telemetry submit");
		expect(plan.input).toEqual({
			endpoint: "https://collector.example.net/v1/telemetry",
			force: true,
			min_interval_hours: "0",
		});
		expect(plan.wrapRustOutput).toBe(false);
		expect(plan.rawRustOutputIndent).toBe(2);
		expect((plan as { exitByPayloadOk?: boolean }).exitByPayloadOk).toBe(true);
	});

	it("routes telemetry endpoint validation errors through the Rust launcher", () => {
		const plan = planInvocation([
			"telemetry",
			"submit",
			"--endpoint",
			"http://collector.example.net/v1/telemetry",
		]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.commandPath).toBe("telemetry submit");
	});

	it("routes telemetry submit interval strings through Rust for TypeScript-lazy parsing", () => {
		expect(
			planInvocation([
				"telemetry",
				"submit",
				"--min-interval-hours",
				"-1",
			]).mode,
		).toBe("rust-cli");
		expect(
			planInvocation([
				"telemetry",
				"submit",
				"--min-interval-hours",
				"not-a-number",
			]).mode,
		).toBe("rust-cli");
		expect(
			planInvocation([
				"telemetry",
				"submit",
				"--min-interval-hours",
				"0x10",
			]).mode,
		).toBe("rust-cli");
		expect(() =>
			planInvocation(["telemetry", "submit", "--min-interval-hours"]),
		).toThrow("error: option '--min-interval-hours <n>' argument missing");
	});

	it("routes share-data to Rust with TypeScript export options", () => {
		const plan = planInvocation([
			"share-data",
			"--output",
			"/tmp/epoch-community.json",
			"--description",
			"Community dataset",
			"--validate",
			"--default-complexity",
			"2",
		]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.commandPath).toBe("share-data");
		expect(plan.toolName).toBe("share_data");
		expect(plan.input).toEqual({
			output: "/tmp/epoch-community.json",
			description: "Community dataset",
			validate: true,
			default_complexity: 2,
		});
		expect(plan.wrapRustOutput).toBe(false);
		expect(plan.rawRustOutputIndent).toBe(2);
		expect((plan as { exitByPayloadOk?: boolean }).exitByPayloadOk).toBe(true);
		expect((plan as { rawRustFailureStream?: string }).rawRustFailureStream).toBe(
			"stderr",
		);
		expect((plan as { rawRustFailureIndent?: number | null }).rawRustFailureIndent)
			.toBeNull();
	});

	it("routes share-data default-complexity values through the Rust launcher", () => {
		expect(
			planInvocation([
				"share-data",
				"--default-complexity",
				"0x10",
			]).mode,
		).toBe("rust-cli");
		expect(
			planInvocation([
				"share-data",
				"--default-complexity",
				"-1",
			]).input,
		).toEqual({ default_complexity: -1 });
	});

	it("prints share-data default-complexity parse errors like Commander", () => {
		expect(() =>
			planInvocation(["share-data", "--default-complexity", "not-a-number"]),
		).toThrow('Error: --default-complexity must be a number, got "not-a-number"');
		expect(() => planInvocation(["share-data", "--default-complexity"]))
			.toThrow("error: option '--default-complexity <n>' argument missing");
	});

	it("fails closed when a Rust-routed command has no Rust binary", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-missing-bin-"));
		try {
			const output = captureOutput(() =>
				runPlannedInvocation(
					planInvocation([
						"pert-estimate",
						"--optimistic",
						"1",
						"--most-likely",
						"2",
						"--pessimistic",
						"4",
					]),
					root,
					{},
				),
			);

			expect(output.status).toBe(1);
			expect(output.stderr).toContain(
				"Epoch Rust launcher could not find epoch-cli.",
			);
			expect(output.stderr).toContain("EPOCH_ALLOW_TYPESCRIPT_FALLBACK=1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("allows TypeScript fallback only when explicitly requested", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-fallback-"));
		try {
			const dist = join(root, "dist");
			mkdirSync(dist, { recursive: true });
			writeFileSync(join(dist, "index.js"), "process.exit(23);\n");

			expect(
				runPlannedInvocation(
					planInvocation([
						"pert-estimate",
						"--optimistic",
						"1",
						"--most-likely",
						"2",
						"--pessimistic",
						"4",
					]),
					root,
					{ EPOCH_ALLOW_TYPESCRIPT_FALLBACK: "1" },
				),
			).toBe(23);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints telemetry submit payloads in TypeScript order and exits by ok", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-run-"));
		try {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const releaseDir = join(root, "rust", "target", "release");
			const binary = join(releaseDir, `epoch-cli${suffix}`);
			mkdirSync(releaseDir, { recursive: true });
			writeFileSync(
				binary,
				[
					"#!/usr/bin/env node",
					"console.log(JSON.stringify({ error: 'no endpoint configured', ok: false, recordCount: 0 }, null, 2));",
				].join("\n"),
			);
			chmodSync(binary, 0o755);

			const output = captureStdout(() =>
				runPlannedInvocation(planInvocation(["telemetry", "submit"]), root, {}),
			);

			expect(output.status).toBe(1);
			expect(output.stdout).toBe(
				[
					"{",
					'  "ok": false,',
					'  "recordCount": 0,',
					'  "error": "no endpoint configured"',
					"}",
					"",
				].join("\n"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints telemetry endpoint validation failures like the TypeScript CLI", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-endpoint-error-"));
		try {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const releaseDir = join(root, "rust", "target", "release");
			const binary = join(releaseDir, `epoch-cli${suffix}`);
			mkdirSync(releaseDir, { recursive: true });
			writeFileSync(
				binary,
				[
					"#!/usr/bin/env node",
					"console.error(JSON.stringify({ error: { isError: true, message: 'this fake binary should not run' } }));",
					"process.exit(2);",
				].join("\n"),
			);
			chmodSync(binary, 0o755);

			const output = captureOutput(() =>
				runPlannedInvocation(
					planInvocation([
						"telemetry",
						"enable",
						"--yes",
						"--endpoint",
						"http://collector.example.net/v1/telemetry",
					]),
					root,
					{},
				),
			);

			expect(output.status).toBe(1);
			expect(output.stdout).toBe("");
			expect(output.stderr).toBe(
				"--endpoint must use https://, except for localhost or Tailscale private receivers\n",
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints self-improve success payloads like the TypeScript CLI", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-self-improve-"));
		try {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const releaseDir = join(root, "rust", "target", "release");
			const binary = join(releaseDir, `epoch-cli${suffix}`);
			mkdirSync(releaseDir, { recursive: true });
			writeFileSync(
				binary,
				[
					"#!/usr/bin/env node",
					"console.log(JSON.stringify({ ok: true, message: 'Self-improvement complete.' }, null, 2));",
				].join("\n"),
			);
			chmodSync(binary, 0o755);

			const output = captureOutput(() =>
				runPlannedInvocation(planInvocation(["self-improve"]), root, {}),
			);

			expect(output.status).toBe(0);
			expect(output.stderr).toBe("");
			expect(output.stdout).toBe(
				'{"ok":true,"message":"Self-improvement complete."}\n',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints root meta help failures like the TypeScript CLI", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-root-help-"));
		try {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const releaseDir = join(root, "rust", "target", "release");
			const binary = join(releaseDir, `epoch-cli${suffix}`);
			mkdirSync(releaseDir, { recursive: true });
			writeFileSync(
				binary,
				[
					"#!/usr/bin/env node",
					"const command = process.argv[2];",
					"if (command === 'telemetry') {",
					"  console.log(JSON.stringify({ ok: false, message: 'Usage: epoch telemetry [options] [command]\\n\\nManage anonymous telemetry settings\\n' }, null, 2));",
					"} else {",
					"  console.log(JSON.stringify({ ok: false, message: 'Usage: epoch data [options] [command]\\n\\nInspect local Epoch data files\\n' }, null, 2));",
					"}",
				].join("\n"),
			);
			chmodSync(binary, 0o755);

			const telemetry = captureOutput(() =>
				runPlannedInvocation(planInvocation(["telemetry"]), root, {}),
			);
			const data = captureOutput(() =>
				runPlannedInvocation(planInvocation(["data"]), root, {}),
			);

			expect(telemetry.status).toBe(1);
			expect(telemetry.stdout).toBe("");
			expect(telemetry.stderr).toContain("Usage: epoch telemetry");
			expect(telemetry.stderr).toContain("Manage anonymous telemetry settings");
			expect(data.status).toBe(1);
			expect(data.stdout).toBe("");
			expect(data.stderr).toContain("Usage: epoch data");
			expect(data.stderr).toContain("Inspect local Epoch data files");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints share-data failures as compact TypeScript stderr and exits by ok", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-share-data-"));
		try {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const releaseDir = join(root, "rust", "target", "release");
			const binary = join(releaseDir, `epoch-cli${suffix}`);
			mkdirSync(releaseDir, { recursive: true });
			writeFileSync(
				binary,
				[
					"#!/usr/bin/env node",
					"console.log(JSON.stringify({ ok: false, message: 'No exportable records found.' }, null, 2));",
				].join("\n"),
			);
			chmodSync(binary, 0o755);

			const output = captureOutput(() =>
				runPlannedInvocation(planInvocation(["share-data", "--validate"]), root, {}),
			);

			expect(output.status).toBe(1);
			expect(output.stdout).toBe("");
			expect(output.stderr).toBe(
				'{"ok":false,"message":"No exportable records found."}\n',
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("prints share-data success payloads in TypeScript order", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-share-data-ok-"));
		try {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const releaseDir = join(root, "rust", "target", "release");
			const binary = join(releaseDir, `epoch-cli${suffix}`);
			mkdirSync(releaseDir, { recursive: true });
			writeFileSync(
				binary,
				[
					"#!/usr/bin/env node",
					"console.log(JSON.stringify({ ok: true, path: '/tmp/community.json', recordCount: 1, skipped: { invalidHours: 0, invalidTaskType: 1, missingComplexity: 2 }, schema: 'estimation-record', validated: false, nextSteps: ['review'] }, null, 2));",
				].join("\n"),
			);
			chmodSync(binary, 0o755);

			const output = captureOutput(() =>
				runPlannedInvocation(planInvocation(["share-data", "--validate"]), root, {}),
			);

			expect(output.status).toBe(0);
			expect(output.stderr).toBe("");
			expect(output.stdout).toBe(
				[
					"{",
					'  "ok": true,',
					'  "path": "/tmp/community.json",',
					'  "recordCount": 1,',
					'  "skipped": {',
					'    "missingComplexity": 2,',
					'    "invalidTaskType": 1,',
					'    "invalidHours": 0',
					"  },",
					'  "schema": "estimation-record",',
					'  "validated": false,',
					'  "nextSteps": [',
					'    "review"',
					"  ]",
					"}",
					"",
				].join("\n"),
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("builds nested time-math operands for Rust CLI", () => {
		const plan = planInvocation([
			"time-math",
			"--operation",
			"diff",
			"--date",
			"2026-06-29",
			"--end-date",
			"2026-06-30",
		]);

		expect(plan.mode).toBe("rust-cli");
		expect(plan.input).toEqual({
			operation: "diff",
			operands: {
				date: "2026-06-29",
				end_date: "2026-06-30",
			},
		});
	});

	it("parses JSON and CSV command flags", () => {
		const criticalPath = planInvocation([
			"critical-path",
			"--tasks",
			'[{"name":"a","duration":1,"predecessors":[]}]',
		]);
		const sprint = planInvocation([
			"sprint-forecast",
			"--backlog-points",
			"20",
			"--velocity-history",
			"8,10,9",
		]);

		expect(criticalPath.input).toEqual({
			tasks: [{ name: "a", duration: 1, predecessors: [] }],
		});
		expect(sprint.input).toEqual({
			backlog_points: 20,
			velocity_history: [8, 10, 9],
		});
	});

	it("prefers explicit bins then fresh source-tree release bins before prebuilds", () => {
		const root = mkdtempSync(join(tmpdir(), "epoch-launcher-"));
		try {
			const suffix = process.platform === "win32" ? ".exe" : "";
			const arch = process.arch === "x64" ? "x64" : process.arch;
			const platform = `${process.platform}-${arch}`;
			const explicitDir = join(root, "explicit");
			const releaseDir = join(root, "rust", "target", "release");
			const prebuildDir = join(root, "prebuilds", platform);
			const explicit = join(explicitDir, `epoch-cli${suffix}`);
			const release = join(releaseDir, `epoch-cli${suffix}`);
			const prebuild = join(prebuildDir, `epoch-cli${suffix}`);

			mkdirSync(explicitDir, { recursive: true });
			mkdirSync(releaseDir, { recursive: true });
			mkdirSync(prebuildDir, { recursive: true });
			writeFileSync(explicit, "");
			writeFileSync(release, "");
			writeFileSync(prebuild, "");

			expect(resolveRustBinary(root, "epoch-cli", {})).toBe(release);
			expect(
				resolveRustBinary(root, "epoch-cli", { EPOCH_RUST_BIN_DIR: explicitDir }),
			).toBe(explicit);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

function captureStdout(fn: () => number): { status: number; stdout: string } {
	const originalWrite = process.stdout.write;
	let stdout = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	try {
		return { status: fn(), stdout };
	} finally {
		process.stdout.write = originalWrite;
	}
}

function captureOutput(fn: () => number): {
	status: number;
	stdout: string;
	stderr: string;
} {
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;
	let stdout = "";
	let stderr = "";
	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += String(chunk);
		return true;
	}) as typeof process.stdout.write;
	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += String(chunk);
		return true;
	}) as typeof process.stderr.write;
	try {
		return { status: fn(), stdout, stderr };
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}
