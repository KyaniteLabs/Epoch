// ---------------------------------------------------------------------------
// Epoch Data Status — Read-only inspection of local Epoch data files
// ---------------------------------------------------------------------------

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import * as os from "node:os";
import { loadConfig, isUsableTelemetryEndpoint } from "./config.js";
import { extractAnonymizedRecords } from "./telemetry-submit.js";
import { loadReferenceDb } from "./self-improve.js";
import { getLedgerCacheStatus } from "./ledger.js";

// ---- Path helpers -----------------------------------------------------------

function dataDir(): string {
  return process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
}

// ---- data where -------------------------------------------------------------

export interface EpochDataPaths {
  dataDir: string;
  config: string;
  estimates: string;
  actuals: string;
  toolTelemetry: string;
  referenceDatabase: string;
  exportsDir: string;
  receiverRecords: string;
  receiverReceipts: string;
  receiverDedupeKeys: string;
}

export function getEpochDataPaths(): EpochDataPaths {
  const dir = dataDir();
  return {
    dataDir: dir,
    config: join(dir, "config.json"),
    estimates: join(dir, "estimates.jsonl"),
    actuals: join(dir, "feedback.jsonl"),
    toolTelemetry: join(dir, "telemetry.jsonl"),
    referenceDatabase: join(dir, "reference-database.json"),
    exportsDir: join(dir, "exports"),
    receiverRecords: join(dir, "telemetry-records.jsonl"),
    receiverReceipts: join(dir, "telemetry-receipts.jsonl"),
    receiverDedupeKeys: join(dir, "telemetry-record-keys.jsonl"),
  };
}

// ---- data status ------------------------------------------------------------

interface FileStatus {
  path: string;
  exists: boolean;
  lines: number;
  /**
   * Ledger read-cache provenance (ticket 17; present on estimates/actuals
   * only — files read through ledger.ts's cached readLines()): epoch-ms of the
   * parse that populated the in-memory cache, or null when this process has
   * not cached the file. The cache is stat-validated on every read, so a
   * growing cacheAgeMs means "file unchanged for that long", never staleness.
   */
  parsedAt?: number | null;
  /** Age of the cached parse in ms (now - parsedAt); null when not cached this process. */
  cacheAgeMs?: number | null;
  /** Total full read+parse executions of this file since process start (cache hits excluded). */
  parses?: number;
}

interface FeedbackSummary {
  totalEstimates: number;
  totalActuals: number;
  matchedPairs: number;
  matchRate: number;
}

interface TelemetrySummary {
  enabled: boolean;
  endpointConfigured: boolean;
  queuedRecords: number;
  lastSubmissionAt: string | null;
  totalRecordsAccepted: number;
  totalRecordsDeduplicated: number;
}

interface ReferenceDatabaseSummary {
  loaded: boolean;
  path: string;
  source: string | null;
  sampleSize: number | null;
  generatedAt: string | null;
}

interface RoleHints {
  hasReceiverRecords: boolean;
  likelyReceiver: boolean;
}

export interface EpochDataStatus {
  dataDir: string;
  exists: boolean;
  machine: {
    hostname: string;
    platform: string;
    arch: string;
  };
  files: {
    estimates: FileStatus;
    actuals: FileStatus;
    toolTelemetry: FileStatus;
    receiverRecords: FileStatus;
    receiverReceipts: FileStatus;
  };
  feedback: FeedbackSummary;
  telemetry: TelemetrySummary;
  referenceDatabase: ReferenceDatabaseSummary;
  roleHints: RoleHints;
}

/** Count lines in a file safely. Returns 0 if file does not exist or on error. */
function countLines(filePath: string): number {
  if (!existsSync(filePath)) return 0;
  try {
    const content = readFileSync(filePath, "utf-8");
    return content.split("\n").filter((line) => line.trim().length > 0).length;
  } catch {
    return 0;
  }
}

/** Check file status (exists + line count) for a JSONL file. */
function fileStatus(filePath: string): FileStatus {
  const exists = existsSync(filePath);
  return {
    path: filePath,
    exists,
    lines: exists ? countLines(filePath) : 0,
  };
}

/**
 * Attach ledger read-cache provenance (ticket 17) to a ledger file's status:
 * how old the cached parse is and how many parses this process performed.
 * Additive/optional — non-ledger files keep the plain FileStatus shape.
 */
function withLedgerCacheInfo(status: FileStatus): FileStatus {
  const entry = getLedgerCacheStatus().get(status.path);
  if (!entry) {
    return { ...status, parsedAt: null, cacheAgeMs: null, parses: 0 };
  }
  return {
    ...status,
    parsedAt: entry.parsedAt,
    cacheAgeMs: entry.parsedAt !== null ? Date.now() - entry.parsedAt : null,
    parses: entry.parses,
  };
}

