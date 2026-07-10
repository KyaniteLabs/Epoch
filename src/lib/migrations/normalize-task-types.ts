// ---------------------------------------------------------------------------
// Epoch Migration — Normalize Task Types (Phase 2 Task 4)
// ---------------------------------------------------------------------------
//
// Maps free-text task types (e.g. "resume-job-search-takeover-packet",
// "pricing_strategy", "website_offer_surface", "writing_system",
// "revenue_copy") to the nearest canonical taskTypeEnum value, preserving
// the original as `taskTypeRaw`. Overlay-only (estimates.tasktype.jsonl) —
// never rewrites estimates.jsonl's `inputs.task_type`.
//
// Thin CLI wrapper: scripts/normalize-task-types.mjs
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §3 Phase 2 Task 4.
//
// Rollback: delete the appended lines from estimates.tasktype.jsonl (the
// last N lines), or restore the printed backupPath.

import { loadLedgerWithOverlays, readLines } from "../ledger.js";
import { appendOverlay, backupFile, migrationStamp, type MigrationMode } from "./shared.js";
import type { OverlayRecord } from "../ledger.js";

/** Overlay sidecar for normalized task types — Phase 2 only; not yet joined by loadLedgerWithOverlays() (that wiring is a later contract-touching step, out of this migration script's scope). */
export const TASKTYPE_FILE = "estimates.tasktype.jsonl";

export const CANONICAL_TASK_TYPES: ReadonlySet<string> = new Set([
  "feature",
  "bugfix",
  "refactor",
  "migration",
  "infrastructure",
  "documentation",
  "testing",
  "design",
]);

const KEYWORD_RULES: ReadonlyArray<{ pattern: RegExp; canonical: string }> = [
  { pattern: /bug|hotfix|patch|\bfix\b/i, canonical: "bugfix" },
  { pattern: /refactor|cleanup|restructur/i, canonical: "refactor" },
  { pattern: /migrat/i, canonical: "migration" },
  { pattern: /infra|deploy|pipeline|devops|hosting|\bserver\b|\bops\b/i, canonical: "infrastructure" },
  { pattern: /\btest\b|\bqa\b|quality/i, canonical: "testing" },
  { pattern: /design|\bux\b|\bui\b|mockup|visual/i, canonical: "design" },
  { pattern: /writing|copy|content|\bdoc\b|resume|article/i, canonical: "documentation" },
];

/** Best-effort keyword classifier from a free-text task type to the nearest canonical bucket. Falls back to "feature" (the generic deliverable bucket) when nothing matches. */
export function normalizeTaskType(raw: string): string {
  if (CANONICAL_TASK_TYPES.has(raw)) return raw;
  for (const rule of KEYWORD_RULES) {
    if (rule.pattern.test(raw)) return rule.canonical;
  }
  return "feature";
}

export interface NormalizeOptions {
  mode: MigrationMode;
}

export interface NormalizeCandidate {
  id: string;
  taskTypeRaw: string;
  taskTypeNormalized: string;
}

export interface NormalizeReport {
  mode: MigrationMode;
  candidateCount: number;
  distinctRawValues: string[];
  sample: NormalizeCandidate[];
  written: number;
  backupPath: string | null;
}

export function runNormalizeTaskTypes(options: NormalizeOptions): NormalizeReport {
  const merged = loadLedgerWithOverlays();
  const alreadyNormalized = new Set(readLines<OverlayRecord>(TASKTYPE_FILE).map((r) => r.id));

  const candidates: NormalizeCandidate[] = [];
  const distinctRaw = new Set<string>();

  for (const rec of merged) {
    if (alreadyNormalized.has(rec.id)) continue; // idempotent
    const raw = rec.inputs["task_type"];
    if (typeof raw !== "string" || CANONICAL_TASK_TYPES.has(raw)) continue;

    distinctRaw.add(raw);
    candidates.push({ id: rec.id, taskTypeRaw: raw, taskTypeNormalized: normalizeTaskType(raw) });
  }

  let written = 0;
  let backupPath: string | null = null;

  if (options.mode === "apply" && candidates.length > 0) {
    backupPath = backupFile(TASKTYPE_FILE, migrationStamp());
    for (const c of candidates) {
      appendOverlay(TASKTYPE_FILE, { id: c.id, taskTypeRaw: c.taskTypeRaw, taskTypeNormalized: c.taskTypeNormalized });
      written++;
    }
  }

  return {
    mode: options.mode,
    candidateCount: candidates.length,
    distinctRawValues: [...distinctRaw].sort(),
    sample: candidates,
    written,
    backupPath,
  };
}
