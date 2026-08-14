// ---------------------------------------------------------------------------
// Epoch Shared Ledger — file access + overlay-merge loader
// ---------------------------------------------------------------------------
//
// This is the ONLY module permitted to read `estimates.jsonl` / `feedback.jsonl`
// (and their overlay sidecars) directly. Every other reader (feedback.ts,
// and transitively analytics.ts / calibration-factors.ts /
// reference-db-recalculation.ts) must go through readLines()/
// loadLedgerWithOverlays() exported here. See Pre-mortem Scenario 6
// ("skipped join") in the remediation plan — the guard test in
// ledger.test.ts asserts this stays true.
//
// feedback.ts imports from this module; this module must never import from
// feedback.ts (kept acyclic per execution annotation 2).

import { existsSync, readFileSync, statSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import type { TaskType } from "../types/index.js";
import { debugLog } from "./internal/logging.js";

const DEFAULT_DATA_DIR = join(homedir(), ".epoch");

export const ESTIMATES_FILE = "estimates.jsonl";
export const ACTUALS_FILE = "feedback.jsonl";
/** Sidecar overlay: append-only quarantine/flag records (Phase 2). Never rewrites the hot ledger. */
export const FLAGS_FILE = "estimates.flags.jsonl";
/** Sidecar overlay: append-only retro-label records (Phase 2). */
export const LABELS_FILE = "estimates.labels.jsonl";
/** Archive: rows physically moved out of ESTIMATES_FILE after the audit window (Phase 2). */
export const QUARANTINE_ARCHIVE_FILE = "estimates.quarantine.jsonl";

export function dataDir(): string {
  return process.env["EPOCH_DATA_DIR"] ?? DEFAULT_DATA_DIR;
}

// ---- Read cache (ticket 17, W3 performance) ----------------------------------
//
// A single estimation dispatch used to re-read+re-parse the whole ledger ~3x
// (correction factors, empirical intervals, calibration data), with parse cost
// growing linearly in history. readLines() now memoizes the parsed array per
// absolute file path, validated on EVERY call by a stat of the file:
//
//   key = (size, mtimeMs, ino)
//
// Append-only files make this exact: an append changes size; a rename-based
// rewrite (atomicWriteJsonl) changes inode AND mtime; an in-place same-size
// rewrite changes mtime (APFS/ext4 expose sub-millisecond mtimeMs). Any stat
// mismatch re-reads and re-parses. External appends from other processes are
// therefore picked up on the next read — the cache is a per-call memo, never a
// TTL cache.
//
// Own writes (feedback.ts's appendLine, migrations' atomicWriteJsonl) are NOT
// hooked: they invalidate implicitly because every write changes the stat key
// (appends change size; rewrites change mtime/ino). Nothing in this module
// writes LEDGER DATA, so there is no self-write path to invalidate
// proactively. (The advisory write-lock section below does create/remove
// `<file>.lock` sidecar files — lockfiles only, never ledger rows.)
//
// Mutation discipline (deliberate choice, per ticket): cached rows are
// deep-frozen and readLines() hands out a SHALLOW COPY of the array
// (copy-on-read). A caller may sort/reverse/splice its returned array freely —
// it owns that copy — but any in-place mutation of a row object throws in
// strict mode instead of silently corrupting the cache. Deep-copying every row
// per read was rejected: it would reintroduce O(rows) work per read, which is
// the exact blowup this cache exists to remove.
//
// Escape hatch: EPOCH_LEDGER_CACHE=0 (or "false") bypasses the cache entirely
// (reads still parse, and still count in the parse counters) — used to A/B
// measure the parse-count improvement and as a safety valve.

interface LedgerCacheEntry {
  /** Stat key the cached rows were parsed from. */
  size: number;
  mtimeMs: number;
  /** Inode as an exact string (real Stats carry bigint inos; mocks carry numbers). */
  ino: string;
  /** Deep-frozen parsed rows. Never handed out directly — readLines() returns a shallow copy. */
  rows: unknown[];
  /**
   * Non-empty lines that failed JSON.parse in the parse that populated this
   * entry (ticket 18). Same stat key = same content = same corrupt count, so
   * cache hits don't need to recount. Skip semantics are unchanged — the rows
   * were always silently dropped; now the drop is counted.
   */
  corruptLines: number;
  /** Epoch-ms of the parse that populated this entry. */
  parsedAt: number;
  /** Epoch-ms of the most recent read that validated/produced this entry. */
  lastReadAt: number;
}

/**
 * Cached parsed ledger contents, keyed by absolute file path. The key set is
 * bounded by the fixed set of ledger/sidecar filenames (constants in this
 * module), so no eviction policy is needed.
 */
const ledgerCache = new Map<string, LedgerCacheEntry>();

/**
 * Cumulative count of full read+parse executions per absolute path, incremented
 * on EVERY parse whether it hit the cache validation or ran in bypass mode.
 * Test instrumentation (ticket 17): lets tests assert bounded parse counts
 * without wall-clock flakiness. Never reset except by
 * {@link resetLedgerReadCache}.
 */
const ledgerParseCounts = new Map<string, number>();

/**
 * Corrupt-line counts per absolute path, updated on every parse (ticket 18):
 * non-empty lines that failed JSON.parse. Skip semantics in readLines() are
 * pinned by tests and UNCHANGED — this only makes the previously-silent drop
 * observable (surfaced via data_status / feedback_health).
 */
const ledgerCorruptLines = new Map<string, number>();

function ledgerCacheEnabled(): boolean {
  const raw = process.env["EPOCH_LEDGER_CACHE"];
  return !(raw === "0" || raw === "false");
}

/** Deep-freeze a parsed row (and everything reachable from it) so cache corruption fails loudly. */
function deepFreeze<T>(value: T): T {
  if (value !== null && (typeof value === "object" || typeof value === "function")) {
    for (const key of Object.keys(value as object)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Stat facts used to validate cache entries; null when stat is unavailable.
 * The statSync access sits inside the try because test suites that mock
 * node:fs without a statSync export throw at the property access itself —
 * that must degrade to a cache bypass (plain read), never a hard failure.
 */
function statKey(path: string): { size: number; mtimeMs: number; ino: string } | null {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs, ino: String(s.ino) };
  } catch {
    return null;
  }
}

/** Read and parse a JSONL file under the Epoch data dir. Missing file / unparsable lines yield []. */
export function readLines<T>(filename: string): T[] {
  const path = join(dataDir(), filename);
  if (!existsSync(path)) return [];

  const stat = ledgerCacheEnabled() ? statKey(path) : null;
  const cached = stat !== null ? ledgerCache.get(path) : undefined;
  if (cached && stat && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ino === stat.ino) {
    cached.lastReadAt = Date.now();
    return cached.rows.slice() as T[];
  }

  let rows: unknown[];
  let corruptLines = 0;
  try {
    const content = readFileSync(path, "utf-8");
    rows = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          corruptLines++;
          return null;
        }
      })
      .filter((r) => r !== null);
  } catch {
    return [];
  }

  ledgerParseCounts.set(path, (ledgerParseCounts.get(path) ?? 0) + 1);
  ledgerCorruptLines.set(path, corruptLines);
  if (stat !== null) {
    ledgerCache.set(path, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      rows: rows.map(deepFreeze),
      corruptLines,
      parsedAt: Date.now(),
      lastReadAt: Date.now(),
    });
  }
  return rows as T[];
}

