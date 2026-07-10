// ---------------------------------------------------------------------------
// Epoch Migration — Retro-label Estimates (Phase 2 Task 3)
// ---------------------------------------------------------------------------
//
// Backfills `task_label` onto confidently-matched estimates (clean pairs —
// isExcluded() === false) from their feedback notes (88% of matched actuals
// carry a free-text `notes` field). Row-enriching, but expressed as an
// overlay (estimates.labels.jsonl) rather than an in-place rewrite: taskLabel
// is already a first-class field in ledger.ts's MergedOverlayFlags/
// OverlayRecord shape, so every reader picks it up via
// loadLedgerWithOverlays() with no ledger.ts changes needed.
//
// Thin CLI wrapper: scripts/retro-label-estimates.mjs
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 3.
//
// Rollback: delete the appended lines from estimates.labels.jsonl (the last
// N lines), or restore the printed backupPath.

import { loadLedgerWithOverlays, LABELS_FILE } from "../ledger.js";
import { isExcluded } from "../exclusion.js";
import { extractEstimatedHours } from "../feedback.js";
import { appendOverlay, backupFile, migrationStamp, type MigrationMode } from "./shared.js";

const MAX_LABEL_LENGTH = 80;
const MIN_NOTES_LENGTH = 3;
const SAMPLE_LIMIT = 20;

/** Derive a human-readable task label from an actual's free-text notes, truncated on a word boundary. Returns null when notes are too short/empty to be confident. */
export function deriveTaskLabel(notes: string): string | null {
  const trimmed = notes.trim();
  if (trimmed.length < MIN_NOTES_LENGTH) return null;
  if (trimmed.length <= MAX_LABEL_LENGTH) return trimmed;
  const truncated = trimmed.slice(0, MAX_LABEL_LENGTH);
  const lastSpace = truncated.lastIndexOf(" ");
  const cut = lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated;
  return `${cut.trimEnd()}…`;
}

export interface RetroLabelOptions {
  mode: MigrationMode;
}

export interface RetroLabelCandidate {
  id: string;
  taskLabel: string;
}

export interface RetroLabelReport {
  mode: MigrationMode;
  candidateCount: number;
  sample: RetroLabelCandidate[];
  written: number;
  backupPath: string | null;
}

export function runRetroLabelEstimates(options: RetroLabelOptions): RetroLabelReport {
  const merged = loadLedgerWithOverlays();
  const candidates: RetroLabelCandidate[] = [];

  for (const rec of merged) {
    if (rec.flags.taskLabel) continue; // already labeled — idempotent
    if (!rec.actual || !rec.actual.notes) continue;

    const estimatedHours = extractEstimatedHours(rec.outputs);
    const verdict = isExcluded({
      id: rec.id,
      tool: rec.tool,
      inputs: rec.inputs,
      estimatedAt: rec.estimatedAt,
      estimatedHours,
      actual: {
        actualHours: rec.actual.actualHours,
        notes: rec.actual.notes,
        reportedAt: rec.actual.reportedAt,
        completedAt: rec.actual.completedAt,
      },
      flags: { quarantined: rec.flags.quarantined, orphan: rec.flags.orphan },
      ...(rec.expiresAt && { expiresAt: rec.expiresAt }),
    });
    // Only confidently-matched (clean, non-excluded) pairs are labeled.
    if (verdict.excluded) continue;

    const label = deriveTaskLabel(rec.actual.notes);
    if (!label) continue;

    candidates.push({ id: rec.id, taskLabel: label });
  }

  let written = 0;
  let backupPath: string | null = null;

  if (options.mode === "apply" && candidates.length > 0) {
    backupPath = backupFile(LABELS_FILE, migrationStamp());
    for (const c of candidates) {
      appendOverlay(LABELS_FILE, { id: c.id, taskLabel: c.taskLabel });
      written++;
    }
  }

  return { mode: options.mode, candidateCount: candidates.length, sample: candidates.slice(0, SAMPLE_LIMIT), written, backupPath };
}
