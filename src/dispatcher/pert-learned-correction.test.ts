// ---------------------------------------------------------------------------
// pert_estimate handler — PERT learned-correction wiring (Phase 1 Task 0)
// ---------------------------------------------------------------------------
//
// Exercises the tool-registry pert_estimate handler directly (bypassing
// dispatch()'s recordEstimate/telemetry side effects) against a temp
// EPOCH_DATA_DIR seeded with matched pert_estimate pairs, to prove:
//   - flag off (default): output is byte-identical to current behavior,
//     regardless of what matching ledger data exists.
//   - flag on + n >= MIN_RECORDS_PER_FACTOR: adjustedEstimate uses the
//     learned factor, never multiplied with developerProfile.correctionFactor.
//   - flag on + n < MIN_RECORDS_PER_FACTOR: unchanged current behavior.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 1 Task 0.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TOOL_REGISTRY } from "./tool-registry.js";
import { getDeveloperProfileGradient } from "../lib/profiles.js";
import { MIN_RECORDS_PER_FACTOR } from "../lib/calibration-factors.js";
import type { ToolResult } from "../types/index.js";

const handler = TOOL_REGISTRY.get("pert_estimate")?.handler;
if (!handler) throw new Error("pert_estimate handler not registered");

function callPert(input: Record<string, unknown>): Record<string, unknown> {
  const result = handler(input) as ToolResult<Record<string, unknown>>;
  if (!result.ok) throw new Error(`pert_estimate returned an error: ${result.error.message}`);
  return result.data;
}

let previousDataDir: string | undefined;
let previousFlag: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  previousFlag = process.env["EPOCH_PERT_LEARNED_CORRECTION"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-pert-handler-test-"));
  process.env["EPOCH_DATA_DIR"] = tempDataDir;
  delete process.env["EPOCH_PERT_LEARNED_CORRECTION"];
});

afterEach(() => {
  if (previousDataDir === undefined) {
    delete process.env["EPOCH_DATA_DIR"];
  } else {
    process.env["EPOCH_DATA_DIR"] = previousDataDir;
  }
  if (previousFlag === undefined) {
    delete process.env["EPOCH_PERT_LEARNED_CORRECTION"];
  } else {
    process.env["EPOCH_PERT_LEARNED_CORRECTION"] = previousFlag;
  }
  rmSync(tempDataDir, { recursive: true, force: true });
});

function writeJsonl(filename: string, records: unknown[]): void {
  writeFileSync(
    join(tempDataDir, filename),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf-8",
  );
}

/** Seed n matched pert_estimate/task_type pairs with a fixed actual/estimate ratio. */
function seedMatchedPairs(taskType: string, n: number, estimatedHours: number, actualHours: number): void {
  const estimates = Array.from({ length: n }, (_, i) => ({
    id: `pe-${taskType}-${i}`,
    tool: "pert_estimate",
    inputs: { task_type: taskType },
    outputs: { expected: estimatedHours, unit: "hours" },
    estimatedAt: `2026-06-0${(i % 9) + 1}T00:00:00.000Z`,
  }));
  const actuals = Array.from({ length: n }, (_, i) => ({
    estimateId: `pe-${taskType}-${i}`,
    actualHours,
    reportedAt: `2026-06-0${(i % 9) + 1}T01:00:00.000Z`,
  }));
  writeJsonl("estimates.jsonl", estimates);
  writeJsonl("feedback.jsonl", actuals);
}

const BASE_INPUT = { optimistic: 2, most_likely: 4, pessimistic: 12, unit: "hours" as const };

