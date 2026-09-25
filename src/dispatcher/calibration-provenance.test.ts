// ---------------------------------------------------------------------------
// S1.2 calibration provenance counts on estimate outputs — dispatcher level.
//
// Proves against a temp EPOCH_DATA_DIR that pert_estimate and
// reference_class_estimate emit the dual-labeled provenance line
// ("Calibrated on YOUR N historical tasks (n git-derived, n verified)") with
// REAL counts from the ledger population that calibrated the output, and the
// honest cold-start form when no user data exists.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { TOOL_REGISTRY, dispatch } from "./index.js";
import type { ToolResult } from "../types/index.js";

const maybePertHandler = TOOL_REGISTRY.get("pert_estimate")?.handler;
if (!maybePertHandler) throw new Error("pert_estimate handler not registered");
const pertHandler = maybePertHandler;

function callPert(input: Record<string, unknown>): Record<string, unknown> {
  const result = pertHandler(input) as ToolResult<Record<string, unknown>>;
  if (!result.ok) throw new Error(`pert_estimate returned an error: ${result.error.message}`);
  return result.data;
}

/** (O + 4M + P) / 6 = 10 exactly. */
const PERT_10 = { optimistic: 2, most_likely: 10, pessimistic: 18 } as const;

type Provenance = "git_derived" | "prospective" | "auto_wallclock" | undefined;

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-cal-prov-test-"));
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

interface SeededPair {
  tool: string;
  ratio: number;
  provenance: Provenance;
  basisVersion?: 1 | 2;
}

/**
 * Seed matched pairs for ONE tool/task_type cell at a fixed recorded estimate
 * (10h), with per-row actual/estimate ratios and per-row provenance stamps.
 * Relative timestamps keep the pairs inside getCalibrationData's 90-day
 * window on every run (same convention as estimate-basis.test.ts).
 */
function seedCell(pairs: SeededPair[], taskType = "bugfix"): void {
  const estimateLines = pairs
    .map((p, i) =>
      JSON.stringify({
        id: `calprov-${p.tool}-${i}`,
        tool: p.tool,
        inputs: { task_type: taskType },
        outputs: p.tool === "pert_estimate" ? { expected: 10, unit: "hours" } : { correctedEstimate: 10 },
        estimatedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
        ...(p.basisVersion !== undefined && { basisVersion: p.basisVersion }),
      }),
    )
    .join("\n");
  const actualLines = pairs
    .map((p, i) =>
      JSON.stringify({
        estimateId: `calprov-${p.tool}-${i}`,
        actualHours: p.ratio * 10,
        reportedAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        ...(p.provenance !== undefined && { calibrationProvenance: p.provenance }),
      }),
    )
    .join("\n");
  writeFileSync(join(tempDataDir, "estimates.jsonl"), `${estimateLines}\n`, "utf-8");
  writeFileSync(join(tempDataDir, "feedback.jsonl"), `${actualLines}\n`, "utf-8");
}

describe("pert_estimate — calibration provenance line (S1.2)", () => {
  it("reports the empirical interval population's counts, dual-labeled, never blended", () => {
    seedCell(
      Array.from({ length: 7 }, (_, i) => ({ tool: "pert_estimate", ratio: 1 + (i % 3) * 0.1, provenance: "git_derived" as const })),
    );
    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix" });

    expect(data["calibrationCounts"]).toEqual({ total: 7, gitDerived: 7, verified: 0, autoWallclock: 0 });
    expect(data["humanReadable"]).toContain("Calibrated on YOUR 7 historical tasks (7 git-derived, 0 verified).");
  });

  it("splits mixed provenance and names the auto wall-clock class only when it contributed", () => {
    seedCell([
      { tool: "pert_estimate", ratio: 1.0, provenance: "git_derived" },
      { tool: "pert_estimate", ratio: 1.1, provenance: "git_derived" },
      { tool: "pert_estimate", ratio: 1.2, provenance: "git_derived" },
      { tool: "pert_estimate", ratio: 1.3, provenance: "git_derived" },
      { tool: "pert_estimate", ratio: 0.9, provenance: "prospective" },
      { tool: "pert_estimate", ratio: 1.0, provenance: "prospective" },
      { tool: "pert_estimate", ratio: 1.1, provenance: "auto_wallclock" },
    ]);
    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix" });

    expect(data["calibrationCounts"]).toEqual({ total: 7, gitDerived: 4, verified: 2, autoWallclock: 1 });
    expect(data["humanReadable"]).toContain("Calibrated on YOUR 7 historical tasks (4 git-derived, 1 auto wall-clock, 2 verified).");
  });

  it("states the cold-start case honestly on an empty ledger (PERT-variance interval, no user data)", () => {
    const data = callPert({ ...PERT_10, unit: "hours", task_type: "bugfix" });

    expect(data["calibrationCounts"]).toEqual({ total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 });
    const humanReadable = data["humanReadable"] as string;
    expect(humanReadable).toContain("Not yet calibrated on your historical tasks (0 git-derived, 0 verified)");
    expect(humanReadable).toContain("epoch mine-git --repo <path> --since <date>");
  });
});

describe("reference_class_estimate — calibration provenance line (S1.2)", () => {
  it("counts the SAME records population that drives correctionFactor/sampleSize, split git-derived vs verified", async () => {
    seedCell([
      { tool: "reference_class_estimate", ratio: 0.8, provenance: "git_derived" },
      { tool: "reference_class_estimate", ratio: 0.9, provenance: "git_derived" },
      { tool: "reference_class_estimate", ratio: 1.0, provenance: "git_derived" },
      { tool: "reference_class_estimate", ratio: 1.1, provenance: "git_derived" },
      { tool: "reference_class_estimate", ratio: 1.2, provenance: "prospective" },
      { tool: "reference_class_estimate", ratio: 1.3, provenance: "prospective" },
    ]);
    const result = await dispatch("reference_class_estimate", { task_type: "bugfix", complexity: 3 });
    if (!result.ok) throw new Error(`reference_class_estimate failed: ${result.error.message}`);
    const data = result.data as Record<string, unknown>;

    // counts.total always agrees with the tool's own sampleSize.
    expect(data["calibrationCounts"]).toEqual({ total: 6, gitDerived: 4, verified: 2, autoWallclock: 0 });
    expect(data["sampleSize"]).toBe(6);
    expect(data["humanReadable"]).toContain("Calibrated on YOUR 6 historical tasks (4 git-derived, 2 verified).");
  });

  it("states the cold-start case honestly on an empty ledger", async () => {
    const result = await dispatch("reference_class_estimate", { task_type: "bugfix", complexity: 3 });
    if (!result.ok) throw new Error(`reference_class_estimate failed: ${result.error.message}`);
    const data = result.data as Record<string, unknown>;

    expect(data["calibrationCounts"]).toEqual({ total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 });
    expect(data["humanReadable"]).toContain("Not yet calibrated on your historical tasks (0 git-derived, 0 verified)");
  });
});
