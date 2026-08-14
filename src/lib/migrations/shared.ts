// ---------------------------------------------------------------------------
// Epoch Migration Shared Helpers (Phase 2)
// ---------------------------------------------------------------------------
//
// Common write-path plumbing for the Phase 2 data-migration modules:
// .pre-migration backups, an advisory quiesce lockfile, atomic tmp+rename
// writes (mirrors self-improve.ts:197-199's pattern for reference-database.json,
// extended here to the append-only JSONL ledgers), and the append-surviving
// rewrite helper (ticket 18). Every migration module in this directory
// imports these instead of reimplementing file I/O.
//
// Mechanism per Pre-mortem Scenario 4 (concurrent-rewrite data loss): row-
// enriching migrations that must rewrite a file in place acquire the quiesce
// lock first, back up, re-read fresh under lock, then atomic tmp+rename.
// Append-only overlay writes never need the lock (they can't race a
// concurrent appender's file offset — both appenders just add lines).
//
// Ticket 18 (ledger write integrity) hardening:
// - acquireQuiesceLock creates the lockfile exclusively (flag "wx") and
//   steals it when STALE (dead owner PID or age past the migration stale
//   window) — a crashed migration no longer wedges every later one.
// - rewriteJsonlWithTailMerge writes its temp file through an fsync'd fd
//   before rename (and best-effort fsyncs the directory after), so a crash
//   can't leave a renamed-but-empty ledger. It also re-reads the file's tail
//   immediately before the rename and re-appends any lines that appeared
//   since the rewrite's own read, so rows appended by the live MCP server
//   during the migration survive (belt-and-braces on top of the per-file
//   ledger write lock, which cooperating writers already hold).
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 ("scripts/lib/ledger-migrate.mjs — shared helpers").

import { existsSync, mkdirSync, appendFileSync, readFileSync, renameSync, copyFileSync, unlinkSync } from "node:fs";
import { openSync, writeSync, closeSync, fsyncSync } from "node:fs";
import { join } from "node:path";
import { dataDir, appendOverlayRecord, acquireExclusiveFileLock, releaseExclusiveFileLock, withLedgerWriteLock, type OverlayRecord, type OverlayRecordCore } from "../ledger.js";

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
 * Migrations rewrite whole files synchronously and can legitimately run
 * longer than the ledger write lock's ms-scale scope, so the quiesce lock's
 * staleness window is deliberately wider (default 120s, EPOCH_MIGRATION_LOCK_STALE_MS).
 */
const MIGRATION_LOCK_STALE_MS = 120_000;

/**
 * Acquire the advisory quiesce lock before an in-place rewrite (ticket 18:
 * exclusive-create "wx" + staleness). A lock left behind by a crashed
 * migration (dead PID, or older than the migration stale window) is removed
 * and re-acquired automatically. A lock held by a LIVE holder still throws —
 * two migrations must never interleave a whole-file rewrite. The live MCP
 * server's append path does not take this lock (it takes the per-ledger-file
 * write lock instead; append-survival is additionally guaranteed by
 * rewriteJsonlWithTailMerge's tail re-merge).
 */
export function acquireQuiesceLock(owner: string): string {
  const dir = dataDir();
  ensureDataDir(dir);
  const lockPath = join(dir, LOCK_FILE);
  const staleMs = migrationStaleMs();
  // Single-attempt semantics (timeoutMs: 0): steal stale locks, throw on live ones.
  const acquisition = acquireExclusiveFileLock(lockPath, owner, { timeoutMs: 0, staleMs, retryMs: 0 });
  if (!acquisition.ok) {
    let existing = "";
    try {
      existing = readFileSync(lockPath, "utf-8");
    } catch {
      /* unreadable lock — the message below still names the path */
    }
    throw new Error(`Quiesce lock already held (${lockPath}): ${existing.trim() || "(unreadable)"}. Refusing to run concurrently.`);
  }
  // Stash the token for releaseQuiesceLock (legacy call sites release without args).
  quiesceToken = acquisition.token;
  quiesceLockPath = lockPath;
  return lockPath;
}

let quiesceToken: string | null = null;
let quiesceLockPath: string | null = null;

