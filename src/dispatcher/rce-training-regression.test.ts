// ---------------------------------------------------------------------------
// reference_class_estimate — correction-training regression coverage
// (issue #42 wave-2 rework, security review round 2 on PR #264)
//
// End-to-end dispatcher regressions for the three review findings:
//   1. Correction provenance coherence: calibrationCounts, the note, and the
//      humanReadable provenance line must describe the EXACT raw-basis
//      (outputs.rawEstimate) training population that trained the factor —
//      counts.total always equals sampleSize, and a learned factor can never
//      be presented as "shipped baselines only" (reproduced with six pairs
//      120–125d old: the old 90-day getCalibrationData counts source was
//      empty there while a factor learned from those six pairs was in use).
//   2. Team scope: an explicit team_id must scope the training population;
//      a team-a request must not learn from team-b records.
//   3. Malformed raw basis: present-but-invalid rawEstimate values must be
//      rejected, not silently trained on the post-correction correctedEstimate.
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { dispatch } from "./index.js";

let previousDataDir: string | undefined;
let tempDataDir: string;

beforeEach(() => {
  previousDataDir = process.env["EPOCH_DATA_DIR"];
  tempDataDir = mkdtempSync(join(tmpdir(), "epoch-rce-regression-"));
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

interface SeedPair {
  id: string;
  raw?: number;
  corrected?: number;
  actual: number;
  completedDaysAgo: number;
  team?: string;
  notes?: string;
  outputs?: Record<string, unknown>;
}

/**
 * Seed matched reference_class_estimate/bugfix pairs straight into the temp
 * ledger. raw=10/corrected=18/actual=20 mirrors the security review's probe
 * rows: act/rawEstimate = 2.0 (the pre-correction ratio the wiring must
 * learn) vs act/correctedEstimate ≈ 1.11 (the removed post-correction loop).
 */
function seedPairs(pairs: SeedPair[]): void {
  const daysAgo = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
  writeFileSync(
    join(tempDataDir, "estimates.jsonl"),
    pairs.map((p) => JSON.stringify({
      id: p.id,
      tool: "reference_class_estimate",
      inputs: { task_type: "bugfix", complexity: 3, ...(p.team !== undefined && { team_id: p.team }) },
      outputs: p.outputs ?? {
        rawEstimate: p.raw,
        correctedEstimate: p.corrected ?? Math.round((p.raw ?? 0) * 1.8 * 10) / 10,
        correctionFactor: 1.8,
      },
      estimatedAt: daysAgo(p.completedDaysAgo + 1),
    })).join("\n") + "\n",
    "utf-8",
  );
  writeFileSync(
    join(tempDataDir, "feedback.jsonl"),
    pairs.map((p) => JSON.stringify({
      estimateId: p.id,
      actualHours: p.actual,
      reportedAt: daysAgo(p.completedDaysAgo),
      ...(p.notes !== undefined && { notes: p.notes }),
    })).join("\n") + "\n",
    "utf-8",
  );
}

async function dispatchRce(input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await dispatch("reference_class_estimate", input);
  if (!result.ok) throw new Error(`reference_class_estimate failed: ${result.error.message}`);
  return result.data as Record<string, unknown>;
}

/** Six raw=10/corrected=18/actual=20 pairs offset by `offsetDays`. */
function sixProbePairs(offsetDays: number, prefix: string): SeedPair[] {
  return Array.from({ length: 6 }, (_, i) => ({
    id: `${prefix}-${i + 1}`,
    raw: 10,
    corrected: 18,
    actual: 20,
    completedDaysAgo: offsetDays + i,
  }));
}

describe("reference_class_estimate — correction-training provenance coherence (finding 1)", () => {
  it("OLD-ONLY history (120–125d, outside the old 90-day counts window): learned factor reports its own training population", async () => {
    seedPairs(sixProbePairs(120, "rce-old"));

    const data = await dispatchRce({ task_type: "bugfix", complexity: 3 });

    // The factor is learned from the six all-history pairs (win60's window is
    // empty → min-n fallback to all-history) — and every public count/prose
    // field now names exactly that population.
    expect(data["sampleSize"]).toBe(6);
    expect(data["correctionFactor"]).toBe(2);
    expect(data["calibrationCounts"]).toEqual({ total: 6, gitDerived: 0, verified: 6, autoWallclock: 0 });
    expect((data["calibrationCounts"] as { total: number }).total).toBe(data["sampleSize"]);

    const note = data["note"] as string;
    expect(note).toContain("6 matched reference_class_estimate");
    expect(note).toContain("rawEstimate");

    const humanReadable = data["humanReadable"] as string;
    expect(humanReadable).toContain("Calibrated on YOUR 6 historical tasks (0 git-derived, 6 verified).");
    // The defect this file locks out: a learned factor presented as shipped
    // baselines / reference-database correction.
    expect(humanReadable).not.toContain("shipped baselines only");
    expect(note).not.toContain("Using reference database correction factors");
  });

  it("RECENT history control (3–8d): the same coherence holds inside every window", async () => {
    seedPairs(sixProbePairs(3, "rce-recent"));

    const data = await dispatchRce({ task_type: "bugfix", complexity: 3 });

    expect(data["sampleSize"]).toBe(6);
    expect(data["correctionFactor"]).toBe(2);
    expect(data["calibrationCounts"]).toEqual({ total: 6, gitDerived: 0, verified: 6, autoWallclock: 0 });
    expect((data["humanReadable"] as string)).toContain("Calibrated on YOUR 6 historical tasks (0 git-derived, 6 verified).");
  });

  it("baseline-usage backfills are held out of training and counts (correction-usage population only)", async () => {
    // Five ordinary pairs (ratio 2.0) plus two "ingested from" backfills
    // (usage=baseline, actual ratio 4.0). Backfills must neither train the
    // factor nor be counted as verified: n=5, total=5.
    seedPairs([
      ...Array.from({ length: 5 }, (_, i) => ({ id: `rce-corr-${i + 1}`, raw: 10, corrected: 18, actual: 20, completedDaysAgo: 8 - i })),
      { id: "rce-backfill-1", raw: 10, corrected: 18, actual: 40, completedDaysAgo: 2, notes: "ingested from external tracker" },
      { id: "rce-backfill-2", raw: 10, corrected: 18, actual: 40, completedDaysAgo: 1, notes: "ingested from external tracker" },
    ]);

    const data = await dispatchRce({ task_type: "bugfix", complexity: 3 });

    expect(data["sampleSize"]).toBe(5);
    expect(data["calibrationCounts"]).toEqual({ total: 5, gitDerived: 0, verified: 5, autoWallclock: 0 });
    expect(data["correctionFactor"]).toBe(2);
  });
});

describe("reference_class_estimate — explicit team scope is preserved (finding 2)", () => {
  beforeEach(() => {
    seedPairs(sixProbePairs(3, "rce-tb").map((p) => ({ ...p, team: "team-b" })));
  });

  it("a team-a request does NOT learn from team-b records (the old filtered population was empty → low-n fallback)", async () => {
    const data = await dispatchRce({ task_type: "bugfix", complexity: 3, team_id: "team-a" });

    expect(data["sampleSize"]).toBe(0);
    expect(data["calibrationCounts"]).toEqual({ total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 });
    expect(data["correctionFactor"]).not.toBe(2); // team-b's learned factor must not leak in
    const note = data["note"] as string;
    expect(note).toContain("using reference database correction factors");
    // With an empty population this line is now TRUE, not a contradiction.
    expect(data["humanReadable"] as string).toContain("shipped baselines only");
  });

  it("a team-b request learns from exactly its own six pairs", async () => {
    const data = await dispatchRce({ task_type: "bugfix", complexity: 3, team_id: "team-b" });

    expect(data["sampleSize"]).toBe(6);
    expect(data["correctionFactor"]).toBe(2);
    expect(data["calibrationCounts"]).toEqual({ total: 6, gitDerived: 0, verified: 6, autoWallclock: 0 });
    expect((data["note"] as string)).toContain("rawEstimate");
  });

  it("an UNSCOPED request keeps the intended all-history behavior (team-b rows are its whole population here)", async () => {
    const data = await dispatchRce({ task_type: "bugfix", complexity: 3 });

    expect(data["sampleSize"]).toBe(6);
    expect(data["correctionFactor"]).toBe(2);
    expect(data["calibrationCounts"]).toEqual({ total: 6, gitDerived: 0, verified: 6, autoWallclock: 0 });
  });
});

describe("reference_class_estimate — malformed raw basis is rejected, not trained on correctedEstimate (finding 3)", () => {
  it("six rawEstimate=\"bad\" rows train nothing: honest cold start, no ~1.11 post-correction factor", async () => {
    seedPairs(Array.from({ length: 6 }, (_, i) => ({
      id: `rce-malformed-${i + 1}`,
      actual: 20,
      completedDaysAgo: 6 - i,
      outputs: { rawEstimate: "bad", correctedEstimate: 18, correctionFactor: 1.8 },
    })));

    const data = await dispatchRce({ task_type: "bugfix", complexity: 3 });

    expect(data["sampleSize"]).toBe(0);
    expect(data["calibrationCounts"]).toEqual({ total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 });
    // The old code learned ≈1.11 here (median 20/18 on the post-correction
    // basis); the fallback factor now in use is the reference-database one.
    expect(data["correctionFactor"]).not.toBeCloseTo(1.11, 1);
    expect(data["correctionFactor"]).not.toBe(2);
    expect(data["humanReadable"] as string).toContain("shipped baselines only");
  });

  it("legacy rows with NO rawEstimate field still train on their only recorded basis (correctedEstimate)", async () => {
    seedPairs(Array.from({ length: 6 }, (_, i) => ({
      id: `rce-legacy-${i + 1}`,
      actual: 20,
      completedDaysAgo: 6 - i,
      outputs: { correctedEstimate: 10 }, // legacy shape: rawEstimate field absent
    })));

    const data = await dispatchRce({ task_type: "bugfix", complexity: 3 });

    expect(data["sampleSize"]).toBe(6);
    expect(data["correctionFactor"]).toBe(2); // median 20/10 on the legacy basis
    expect(data["calibrationCounts"]).toEqual({ total: 6, gitDerived: 0, verified: 6, autoWallclock: 0 });
  });
});
