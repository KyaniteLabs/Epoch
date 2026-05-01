import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerEstimationTools } from "./estimation.js";

// ---------------------------------------------------------------------------
// Tool Registration Tests — Layer 3 (Estimation)
// ---------------------------------------------------------------------------

function createMockServer(): {
  server: McpServer;
  tools: Array<{ name: string; handler: (...args: unknown[]) => Promise<unknown> }>;
} {
  const tools: Array<{ name: string; handler: (...args: unknown[]) => Promise<unknown> }> = [];

  const server = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handlerOrAnn: unknown, maybeHandler?: unknown) => {
      const handler = typeof handlerOrAnn === "function" ? handlerOrAnn : maybeHandler;
      tools.push({ name, handler: handler ?? handlerOrAnn });
    }),
  } as unknown as McpServer;

  return { server, tools };
}

describe("registerEstimationTools", () => {
  it("registers 5 estimation tools", () => {
    const { server, tools } = createMockServer();
    registerEstimationTools(server);
    expect(tools.length).toBe(5);

    const names = tools.map(t => t.name);
    expect(names).toContain("pert_estimate");
    expect(names).toContain("cocomo_estimate");
    expect(names).toContain("sprint_forecast");
    expect(names).toContain("critical_path");
    expect(names).toContain("monte_carlo_schedule");
  });

  it("pert_estimate computes PERT correctly", async () => {
    const { server, tools } = createMockServer();
    registerEstimationTools(server);

    const pert = tools.find(t => t.name === "pert_estimate")!;
    const result = await pert.handler({
      optimistic: 2,
      most_likely: 4,
      pessimistic: 12,
      unit: "hours",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.expected).toBe(5);
    expect(data.unit).toBe("hours");
  });

  it("pert_estimate returns error for invalid inputs", async () => {
    const { server, tools } = createMockServer();
    registerEstimationTools(server);

    const pert = tools.find(t => t.name === "pert_estimate")!;
    const result = await pert.handler({
      optimistic: 10,
      most_likely: 5,
      pessimistic: 15,
      unit: "hours",
    });
    const response = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(response.isError).toBe(true);
  });

  it("cocomo_estimate returns effort estimates", async () => {
    const { server, tools } = createMockServer();
    registerEstimationTools(server);

    const cocomo = tools.find(t => t.name === "cocomo_estimate")!;
    const result = await cocomo.handler({
      kloc: 10,
      reasoning_complexity: 1.0,
      context_completeness: 1.0,
      transformation_impact: 1.0,
      iterative_cycles: 1.0,
      human_oversight: 1.0,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.personMonthsNominal).toBeGreaterThan(0);
    expect(data.personMonthsLlmAdjusted).toBeGreaterThan(0);
    expect(data.effortMultipliers).toBeDefined();
  });

  it("sprint_forecast returns sprint data", async () => {
    const { server, tools } = createMockServer();
    registerEstimationTools(server);

    const sprint = tools.find(t => t.name === "sprint_forecast")!;
    const result = await sprint.handler({
      backlog_points: 100,
      velocity_history: [20, 25, 22, 23],
      sprint_length_days: 14,
      hours_per_sprint: 300,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.averageVelocity).toBeDefined();
    expect(data.requiredSprints).toBeGreaterThan(0);
    expect(data.completionDays).toBeGreaterThan(0);
  });

  it("critical_path computes path", async () => {
    const { server, tools } = createMockServer();
    registerEstimationTools(server);

    const cp = tools.find(t => t.name === "critical_path")!;
    const result = await cp.handler({
      tasks: [
        { name: "A", duration: 3, predecessors: [] },
        { name: "B", duration: 5, predecessors: ["A"] },
      ],
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.total_duration).toBe(8);
    expect(data.critical_path).toEqual(["A", "B"]);
  });

  it("monte_carlo_schedule returns percentiles", async () => {
    const { server, tools } = createMockServer();
    registerEstimationTools(server);

    const mc = tools.find(t => t.name === "monte_carlo_schedule")!;
    const result = await mc.handler({
      tasks: [
        { name: "T1", optimistic: 1, most_likely: 3, pessimistic: 8 },
      ],
      iterations: 1000,
      seed: 42,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.p10).toBeDefined();
    expect(data.p50).toBeDefined();
    expect(data.p95).toBeDefined();
    expect(parseFloat(data.p10)).toBeLessThan(parseFloat(data.p95));
  });
});
