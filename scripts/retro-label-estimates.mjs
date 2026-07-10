#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Retro-label Estimates (Phase 2 Task 3)
// ---------------------------------------------------------------------------
//
// Backfills `task_label` onto confidently-matched (clean) estimates from
// their actual's free-text notes (src/lib/migrations/retro-label.ts).
// Overlay-only (estimates.labels.jsonl) — never rewrites estimates.jsonl.
//
// Dry-run by default. Pass --apply to write; EPOCH_DRY_RUN=1 forces
// dry-run regardless of --apply.
//
// Usage:
//   npx tsx scripts/retro-label-estimates.mjs           # dry-run
//   npx tsx scripts/retro-label-estimates.mjs --apply   # write
//
// Rollback: delete the appended lines from estimates.labels.jsonl (the last
// N lines), or restore the printed backupPath.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 3.

import { resolveMode, printReport, dataDirLabel } from "./lib/ledger-migrate.mjs";

const { mode } = resolveMode();
const { runRetroLabelEstimates } = await import("../src/lib/migrations/retro-label.ts");

console.error(`[retro-label-estimates] mode=${mode} dataDir=${dataDirLabel()}`);
const report = runRetroLabelEstimates({ mode });
printReport(report);
