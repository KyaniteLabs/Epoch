#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Repair Orphaned Actuals (Phase 2 Task 2)
// ---------------------------------------------------------------------------
//
// Re-links feedback rows whose estimateId matches no estimate on file
// (src/lib/migrations/repair-orphaned-actuals.ts). Re-link key: canonical
// tool + inputsSignature + timestamp within a window (default 24h).
// Collision policy: exactly one candidate => re-link; zero or >1 => leave
// orphaned, never guess. In apply mode, a resolved relink rewrites
// feedback.jsonl in place (quiesce lock + backup + atomic tmp+rename) —
// unresolved rows are never written, only reported.
//
// Dry-run by default. Pass --apply to write; EPOCH_DRY_RUN=1 forces
// dry-run regardless of --apply. Pass --window-hours=N to override the
// default 24h re-link window.
//
// Usage:
//   npx tsx scripts/repair-orphaned-actuals.mjs                       # dry-run
//   npx tsx scripts/repair-orphaned-actuals.mjs --window-hours=48      # dry-run, wider window
//   npx tsx scripts/repair-orphaned-actuals.mjs --apply                # write
//
// Rollback: restore the printed backupPath over feedback.jsonl.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 2.

import { resolveMode, printReport, dataDirLabel, numericFlag } from "./lib/ledger-migrate.mjs";

const { mode } = resolveMode();
const windowHours = numericFlag("window-hours", 24);
const { runRepairOrphanedActuals } = await import("../src/lib/migrations/repair-orphaned-actuals.ts");

console.error(`[repair-orphaned-actuals] mode=${mode} windowHours=${windowHours} dataDir=${dataDirLabel()}`);
const report = runRepairOrphanedActuals({ mode, windowHours });
printReport(report);
