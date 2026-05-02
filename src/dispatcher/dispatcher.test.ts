// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { dispatch, listTools, TOOL_NAMES } from "./index.js";

// ---------------------------------------------------------------------------
// dispatch()
// ---------------------------------------------------------------------------

describe("dispatch", () => {
  it("dispatches pert_estimate with valid input", async () => {
    const result = await dispatch("pert_estimate", {
      optimistic: 2,
      most_likely: 4,
      pessimistic: 12,
      unit: "hours",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // PERT expected = (2 + 4*4 + 12) / 6 = 30/6 = 5
    const data = result.data as { expected: number };
    expect(data.expected).toBe(5);
  });

  it("includes feedbackToken in estimation responses", async () => {
    const result = await dispatch("pert_estimate", {
      optimistic: 2,
      most_likely: 4,
      pessimistic: 12,
      unit: "hours",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.data as { expected: number; feedbackToken?: string };
    expect(data.feedbackToken).toBeDefined();
    expect(typeof data.feedbackToken).toBe("string");
  });

  it("rejects pert_estimate with invalid input (optimistic > most_likely)", async () => {
    const result = await dispatch("pert_estimate", {
      optimistic: 10,
      most_likely: 4,
      pessimistic: 12,
      unit: "hours",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("most_likely");
  });

  it("returns error for unknown tool", async () => {
    const result = await dispatch("nonexistent_tool", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Unknown tool");
  });

  it("dispatches monte_carlo_schedule with tasks", async () => {
    const result = await dispatch("monte_carlo_schedule", {
      tasks: [
        {
          name: "design",
          optimistic: 2,
          most_likely: 4,
          pessimistic: 8,
          predecessors: [],
        },
        {
          name: "build",
          optimistic: 5,
          most_likely: 10,
          pessimistic: 20,
          predecessors: ["design"],
        },
      ],
      iterations: 5000,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveProperty("p50");
    expect(result.data).toHaveProperty("p95");
  });

  it("dispatches add_business_days with valid input", async () => {
    const result = await dispatch("add_business_days", {
      start_date: "2026-05-01",
      days: 5,
      country_code: "US",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toHaveProperty("endDate");
    expect(result.data).toHaveProperty("businessDays");
  });
});

// ---------------------------------------------------------------------------
// listTools()
// ---------------------------------------------------------------------------

describe("listTools", () => {
  it("returns 21 tools", () => {
    const tools = listTools();
    expect(tools).toHaveLength(21);
  });

  it("each tool has name and description", () => {
    const tools = listTools();
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });
});

// ---------------------------------------------------------------------------
// TOOL_NAMES
// ---------------------------------------------------------------------------

describe("TOOL_NAMES", () => {
  it("contains expected tool names", () => {
    expect(TOOL_NAMES.has("pert_estimate")).toBe(true);
    expect(TOOL_NAMES.has("get_current_time")).toBe(true);
    expect(TOOL_NAMES.has("monte_carlo_schedule")).toBe(true);
    expect(TOOL_NAMES.has("add_business_days")).toBe(true);
    expect(TOOL_NAMES.has("token_time_bridge")).toBe(true);
    expect(TOOL_NAMES.has("calibrate_estimates")).toBe(true);
  });
});
