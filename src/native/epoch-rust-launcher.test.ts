import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planInvocation, resolveRustBinary } from "./epoch-rust-launcher.js";

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

	it("keeps unported meta commands on the TypeScript compatibility path", () => {
		expect(planInvocation(["telemetry"]).mode).toBe("typescript");
		expect(planInvocation(["telemetry", "enable"]).mode).toBe("typescript");
		expect(planInvocation(["share-data", "--validate"]).mode).toBe("typescript");
		expect(planInvocation(["self-improve"]).mode).toBe("typescript");
		expect(planInvocation(["data"]).mode).toBe("typescript");
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

		expect(status.mode).toBe("rust-cli");
		expect(status.commandPath).toBe("telemetry status");
		expect(status.wrapRustOutput).toBe(false);
		expect(preview.mode).toBe("rust-cli");
		expect(preview.commandPath).toBe("telemetry preview");
		expect(preview.wrapRustOutput).toBe(false);
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