/** Test/observability hook: clear the read cache and parse counters (ticket 17). */
export function resetLedgerReadCache(): void {
  ledgerCache.clear();
  ledgerParseCounts.clear();
  ledgerCorruptLines.clear();
}

/**
 * Corrupt-line counts per absolute path from the most recent parse (ticket 18).
 * A count of 0 means the file was parsed and every non-empty line was valid;
 * absence from the map means the file has not been parsed in this process.
 */
export function getLedgerCorruptLines(): ReadonlyMap<string, number> {
  return new Map(ledgerCorruptLines);
}

/** Per-file read-cache status, keyed by absolute path. `parses` counts every parse including cache-bypass reads. */
export interface LedgerCacheStatusEntry {
  parses: number;
  /** Epoch-ms of the parse that populated the cache entry; null when the file was only read in bypass mode. */
  parsedAt: number | null;
  /** Epoch-ms of the most recent read that validated/produced the entry; null when never read. */
  lastReadAt: number | null;
}

/** Snapshot of the read-cache state, for data_status surfacing and tests. */
export function getLedgerCacheStatus(): ReadonlyMap<string, LedgerCacheStatusEntry> {
  const out = new Map<string, LedgerCacheStatusEntry>();
  for (const [path, count] of ledgerParseCounts) {
    const entry = ledgerCache.get(path);
    out.set(path, {
      parses: count,
      parsedAt: entry?.parsedAt ?? null,
      lastReadAt: entry?.lastReadAt ?? null,
    });
  }
  return out;
}

