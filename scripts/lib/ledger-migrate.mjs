// ---------------------------------------------------------------------------
// Epoch Phase 2 Migration Scripts — Shared CLI Glue
// ---------------------------------------------------------------------------
//
// Business logic (backups, quiesce lock, atomic tmp+rename, diff-report
// math) lives in src/lib/migrations/*.ts and src/lib/migration-stats.ts —
// testable directly via vitest against synthetic temp ledgers. This module
// only standardizes argv parsing and report rendering across the Phase 2
// CLI scripts (scripts/quarantine-backfill-2026-05-05.mjs,
// scripts/repair-orphaned-actuals.mjs, scripts/retro-label-estimates.mjs,
// scripts/normalize-task-types.mjs, scripts/archive-quarantined.mjs) so
// every script dry-runs the same way and prints the same report shape.
//
// Mode resolution (EPOCH_DRY_RUN is a first-class safety gate, not just a
// default): without --apply, always dry-run. With --apply, still dry-run if
// EPOCH_DRY_RUN=1/true is set (explicit override belt-and-suspenders).
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 ("scripts/lib/ledger-migrate.mjs — shared helpers").

/** Resolve dry-run vs apply mode from argv + the EPOCH_DRY_RUN env override. */
export function resolveMode(argv = process.argv.slice(2)) {
  const hasApplyFlag = argv.includes("--apply");
  const dryRunEnvSet = process.env["EPOCH_DRY_RUN"] === "1" || process.env["EPOCH_DRY_RUN"] === "true";
  const mode = hasApplyFlag && !dryRunEnvSet ? "apply" : "dry-run";
  return { mode, hasApplyFlag, dryRunEnvSet };
}

export function hasFlag(flag, argv = process.argv.slice(2)) {
  return argv.includes(flag);
}

/** Parse a `--name=value` or `--name value` CLI arg into a number, or return the fallback. */
export function numericFlag(name, fallback, argv = process.argv.slice(2)) {
  const eqPrefix = `--${name}=`;
  const eqArg = argv.find((a) => a.startsWith(eqPrefix));
  if (eqArg) {
    const n = Number(eqArg.slice(eqPrefix.length));
    return Number.isFinite(n) ? n : fallback;
  }
  const idx = argv.indexOf(`--${name}`);
  if (idx >= 0 && argv[idx + 1] !== undefined) {
    const n = Number(argv[idx + 1]);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function printReport(report) {
  console.log(JSON.stringify(report, null, 2));
}

export function dataDirLabel() {
  return process.env["EPOCH_DATA_DIR"] ?? "(default ~/.epoch)";
}
