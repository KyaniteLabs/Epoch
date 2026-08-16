// ---------------------------------------------------------------------------
// Feedback contract matrix (remediation ticket 04)
// ---------------------------------------------------------------------------
//
// Proves, against a real (temp) EPOCH_DATA_DIR via dispatch() — the same
// seam/fixture style as contract-wave.test.ts — that EVERY estimation tool's
// feedbackRef is accepted by record_actual:
//
//   estimate tool -> feedbackRef -> record_actual -> ok
//
// This is the end-to-end restoration of the estimate-vs-actual feedback
// contract: estimate_from_context estimates could previously never receive
// actuals (its tool name was missing from the canonical set, so
// record_actual failed with unknown_tool surfaced as "Unknown error.").
//
// The matrix is driven by the AUTHORITATIVE estimation partition
// (src/lib/tool-aliases.ts ESTIMATION_TOOL_NAMES) with one minimal valid
// input fixture per tool, so a newly added estimation tool fails this suite
// until it gets a fixture row — the contract can't silently regress to
// "most tools" again.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatch } from "./index.js";
import { ESTIMATION_TOOL_NAMES } from "../lib/tool-aliases.js";
import { defined } from "../test-support.js";

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-feedback-contract-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env["EPOCH_DATA_DIR"];
  } else {
    process.env["EPOCH_DATA_DIR"] = previousDataDir;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});

/** Minimal valid dispatch input for every estimation tool (schema-valid, fast). */
const MINIMAL_ESTIMATE_INPUTS: Record<string, Record<string, unknown>> = {
  pert_estimate: { optimistic: 2, most_likely: 4, pessimistic: 12, unit: "hours" },
  reference_class_estimate: { task_type: "feature", complexity: 3 },
  cocomo_estimate: { kloc: 5 },
  sprint_forecast: { backlog_points: 20, velocity_history: [8, 10, 12] },
  critical_path: { tasks: [{ name: "A", duration: 3, predecessors: [] }] },
  monte_carlo_schedule: {
    tasks: [{ name: "A", optimistic: 1, most_likely: 2, pessimistic: 5 }],
    iterations: 200,
    seed: 42,
  },
  token_time_bridge: { tokens: 50_000, model: "test-model" },
  schedule_risk: { estimated_hours: 8 },
  estimate_from_context: { context: "Fix a null pointer exception in the login flow." },
};

/** Actual hours to record per tool, chosen to keep actual/estimate ratios ordinary. */
const ACTUAL_HOURS: Record<string, number> = {
  ...Object.fromEntries(Object.keys(MINIMAL_ESTIMATE_INPUTS).map((tool) => [tool, 2])),
  token_time_bridge: 0.2, // estimate is in seconds — keep the ratio non-suspect
};

// ---------------------------------------------------------------------------
// The contract matrix: all 9 estimation tools
// ---------------------------------------------------------------------------

describe("feedback contract matrix — every estimation tool's feedbackRef is accepted by record_actual", () => {
  it("the matrix covers the entire authoritative estimation partition", () => {
    expect([...ESTIMATION_TOOL_NAMES].sort()).toEqual(Object.keys(MINIMAL_ESTIMATE_INPUTS).sort());
  });

  it.each([...ESTIMATION_TOOL_NAMES])("%s -> feedbackRef -> record_actual returns ok", async (tool) => {
    const input = defined(
      MINIMAL_ESTIMATE_INPUTS[tool],
      `No minimal input fixture for estimation tool ${tool} — add one so the feedback-contract matrix covers it`,
    );

    // 1. Dispatch the estimate through the real registry seam.
    const estimate = await dispatch(tool, input);
    expect(estimate.ok).toBe(true);
    if (!estimate.ok) throw new Error(`${tool} returned an error: ${estimate.error.message}`);

    // 2. The estimate carries a feedbackRef (it joined the estimates ledger).
    const feedbackRef = (estimate.data as Record<string, unknown>)["feedbackRef"];
    expect(typeof feedbackRef).toBe("string");

    // 3. record_actual accepts that feedbackRef — the feedback contract holds.
    const actual = await dispatch("record_actual", {
      estimate_id: feedbackRef,
      actual_hours: defined(ACTUAL_HOURS[tool]),
    });
    expect(actual.ok).toBe(true);
    if (actual.ok) {
      expect((actual.data as Record<string, unknown>)["recorded"]).toBe(true);
      expect((actual.data as Record<string, unknown>)["estimate_id"]).toBe(feedbackRef);
    }
  });

  it("recording a second actual for the same feedbackRef fails with duplicate, not Unknown error", async () => {
    const estimate = await dispatch("estimate_from_context", {
      context: "Fix a null pointer exception in the login flow.",
    });
    expect(estimate.ok).toBe(true);
    if (!estimate.ok) return;
    const feedbackRef = (estimate.data as Record<string, unknown>)["feedbackRef"] as string;

    const first = await dispatch("record_actual", { estimate_id: feedbackRef, actual_hours: 2 });
    expect(first.ok).toBe(true);

    const second = await dispatch("record_actual", { estimate_id: feedbackRef, actual_hours: 3 });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.error.message).not.toBe("Unknown error.");
      expect(second.error.message).toContain("already exists");
    }
  });
});

// ---------------------------------------------------------------------------
// Ticket 04 acceptance: estimate_from_context specifically
// ---------------------------------------------------------------------------

describe("estimate_from_context — feedback loop restored", () => {
  it("record_actual against an estimate_from_context feedbackRef returns ok", async () => {
    const estimate = await dispatch("estimate_from_context", {
      context: "Fix a null pointer exception in the login flow.",
    });
    expect(estimate.ok).toBe(true);
    if (!estimate.ok) return;

    const feedbackRef = (estimate.data as Record<string, unknown>)["feedbackRef"];
    expect(typeof feedbackRef).toBe("string");

    const result = await dispatch("record_actual", {
      estimate_id: feedbackRef,
      actual_hours: 2,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)["recorded"]).toBe(true);
    }
  });

  it("batch_record_actuals accepts an estimate_from_context feedbackRef and reports per-entry reasons on failure", async () => {
    const estimate = await dispatch("estimate_from_context", {
      context: "Refactor the authentication middleware to support scoped tokens.",
    });
    expect(estimate.ok).toBe(true);
    if (!estimate.ok) return;
    const feedbackRef = (estimate.data as Record<string, unknown>)["feedbackRef"] as string;

    const batch = await dispatch("batch_record_actuals", {
      entries: [
        { estimate_id: feedbackRef, actual_hours: 3 },
        { estimate_id: "seed-synthetic-id", actual_hours: 1 }, // synthetic prefix -> per-entry reason
      ],
    });
    expect(batch.ok).toBe(true);
    if (batch.ok) {
      const data = batch.data as Record<string, unknown>;
      expect(data["succeeded"]).toBe(1);
      expect(data["failed"]).toBe(1);
      const errors = data["errors"] as string[];
      expect(defined(errors[0])).toContain("reason: synthetic_id");
    }
  });
});
