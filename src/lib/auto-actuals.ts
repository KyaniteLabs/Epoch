// ---------------------------------------------------------------------------
// Epoch Auto-Actuals — close the feedback loop without asking
// ---------------------------------------------------------------------------
//
// record_actual is manual, so most estimates never get an actual (match
// rate stays low). This module auto-records wall-clock-derived actuals for
// a Claude Code session's un-actualed pending estimates when the session
// ends — honestly labeled, never fabricated.
//
// Wall-clock time is NOT focused effort — that's exactly why every actual
// this module writes carries calibrationProvenance "auto_wallclock" (never
// overwrites a real, human/agent-verified actual — recordActualDetailed's
// existing duplicate guard makes that structurally impossible) and is
// segmented separately from verified actuals in getFeedbackHealthReport()'s
// byProvenance block (src/lib/feedback.ts), so calibration drift introduced
// by wall-clock noise is visible rather than silently blended in. Every
// candidate is also gated by isAutoWallclockSane() (src/lib/exclusion.ts) —
// out-of-bounds durations are skipped here (never recorded), and the same
// gate runs again as a write-time guard inside recordActualDetailed() and
// as a calibration-math guard inside isExcluded().
//
// CLI entry point: `epoch auto-actuals --session <id> [--dry-run]`
// (src/entries/cli.ts). Not an MCP tool — session_id is minted by the
// calling agent/hook (e.g. a SessionEnd hook), not self-reported by an LLM.

import { getPendingEstimates, recordActualDetailed, extractEstimatedHours } from "./feedback.js";
import { isAutoWallclockSane, AUTO_WALLCLOCK_MIN_HOURS, AUTO_WALLCLOCK_MAX_HOURS } from "./exclusion.js";

/** Note persisted on every actual this module records. */
export const AUTO_ACTUALS_NOTE = "auto-recorded at session end (wall-clock)";

/** Practically-unbounded limit passed to getPendingEstimates() so the session filter below sees every pending estimate, not just its default page (50). */
const PENDING_FETCH_LIMIT = 1_000_000;

export type AutoActualsSkipReason = "non_positive_wallclock" | "auto_wallclock_out_of_bounds" | "duplicate" | "write_failed";

export interface AutoActualsSkip {
  readonly estimateId: string;
  readonly reason: AutoActualsSkipReason;
  readonly wallClockHours?: number;
}

export interface AutoActualsRecorded {
  readonly estimateId: string;
  readonly wallClockHours: number;
}

export interface AutoActualsResult {
  readonly sessionId: string;
  readonly dryRun: boolean;
  /** Pending estimates matched to this session_id before the sanity gate. */
  readonly candidates: number;
  readonly recorded: readonly AutoActualsRecorded[];
  readonly skipped: readonly AutoActualsSkip[];
  readonly summary: string;
}

function sessionIdOf(estimate: { inputs: Record<string, unknown> }): string | undefined {
  const raw = estimate.inputs["session_id"];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

/**
 * Auto-record wall-clock-derived actuals for a session's pending estimates.
 *
 * Idempotent: getPendingEstimates() only returns estimates with no matched
 * actual and no TTL expiry, so an estimate this call (or any prior call)
 * already actualed is never revisited — re-running with the same session_id
 * after a successful run is a no-op (candidates recomputed as 0 for those
 * ids).
 */
export function runAutoActuals(sessionId: string, dryRun = false, now: Date = new Date()): AutoActualsResult {
  const pending = getPendingEstimates(PENDING_FETCH_LIMIT);
  const candidates = pending.filter((e) => sessionIdOf(e) === sessionId);

  const recorded: AutoActualsRecorded[] = [];
  const skipped: AutoActualsSkip[] = [];

  for (const estimate of candidates) {
    const estimatedAtMs = Date.parse(estimate.estimatedAt);
    const wallClockHours = Number.isFinite(estimatedAtMs) ? (now.getTime() - estimatedAtMs) / 3_600_000 : NaN;

    if (!Number.isFinite(wallClockHours) || wallClockHours <= 0) {
      skipped.push({ estimateId: estimate.id, reason: "non_positive_wallclock" });
      continue;
    }

    const estimatedHours = extractEstimatedHours(estimate.outputs);
    if (!isAutoWallclockSane(wallClockHours, estimatedHours)) {
      skipped.push({ estimateId: estimate.id, reason: "auto_wallclock_out_of_bounds", wallClockHours });
      continue;
    }

    if (dryRun) {
      recorded.push({ estimateId: estimate.id, wallClockHours });
      continue;
    }

    const result = recordActualDetailed(estimate.id, wallClockHours, AUTO_ACTUALS_NOTE, undefined, "auto_wallclock");
    if (result.ok) {
      recorded.push({ estimateId: estimate.id, wallClockHours });
    } else if (result.reason === "duplicate") {
      skipped.push({ estimateId: estimate.id, reason: "duplicate", wallClockHours });
    } else if (result.reason === "auto_wallclock_out_of_bounds") {
      skipped.push({ estimateId: estimate.id, reason: "auto_wallclock_out_of_bounds", wallClockHours });
    } else {
      // synthetic_id / unknown_tool / below_threshold — edge cases that
      // shouldn't occur on a real pending estimate, kept under one
      // catch-all reason rather than over-fitting the summary to them.
      skipped.push({ estimateId: estimate.id, reason: "write_failed", wallClockHours });
    }
  }

  const verb = dryRun ? "would record" : "recorded";
  const summary =
    `auto-actuals: session ${sessionId} -- ${recorded.length} actual(s) ${verb}, ${skipped.length} skipped ` +
    `(of ${candidates.length} candidate${candidates.length === 1 ? "" : "s"}), sanity bounds [${AUTO_WALLCLOCK_MIN_HOURS}h, ${AUTO_WALLCLOCK_MAX_HOURS}h].`;

  return { sessionId, dryRun, candidates: candidates.length, recorded, skipped, summary };
}
