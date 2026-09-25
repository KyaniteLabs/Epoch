// ---------------------------------------------------------------------------
// Calibration provenance counts — S1.2 bootstrap mode
// ---------------------------------------------------------------------------
//
// The honest answer to "how much of MY data stands behind this number?",
// split by trust class. git-derived actuals (epoch mine-git) and verified
// actuals (a human/agent explicitly recorded them) are counted as SEPARATE
// numbers, never summed into one — the same never-blend rule the S1.1
// cycle-time windows and feedback_health.byProvenance already enforce.
//
// Verified mirrors feedback.ts's byProvenance idiom exactly: verified = every
// provenance that is neither auto_wallclock nor git-derived (prospective,
// backfilled_*, unknown, ...). auto_wallclock stays its own third class and
// only appears in the sentence when it actually contributed, so the pinned
// two-number form is never silently wrong.

import { isGitDerivedProvenance } from "./exclusion.js";

/** Dual-labeled task counts behind a calibration, never blended. */
export interface CalibrationTaskCounts {
  /** Total tasks in the calibration population (the sum of the three classes below). */
  readonly total: number;
  /** Cycle-time actuals mined from local git history (git_derived / git_derived_review_inclusive). */
  readonly gitDerived: number;
  /** Actuals a human/agent explicitly recorded (every non-auto, non-git provenance). */
  readonly verified: number;
  /** Session wall-clock actuals recorded automatically at session end (auto_wallclock). */
  readonly autoWallclock: number;
}

/**
 * Minimal structural input: anything carrying an actual-side provenance stamp
 * counts — HistoricalRecord from the feedback matcher and coverage.ts's
 * CleanPair both satisfy it without one widening the other's type.
 */
export type CalibrationCountableRecord = { readonly calibrationProvenance?: string };

/** Count a calibration population by trust class. Empty input yields the all-zero cold-start counts. */
export function calibrationTaskCounts(records: ReadonlyArray<CalibrationCountableRecord>): CalibrationTaskCounts {
  let gitDerived = 0;
  let verified = 0;
  let autoWallclock = 0;
  for (const record of records) {
    const provenance = record.calibrationProvenance;
    if (isGitDerivedProvenance(provenance)) gitDerived++;
    else if (provenance === "auto_wallclock") autoWallclock++;
    else verified++;
  }
  return { total: gitDerived + verified + autoWallclock, gitDerived, verified, autoWallclock };
}

/**
 * User-facing provenance line for estimate outputs.
 *
 * Calibrated form (pinned): "Calibrated on YOUR N historical tasks (n
 * git-derived, n verified)." — extended with the auto wall-clock class only
 * when those rows actually contributed, because omitting a contributing class
 * would misattribute it to the named ones.
 *
 * Cold-start form states plainly that no user data was used and names the
 * seeding path (bootstrap via mine-git, or recording actuals).
 */
export function calibrationProvenanceSentence(counts: CalibrationTaskCounts): string {
  if (counts.total === 0) {
    return (
      "Not yet calibrated on your historical tasks (0 git-derived, 0 verified) — " +
      "this output rests on shipped baselines only; run 'epoch mine-git --repo <path> --since <date>' " +
      "or record actuals to seed your calibration corpus."
    );
  }
  const split = counts.autoWallclock > 0
    ? `${counts.gitDerived} git-derived, ${counts.autoWallclock} auto wall-clock, ${counts.verified} verified`
    : `${counts.gitDerived} git-derived, ${counts.verified} verified`;
  const tasks = counts.total === 1 ? "task" : "tasks";
  return `Calibrated on YOUR ${counts.total} historical ${tasks} (${split}).`;
}
