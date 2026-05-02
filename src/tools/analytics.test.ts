import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAnalyticsTools } from "./analytics.js";

// ---------------------------------------------------------------------------
// Tool Registration Tests — Layer 4-5 (Analytics)
// ---------------------------------------------------------------------------

type MockHandler = (args: Record<string, unknown>) => Promise<unknown>;

function createMockServer(): {
  server: McpServer;
  tools: Array<{ name: string; handler: MockHandler }>;
} {
  const tools: Array<{ name: string; handler: MockHandler }> = [];

  const server = {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handlerOrAnn: unknown, maybeHandler?: unknown) => {
      const fn = typeof handlerOrAnn === "function" ? handlerOrAnn : maybeHandler;
      tools.push({ name, handler: (fn ?? handlerOrAnn) as MockHandler });
    }),
  } as unknown as McpServer;

  return { server, tools };
}

describe("registerAnalyticsTools", () => {
  it("registers 3 analytics tools", () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);
    expect(tools.length).toBe(3);

    const names = tools.map(t => t.name);
    expect(names).toContain("reference_class_estimate");
    expect(names).toContain("calibrate_estimates");
    expect(names).toContain("token_time_bridge");
  });

  it("reference_class_estimate returns estimate", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const ref = tools.find(t => t.name === "reference_class_estimate")!;
    const result = await ref.handler({
      task_type: "feature",
      complexity: 3,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const content = response.content[0]!;
    const data = JSON.parse(content.text);
    expect(data.rawEstimate).toBeGreaterThan(0);
    expect(data.correctedEstimate).toBeGreaterThan(0);
    expect(data.correctionFactor).toBeGreaterThan(1);
  });

  it("reference_class_estimate with team_id returns note", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const ref = tools.find(t => t.name === "reference_class_estimate")!;
    const result = await ref.handler({
      task_type: "bugfix",
      complexity: 2,
      team_id: "team-alpha",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.note).toBeDefined();
  });

  it("calibrate_estimates returns stub data", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const cal = tools.find(t => t.name === "calibrate_estimates")!;
    const result = await cal.handler({
      team_id: "team-a",
      period_days: 90,
      minimum_samples: 10,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.correction_factor).toBeGreaterThan(0);
    expect(data.recommendations.length).toBeGreaterThan(0);
  });

  it("token_time_bridge estimates wall-clock time", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const bridge = tools.find(t => t.name === "token_time_bridge")!;
    const result = await bridge.handler({
      tokens: 50000,
      model: "claude-sonnet-4-20250514",
      tool_calls: 10,
      reasoning_depth: "deep",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.estimatedSeconds).toBeGreaterThan(0);
    expect(data.estimatedMinutes).toBeGreaterThan(0);
    expect(data.confidence).toBe("likely");
    expect(data.model).toBe("claude-sonnet-4-20250514");
  });

  it("token_time_bridge handles unknown model", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const bridge = tools.find(t => t.name === "token_time_bridge")!;
    const result = await bridge.handler({
      tokens: 1000,
      model: "gpt-4o-mini",
      tool_calls: 0,
      reasoning_depth: "shallow",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.estimatedSeconds).toBeGreaterThan(0);
  });
});
