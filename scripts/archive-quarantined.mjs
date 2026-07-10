#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Archive Quarantined Rows (Phase 2 Task 6)
// ---------------------------------------------------------------------------
//
// After the audit window, physically moves flagged rows out of
// estimates.jsonl into estimates.quarantine.jsonl (quiesce + backup + atomic
// tmp+rename), GC'ing their matching flags/labels overlay records together
// (src/lib/migrations/archive-quarantined.ts). CONSERVATION invariant:
// count(hot) + count(archive) is constant across the migration.
//
// Guarded by a REQUIRED --audit-window-confirmed flag for apply mode — the
// script refuses to write without it, so this can't run accidentally.
//
// Dry-run by default (does not require --audit-window-confirmed — dry-run is
// always safe informational output). Pass --apply --audit-window-confirmed
// to write; EPOCH_DRY_RUN=1 forces dry-run regardless of --apply.
//
// Usage:
//   npx tsx scripts/archive-quarantined.mjs                                    # dry-run
//   npx tsx scripts/archive-quarantined.mjs --apply --audit-window-confirmed   # write
//
// Rollback: restore all four printed backupPaths over their live
// counterparts (estimates.jsonl, estimates.quarantine.jsonl,
// estimates.flags.jsonl, estimates.labels.jsonl).
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 6, Pre-mortem Scenario 4.

import { resolveMode, printReport, dataDirLabel, hasFlag } from "./lib/ledger-migrate.mjs";

const { mode } = resolveMode();
const auditWindowConfirmed = hasFlag("--audit-window-confirmed");
const { runArchiveQuarantined } = await import("../src/lib/migrations/archive-quarantined.ts");

console.error(`[archive-quarantined] mode=${mode} auditWindowConfirmed=${auditWindowConfirmed} dataDir=${dataDirLabel()}`);

try {
  const report = runArchiveQuarantined({ mode, auditWindowConfirmed });
  printReport(report);
} catch (err) {
  console.error(`[archive-quarantined] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
}
