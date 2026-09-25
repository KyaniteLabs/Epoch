// ---------------------------------------------------------------------------
// Model calibration table — stamped bundled data (S4.1 model-table freshness)
//
// The latency/throughput table previously lived as inline constants in
// src/lib/analytics.ts (MODEL_CALIBRATIONS). It is now shipped as stamped
// DATA (data/model-calibrations.json): every entry carries `measured_at`
// (ISO date the values were last set/measured) and `provenance` (kind +
// source). Placeholder entries (figures copied from a same-tier sibling,
// not primary-source verified) are explicitly marked as such.
//
// Loading follows the supplementary-data.ts convention: an override in the
// user data dir ($EPOCH_DATA_DIR/model-calibrations.json, default
// ~/.epoch/model-calibrations.json) shadows the bundled table — this is the
// community refresh-between-releases path — and a corrupt override falls
// through to the bundled table rather than silently disabling calibration.
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** How a table entry's values came to be. Drives honesty surfaces. */
export type ModelCalibrationProvenanceKind =
  | "curated" // curated aggregate from the supplementary-DB llmBenchmarks source class
  | "placeholder" // figures copied from a same-tier sibling — NOT primary-source verified
  | "public_source" // refreshed from an approved public zero-cost benchmark/spec page
  | "community"; // refreshed from a community record (data/schemas/model-calibration.schema.json)

export interface ModelCalibrationProvenanceStamp {
  readonly kind: ModelCalibrationProvenanceKind;
  /** Citation for the values: sibling model id, source class, or public page. */
  readonly source: string;
  /** Optional honesty note (placeholders carry "NOT primary-source verified …"). */
  readonly note?: string;
}

/** A stamped calibration entry — the numeric fields consumers read, plus stamps. */
export interface StampedModelCalibration {
  readonly tokensPerSecond: number;
  readonly reasoningOverheadMs: number;
  readonly toolCallLatencyMs: number;
  /** ISO date (YYYY-MM-DD) the entry's values were last set or measured. */
  readonly measured_at: string;
  readonly provenance: ModelCalibrationProvenanceStamp;
}

export interface ModelCalibrationTable {
  readonly version: number;
  /** ISO date (YYYY-MM-DD) of the last VALUE refresh (max entry measured_at). */
  readonly refreshed_at: string;
  readonly description?: string;
  readonly sources?: Record<string, string>;
  readonly staleness_threshold_days?: number;
  readonly models: Record<string, StampedModelCalibration>;
}

/** Age at which calibration data is surfaced as stale (matches the tripwire). */
export const MODEL_CALIBRATION_STALENESS_THRESHOLD_DAYS = 90;

// ---- Lazy Singleton Loader ------------------------------------------------

let _table: ModelCalibrationTable | null | undefined = undefined;
let _tablePath: string | null = null;

function getDataDir(): string {
  return process.env.EPOCH_DATA_DIR ?? join(homedir(), ".epoch");
}

/**
 * Parse and structurally validate a table. Returns null on any violation —
 * the loader treats a corrupt file the same as a missing one (fall through
 * to the next candidate path) and the refresh script treats it as fatal.
 */
export function parseModelCalibrationTable(raw: string): ModelCalibrationTable | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const t = parsed as Record<string, unknown>;
  if (typeof t.version !== "number") return null;
  if (typeof t.refreshed_at !== "string" || !ISO_DATE_RE.test(t.refreshed_at)) return null;
  if (typeof t.models !== "object" || t.models === null) return null;

  const models: Record<string, StampedModelCalibration> = {};
  for (const [id, entry] of Object.entries(t.models as Record<string, unknown>)) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.tokensPerSecond !== "number" || !(e.tokensPerSecond > 0)) return null;
    if (typeof e.reasoningOverheadMs !== "number" || e.reasoningOverheadMs < 0) return null;
    if (typeof e.toolCallLatencyMs !== "number" || e.toolCallLatencyMs < 0) return null;
    if (typeof e.measured_at !== "string" || !ISO_DATE_RE.test(e.measured_at)) return null;
    if (typeof e.provenance !== "object" || e.provenance === null) return null;
    const p = e.provenance as Record<string, unknown>;
    if (!VALID_KINDS.has(p.kind as ModelCalibrationProvenanceKind)) return null;
    if (typeof p.source !== "string" || p.source.length === 0) return null;
    if (p.note !== undefined && typeof p.note !== "string") return null;
    models[id] = {
      tokensPerSecond: e.tokensPerSecond,
      reasoningOverheadMs: e.reasoningOverheadMs,
      toolCallLatencyMs: e.toolCallLatencyMs,
      measured_at: e.measured_at,
      provenance: {
        kind: p.kind as ModelCalibrationProvenanceKind,
        source: p.source,
        ...(p.note !== undefined ? { note: p.note } : {}),
      },
    };
  }
  return {
    version: t.version,
    refreshed_at: t.refreshed_at,
    ...(typeof t.description === "string" ? { description: t.description } : {}),
    ...(isStringRecord(t.sources) ? { sources: t.sources } : {}),
    ...(typeof t.staleness_threshold_days === "number" ? { staleness_threshold_days: t.staleness_threshold_days } : {}),
    models,
  };
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_KINDS = new Set<ModelCalibrationProvenanceKind>(["curated", "placeholder", "public_source", "community"]);

