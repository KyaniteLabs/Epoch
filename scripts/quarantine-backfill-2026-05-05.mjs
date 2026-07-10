#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Quarantine the 2026-05-05 exact-match backfill (Phase 2 Task 1)
// ---------------------------------------------------------------------------
//
// Flags rows failing isExcluded()'s "backfill_signature" rule (exact-match
// ratio epsilon AND the 2026-05-05 calendar-date signature — BOTH required,
// per Pre-mortem Scenario 1) by appending overlay flag records to
// estimates.flags.jsonl (src/lib/migrations/quarantine-backfill.ts).
// NEVER rewrites the hot ledger (estimates.jsonl).
//
// Dry-run by default (prints the report, writes nothing). Pass --apply to
// write; EPOCH_DRY_RUN=1 forces dry-run regardless of --apply.
//
// Usage:
//   npx tsx scripts/quarantine-backfill-2026-05-05.mjs             # dry-run
//   npx tsx scripts/quarantine-backfill-2026-05-05.mjs --apply     # write
//
// Rollback: delete the appended lines from estimates.flags.jsonl (the last
// N lines, reason "backfill_signature_2026-05-05"), or restore the printed
// backupPath over estimates.flags.jsonl.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 1.

import { resolveMode, printReport, dataDirLabel } from "./lib/ledger-migrate.mjs";

const { mode } = resolveMode();
const { runQuarantineBackfill } = await import("../src/lib/migrations/quarantine-backfill.ts");

console.error(`[quarantine-backfill-2026-05-05] mode=${mode} dataDir=${dataDirLabel()}`);
const report = runQuarantineBackfill({ mode });
printReport(report);
