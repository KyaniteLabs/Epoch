import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

// Mock the MCP SDK
const registeredTools: Array<{ name: string; shape: unknown; annotations: unknown }> = [];
const mockServer = {
  tool: vi.fn((name: string, _desc: string, shape: unknown, annotations: unknown, _handler: unknown) => {
    registeredTools.push({ name, shape, annotations });
  }),
} as unknown as McpServer;

// Mock feedback and telemetry to prevent side effects
vi.mock("../lib/feedback.js", () => ({
  recordEstimate: vi.fn(() => "test-id"),
  recordActual: vi.fn(() => true),
  getPendingEstimates: vi.fn(() => []),
  batchRecordActuals: vi.fn(() => ({ total: 0, succeeded: 0, failed: 0, errors: [] })),
  getFeedbackHealthReport: vi.fn(() => ({
    totalEstimates: 0, totalActuals: 0, matchRate: 0,
    byTool: {}, byTaskType: {},
    selfImprovement: { readyTypes: [], callsUntilUpdate: 100 },
  })),
  getCalibrationData: vi.fn(() => []),
  matchEstimatesToActuals: vi.fn(() => []),
}));

vi.mock("../lib/telemetry.js", () => ({
  getTelemetry: vi.fn(() => ({ record: vi.fn(), getStats: vi.fn(() => []) })),
}));

vi.mock("../lib/self-improve.js", () => ({
  notifyToolCall: vi.fn(),
  getGlobalCorrectionFactor: vi.fn(() => 1.07),
  updateReferenceDatabase: vi.fn(() => Promise.resolve()),
}));

import { registerAllMcpTools } from "./mcp-adapter.js";
import { TOOL_REGISTRY } from "./tool-registry.js";

describe("registerAllMcpTools", () => {
  beforeEach(() => {
    registeredTools.length = 0;
    vi.mocked(mockServer.tool).mockClear();
  });

  it("registers all tools from TOOL_REGISTRY", () => {
    registerAllMcpTools(mockServer);
    expect(mockServer.tool).toHaveBeenCalledTimes(TOOL_REGISTRY.size);
    const names = registeredTools.map(t => t.name).sort();
    const expected = [...TOOL_REGISTRY.keys()].sort();
    expect(names).toEqual(expected);
  });

  it("extracts shape from schemas with ZodEffects (e.g., aiNativeGradient)", () => {
    registerAllMcpTools(mockServer);
    // pert_estimate uses aiNativeGradient which wraps in ZodEffects
    const pert = registeredTools.find(t => t.name === "pert_estimate");
    expect(pert).toBeDefined();
    expect(pert!.shape).toBeDefined();
    expect(typeof pert!.shape).toBe("object");
    // Shape should have the core fields, not undefined from failed extraction
    expect((pert!.shape as Record<string, unknown>).optimistic).toBeDefined();
    expect((pert!.shape as Record<string, unknown>).most_likely).toBeDefined();
  });

  it("marks write tools with write annotations", () => {
    registerAllMcpTools(mockServer);
    const recordActual = registeredTools.find(t => t.name === "record_actual");
    expect(recordActual).toBeDefined();
    expect(recordActual!.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  it("marks read-only tools with read annotations", () => {
    registerAllMcpTools(mockServer);
    const getCurrentTime = registeredTools.find(t => t.name === "get_current_time");
    expect(getCurrentTime).toBeDefined();
    expect(getCurrentTime!.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it("does not throw for any tool's schema extraction", () => {
    expect(() => registerAllMcpTools(mockServer)).not.toThrow();
    // Every tool should have a non-null shape
    for (const t of registeredTools) {
      expect(t.shape).toBeDefined();
      expect(t.shape).not.toBeNull();
    }
  });
});