/**
 * Basis version stamped on every estimate row written by the CURRENT process
 * (ticket 11, estimate-basis unification): v2 = post-unification rows, where
 * the displayed estimate IS the recorded estimate (PERT rows record their raw
 * `expected`; reference-class rows record `correctedEstimate`). Rows written
 * before the unification carry no stamp and are implicitly v1 — the era in
 * which tools displayed an `adjustedEstimate` the ledger never recorded.
 * Ratio populations are permanently split by this era (see coverage.ts);
 * there is deliberately no automatic aging-out or merging of the two.
 */
export const CURRENT_BASIS_VERSION = 2 as const;

/** Legacy (pre-unification) rows carry no `basisVersion` stamp and read as this. */
export const LEGACY_BASIS_VERSION = 1 as const;

export interface EstimateRecord {
  id: string;
  tool: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  estimatedAt: string;
  /** Project or source that generated this estimate (e.g. "epoch", "liminal", "github_pipeline"). */
  source?: string;
  /** Pending-estimate TTL expiry (Phase 1 Task 7), set at write time. */
  expiresAt?: string;
  /** Basis-era stamp (ticket 11): 2 = post-unification (displayed == recorded); absent = legacy v1. */
  basisVersion?: number;
}

export interface ActualRecord {
  estimateId: string;
  actualHours: number;
  notes?: string;
  reportedAt: string;
  completedAt?: string;
  /** Explicit calibration-provenance classification supplied at record_actual time (Phase 3 contract wave). Read by isExcluded() via ExclusionActual.calibrationProvenance. */
  calibrationProvenance?: string;
}

