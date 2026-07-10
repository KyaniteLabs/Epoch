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

import { existsSync, readFileSync } from "node:fs";
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

/** Read and parse a JSONL file under the Epoch data dir. Missing file / unparsable lines yield []. */
export function readLines<T>(filename: string): T[] {
  const path = join(dataDir(), filename);
  if (!existsSync(path)) return [];
  try {
    const content = readFileSync(path, "utf-8");
    return content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try {
          return JSON.parse(line) as T;
        } catch {
          return null;
        }
      })
      .filter((r): r is T => r !== null);
  } catch {
    return [];
  }
}

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