describe("pert_estimate handler — learned correction (feature-flagged)", () => {
  it("flag off (default): adjustedEstimate uses developerProfile.correctionFactor, ignoring any learned data", () => {
    // n=5 matched pairs with a very different ratio (5.0) — must NOT affect the output while flag is off.
    seedMatchedPairs("bugfix", 5, 10, 50);

    const data = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });
    const profile = getDeveloperProfileGradient(0.5);
    const expectedAdjusted = Math.round((data["expected"] as number) * profile.correctionFactor * 100) / 100;

    expect(data["adjustedEstimate"]).toBe(expectedAdjusted);
    expect((data["developerProfile"] as { correctionFactor: number }).correctionFactor).toBe(profile.correctionFactor);
  });

  it("flag off: output is byte-identical whether or not matching learned data exists", () => {
    const withoutData = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });
    seedMatchedPairs("bugfix", 5, 10, 50);
    const withData = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });

    expect(withData).toEqual(withoutData);
  });

  it("flag on + n >= MIN_RECORDS_PER_FACTOR: adjustedEstimate uses the learned factor, not multiplied with the profile factor", () => {
    process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "1";
    // median ratio = 50/10 = 5.0, n = MIN_RECORDS_PER_FACTOR
    seedMatchedPairs("bugfix", MIN_RECORDS_PER_FACTOR, 10, 50);

    const data = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });
    const profile = getDeveloperProfileGradient(0.5);
    const learnedFactor = 3.0; // roundFactor() clamps median ratios to [0.1, 3.0]
    const expectedAdjusted = Math.round((data["expected"] as number) * learnedFactor * 100) / 100;
    const multipliedBothWrong = Math.round((data["expected"] as number) * learnedFactor * profile.correctionFactor * 100) / 100;

    expect(data["adjustedEstimate"]).toBe(expectedAdjusted);
    expect(data["adjustedEstimate"]).not.toBe(multipliedBothWrong);
    // developerProfile output field itself is unaffected (still the ai_native heuristic).
    expect((data["developerProfile"] as { correctionFactor: number }).correctionFactor).toBe(profile.correctionFactor);
  });

  it("flag on + n < MIN_RECORDS_PER_FACTOR: unchanged current behavior (developerProfile fallback)", () => {
    process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "1";
    seedMatchedPairs("bugfix", MIN_RECORDS_PER_FACTOR - 1, 10, 50);

    const flagOnLowN = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });

    delete process.env["EPOCH_PERT_LEARNED_CORRECTION"];
    const flagOff = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });

    expect(flagOnLowN).toEqual(flagOff);
  });

  it("flag on + no task_type supplied: unchanged current behavior", () => {
    process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "1";
    seedMatchedPairs("bugfix", 5, 10, 50);

    const withoutTaskType = callPert({ ...BASE_INPUT, ai_native: 0.5 });
    const profile = getDeveloperProfileGradient(0.5);
    const expectedAdjusted = Math.round((withoutTaskType["expected"] as number) * profile.correctionFactor * 100) / 100;

    expect(withoutTaskType["adjustedEstimate"]).toBe(expectedAdjusted);
  });

  it("flag on + n >= MIN_RECORDS_PER_FACTOR but for a different task_type: falls back to profile (no cross-type leakage)", () => {
    process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "1";
    seedMatchedPairs("bugfix", 5, 10, 50);

    const data = callPert({ ...BASE_INPUT, task_type: "feature", ai_native: 0.5 });
    const profile = getDeveloperProfileGradient(0.5);
    const expectedAdjusted = Math.round((data["expected"] as number) * profile.correctionFactor * 100) / 100;

    expect(data["adjustedEstimate"]).toBe(expectedAdjusted);
  });

  it("does not add any new output keys when the flag is on", () => {
    process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "1";
    seedMatchedPairs("bugfix", 5, 10, 50);

    delete process.env["EPOCH_PERT_LEARNED_CORRECTION"];
    const flagOff = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });

    process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "1";
    const flagOn = callPert({ ...BASE_INPUT, task_type: "bugfix", ai_native: 0.5 });

    expect(Object.keys(flagOn).sort()).toEqual(Object.keys(flagOff).sort());
  });
});
