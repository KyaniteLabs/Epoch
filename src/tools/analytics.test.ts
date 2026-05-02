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
  it("registers 7 analytics tools", () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);
    expect(tools.length).toBe(7);

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

  it("compare_models returns model comparison", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const compare = tools.find(t => t.name === "compare_models")!;
    const result = await compare.handler({
      tokens: 50000,
      tool_calls: 5,
      reasoning_depth: "moderate",
      sort_by: "cost",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.models).toBeDefined();
    expect(Array.isArray(data.models)).toBe(true);
    expect(data.models.length).toBeGreaterThan(0);
    expect(data.models[0]).toHaveProperty("model");
    expect(data.models[0]).toHaveProperty("estimatedSeconds");
    expect(data.models[0]).toHaveProperty("estimatedCost");
    expect(data.models[0]).toHaveProperty("qualityTier");
  });

  it("accuracy_trend returns trend data", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const trend = tools.find(t => t.name === "accuracy_trend")!;
    const result = await trend.handler({
      window_size: 50,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.overallTrend).toBeDefined();
    expect(data.industryBaselineMape).toBeGreaterThan(0);
    expect(data.totalEstimates).toBeGreaterThanOrEqual(0);
    expect(data.humanReadable).toBeDefined();
  });

  it("accuracy_trend with team_id returns team data", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const trend = tools.find(t => t.name === "accuracy_trend")!;
    const result = await trend.handler({
      team_id: "team-bravo",
      window_size: 20,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.overallTrend).toBeDefined();
  });

  it("schedule_risk returns risk assessment", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const risk = tools.find(t => t.name === "schedule_risk")!;
    const result = await risk.handler({
      estimated_hours: 40,
      task_type: "feature",
      team_id: "team-alpha",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.riskLevel).toBeDefined();
    expect(data.confidenceIntervals.p50).toBeGreaterThan(0);
    expect(data.confidenceIntervals.p80).toBeGreaterThanOrEqual(data.confidenceIntervals.p50);
    expect(data.confidenceIntervals.p95).toBeGreaterThanOrEqual(data.confidenceIntervals.p80);
    expect(data.historicalAccuracy.mape).toBeGreaterThan(0);
    expect(data.recommendation).toBeDefined();
  });

  it("schedule_risk with minimal inputs returns assessment", async () => {
    const { server, tools } = createMockServer();
    registerAnalyticsTools(server);

    const risk = tools.find(t => t.name === "schedule_risk")!;
    const result = await risk.handler({
      estimated_hours: 8,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.confidenceIntervals.p50).toBeGreaterThan(0);
    expect(data.riskLevel).toBeDefined();
  });
});