function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== "object" || v === null) return false;
  return Object.values(v).every((x) => typeof x === "string");
}

/** Resolve a UTC-midnight epoch (ms) for a YYYY-MM-DD stamp; null when unparseable. */
function isoDateToEpochMs(iso: string): number | null {
  if (!ISO_DATE_RE.test(iso)) return null;
  const ms = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/** Whole days between a YYYY-MM-DD stamp and `now` (UTC); null when unparseable. */
export function daysSinceIsoDate(iso: string, now: Date = new Date()): number | null {
  const then = isoDateToEpochMs(iso);
  if (then === null) return null;
  const nowMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.floor((nowMs - then) / 86_400_000);
}

/** Table age in days (time since the last VALUE refresh); null when unstamped/unparseable. */
export function modelTableAgeDays(table: ModelCalibrationTable, now: Date = new Date()): number | null {
  return daysSinceIsoDate(table.refreshed_at, now);
}

/** Entry age in days (time since the entry's values were last set/measured). */
export function modelEntryAgeDays(entry: StampedModelCalibration, now: Date = new Date()): number | null {
  return daysSinceIsoDate(entry.measured_at, now);
}

/** Stale iff the age is known AND exceeds the 90d threshold. Unknown age is NOT stale (it is unstamped, surfaced separately). */
export function isStaleAge(ageDays: number | null, thresholdDays: number = MODEL_CALIBRATION_STALENESS_THRESHOLD_DAYS): boolean {
  return ageDays !== null && ageDays > thresholdDays;
}

// ---- Loader ----------------------------------------------------------------

export interface LoadedModelCalibrationTable {
  readonly table: ModelCalibrationTable;
  /** Path the table was read from; "(bundled)" for the repo data/ fallback. */
  readonly path: string;
}

/**
 * Load the stamped calibration table (user-dir override → bundled data/).
 * A structurally invalid user override is skipped, not trusted — the
 * bundled table wins over a corrupt file.
 */
export function loadModelCalibrationTable(): LoadedModelCalibrationTable | null {
  if (_table !== undefined) return _table === null ? null : { table: _table, path: _tablePath ?? "(unknown)" };

  const candidates = [
    join(getDataDir(), "model-calibrations.json"),
    // Dev: src/lib/model-calibration-table.ts → repo root data/
    join(import.meta.dirname, "..", "..", "data", "model-calibrations.json"),
    // Built: dist/chunk-*.js → dist/model-calibrations.json (data/ ships next to dist in the npm tarball layout)
    join(import.meta.dirname, "..", "data", "model-calibrations.json"),
    join(import.meta.dirname, "model-calibrations.json"),
  ];

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const parsed = parseModelCalibrationTable(readFileSync(p, "utf-8"));
      if (parsed) {
        _table = parsed;
        _tablePath = p;
        return { table: parsed, path: p };
      }
    } catch {
      // unreadable/corrupt candidate — fall through to the next
    }
  }

  _table = null;
  _tablePath = null;
  return null;
}

/** Test hook: clear the lazy singleton (mirrors resetSupplementaryCache). */
export function resetModelCalibrationTableCache(): void {
  _table = undefined;
  _tablePath = null;
}

/** The stamped entries keyed by model id (empty record when no table loads). */
export function getBundledModelCalibrations(): Record<string, StampedModelCalibration> {
  return loadModelCalibrationTable()?.table.models ?? {};
}

/** Model ids whose entries are explicit placeholders (sibling copies). */
export function getPlaceholderModelIds(): string[] {
  return Object.entries(getBundledModelCalibrations())
    .filter(([, e]) => e.provenance.kind === "placeholder")
    .map(([id]) => id)
    .sort();
}
