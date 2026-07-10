// ---------------------------------------------------------------------------
// Epoch Migration Shared Helpers (Phase 2)
// ---------------------------------------------------------------------------
//
// Common write-path plumbing for the Phase 2 data-migration modules:
// .pre-migration backups, an advisory quiesce lockfile, atomic tmp+rename
// writes (mirrors self-improve.ts:197-199's pattern for reference-database.json,
// extended here to the append-only JSONL ledgers), and the appendOverlayRecord
// wiring shared with ledger.ts. Every migration module in this directory
// imports these instead of reimplementing file I/O.
//
// Mechanism per Pre-mortem Scenario 4 (concurrent-rewrite data loss): row-
// enriching migrations that must rewrite a file in place acquire the quiesce
// lock first, back up, re-read fresh under lock, then atomic tmp+rename.
// Append-only overlay writes never need the lock (they can't race a
// concurrent appender's file offset — both appenders just add lines).
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 ("scripts/lib/ledger-migrate.mjs — shared helpers").

import { existsSync, mkdirSync, appendFileSync, writeFileSync, renameSync, copyFileSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { dataDir, appendOverlayRecord, type OverlayRecord, type OverlayRecordCore } from "../ledger.js";

export type MigrationMode = "dry-run" | "apply";

function ensureDataDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Append a single JSONL line to `filename` under the current data dir. Mirrors feedback.ts's private appendLine. */
export function appendLine(filename: string, data: unknown): boolean {
  const dir = dataDir();
  ensureDataDir(dir);
  try {
    appendFileSync(join(dir, filename), JSON.stringify(data) + "\n", "utf-8");
    return true;
  } catch {
    return false;
  }
}

/** Append an overlay record via ledger.ts's shared appendOverlayRecord (monotonic seq, never rewrites the hot ledger). */
export function appendOverlay(
  filename: string,
  record: Omit<OverlayRecordCore, "seq" | "recordedAt"> & { recordedAt?: string } & Record<string, unknown>,
): OverlayRecord {
  return appendOverlayRecord(filename, record, appendLine);
}

/** Timestamp suffix for backup/lock artifacts — filesystem-safe (no colons). */
export function migrationStamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Copy `filename` to `<filename>.pre-migration-<stamp>` under the data dir. Returns the backup path, or null if the source file doesn't exist yet. */
export function backupFile(filename: string, stamp: string): string | null {
  const dir = dataDir();
  const src = join(dir, filename);
  if (!existsSync(src)) return null;
  const backupPath = join(dir, `${filename}.pre-migration-${stamp}`);
  copyFileSync(src, backupPath);
  return backupPath;
}

const LOCK_FILE = ".epoch-migration.lock";

/**
 * Acquire the advisory quiesce lock before an in-place rewrite. Throws if
 * already held (never silently proceeds concurrently). The live MCP server
 * does not currently honor this lock (append-only writers can't race a
 * rewrite that reads-fresh-then-atomic-renames), but a second migration
 * script running concurrently must not interleave.
 */
export function acquireQuiesceLock(owner: string): string {
  const dir = dataDir();
  ensureDataDir(dir);
  const lockPath = join(dir, LOCK_FILE);
  if (existsSync(lockPath)) {
    const existing = readFileSync(lockPath, "utf-8");
    throw new Error(`Quiesce lock already held (${lockPath}): ${existing}. Refusing to run concurrently.`);
  }
  writeFileSync(
    lockPath,
    JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString() }, null, 2),
    "utf-8",
  );
  return lockPath;
}

export function releaseQuiesceLock(): void {
  const dir = dataDir();
  const lockPath = join(dir, LOCK_FILE);
  if (existsSync(lockPath)) {
    try {
      unlinkSync(lockPath);
    } catch {
      /* best effort */
    }
  }
}

/** Atomic tmp+rename write of a full JSONL file — mirrors self-improve.ts:197-199's pattern. */
export function atomicWriteJsonl(filename: string, records: unknown[]): void {
  const dir = dataDir();
  ensureDataDir(dir);
  const finalPath = join(dir, filename);
  const tmpPath = join(dir, `${filename}.tmp-${process.pid}`);
  const content = records.map((r) => JSON.stringify(r)).join("\n") + (records.length > 0 ? "\n" : "");
  writeFileSync(tmpPath, content, "utf-8");
  renameSync(tmpPath, finalPath);
}
