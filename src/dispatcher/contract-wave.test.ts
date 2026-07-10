// ---------------------------------------------------------------------------
// Phase 3 contract wave — end-to-end acceptance tests
// ---------------------------------------------------------------------------
//
// Proves, against a real (temp) EPOCH_DATA_DIR via dispatch():
//   1. pert_estimate's provenance-output key-set delta vs the pre-wave shape
//      is exactly {rawEstimate, correctionFactor, n} (additive-only).
//   2. Optional task_label/project/session_id/complexity inputs round-trip:
//      absent by default, persisted verbatim on the estimate row when
//      supplied.
//   3. task_label surfaces on get_pending_estimates output when present.
//   4. record_actual's unit + calibration_provenance wire through to the
//      persisted actual record (unit normalizes actual_hours; provenance is
//      readable by the shared exclusion predicate via classifyCalibrationRecord).
//   5. estimate_from_context returns the documented not-implemented shape.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 3.

import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatch } from "./index.js";
import type { ToolResult } from "../types/index.js";
import { defined } from "../test-support.js";

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-contract-wave-test-"));
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

function readJsonl(filename: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(join(tempDataDir, filename), "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  } catch {
    return [];
  }
}

async function ok(toolName: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result: ToolResult<unknown> = await dispatch(toolName, input);
  if (!result.ok) throw new Error(`${toolName} returned an error: ${result.error.message}`);
  return result.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// 1. pert_estimate provenance-output key-set delta
// ---------------------------------------------------------------------------

describe("pert_estimate — provenance-output key-set delta (Phase 3 contract wave)", () => {
  // Exact key set pert_estimate produced pre-wave (v0.2.9-style call, no new
  // fields, EPOCH_PERT_LEARNED_CORRECTION off). Locks the "additive only"
  // acceptance criterion.
  const PRE_WAVE_KEYS = [
    "optimistic", "mostLikely", "pessimistic", "expected", "variance",
    "stdDeviation", "confidence95", "confidence99", "unit", "urgencyCategory",
    "riskLevel", "humanReadable", "developerProfile", "adjustedEstimate",
    "feedbackRef",
  ].sort();

  it("the only key-set delta vs the pre-wave shape is {rawEstimate, correctionFactor, n}", async () => {
    const data = await ok("pert_estimate", { optimistic: 2, most_likely: 4, pessimistic: 12, unit: "hours" });

    const keys = Object.keys(data).sort();
    const added = keys.filter((k) => !PRE_WAVE_KEYS.includes(k)).sort();
    const removed = PRE_WAVE_KEYS.filter((k) => !keys.includes(k));

    expect(added).toEqual(["correctionFactor", "n", "rawEstimate"]);
    expect(removed).toEqual([]);
  });

  it("existing v0.2.9-style calls (no new fields, flag off) are byte-identical on shared keys, with documented additive defaults", async () => {
    const data = await ok("pert_estimate", { optimistic: 2, most_likely: 4, pessimistic: 12, unit: "hours" });

    expect(data["expected"]).toBe(5);
    expect(data["rawEstimate"]).toBe(5); // pre-correction headline === expected
    expect(data["correctionFactor"]).toBe(1.0); // learned-correction flag off by default
    expect(data["n"]).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 2 + 3. task_label/project/session_id/complexity round-trip + pending surfacing
// ---------------------------------------------------------------------------

describe("optional provenance inputs — round-trip through dispatch() (Phase 3 contract wave)", () => {
  it("task_label/project/session_id/complexity are absent by default and persisted verbatim when supplied", async () => {
    await ok("pert_estimate", { optimistic: 2, most_likely: 4, pessimistic: 12 });
    await ok("pert_estimate", {
      optimistic: 2, most_likely: 4, pessimistic: 12,
      task_label: "EPOCH-142", project: "epoch", session_id: "sess-abc123", complexity: 4,
    });

    const rows = readJsonl("estimates.jsonl");
    expect(rows).toHaveLength(2);

    const [withoutFields, withFields] = rows as [Record<string, unknown>, Record<string, unknown>];
    const withoutInputs = withoutFields["inputs"] as Record<string, unknown>;
    const withInputs = withFields["inputs"] as Record<string, unknown>;

    expect(withoutInputs["task_label"]).toBeUndefined();
    expect(withoutInputs["project"]).toBeUndefined();
    expect(withoutInputs["session_id"]).toBeUndefined();
    expect(withoutInputs["complexity"]).toBeUndefined();

    expect(withInputs["task_label"]).toBe("EPOCH-142");
    expect(withInputs["project"]).toBe("epoch");
    expect(withInputs["session_id"]).toBe("sess-abc123");
    expect(withInputs["complexity"]).toBe(4);
  });

  it("get_pending_estimates surfaces task_label when present and omits it when absent", async () => {
    await ok("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 4 });
    await ok("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 4, task_label: "EPOCH-7" });

    const pending = await ok("get_pending_estimates", { limit: 20 });
    const estimates = pending["estimates"] as Array<Record<string, unknown>>;
    expect(estimates).toHaveLength(2);
    expect(estimates[0]).not.toHaveProperty("task_label");
    expect(defined(estimates[1])["task_label"]).toBe("EPOCH-7");
  });

  it("rejects a wrongly-typed session_id at the schema boundary", async () => {
    const result = await dispatch("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 4, session_id: 12345 });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. record_actual unit + calibration_provenance wiring
// ---------------------------------------------------------------------------

describe("record_actual — unit + calibration_provenance wiring (Phase 3 contract wave)", () => {
  it("normalizes actual_hours through the supplied unit before persisting", async () => {
    const pending = await ok("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 4 });
    const estimateId = pending["feedbackRef"] as string;

    await ok("record_actual", { estimate_id: estimateId, actual_hours: 120, unit: "minutes" });

    const actuals = readJsonl("feedback.jsonl");
    expect(actuals).toHaveLength(1);
    expect(defined(actuals[0])["actualHours"]).toBe(2); // 120 minutes -> 2 hours
  });

  it("persists calibration_provenance on the actual record", async () => {
    const pending = await ok("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 4 });
    const estimateId = pending["feedbackRef"] as string;

    await ok("record_actual", { estimate_id: estimateId, actual_hours: 3, calibration_provenance: "backfilled_calibration" });

    const actuals = readJsonl("feedback.jsonl");
    expect(defined(actuals[0])["calibrationProvenance"]).toBe("backfilled_calibration");
  });

  it("a 'synthetic' calibration_provenance is honored by the shared exclusion predicate", async () => {
    const pending = await ok("pert_estimate", { optimistic: 1, most_likely: 2, pessimistic: 4 });
    const estimateId = pending["feedbackRef"] as string;

    await ok("record_actual", { estimate_id: estimateId, actual_hours: 3, calibration_provenance: "synthetic" });

    const health = await ok("feedback_health", {});
    // The matched pair is excluded from correction-eligible calibration math.
    expect(health["matchedPairs"]).toBe(0);
    expect((health["seedRecordsFiltered"] as number)).toBeGreaterThanOrEqual(1);
  });

  it("rejects an invalid unit at the schema boundary", async () => {
    const result = await dispatch("record_actual", { estimate_id: "does-not-matter", actual_hours: 3, unit: "fortnights" });
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. estimate_from_context (registered Phase 3; logic lands Phase 5)
// ---------------------------------------------------------------------------

describe("estimate_from_context — registered stub (Phase 3 contract wave)", () => {
  it("returns a structured not-implemented response", async () => {
    const data = await ok("estimate_from_context", { context: "Fix a null pointer exception in the login flow." });
    expect(data["implemented"]).toBe(false);
    expect(data["plannedPhase"]).toBe(5);
    expect(data["tool"]).toBe("estimate_from_context");
    expect(typeof data["message"]).toBe("string");
  });

  it("does not join the estimates ledger (non-estimation telemetry)", async () => {
    await ok("estimate_from_context", { context: "Fix a null pointer exception in the login flow." });
    expect(readJsonl("estimates.jsonl")).toHaveLength(0);
    expect(readJsonl("tool-calls.jsonl")).toHaveLength(1);
  });

  it("rejects a missing context at the schema boundary", async () => {
    const result = await dispatch("estimate_from_context", {});
    expect(result.ok).toBe(false);
  });
});