/** Date.parse an actual's reportedAt; unparseable/missing timestamps rank as "latest possible". */
function reportedAtMs(a: ActualRecord): number {
  const t = Date.parse(a.reportedAt ?? "");
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

/**
 * Deterministic estimate→actual join (ticket 18, D3 concurrency model): for a
 * given estimateId the EARLIEST-reported actual wins; ties (equal reportedAt,
 * or timestamps that can't be parsed) break to the earliest record in file
 * order — i.e. the FIRST one seen, so identical file contents always produce
 * the identical joined pair. This replaces the previous last-write-wins-by-
 * file-order join, which made the winner depend on the append order of
 * duplicate rows. Duplicates are never silently collapsed anymore either:
 * countDuplicateActuals() surfaces them.
 */
export function joinActualsEarliestReported(actuals: ActualRecord[]): Map<string, ActualRecord> {
  const byId = new Map<string, ActualRecord>();
  for (const a of actuals) {
    const current = byId.get(a.estimateId);
    if (current === undefined || reportedAtMs(a) < reportedAtMs(current)) {
      byId.set(a.estimateId, a);
    }
  }
  return byId;
}

/**
 * duplicateActuals counter (ticket 18): the number of DISTINCT estimateIds
 * carrying more than one actual row. Zero is the invariant the write lock
 * enforces; a non-zero value means duplicate rows predate the lock (or were
 * written by a non-cooperating writer) and are being resolved deterministically
 * by {@link joinActualsEarliestReported}.
 */
export function countDuplicateActuals(actuals: ActualRecord[]): number {
  const counts = new Map<string, number>();
  for (const a of actuals) counts.set(a.estimateId, (counts.get(a.estimateId) ?? 0) + 1);
  let duplicated = 0;
  for (const n of counts.values()) if (n > 1) duplicated++;
  return duplicated;
}

// ---- Overlay records --------------------------------------------------------

/**
 * Explicit overlay-record fields, deliberately kept free of an inline index
 * signature. `appendOverlayRecord` below computes `Omit<OverlayRecordCore, ...>`
 * — Omit'ing keys off a type that itself carries a `[key: string]: unknown`
 * index signature collapses `keyof` to `string`, which silently drops the
 * required-ness of every named field (including `id`). Compute Omit against
 * this index-signature-free core instead, then intersect the index signature
 * back in via `OverlayRecord` below.
 */
export interface OverlayRecordCore {
  id: string;
  seq: number;
  recordedAt: string;
  quarantined?: boolean;
  reason?: string;
  orphan?: boolean;
  taskLabel?: string;
}

/**
 * An append-only overlay record annotating one ledger record by id.
 * Every overlay record carries a monotonic `seq` assigned at write time —
 * this is the deterministic tiebreak for conflict resolution (per plan
 * decision: last-write-wins by `recordedAt`, tiebreak on equal timestamps
 * = monotonic `seq`, NOT file/line order — cross-filesystem/cross-language
 * safe, unlike file order).
 *
 * Overlay sidecar files (flags/labels/tasktype/...) may carry additional
 * caller-defined fields beyond the explicit core above (e.g. the
 * normalize-task-types migration writes `taskTypeRaw`/`taskTypeNormalized`)
 * — the intersection with `Record<string, unknown>` preserves that
 * extensibility on the on-disk overlay format without reintroducing the
 * inline index signature that collapsed `keyof` (see OverlayRecordCore).
 */
export type OverlayRecord = OverlayRecordCore & Record<string, unknown>;

/**
 * Append a new overlay record to a sidecar file, auto-assigning the next
 * monotonic `seq` (max existing seq in the file + 1) and `recordedAt`
 * (now, if not supplied). Overlay files are append-only — this never
 * rewrites the hot ledger (Pre-mortem Scenario 4: concurrent-rewrite data loss).
 */
export function appendOverlayRecord(
  filename: string,
  record: Omit<OverlayRecordCore, "seq" | "recordedAt"> & { recordedAt?: string } & Record<string, unknown>,
  appendLine: (filename: string, data: unknown) => boolean,
): OverlayRecord {
  const existing = readLines<OverlayRecord>(filename);
  const nextSeq = existing.reduce((max, r) => Math.max(max, r.seq ?? 0), 0) + 1;
  const full: OverlayRecord = {
    ...record,
    seq: nextSeq,
    recordedAt: record.recordedAt ?? new Date().toISOString(),
  };
  appendLine(filename, full);
  return full;
}

/** Merged overlay state for a single ledger record, after last-write-wins conflict resolution. */
export interface MergedOverlayFlags {
  quarantined: boolean;
  quarantineReason?: string;
  orphan: boolean;
  taskLabel?: string;
}

/**
 * Merge conflict resolution: for a given estimate id, apply overlay records
 * last-write-wins by `recordedAt`, tiebreak on equal timestamps = higher
 * monotonic `seq`. Deterministic (§5 row 10).
 */
function resolveOverlayConflicts(records: OverlayRecord[]): Map<string, OverlayRecord[]> {
  const byId = new Map<string, OverlayRecord[]>();
  for (const r of records) {
    const arr = byId.get(r.id) ?? [];
    arr.push(r);
    byId.set(r.id, arr);
  }
  for (const arr of byId.values()) {
    arr.sort((a, b) => {
      const t = Date.parse(a.recordedAt) - Date.parse(b.recordedAt);
      if (t !== 0) return t;
      return (a.seq ?? 0) - (b.seq ?? 0);
    });
  }
  return byId;
}

function mergeFlagsForId(records: OverlayRecord[] | undefined): MergedOverlayFlags {
  const merged: MergedOverlayFlags = { quarantined: false, orphan: false };
  if (!records) return merged;
  // Apply in last-write-wins order (already sorted ascending by recordedAt/seq);
  // later records' explicit fields override earlier ones.
  for (const r of records) {
    if (r.quarantined !== undefined) merged.quarantined = r.quarantined;
    if (r.reason !== undefined) merged.quarantineReason = r.reason;
    if (r.orphan !== undefined) merged.orphan = r.orphan;
    if (r.taskLabel !== undefined) merged.taskLabel = r.taskLabel;
  }
  return merged;
}

/**
 * The canonical merged view of the ledger: every estimate (live + archived),
 * its matched actual (if any), and the last-write-wins merge of every
 * overlay sidecar — produced BEFORE isExcluded() is applied. This is the
 * single sanctioned path to ledger records (Pre-mortem Scenario 6): no
 * other module should call readLines(ESTIMATES_FILE) / readLines(ACTUALS_FILE)
 * directly.
 */
export interface MergedRecord {
  id: string;
  tool: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  estimatedAt: string;
  source?: string;
  expiresAt?: string;
  /** Basis-era stamp propagated from the estimate row (ticket 11); absent = legacy v1. */
  basisVersion?: number;
  actual?: ActualRecord;
  flags: MergedOverlayFlags;
  /** True if this record was physically moved to the quarantine archive (Phase 2 Task 6). */
  archived: boolean;
}

export interface LoadLedgerOptions {
  /** Task-type filter, applied after the join (mirrors matchEstimatesToActuals' filters shape). */
  taskType?: TaskType;
}

/**
 * Load the full ledger (live estimates + archived/quarantined estimates),
 * join each row to its actual (if matched) and to the last-write-wins merge
 * of every overlay sidecar. Deterministic: identical file contents always
 * produce byte-identical output (stable id-based join order, overlay merge
 * order fixed by recordedAt+seq).
 */
export function loadLedgerWithOverlays(_options: LoadLedgerOptions = {}): MergedRecord[] {
  const liveEstimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const archivedEstimates = readLines<EstimateRecord>(QUARANTINE_ARCHIVE_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const flagRecords = readLines<OverlayRecord>(FLAGS_FILE);
  const labelRecords = readLines<OverlayRecord>(LABELS_FILE);

  // Deterministic join (ticket 18): earliest-reportedAt wins, tie = earliest
  // file order — see joinActualsEarliestReported.
  const actualsMap = joinActualsEarliestReported(actuals);

  const flagsById = resolveOverlayConflicts(flagRecords);
  const labelsById = resolveOverlayConflicts(labelRecords);

  const buildRecord = (est: EstimateRecord, archived: boolean): MergedRecord => {
    const flags = mergeFlagsForId(flagsById.get(est.id));
    const labels = mergeFlagsForId(labelsById.get(est.id));
    return {
      id: est.id,
      tool: est.tool,
      inputs: est.inputs,
      outputs: est.outputs,
      estimatedAt: est.estimatedAt,
      ...(est.source && { source: est.source }),
      ...(est.expiresAt && { expiresAt: est.expiresAt }),
      ...(est.basisVersion !== undefined && { basisVersion: est.basisVersion }),
      ...(actualsMap.has(est.id) && { actual: actualsMap.get(est.id) }),
      flags: { ...flags, taskLabel: labels.taskLabel ?? flags.taskLabel },
      archived,
    };
  };

  return [
    ...liveEstimates.map((e) => buildRecord(e, false)),
    ...archivedEstimates.map((e) => buildRecord(e, true)),
  ];
}

// ---- Advisory write lock (ticket 18, D3 concurrency model) -------------------
//
// An exclusive-create (writeFileSync flag "wx") lockfile serializing the
// check-then-append regions of the write path across processes:
// recordActualDetailed's duplicate check → append, and recordEstimate's dedup
// get-or-create when enabled. Scope is deliberately minimal (single-digit ms):
// the lock wraps only read-check → append, never whole tool calls. Plain
// append-only writes with no read-check (telemetry, overlay records) stay
// lock-free — two concurrent appenders only ever add lines.
//
// Staleness & recovery: the lockfile carries { owner, pid, acquiredAt, token }.
// A lock is STALE when its mtime age exceeds the stale window (default 30s,
// EPOCH_LOCK_STALE_MS) or its owner PID is no longer alive
// (process.kill(pid, 0) → ESRCH). Stale locks are removed automatically by the
// next acquirer. The documented MANUAL recovery path (surfaced verbatim in
// data_status) is: verify the PID is gone, then delete `<ledger-file>.lock`.
// Release is token-matched so a slow holder that outlived a staleness steal
// cannot delete a newer owner's lock.
//
// Failure mode: this is an ADVISORY lock. If the lockfile cannot be created
// for infrastructure reasons (node:fs partially mocked in unit tests, unusual
// permissions), the guarded section runs UNLOCKED rather than failing closed —
// in those environments the append itself fails loudly and propagates
// (write_failed / null) when the filesystem is genuinely unusable. Contention
// with a live holder, by contrast, waits up to the timeout (default 2s,
// EPOCH_LOCK_TIMEOUT_MS) and then fails the write.

/** Default staleness window: a lockfile older than this (or with a dead owner PID) is stealable. */
export const LEDGER_WRITE_LOCK_STALE_MS = 30_000;
/** Default contention timeout: how long an acquirer waits for a live holder before failing. */
export const LEDGER_WRITE_LOCK_TIMEOUT_MS = 2_000;

export interface ExclusiveLockOptions {
  /** Lockfile age above which the lock is stealable (default EPOCH_LOCK_STALE_MS / 30s). */
  staleMs?: number;
  /** How long to wait for a live holder. 0 = single attempt (migrations throw immediately when held). */
  timeoutMs?: number;
  /** Retry cadence while waiting (default 25ms). */
  retryMs?: number;
}

export interface ExclusiveLockAcquisition {
  ok: boolean;
  lockPath: string;
  /** Ownership token; non-null only on success. Release only removes a matching token. */
  token: string | null;
  /** True when at least one stale lockfile was detected and removed to recover. */
  recoveredStale: boolean;
  /** Failure reason: "held" = live holder outlasted the timeout; "unavailable" = lock infrastructure error. */
  reason?: "held" | "unavailable";
}

/** Observed state of one lockfile, for data_status surfacing. */
export interface LedgerWriteLockInfo {
  path: string;
  present: boolean;
  pid: number | null;
  owner: string | null;
  acquiredAt: string | null;
  ageMs: number | null;
  /** True when the next acquirer would steal this lock (dead PID or age > stale window). */
  stale: boolean;
  /** Documented recovery path, verbatim for data_status output. */
  recovery: string;
}

interface LockFileContent {
  owner?: unknown;
  pid?: unknown;
  acquiredAt?: unknown;
  token?: unknown;
}

function lockEnvInt(name: string): number | null {
  const raw = process.env[name];
  if (raw === undefined) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** A pid is "alive" when signal 0 is deliverable; EPERM means alive but owned by another user. */
function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException | null)?.code === "EPERM";
  }
}

