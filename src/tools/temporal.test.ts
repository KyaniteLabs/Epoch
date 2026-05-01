import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerTemporalTools } from "./temporal.js";

// ---------------------------------------------------------------------------
// Tool Registration Tests — Layer 1 & 2 (Temporal + Calendar)
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

describe("registerTemporalTools", () => {
  it("registers 6 temporal tools", () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);
    expect(tools.length).toBe(6);

    const names = tools.map(t => t.name);
    expect(names).toContain("get_current_time");
    expect(names).toContain("convert_timezone");
    expect(names).toContain("parse_duration");
    expect(names).toContain("time_math");
    expect(names).toContain("add_business_days");
    expect(names).toContain("count_business_days");
  });

  it("get_current_time returns valid time data", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const getTime = tools.find(t => t.name === "get_current_time");
    expect(getTime).toBeDefined();

    const result = await getTime!.handler({ timezone: "UTC" });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.timezone).toBe("UTC");
    expect(data.iso).toBeDefined();
  });

  it("get_current_time returns error for invalid timezone", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const getTime = tools.find(t => t.name === "get_current_time")!;
    const result = await getTime.handler({ timezone: "Invalid/TZ" });
    const response = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(response.isError).toBe(true);
  });

  it("convert_timezone converts correctly", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const convert = tools.find(t => t.name === "convert_timezone")!;
    const result = await convert.handler({
      timestamp: "2026-05-01T12:00:00Z",
      target_tz: "America/Los_Angeles",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.timezone).toBe("America/Los_Angeles");
  });

  it("parse_duration parses valid durations", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const parse = tools.find(t => t.name === "parse_duration")!;
    const result = await parse.handler({ duration_string: "2h30m" });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.totalSeconds).toBe(9000);
  });

  it("time_math add_days operation works", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const math = tools.find(t => t.name === "time_math")!;
    const result = await math.handler({
      operation: "add_days",
      operands: { date: "2026-05-01", days: 5 },
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.date).toBe("2026-05-06");
  });

  it("time_math diff operation works", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const math = tools.find(t => t.name === "time_math")!;
    const result = await math.handler({
      operation: "diff",
      operands: { date: "2026-05-01T00:00:00Z", end_date: "2026-05-03T00:00:00Z" },
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.total_seconds).toBe(172800);
  });

  it("time_math format_duration works", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const math = tools.find(t => t.name === "time_math")!;
    const result = await math.handler({
      operation: "format_duration",
      operands: { milliseconds: 3600000 },
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.formatted).toBe("1h");
  });

  it("time_math returns error for missing operands", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const math = tools.find(t => t.name === "time_math")!;
    const result = await math.handler({
      operation: "add_days",
      operands: {},
    });
    const response = result as { content: Array<{ type: string; text: string }>; isError?: boolean };
    expect(response.isError).toBe(true);
  });

  it("add_business_days returns a result", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const add = tools.find(t => t.name === "add_business_days")!;
    const result = await add.handler({
      start_date: "2026-05-04",
      days: 5,
      country: "US",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.endDate ?? data.result).toBeDefined();
  });

  it("count_business_days returns a result", async () => {
    const { server, tools } = createMockServer();
    registerTemporalTools(server);

    const count = tools.find(t => t.name === "count_business_days")!;
    const result = await count.handler({
      start_date: "2026-05-04",
      end_date: "2026-05-08",
      country: "US",
    });
    const response = result as { content: Array<{ type: string; text: string }> };
    const data = JSON.parse(response.content[0].text);
    expect(data.businessDays).toBeDefined();
  });
});
