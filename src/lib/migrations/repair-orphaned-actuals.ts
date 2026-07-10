// ---------------------------------------------------------------------------
// Epoch Migration — Repair Orphaned Actuals (Phase 2 Task 2)
// ---------------------------------------------------------------------------
//
// Re-links feedback rows whose estimateId matches no estimate on file.
//
// Exact re-link key: canonicalTool(tool) + inputsSignature (stable hash of
// normalized inputs) + timestamp within a configurable window (default 24h)
// — matched against PENDING (unmatched) estimates only. Collision policy:
// exactly one candidate => re-link; zero or >1 candidates => leave orphaned,
// never guess. Unresolved remainder is retained for audit (never silently
// dropped, never rewritten).
//
// Mechanism: an orphan actual's `estimateId` is a fabricated/garbled
// placeholder — no estimate row exists to attach a quarantine-style overlay
// flag to (loadLedgerWithOverlays() joins overlays against estimate ids, not
// actual ids). Overlay-only expression is therefore not available for the
// relink itself, so per the plan's fallback ("if in-place needed, use
// quiesce+tmp+rename"), a successful single-candidate relink is expressed as
// an in-place rewrite of feedback.jsonl's `estimateId` field for that one
// row, under the quiesce lock + backup + atomic tmp+rename. Unresolved rows
// are never written — they are reported for audit only.
//
// Thin CLI wrapper: scripts/repair-orphaned-actuals.mjs
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 2.
//
// Rollback: restore the printed backupPath over feedback.jsonl.

import { createHash } from "node:crypto";
import { readLines, ESTIMATES_FILE, ACTUALS_FILE, type EstimateRecord, type ActualRecord } from "../ledger.js";
import { canonicalizeToolName } from "../tool-aliases.js";
import { acquireQuiesceLock, releaseQuiesceLock, atomicWriteJsonl, backupFile, migrationStamp, type MigrationMode } from "./shared.js";

const DEFAULT_WINDOW_HOURS = 24;

export interface RepairOptions {
  mode: MigrationMode;
  windowHours?: number;
}

export interface RelinkedActual {
  orphanEstimateId: string;
  relinkedToEstimateId: string;
  tool: string;
}

export interface UnresolvedOrphan {
  orphanEstimateId: string;
  candidateCount: number;
  reason: "zero_candidates" | "multiple_candidates";
}

export interface RepairReport {
  mode: MigrationMode;
  windowHours: number;
  totalOrphans: number;
  relinked: RelinkedActual[];
  unresolved: UnresolvedOrphan[];
  written: number;
  backupPath: string | null;
}

/** Loosely-typed legacy actual shape: some historical rows carry extra tool/inputs context beyond the declared ActualRecord fields. */
interface LegacyActualExtras {
  tool?: unknown;
  inputs?: unknown;
  taskType?: unknown;
  complexity?: unknown;
}

function normalizeInputs(inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(inputs).sort()) {
    const v = inputs[key];
    out[key] = typeof v === "string" ? v.trim().toLowerCase() : v;
  }
  return out;
}

function stableHash(value: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

/** Derive an inputsSignature from whatever context an orphan actual carries — literal `inputs`, or the legacy taskType/complexity fields, or none. */
function orphanInputsSignature(orphan: ActualRecord): string | null {
  const extras = orphan as unknown as LegacyActualExtras;
  if (extras.inputs && typeof extras.inputs === "object") {
    return stableHash(normalizeInputs(extras.inputs as Record<string, unknown>));
  }
  if (extras.taskType !== undefined || extras.complexity !== undefined) {
    return stableHash(normalizeInputs({ task_type: extras.taskType, complexity: extras.complexity }));
  }
  return null;
}

function orphanToolFilter(orphan: ActualRecord): string | null {
  const extras = orphan as unknown as LegacyActualExtras;
  if (typeof extras.tool === "string") return canonicalizeToolName(extras.tool);
  return null;
}

export function runRepairOrphanedActuals(options: RepairOptions): RepairReport {
  const windowHours = options.windowHours ?? DEFAULT_WINDOW_HOURS;
  const windowMs = windowHours * 3_600_000;

  const estimates = readLines<EstimateRecord>(ESTIMATES_FILE);
  const actuals = readLines<ActualRecord>(ACTUALS_FILE);
  const estIds = new Set(estimates.map((e) => e.id));
  const matchedEstimateIds = new Set(actuals.map((a) => a.estimateId));
  const orphans = actuals.filter((a) => !estIds.has(a.estimateId));
  const pendingEstimates = estimates.filter((e) => !matchedEstimateIds.has(e.id));

  const relinked: RelinkedActual[] = [];
  const unresolved: UnresolvedOrphan[] = [];

  for (const orphan of orphans) {
    const completedAtRaw = orphan.completedAt ?? orphan.reportedAt;
    const orphanTime = Date.parse(completedAtRaw);
    const toolFilter = orphanToolFilter(orphan);
    const inputsSig = orphanInputsSignature(orphan);

    const candidates = pendingEstimates.filter((e) => {
      const t = Date.parse(e.estimatedAt);
      if (!Number.isFinite(t) || !Number.isFinite(orphanTime)) return false;
      if (Math.abs(t - orphanTime) > windowMs) return false;
      if (toolFilter && canonicalizeToolName(e.tool) !== toolFilter) return false;
      if (inputsSig && stableHash(normalizeInputs(e.inputs)) !== inputsSig) return false;
      return true;
    });

    if (candidates.length === 1) {
      const only = candidates[0];
      if (only) {
        relinked.push({ orphanEstimateId: orphan.estimateId, relinkedToEstimateId: only.id, tool: only.tool });
      }
    } else {
      unresolved.push({
        orphanEstimateId: orphan.estimateId,
        candidateCount: candidates.length,
        reason: candidates.length === 0 ? "zero_candidates" : "multiple_candidates",
      });
    }
  }

  let written = 0;
  let backupPath: string | null = null;

  if (options.mode === "apply" && relinked.length > 0) {
    const stamp = migrationStamp();
    acquireQuiesceLock("repair-orphaned-actuals");
    try {
      backupPath = backupFile(ACTUALS_FILE, stamp);
      const relinkMap = new Map(relinked.map((r) => [r.orphanEstimateId, r.relinkedToEstimateId]));
      // Re-read fresh under the lock so a concurrent appender's rows aren't lost.
      const freshActuals = readLines<ActualRecord>(ACTUALS_FILE);
      const updated = freshActuals.map((a) => {
        const target = relinkMap.get(a.estimateId);
        if (target === undefined) return a;
        written++;
        return { ...a, estimateId: target };
      });
      atomicWriteJsonl(ACTUALS_FILE, updated);
    } finally {
      releaseQuiesceLock();
    }
  }

  return { mode: options.mode, windowHours, totalOrphans: orphans.length, relinked, unresolved, written, backupPath };
}