function readLockFile(lockPath: string): { parsed: LockFileContent | null; ageMs: number | null } {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    return { parsed: null, ageMs: null };
  }
  let parsed: LockFileContent | null;
  try {
    parsed = JSON.parse(raw) as LockFileContent;
  } catch {
    parsed = null;
  }
  let ageMs: number | null = null;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    /* age unknown — staleness then rests on the PID check alone */
  }
  return { parsed, ageMs };
}

function isStaleLock(parsed: LockFileContent | null, ageMs: number | null, staleMs: number): boolean {
  if (parsed && typeof parsed.pid === "number" && !pidAlive(parsed.pid)) return true;
  if (ageMs !== null && ageMs > staleMs) return true;
  return false;
}

/** Absolute lockfile path for a ledger filename: `<dataDir>/<filename>.lock`. */
export function ledgerWriteLockPath(filename: string): string {
  return join(dataDir(), `${filename}.lock`);
}

/**
 * Acquire an exclusive advisory lock at an absolute path (exclusive-create +
 * staleness steal + bounded wait). Returns a failed acquisition on timeout or
 * infrastructure error — callers decide whether to fail the write (feedback.ts)
 * or throw (migrations' quiesce lock, which refuses to run concurrently).
 */
export function acquireExclusiveFileLock(lockPath: string, owner: string, options: ExclusiveLockOptions = {}): ExclusiveLockAcquisition {
  const staleMs = options.staleMs ?? lockEnvInt("EPOCH_LOCK_STALE_MS") ?? LEDGER_WRITE_LOCK_STALE_MS;
  const timeoutMs = options.timeoutMs ?? lockEnvInt("EPOCH_LOCK_TIMEOUT_MS") ?? LEDGER_WRITE_LOCK_TIMEOUT_MS;
  const retryMs = options.retryMs ?? 25;

  try {
    const dir = dirname(lockPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  } catch {
    /* best effort — creation below reports real errors */
  }

  const token = randomUUID();
  const payload =
    JSON.stringify({ owner, pid: process.pid, acquiredAt: new Date().toISOString(), token }, null, 2) + "\n";
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let recoveredStale = false;
  let steals = 0;

  for (;;) {
    try {
      writeFileSync(lockPath, payload, { flag: "wx" });
      return { ok: true, lockPath, token, recoveredStale };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code !== "EEXIST") {
        // Infrastructure unavailable (fs functions mocked/absent, EACCES, ...).
        // Advisory fail-open — see the section comment; real write errors still
        // propagate from the append itself.
        debugLog("ledger.lock-unavailable", `could not create ${lockPath}: ${code ?? String(err)}`);
        return { ok: false, lockPath, token: null, recoveredStale, reason: "unavailable" };
      }
    }

    const { parsed, ageMs } = readLockFile(lockPath);
    if (isStaleLock(parsed, ageMs, staleMs) && steals < 3) {
      try {
        unlinkSync(lockPath);
        recoveredStale = true;
        ledgerStaleRecoveries++;
        steals++;
        continue; // immediately retry the exclusive create
      } catch {
        /* raced another stealer — fall through to the wait/deadline path */
      }
    }

    if (Date.now() >= deadline) {
      return { ok: false, lockPath, token: null, recoveredStale, reason: "held" };
    }
    sleepSync(Math.max(1, Math.min(retryMs, deadline - Date.now())));
  }
}