function migrationStaleMs(): number {
  const raw = process.env["EPOCH_MIGRATION_LOCK_STALE_MS"];
  if (raw === undefined) return MIGRATION_LOCK_STALE_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : MIGRATION_LOCK_STALE_MS;
}

export function releaseQuiesceLock(): void {
  if (quiesceToken !== null && quiesceLockPath !== null) {
    releaseExclusiveFileLock(quiesceLockPath, quiesceToken);
  } else {
    // Legacy fallback (token unknown): best-effort unlink, preserving the
    // pre-ticket-18 release contract.
    const lockPath = join(dataDir(), LOCK_FILE);
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
      } catch {
        /* best effort */
      }
    }
  }
  quiesceToken = null;
  quiesceLockPath = null;
}

/** Write `content` to `path` through an explicit fd + fsync (Node durability practice: data must hit disk before the rename). */
function writeFsynced(path: string, content: string): void {
  const fd = openSync(path, "w");
  try {
    writeSync(fd, content, 0, "utf-8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** Best-effort directory fsync so a preceding rename is durable (POSIX; a no-op failure on platforms that forbid it). */
function fsyncDirBestEffort(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    /* Windows / permission-restricted filesystems — rename durability is best-effort */
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// ---- Tail re-merge rewrite (ticket 18) ---------------------------------------

export interface TailMergeResult {
  /** Number of transformed lines written (the migration's own rewrite output). */
  written: number;
  /** Number of concurrently-appended lines re-merged (appended verbatim after the transformed content). */
  tailMerged: number;
}

/**
 * Rewrite `filename` in place, append-surviving (ticket 18, Pre-mortem
 * Scenario 4): under the per-file ledger write lock, read the file's current
 * raw lines, apply `transform`, then — immediately before the rename —
 * re-read the file and re-append verbatim every line that appeared beyond the
 * offset captured at the initial read. A concurrent appender's row therefore
 * survives even if it does not cooperate with the write lock (old server
 * versions, external scripts). Throws if the file SHRANK below the initial
 * offset (an unexpected concurrent rewrite — fail loudly rather than lose data).
 *
 * `transform` receives the raw non-empty lines of the fresh read and returns
 * the lines to keep. Parsing discipline mirrors readLines(): unparseable
 * lines are the caller's to handle (migrations drop them, matching the
 * readLines-based rewrites they replace).
 */
export function rewriteJsonlWithTailMerge(
  filename: string,
  transform: (rawLines: string[]) => string[],
): TailMergeResult {
  return withLedgerWriteLock(
    filename,
    (): TailMergeResult => {
      const dir = dataDir();
      ensureDataDir(dir);
      const finalPath = join(dir, filename);
      const tmpPath = join(dir, `${filename}.tmp-${process.pid}`);

      // Initial read under the lock — the offset of this read is the boundary.
      const initial = readRaw(finalPath);
      const readOffsetChars = initial.length; // char offset == byte boundary of this prefix for append-only growth
      const initialLines = splitLines(initial);
      const transformed = transform(initialLines);
      const written = transformed.length;

      // Tail re-merge: immediately before the rename, re-read and keep whatever
      // was appended beyond the initial read's offset. Appends only ever
      // extend the content, so current.startsWith(initial) holds and the
      // character-offset slice is the exact tail even for multi-byte UTF-8.
      const current = readRaw(finalPath);
      if (current.length < readOffsetChars) {
        throw new Error(
          `rewriteJsonlWithTailMerge(${filename}): file shrank from ${readOffsetChars} to ${current.length} chars during the rewrite — refusing to proceed (concurrent rewrite?).`,
        );
      }
      const tailLines = splitLines(current.slice(readOffsetChars));

      const content = [...transformed, ...tailLines].join("\n") + (transformed.length + tailLines.length > 0 ? "\n" : "");
      writeFsynced(tmpPath, content);
      renameSync(tmpPath, finalPath);
      fsyncDirBestEffort(dir);
      return { written, tailMerged: tailLines.length };
    },
    "migration-rewrite",
  );
}

function readRaw(path: string): string {
  try {
    return readFileSync(path, "utf-8");
  } catch {
    return "";
  }
}

function splitLines(content: string): string[] {
  return content.split("\n").filter((line) => line.trim().length > 0);
}
