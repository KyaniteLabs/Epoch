// ---------------------------------------------------------------------------
// Epoch Migration — Archive Quarantined Rows (Phase 2 Task 6)
// ---------------------------------------------------------------------------
//
// After the audit window, physically moves flagged rows out of
// estimates.jsonl into estimates.quarantine.jsonl (quiesce + backup + atomic
// tmp+rename), keeping the hot corpus clean while the archive stays
// reversible. Flag-GC: the matching estimates.flags.jsonl / estimates
// .labels.jsonl overlay records are removed together with their rows —
// once a row is archived, MergedRecord.archived=true already carries the
// quarantine provenance, so a surviving flag record referencing that id
// would be a dangling overlay (Pre-mortem Scenario 4's conservation
// invariant: no overlay record survives its row's departure from the hot
// ledger without being accounted for).
//
// CONSERVATION invariant: count(hot) + count(archive) is constant across the
// migration — every row is moved, never lost, never duplicated.
//
// Guarded by a required `auditWindowConfirmed` flag (CLI: --audit-window-
// confirmed) so this can't run accidentally in apply mode.
//
// Thin CLI wrapper: scripts/archive-quarantined.mjs
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 6, Pre-mortem Scenario 4.
//
// Rollback: restore all four printed backupPaths (estimates.jsonl,
// estimates.quarantine.jsonl, estimates.flags.jsonl, estimates.labels.jsonl)
// over their live counterparts.

import {
  loadLedgerWithOverlays,
  readLines,
  ESTIMATES_FILE,
  QUARANTINE_ARCHIVE_FILE,
  FLAGS_FILE,
  LABELS_FILE,
  type EstimateRecord,
  type OverlayRecord,
} from "../ledger.js";
import { acquireQuiesceLock, releaseQuiesceLock, atomicWriteJsonl, backupFile, migrationStamp, type MigrationMode } from "./shared.js";

export interface ArchiveOptions {
  mode: MigrationMode;
  /** Required true for apply mode — the operator's explicit confirmation the audit window has elapsed. */
  auditWindowConfirmed: boolean;
}

export interface LedgerCounts {
  hotCount: number;
  archiveCount: number;
  total: number;
}

export interface ArchiveReport {
  mode: MigrationMode;
  auditWindowConfirmed: boolean;
  archivedCount: number;
  sample: string[];
  flagsGced: number;
  labelsGced: number;
  before: LedgerCounts;
  after: LedgerCounts;
  written: number;
  backupPaths: string[];
}

const SAMPLE_LIMIT = 20;

export function runArchiveQuarantined(options: ArchiveOptions): ArchiveReport {
  if (options.mode === "apply" && !options.auditWindowConfirmed) {
    throw new Error(
      "archive-quarantined requires --audit-window-confirmed for apply mode; refusing to run without explicit confirmation the audit window has elapsed.",
    );
  }

  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const archived = readLines<EstimateRecord>(QUARANTINE_ARCHIVE_FILE);
  const before: LedgerCounts = { hotCount: estimates.length, archiveCount: archived.length, total: estimates.length + archived.length };

  const merged = loadLedgerWithOverlays();
  const toArchive = merged.filter((r) => !r.archived && r.flags.quarantined);
  const toArchiveIds = new Set(toArchive.map((r) => r.id));

  let written = 0;
  let flagsGced = 0;
  let labelsGced = 0;
  const backupPaths: string[] = [];

  if (options.mode === "apply" && toArchive.length > 0) {
    const stamp = migrationStamp();
    acquireQuiesceLock("archive-quarantined");
    try {
      for (const f of [ESTIMATES_FILE, QUARANTINE_ARCHIVE_FILE, FLAGS_FILE, LABELS_FILE]) {
        const b = backupFile(f, stamp);
        if (b) backupPaths.push(b);
      }

      // Re-read fresh under the lock so a concurrent appender's rows aren't lost.
      const freshEstimates = readLines<EstimateRecord>(ESTIMATES_FILE);
      const freshArchived = readLines<EstimateRecord>(QUARANTINE_ARCHIVE_FILE);
      const remainingHot = freshEstimates.filter((e) => !toArchiveIds.has(e.id));
      const movedRows = freshEstimates.filter((e) => toArchiveIds.has(e.id));
      written = movedRows.length;

      atomicWriteJsonl(ESTIMATES_FILE, remainingHot);
      atomicWriteJsonl(QUARANTINE_ARCHIVE_FILE, [...freshArchived, ...movedRows]);

      // Flag-GC: drop overlay records for now-archived ids from the live
      // sidecars — archived membership already carries the quarantine
      // provenance, so a surviving flag/label record for that id would dangle.
      const freshFlags = readLines<OverlayRecord>(FLAGS_FILE);
      const freshLabels = readLines<OverlayRecord>(LABELS_FILE);
      const remainingFlags = freshFlags.filter((r) => !toArchiveIds.has(r.id));
      const remainingLabels = freshLabels.filter((r) => !toArchiveIds.has(r.id));
      flagsGced = freshFlags.length - remainingFlags.length;
      labelsGced = freshLabels.length - remainingLabels.length;
      atomicWriteJsonl(FLAGS_FILE, remainingFlags);
      atomicWriteJsonl(LABELS_FILE, remainingLabels);
    } finally {
      releaseQuiesceLock();
    }
  }

  const after: LedgerCounts =
    options.mode === "apply"
      ? (() => {
          const hot = readLines<EstimateRecord>(ESTIMATES_FILE).length;
          const arch = readLines<EstimateRecord>(QUARANTINE_ARCHIVE_FILE).length;
          return { hotCount: hot, archiveCount: arch, total: hot + arch };
        })()
      : { hotCount: before.hotCount - toArchive.length, archiveCount: before.archiveCount + toArchive.length, total: before.total };

  return {
    mode: options.mode,
    auditWindowConfirmed: options.auditWindowConfirmed,
    archivedCount: toArchive.length,
    sample: toArchive.slice(0, SAMPLE_LIMIT).map((r) => r.id),
    flagsGced,
    labelsGced,
    before,
    after,
    written,
    backupPaths,
  };
}
