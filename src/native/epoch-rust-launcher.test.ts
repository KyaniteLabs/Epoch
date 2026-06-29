import { describe, expect, it } from "vitest";
import { planInvocation } from "./epoch-rust-launcher.js";

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
		expect(planInvocation(["telemetry", "status"]).mode).toBe("typescript");
		expect(planInvocation(["share-data", "--validate"]).mode).toBe("typescript");
		expect(planInvocation(["self-improve"]).mode).toBe("typescript");
		expect(planInvocation(["data", "status"]).mode).toBe("typescript");
		expect(planInvocation(["list-tools"]).mode).toBe("typescript");
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
});