/** Release a lock acquired by {@link acquireExclusiveFileLock}. Token-matched: never removes another owner's lock. */
export function releaseExclusiveFileLock(lockPath: string, token: string | null): void {
  if (!token) return;
  try {
    const raw = readFileSync(lockPath, "utf-8");
    const parsed = JSON.parse(raw) as LockFileContent;
    if (parsed?.token === token) unlinkSync(lockPath);
  } catch {
    /* best effort */
  }
}

/**
 * Run `fn` while holding the ledger write lock for `filename`
 * (`<dataDir>/<filename>.lock`). Releases in a finally. Throws
 * LedgerLockTimeoutError when a live holder outlasts the timeout; runs
 * UNLOCKED (advisory fail-open) when the lock infrastructure is unavailable.
 */
export function withLedgerWriteLock<T>(filename: string, fn: () => T, owner = "epoch"): T {
  const acquisition = acquireExclusiveFileLock(ledgerWriteLockPath(filename), owner);
  if (!acquisition.ok) {
    if (acquisition.reason === "unavailable") return fn();
    throw new LedgerLockTimeoutError(acquisition.lockPath);
  }
  try {
    return fn();
  } finally {
    releaseExclusiveFileLock(acquisition.lockPath, acquisition.token);
  }
}

/** Thrown by withLedgerWriteLock when a live holder outlasts the contention timeout. */
export class LedgerLockTimeoutError extends Error {
  constructor(public readonly lockPath: string) {
    super(`Ledger write lock still held after timeout: ${lockPath}`);
    this.name = "LedgerLockTimeoutError";
  }
}

