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

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { TaskType } from "../types/index.js";

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
// writes, so there is no self-write path to invalidate proactively.
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
  try {
    const content = readFileSync(path, "utf-8");
    rows = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as unknown;
        } catch {
          return null;
        }
      })
      .filter((r) => r !== null);
  } catch {
    return [];
  }

  ledgerParseCounts.set(path, (ledgerParseCounts.get(path) ?? 0) + 1);
  if (stat !== null) {
    ledgerCache.set(path, {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ino: stat.ino,
      rows: rows.map(deepFreeze),
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

  const actualsMap = new Map<string, ActualRecord>();
  for (const a of actuals) actualsMap.set(a.estimateId, a);

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