/** Count estimate IDs that have matching actual records. */
function countMatchedPairs(estimatesPath: string, actualsPath: string): number {
  let estimateIds: Set<string>;
  try {
    const raw = readFileSync(estimatesPath, "utf-8");
    estimateIds = new Set(
      raw.split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line) as { id?: string }; }
          catch { return null; }
        })
        .filter((r): r is { id: string } => r !== null && typeof r.id === "string")
        .map((r) => r.id),
    );
  } catch {
    return 0;
  }

  if (estimateIds.size === 0) return 0;

  let matched = 0;
  try {
    const raw = readFileSync(actualsPath, "utf-8");
    const actualIds = new Set(
      raw.split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try { return JSON.parse(line) as { estimateId?: string }; }
          catch { return null; }
        })
        .filter((r): r is { estimateId: string } => r !== null && typeof r.estimateId === "string")
        .map((r) => r.estimateId),
    );
    for (const id of actualIds) {
      if (estimateIds.has(id)) matched++;
    }
  } catch {
    return 0;
  }

  return matched;
}

export function getEpochDataStatus(): EpochDataStatus {
  const dir = dataDir();
  const dirExists = existsSync(dir);
  const paths = getEpochDataPaths();

  // Machine info
  const machine = {
    hostname: os.hostname(),
    platform: process.platform,
    arch: process.arch,
  };

  // File status
  const estimates = withLedgerCacheInfo(fileStatus(paths.estimates));
  const actuals = withLedgerCacheInfo(fileStatus(paths.actuals));
  const toolTelemetry = fileStatus(paths.toolTelemetry);
  const receiverRecords = fileStatus(paths.receiverRecords);
  const receiverReceipts = fileStatus(paths.receiverReceipts);

  // Feedback summary
  const matchedPairs = countMatchedPairs(paths.estimates, paths.actuals);
  const totalEstimates = estimates.lines;
  const totalActuals = actuals.lines;
  const matchRate = totalEstimates > 0
    ? Math.round((matchedPairs / totalEstimates) * 1000) / 10
    : 0;

  // Telemetry summary — safe, no network calls
  let telemetry: TelemetrySummary;
  try {
    const config = loadConfig();
    const queuedRecords = extractAnonymizedRecords(
      config.telemetry.lastSubmissionAt ?? undefined,
    ).length;
    telemetry = {
      enabled: config.telemetry.enabled,
      endpointConfigured: isUsableTelemetryEndpoint(config.telemetry.endpoint),
      queuedRecords,
      lastSubmissionAt: config.telemetry.lastSubmissionAt,
      totalRecordsAccepted: config.telemetry.totalRecordsAccepted ?? 0,
      totalRecordsDeduplicated: config.telemetry.totalRecordsDeduplicated ?? 0,
    };
  } catch {
    telemetry = {
      enabled: false,
      endpointConfigured: false,
      queuedRecords: 0,
      lastSubmissionAt: null,
      totalRecordsAccepted: 0,
      totalRecordsDeduplicated: 0,
    };
  }

  // Reference database summary
  let referenceDatabase: ReferenceDatabaseSummary;
  try {
    const db = loadReferenceDb();
    if (db) {
      referenceDatabase = {
        loaded: true,
        path: existsSync(paths.referenceDatabase) ? paths.referenceDatabase : "(bundled)",
        source: db.source ?? null,
        sampleSize: db.sampleSize ?? null,
        generatedAt: db.generatedAt ?? null,
      };
    } else {
      referenceDatabase = {
        loaded: false,
        path: paths.referenceDatabase,
        source: null,
        sampleSize: null,
        generatedAt: null,
      };
    }
  } catch {
    referenceDatabase = {
      loaded: false,
      path: paths.referenceDatabase,
      source: null,
      sampleSize: null,
      generatedAt: null,
    };
  }

  // Role hints
  const roleHints: RoleHints = {
    hasReceiverRecords: receiverRecords.exists && receiverRecords.lines > 0,
    likelyReceiver: receiverRecords.exists && receiverRecords.lines > 0,
  };

  return {
    dataDir: dir,
    exists: dirExists,
    machine,
    files: {
      estimates,
      actuals,
      toolTelemetry,
      receiverRecords,
      receiverReceipts,
    },
    feedback: {
      totalEstimates,
      totalActuals,
      matchedPairs,
      matchRate,
    },
    telemetry,
    referenceDatabase,
    roleHints,
  };
}