/** Process-lifetime count of stale lockfiles detected and removed (ticket 18 observability). */
let ledgerStaleRecoveries = 0;

/** How many stale lockfiles this process has recovered (surfaced in data_status). */
export function getLedgerStaleRecoveryCount(): number {
  return ledgerStaleRecoveries;
}

/** Inspect a ledger file's write lock for data_status: presence, owner, age, staleness, recovery path. */
export function inspectLedgerWriteLock(filename: string, staleMs?: number): LedgerWriteLockInfo {
  const lockPath = ledgerWriteLockPath(filename);
  const staleWindow = staleMs ?? lockEnvInt("EPOCH_LOCK_STALE_MS") ?? LEDGER_WRITE_LOCK_STALE_MS;
  const { parsed, ageMs } = readLockFile(lockPath);
  const present = parsed !== null;
  if (!present) {
    // Distinguish "no lockfile" from "unreadable": a read error means absent
    // for advisory purposes (next acquirer recreates it).
    try {
      statSync(lockPath);
    } catch {
      return {
        path: lockPath,
        present: false,
        pid: null,
        owner: null,
        acquiredAt: null,
        ageMs: null,
        stale: false,
        recovery: `No write lock held. If a stale ${lockPath} ever blocks writes, verify the PID inside it is gone, then delete it.`,
      };
    }
  }
  const pid = parsed && typeof parsed.pid === "number" ? parsed.pid : null;
  const lockOwner = parsed && typeof parsed.owner === "string" ? parsed.owner : null;
  const acquiredAt = parsed && typeof parsed.acquiredAt === "string" ? parsed.acquiredAt : null;
  const stale = isStaleLock(parsed, ageMs, staleWindow);
  const ageLabel = ageMs !== null ? `${Math.round(ageMs / 100) / 10}s` : "unknown age";
  const pidLabel = pid !== null ? `PID ${pid}` : "unknown PID";
  return {
    path: lockPath,
    present: true,
    pid,
    owner: lockOwner,
    acquiredAt,
    ageMs,
    stale,
    recovery: stale
      ? `Stale write lock (${pidLabel}, ${ageLabel}) — it will be removed automatically on the next locked write, or delete ${lockPath} manually after verifying the owner is gone.`
      : `Write lock held by ${pidLabel} (${ageLabel}). If that process is no longer running, wait for the staleness window (${Math.round(staleWindow / 1000)}s) or delete ${lockPath} manually.`,
  };
}
