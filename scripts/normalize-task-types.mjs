#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Normalize Task Types (Phase 2 Task 4)
// ---------------------------------------------------------------------------
//
// Maps free-text task types to the nearest canonical taskTypeEnum value,
// preserving the original as taskTypeRaw (src/lib/migrations/normalize-
// task-types.ts). Overlay-only (estimates.tasktype.jsonl) — never rewrites
// estimates.jsonl's inputs.task_type.
//
// Dry-run by default. Pass --apply to write; EPOCH_DRY_RUN=1 forces
// dry-run regardless of --apply.
//
// Usage:
//   npx tsx scripts/normalize-task-types.mjs           # dry-run
//   npx tsx scripts/normalize-task-types.mjs --apply   # write
//
// Rollback: delete the appended lines from estimates.tasktype.jsonl (the
// last N lines), or restore the printed backupPath.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 4.

import { resolveMode, printReport, dataDirLabel } from "./lib/ledger-migrate.mjs";

const { mode } = resolveMode();
const { runNormalizeTaskTypes } = await import("../src/lib/migrations/normalize-task-types.ts");

console.error(`[normalize-task-types] mode=${mode} dataDir=${dataDirLabel()}`);
const report = runNormalizeTaskTypes({ mode });
printReport(report);
