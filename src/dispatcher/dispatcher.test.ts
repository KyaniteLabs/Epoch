// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Tests
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { dispatch, listTools, TOOL_NAMES } from "./index.js";
import { defined } from "../test-support.js";

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

  it("includes feedbackRef in estimation responses", async () => {
    const result = await dispatch("pert_estimate", {
      optimistic: 2,
      most_likely: 4,
      pessimistic: 12,
      unit: "hours",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const data = result.data as { expected: number; feedbackRef?: string };
    expect(data.feedbackRef).toBeDefined();
    expect(typeof data.feedbackRef).toBe("string");
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

  describe("cocomo_estimate iterative_cycles normalization (W2 monotonicity fix)", () => {
    const normalizedCycles = async (iterativeCycles: number): Promise<number> => {
      const result = await dispatch("cocomo_estimate", {
        kloc: 10,
        iterative_cycles: iterativeCycles,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("cocomo_estimate failed");
      const multipliers = (result.data as { effortMultipliers: { iterative_cycles: number } }).effortMultipliers;
      return multipliers.iterative_cycles;
    };

    it("is monotonic non-decreasing over [0.5, 10] with no cliff at 2.0", async () => {
      const sweep = [0.5, 1, 1.5, 2, 2.01, 2.5, 3, 5, 8, 10];
      const values: number[] = [];
      for (const c of sweep) values.push(await normalizedCycles(c));
      for (let i = 1; i < values.length; i++) {
        expect(defined(values[i])).toBeGreaterThanOrEqual(defined(values[i - 1]));
      }
      // The old rule sent 2.0 -> 2.0 but 2.01 -> 1.201 (a ~40% drop).
      const atTwo = defined(values[3]);
      const justAbove = defined(values[4]);
      expect(atTwo).toBe(2);
      expect(justAbove).toBeGreaterThanOrEqual(atTwo);
      expect(justAbove - atTwo).toBeLessThan(0.05);
    });

    it("keeps the literal multiplier region <= 2.0 untouched", async () => {
      expect(await normalizedCycles(0.5)).toBe(0.5);
      expect(await normalizedCycles(1)).toBe(1);
      expect(await normalizedCycles(2)).toBe(2);
    });

    it("maps cycle counts above 2.0 at +0.1 per cycle anchored at 2.0", async () => {
      expect(await normalizedCycles(3)).toBeCloseTo(2.1, 10);
      expect(await normalizedCycles(10)).toBeCloseTo(2.8, 10);
    });
  });

  describe("monte_carlo_schedule target_hours wiring (W2 criticalPathProbability fix)", () => {
    const tasks = [
      { name: "design", optimistic: 2, most_likely: 4, pessimistic: 8 },
      { name: "build", optimistic: 5, most_likely: 10, pessimistic: 20 },
    ];

    it("returns criticalPathProbability: null when no deadline is supplied", async () => {
      const result = await dispatch("monte_carlo_schedule", { tasks, iterations: 2000, seed: 42 });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const data = result.data as { criticalPathProbability: number | null };
      expect(data.criticalPathProbability).toBeNull();
    });

    it("returns P(total <= target_hours) when a deadline is supplied", async () => {
      const impossible = await dispatch("monte_carlo_schedule", {
        tasks, iterations: 2000, seed: 42, target_hours: 8,
      });
      expect(impossible.ok).toBe(true);
      if (!impossible.ok) return;
      const tight = (impossible.data as { criticalPathProbability: number | null }).criticalPathProbability;
      expect(tight).not.toBeNull();
      expect(tight as number).toBeLessThanOrEqual(0.01);

      const loose = await dispatch("monte_carlo_schedule", {
        tasks, iterations: 2000, seed: 42, target_hours: 40 * 8,
      });
      expect(loose.ok).toBe(true);
      if (!loose.ok) return;
      const wide = (loose.data as { criticalPathProbability: number | null }).criticalPathProbability;
      expect(wide as number).toBeGreaterThanOrEqual(0.99);
    });

    it("rejects a non-positive target_hours", async () => {
      const result = await dispatch("monte_carlo_schedule", {
        tasks, iterations: 100, seed: 42, target_hours: -5,
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toContain("target_hours");
    });
  });
});

// ---------------------------------------------------------------------------
// listTools()
// ---------------------------------------------------------------------------

describe("listTools", () => {
  it("returns 25 tools", () => {
    const tools = listTools();
    expect(tools).toHaveLength(25);
  });

  it("each tool has name and description", () => {
    const tools = listTools();
    for (const t of tools) {
      expect(t.name).toBeTruthy();
      expect(t.description).toBeTruthy();
    }
  });

  it("describes routing boundaries for similar MCP tools", () => {
    const descriptions = Object.fromEntries(
      listTools().map((tool) => [tool.name, tool.description.toLowerCase()]),
    );

    expect(descriptions.time_math).toContain("single-purpose");
    expect(descriptions.time_math).toContain("get_current_time");
    expect(descriptions.time_math).toContain("convert_timezone");
    expect(descriptions.token_time_bridge).toContain("use token_cost_estimate");
    expect(descriptions.token_cost_estimate).toContain("use token_time_bridge");
    expect(descriptions.cocomo_validate).toContain("use cocomo_ground_truth");
    expect(descriptions.cocomo_ground_truth).toContain("use cocomo_validate");
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
    expect(TOOL_NAMES.has("cocomo_ground_truth")).toBe(true);
    expect(TOOL_NAMES.has("batch_record_actuals")).toBe(true);
    expect(TOOL_NAMES.has("feedback_health")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Input safety bounds (W1) — bounded-latency rejections
// ---------------------------------------------------------------------------
//
// An uncapped `days` walks the business-day calendar day-by-day (1e9 days =
// indefinite event-loop hang), and oversized task arrays / iteration products
// monopolize the CPU. Every rejection below must return immediately (the
// elapsed-time assertions make "returns an error" mean "returns it fast"),
// with an actionable message.

describe("input safety bounds (W1)", () => {
  it("rejects add_business_days days=1e9 immediately with a clear error (no hang)", async () => {
    const start = performance.now();
    const result = await dispatch("add_business_days", {
      start_date: "2026-05-01",
      days: 1e9,
      country: "US",
    });
    const elapsedMs = performance.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("100000");
    expect(result.error.retryHint).toBeTruthy();
    // Bounded latency: schema rejection, not a day-by-day walk.
    expect(elapsedMs).toBeLessThan(500);
  });

  it("rejects add_business_days days=-1e9 immediately", async () => {
    const start = performance.now();
    const result = await dispatch("add_business_days", {
      start_date: "2026-05-01",
      days: -1e9,
    });
    const elapsedMs = performance.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("-100000");
    expect(elapsedMs).toBeLessThan(500);
  });

  it("rejects non-integer days on add_business_days", async () => {
    const result = await dispatch("add_business_days", {
      start_date: "2026-05-01",
      days: 2.5,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("whole number");
  });

  it("still accepts legitimate add_business_days calls at the cap boundary", async () => {
    const result = await dispatch("add_business_days", {
      start_date: "2026-05-01",
      days: 10,
      country: "US",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects critical_path with 501 tasks fast (schema cap)", async () => {
    const tasks = Array.from({ length: 501 }, (_, i) => ({
      name: `T${i}`,
      duration: 2,
      predecessors: [],
    }));
    const start = performance.now();
    const result = await dispatch("critical_path", { tasks });
    const elapsedMs = performance.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("500");
    expect(elapsedMs).toBeLessThan(500);
  });

  it("rejects monte_carlo_schedule when iterations × tasks exceeds 10,000,000, suggesting lower iterations", async () => {
    // 200 tasks × 100,000 iterations = 20,000,000 sampled durations — each
    // factor is individually within its schema cap, only the product trips.
    const tasks = Array.from({ length: 200 }, (_, i) => ({
      name: `T${i}`,
      optimistic: 1,
      most_likely: 2,
      pessimistic: 3,
    }));
    const start = performance.now();
    const result = await dispatch("monte_carlo_schedule", {
      tasks,
      iterations: 100000,
    });
    const elapsedMs = performance.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("20,000,000");
    expect(result.error.message).toContain("10,000,000");
    // Actionable: the retry hint names a workable iteration count.
    expect(result.error.retryHint).toContain("50,000");
    expect(elapsedMs).toBeLessThan(500);
  });

  it("accepts monte_carlo_schedule under the iterations × tasks product cap", async () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      name: `T${i}`,
      optimistic: 1,
      most_likely: 2,
      pessimistic: 3,
    }));
    const result = await dispatch("monte_carlo_schedule", {
      tasks,
      iterations: 20000,
    });
    expect(result.ok).toBe(true);
  });

  it("rejects estimate_from_context with a context over 50,000 characters fast", async () => {
    const start = performance.now();
    const result = await dispatch("estimate_from_context", {
      context: "x".repeat(50001),
    });
    const elapsedMs = performance.now() - start;

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("50000");
    expect(elapsedMs).toBeLessThan(500);
  });

  it("time_math rejects a numeric country with a clear error instead of toUpperCase failing", async () => {
    const result = await dispatch("time_math", {
      operation: "add_business_days",
      operands: { start_date: "2026-05-01", days: 5, country: 1 },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("country must be a 2-letter ISO-3166 country code string");
    expect(result.error.message).not.toContain("toUpperCase");
  });

  it("time_math rejects out-of-bounds days operands with a clear error", async () => {
    for (const operation of ["add_days", "add_business_days"] as const) {
      const result = await dispatch("time_math", {
        operation,
        operands: { start_date: "2026-05-01", days: 1e9 },
      });
      expect(result.ok, operation).toBe(false);
      if (result.ok) continue;
      expect(result.error.message).toContain("100000");
    }
  });

  it("time_math rejects non-numeric days and milliseconds operands", async () => {
    const badDays = await dispatch("time_math", {
      operation: "add_days",
      operands: { start_date: "2026-05-01", days: "next week" },
    });
    expect(badDays.ok).toBe(false);
    if (!badDays.ok) {
      expect(badDays.error.message).toContain("finite number");
    }

    const badMs = await dispatch("time_math", {
      operation: "format_duration",
      operands: { milliseconds: "soon" },
    });
    expect(badMs.ok).toBe(false);
    if (!badMs.ok) {
      expect(badMs.error.message).toContain("finite number");
    }
  });
});
