// ---------------------------------------------------------------------------
// S1.2 calibration provenance counts — trust-class split + sentence forms.
// ---------------------------------------------------------------------------

import { describe, expect, it } from "vitest";
import { calibrationTaskCounts, calibrationProvenanceSentence } from "./calibration-provenance.js";

describe("calibrationTaskCounts", () => {
  it("returns the all-zero cold-start counts for an empty population", () => {
    expect(calibrationTaskCounts([])).toEqual({ total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 });
  });

  it("splits git_derived (both window stamps) from verified, never summing them into one class", () => {
    const counts = calibrationTaskCounts([
      { calibrationProvenance: "git_derived" },
      { calibrationProvenance: "git_derived_review_inclusive" },
      { calibrationProvenance: "prospective" },
      { calibrationProvenance: "backfilled_calibration" },
      { calibrationProvenance: undefined },
    ]);
    expect(counts).toEqual({ total: 5, gitDerived: 2, verified: 3, autoWallclock: 0 });
  });

  it("counts auto_wallclock as its own third class", () => {
    const counts = calibrationTaskCounts([
      { calibrationProvenance: "git_derived" },
      { calibrationProvenance: "auto_wallclock" },
      { calibrationProvenance: "auto_wallclock" },
    ]);
    expect(counts).toEqual({ total: 3, gitDerived: 1, verified: 0, autoWallclock: 2 });
  });
});

describe("calibrationProvenanceSentence", () => {
  it("pins the calibrated form: dual-labeled counts, never blended", () => {
    expect(calibrationProvenanceSentence({ total: 12, gitDerived: 9, verified: 3, autoWallclock: 0 })).toBe(
      "Calibrated on YOUR 12 historical tasks (9 git-derived, 3 verified).",
    );
  });

  it("singularizes 'task' at exactly one historical task", () => {
    expect(calibrationProvenanceSentence({ total: 1, gitDerived: 1, verified: 0, autoWallclock: 0 })).toBe(
      "Calibrated on YOUR 1 historical task (1 git-derived, 0 verified).",
    );
  });

  it("extends the split with the auto wall-clock class only when it actually contributed", () => {
    expect(calibrationProvenanceSentence({ total: 9, gitDerived: 4, verified: 3, autoWallclock: 2 })).toBe(
      "Calibrated on YOUR 9 historical tasks (4 git-derived, 2 auto wall-clock, 3 verified).",
    );
  });

  it("states the cold-start case honestly and names the seeding path", () => {
    expect(calibrationProvenanceSentence({ total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 })).toBe(
      "Not yet calibrated on your historical tasks (0 git-derived, 0 verified) — " +
        "this output rests on shipped baselines only; run 'epoch mine-git --repo <path> --since <date>' " +
        "or record actuals to seed your calibration corpus.",
    );
  });
});
