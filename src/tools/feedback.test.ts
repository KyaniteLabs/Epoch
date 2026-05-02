import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

vi.mock("../lib/feedback.js", () => ({
  recordActual: vi.fn(() => true),
  getPendingEstimates: vi.fn(() => []),
}));

import { registerFeedbackTools } from "./feedback.js";

// ---------------------------------------------------------------------------
// Tool Registration Tests — Feedback (record_actual, get_pending_estimates)
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

describe("registerFeedbackTools", () => {
  it("registers 2 feedback tools", () => {
    const { server, tools } = createMockServer();
    registerFeedbackTools(server);
    expect(tools.length).toBe(2);

    const names = tools.map(t => t.name);
    expect(names).toContain("record_actual");
    expect(names).toContain("get_pending_estimates");
  });

  // ---- record_actual ----

  it("record_actual returns recorded true on success", async () => {
    const { server, tools } = createMockServer();
    registerFeedbackTools(server);

    const rec = tools.find(t => t.name === "record_actual")!;
    const result = await rec.handler({
      estimate_id: "abc-123",
      actual_hours: 5.5,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.recorded).toBe(true);
    expect(data.estimate_id).toBe("abc-123");
    expect(data.actual_hours).toBe(5.5);
    expect(data.message).toBeDefined();
  });

  it("record_actual passes optional notes", async () => {
    const { server, tools } = createMockServer();
    registerFeedbackTools(server);

    const rec = tools.find(t => t.name === "record_actual")!;
    const result = await rec.handler({
      estimate_id: "xyz-789",
      actual_hours: 3,
      notes: "Scope creep added extra work",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.recorded).toBe(true);
    expect(data.estimate_id).toBe("xyz-789");
  });

  it("record_actual returns recorded false when lib returns false", async () => {
    const { recordActual } = await import("../lib/feedback.js");
    vi.mocked(recordActual).mockReturnValueOnce(false);

    const { server, tools } = createMockServer();
    registerFeedbackTools(server);

    const rec = tools.find(t => t.name === "record_actual")!;
    const result = await rec.handler({
      estimate_id: "fail-case",
      actual_hours: 1,
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.recorded).toBe(false);
  });

  // ---- get_pending_estimates ----

  it("get_pending_estimates returns empty list", async () => {
    const { server, tools } = createMockServer();
    registerFeedbackTools(server);

    const pend = tools.find(t => t.name === "get_pending_estimates")!;
    const result = await pend.handler({ limit: 20 });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.count).toBe(0);
    expect(data.estimates).toEqual([]);
  });

  it("get_pending_estimates returns pending estimates", async () => {
    const { getPendingEstimates } = await import("../lib/feedback.js");
    vi.mocked(getPendingEstimates).mockReturnValueOnce([
      { id: "e1", tool: "pert_estimate", inputs: {}, outputs: {}, estimatedAt: "2025-01-01T00:00:00Z", hasActual: false },
      { id: "e2", tool: "cocomo_estimate", inputs: {}, outputs: {}, estimatedAt: "2025-01-02T00:00:00Z", hasActual: false },
    ]);

    const { server, tools } = createMockServer();
    registerFeedbackTools(server);

    const pend = tools.find(t => t.name === "get_pending_estimates")!;
    const result = await pend.handler({ limit: 10 });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0]!.text);
    expect(data.count).toBe(2);
    expect(data.estimates[0]!.id).toBe("e1");
    expect(data.estimates[1]!.id).toBe("e2");
  });

  it("get_pending_estimates uses default limit", async () => {
    const { getPendingEstimates } = await import("../lib/feedback.js");
    vi.mocked(getPendingEstimates).mockImplementationOnce((limit?: number) => {
      expect(limit).toBe(20);
      return [];
    });

    const { server, tools } = createMockServer();
    registerFeedbackTools(server);

    const pend = tools.find(t => t.name === "get_pending_estimates")!;
    await pend.handler({ limit: 20 });
  });
});
