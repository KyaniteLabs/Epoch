#!/usr/bin/env node
// ---------------------------------------------------------------------------
// Epoch — Flag Test-Fixture Leakage (loose-ends cleanup)
// ---------------------------------------------------------------------------
//
// Flags rows leaked by old http-test-harness / feedback-batch-test runs
// (src/lib/migrations/flag-test-fixture-rows.ts) by appending overlay flag
// records ({id, quarantined:true, reason:"test_fixture", ...}) to
// estimates.flags.jsonl via the shared loader's appendOverlayRecord. NEVER
// rewrites the hot ledger (estimates.jsonl / feedback.jsonl).
//
// Dry-run by default (prints the report, writes nothing). Pass --apply to
// write; EPOCH_DRY_RUN=1 forces dry-run regardless of --apply.
//
// Usage:
//   npx tsx scripts/flag-test-fixture-rows.mjs             # dry-run
//   npx tsx scripts/flag-test-fixture-rows.mjs --apply     # write
//
// Rollback: delete the appended lines from estimates.flags.jsonl (reason
// "test_fixture"), or restore the printed backupPath over
// estimates.flags.jsonl.

import { resolveMode, printReport, dataDirLabel } from "./lib/ledger-migrate.mjs";

const { mode } = resolveMode();
const { runFlagTestFixtureRows } = await import("../src/lib/migrations/flag-test-fixture-rows.ts");

console.error(`[flag-test-fixture-rows] mode=${mode} dataDir=${dataDirLabel()}`);
const report = runFlagTestFixtureRows({ mode });
printReport(report);
