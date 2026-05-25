import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { getTelemetry } from "./telemetry.js";
import { getCalibrationData } from "./feedback.js";
import type { HistoricalRecord, TaskType } from "../types/index.js";

const REFERENCE_DB_PATH = resolveReferenceDbPath();

function resolveReferenceDbPath(): string {
  const configuredDataDir = process.env["EPOCH_DATA_DIR"];
  if (configuredDataDir) {
    const configuredPath = join(configuredDataDir, "reference-database.json");
    if (existsSync(configuredPath)) return configuredPath;
  }

  // Prefer user data dir (survives npm updates, no git noise)
  const userDataPath = join(homedir(), ".epoch", "reference-database.json");
  if (existsSync(userDataPath)) return userDataPath;

  // Dev: src/lib/self-improve.ts → src/data/reference-database.json
  const devPath = join(import.meta.dirname, "..", "data", "reference-database.json");
  if (existsSync(devPath)) return devPath;

  // Built: dist/chunk-*.js → dist/reference-database.json
  const distPath = join(import.meta.dirname, "reference-database.json");
  if (existsSync(distPath)) return distPath;

  // Fallback: try project root
  const rootPath = join(import.meta.dirname, "..", "reference-database.json");
  return rootPath;
}

function getUserDataDir(): string {
  const dir = process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}
const MIN_CALLS_FOR_UPDATE = 100;

interface ReferenceDatabase {
  version: string;
  generatedAt: string;
  source: string;
  sampleSize: number;
  description: string;
  toolExecutionBenchmarks: Record<string, ToolBenchmark>;
  modelLatencyProfiles: Record<string, ModelProfile>;
  estimationAccuracy?: {
    taskTypes: Record<string, { correctionFactor: number }>;
    correctionFactors: { byTaskType: Record<string, number>; global: number };
  };
  taskTypeCorrectionFactors: Record<string, number>;
  complexityCorrectionFactors: Record<string, Record<number, number>>;
  toolTaskCorrectionFactors: Record<string, Record<string, number>>;
  tokenTimeCalibration: Record<string, TokenCalibration>;
  globalCorrectionFactor: number;
}

interface ToolBenchmark {
  p50_ms: number;
  p95_ms: number;
  mean_ms: number;
  stddev_ms: number;
  min_ms: number;
  max_ms: number;
  sampleCount: number;
}

export interface ReferenceDbStatus {
  path: string | null;
  loaded: boolean;
  generatedAt: string | null;
  sampleSize: number | null;
  source: string | null;
  globalCorrectionFactor: number | null;
  taskTypeCorrectionFactorCount: number;
  toolTaskCorrectionFactorCount: number;
  complexityCorrectionFactorCount: number;
  
}

interface ModelProfile {
  successRate: number;
  taskSuccessRate?: number;
  e2eLatencyP50: number;
  e2eLatency?: { p50_s: number; p95_s: number; mean_s: number };
  tokensPerRound: number | { mean: number; meanPrompt: number; meanCompletion: number };
  sampleCount?: number;
}

interface TokenCalibration {
  avgTps?: number;
  medianTps?: number;
  avgTokensPerSecond?: number;
  medianTokensPerSecond?: number;
  sampleCount: number;
}

interface ReceivedTelemetryRecord {
  task_type: string;
  complexity: number | null;
  tool: string;
  estimated_hours: number;
  actual_hours: number;
  ratio: number;
  date: string;
  received_at?: string;
}

let callCounter = 0;
let lastUpdateAt = 0;
let isUpdating = false;

export function notifyToolCall(): void {
  callCounter++;
  if (callCounter >= MIN_CALLS_FOR_UPDATE && Date.now() - lastUpdateAt > 86_400_000 && !isUpdating) {
    callCounter = 0;
    lastUpdateAt = Date.now();
    isUpdating = true;
    updateReferenceDatabase().catch(() => {
      // self-improvement is non-critical
    }).finally(() => {
      isUpdating = false;
    });
  }
}

export async function updateReferenceDatabase(): Promise<void> {
  const db = loadReferenceDb();
  if (!db) return;

  const telemetry = getTelemetry();
  const allStats = telemetry.getStats(undefined, 90);

  for (const stat of allStats) {
    const existing = db.toolExecutionBenchmarks[stat.tool];
    if (existing) {
      const merged = mergeBenchmark(existing, stat);
      db.toolExecutionBenchmarks[stat.tool] = merged;
    } else {
      db.toolExecutionBenchmarks[stat.tool] = {
        p50_ms: stat.p50Ms,
        p95_ms: stat.p95Ms,
        mean_ms: stat.meanMs,
        stddev_ms: 0,
        min_ms: stat.p50Ms,
        max_ms: stat.p95Ms,
        sampleCount: stat.callCount,
      };
    }
  }

  const feedbackRecords = getCalibrationData(undefined, undefined, 180);
  const receivedTelemetryRecords = loadReceivedTelemetryRecords();
  const calibrationRecords = [...feedbackRecords, ...receivedTelemetryRecords];
  if (calibrationRecords.length >= 5) {
    const newFactors = computeCorrectionFactors(calibrationRecords);
    for (const [taskType, factor] of Object.entries(newFactors)) {
      db.taskTypeCorrectionFactors[taskType] = factor;
    }
    db.toolTaskCorrectionFactors = computeToolCorrectionFactors(calibrationRecords);
    db.complexityCorrectionFactors = computeComplexityCorrectionFactors(calibrationRecords);
    db.globalCorrectionFactor = computeGlobalCorrection(calibrationRecords);
  }

  const feedbackSize = feedbackRecords.length;
  const receivedTelemetrySize = receivedTelemetryRecords.length;
  const telemetrySize = allStats.reduce((s, t) => s + t.callCount, 0);
  db.sampleSize += telemetrySize + feedbackSize + receivedTelemetrySize;
  db.generatedAt = new Date().toISOString();
  db.source = "self-improvement";

  // Write to user data dir (~/.epoch/) — never mutate source tree
  const dataDir = getUserDataDir();
  const targetPath = join(dataDir, "reference-database.json");
  const tmpPath = join(dataDir, "reference-database.json.tmp");
  writeFileSync(tmpPath, JSON.stringify(db, null, 2), "utf-8");
  renameSync(tmpPath, targetPath);
  invalidateReferenceDbCache();
}

function loadReceivedTelemetryRecords(): HistoricalRecord[] {
  const path = join(getUserDataDir(), "telemetry-records.jsonl");
  if (!existsSync(path)) return [];

  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as unknown)
      .filter(isReceivedTelemetryRecord)
      .map((record): HistoricalRecord => ({
        taskType: record.task_type,
        estimatedHours: record.estimated_hours,
        actualHours: record.actual_hours,
        tool: record.tool,
        complexity: record.complexity ?? undefined,
        completedAt: record.date,
      }));
  } catch {
    return [];
  }
}

function isReceivedTelemetryRecord(value: unknown): value is ReceivedTelemetryRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["task_type"] === "string" &&
    (typeof record["complexity"] === "number" || record["complexity"] === null) &&
    typeof record["tool"] === "string" &&
    typeof record["estimated_hours"] === "number" &&
    Number.isFinite(record["estimated_hours"]) &&
    record["estimated_hours"] > 0 &&
    typeof record["actual_hours"] === "number" &&
    Number.isFinite(record["actual_hours"]) &&
    record["actual_hours"] > 0 &&
    typeof record["ratio"] === "number" &&
    Number.isFinite(record["ratio"]) &&
    typeof record["date"] === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(record["date"])
  );
}

let _cachedDb: ReferenceDatabase | null | undefined;
let _cachedDbAt = 0;
const DB_CACHE_TTL = 60_000;

export function loadReferenceDb(): ReferenceDatabase | null {
  if (_cachedDb !== undefined && Date.now() - _cachedDbAt < DB_CACHE_TTL) return _cachedDb;
  try {
    const content = readFileSync(REFERENCE_DB_PATH, "utf-8");
    _cachedDb = JSON.parse(content) as ReferenceDatabase;
    _cachedDbAt = Date.now();
    return _cachedDb;
  } catch {
    _cachedDb = null;
    _cachedDbAt = Date.now();
    return null;
  }
}

export function invalidateReferenceDbCache(): void {
  _cachedDb = undefined;
  _cachedDbAt = 0;
}

const _cachedDbPath: string | null = REFERENCE_DB_PATH;

export function getReferenceDbStatus(): ReferenceDbStatus {
  const db = loadReferenceDb();
  if (!db) {
    return {
      path: null,
      loaded: false,
      generatedAt: null,
      sampleSize: null,
      source: null,
      globalCorrectionFactor: null,
      taskTypeCorrectionFactorCount: 0,
      toolTaskCorrectionFactorCount: 0,
      complexityCorrectionFactorCount: 0,
      
    };
  }

  return {
    path: _cachedDbPath,
    loaded: true,
    generatedAt: db.generatedAt ?? null,
    sampleSize: db.sampleSize ?? null,
    source: db.source ?? null,
    globalCorrectionFactor: db.globalCorrectionFactor ?? null,
    taskTypeCorrectionFactorCount: Object.keys(db.taskTypeCorrectionFactors ?? {}).length,
    toolTaskCorrectionFactorCount: Object.keys(db.toolTaskCorrectionFactors ?? {}).length,
    complexityCorrectionFactorCount: Object.keys(db.complexityCorrectionFactors ?? {}).length,
    
  };
}

export function getTaskTypeCorrectionFactor(taskType: TaskType): number {
  const db = loadReferenceDb();
  if (!db) return 1.8;

  // Check taskTypeCorrectionFactors first (updated by self-improvement)
  if (db.taskTypeCorrectionFactors?.[taskType]) {
    return db.taskTypeCorrectionFactors[taskType];
  }

  // Check estimationAccuracy from canary data
  if (db.estimationAccuracy?.correctionFactors?.byTaskType) {
    // Map taskType to canary task categories
    const canaryKey = mapToCanaryKey(taskType);
    const factor = db.estimationAccuracy.correctionFactors.byTaskType[canaryKey];
    if (factor) return factor;
  }

  if (db.estimationAccuracy?.taskTypes) {
    const canaryKey = mapToCanaryKey(taskType);
    const entry = db.estimationAccuracy.taskTypes[canaryKey];
    if (entry?.correctionFactor) return entry.correctionFactor;
  }

  return 1.8;
}

export function getToolTaskCorrectionFactor(tool: string, taskType: TaskType): number {
  const db = loadReferenceDb();
  if (!db?.toolTaskCorrectionFactors) return getTaskTypeCorrectionFactor(taskType);

  const toolFactors = db.toolTaskCorrectionFactors[tool];
  if (toolFactors?.[taskType]) return toolFactors[taskType];

  // Fallback to aggregate task-type factor
  return getTaskTypeCorrectionFactor(taskType);
}

export function getComplexityCorrectionFactor(taskType: TaskType, complexity: number): number | null {
  const db = loadReferenceDb();
  if (!db?.complexityCorrectionFactors) return null;

  const typeFactors = db.complexityCorrectionFactors[taskType];
  if (typeFactors?.[complexity]) return typeFactors[complexity];

  return null;
}

function mapToCanaryKey(taskType: string): string {
  const mapping: Record<string, string> = {
    feature: "pert_estimation",
    bugfix: "calendar_calculation",
    refactor: "cocomo_estimation",
    migration: "cocomo_estimation",
    infrastructure: "token_time_bridge",
    documentation: "other",
    testing: "calibration",
    design: "reference_class",
  };
  return mapping[taskType] ?? taskType;
}

export function getGlobalCorrectionFactor(): number {
  const db = loadReferenceDb();
  return db?.globalCorrectionFactor ?? 1.07;
}

function mergeBenchmark(existing: ToolBenchmark, stat: { p50Ms: number; p95Ms: number; meanMs: number; callCount: number }): ToolBenchmark {
  const totalExisting = existing.sampleCount;
  const totalNew = stat.callCount;
  const total = totalExisting + totalNew;

  const w = totalExisting / total;
  const w2 = totalNew / total;

  return {
    p50_ms: Math.round((existing.p50_ms * w + stat.p50Ms * w2) * 100) / 100,
    p95_ms: Math.round((existing.p95_ms * w + stat.p95Ms * w2) * 100) / 100,
    mean_ms: Math.round((existing.mean_ms * w + stat.meanMs * w2) * 100) / 100,
    stddev_ms: Math.round(Math.sqrt((existing.stddev_ms ** 2) * w + (stat.p95Ms - stat.p50Ms) ** 2 * w2) * 100) / 100,
    min_ms: Math.round(Math.min(existing.min_ms, stat.p50Ms * 0.5) * 100) / 100,
    max_ms: Math.round(Math.max(existing.max_ms, stat.p95Ms * 1.5) * 100) / 100,
    sampleCount: total,
  };
}

function computeCorrectionFactors(records: HistoricalRecord[]): Record<string, number> {
  const grouped = new Map<string, number[]>();
  for (const r of records) {
    if (r.estimatedHours <= 0 || r.actualHours <= 0) continue;
    const arr = grouped.get(r.taskType) ?? [];
    arr.push(r.actualHours / r.estimatedHours);
    grouped.set(r.taskType, arr);
  }

  const factors: Record<string, number> = {};
  for (const [type, ratios] of grouped) {
    if (ratios.length < 3) continue;
    ratios.sort((a, b) => a - b);
    const mid = Math.floor(ratios.length / 2);
    const median = ratios.length % 2 === 0
      ? ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2
      : (ratios[mid] ?? 1.8);
    factors[type] = Math.round(Math.min(3.0, Math.max(0.1, median)) * 100) / 100;
  }

  return factors;
}

function computeGlobalCorrection(records: HistoricalRecord[]): number {
  if (records.length === 0) return 1.07;
  const valid = records.filter((r) => r.estimatedHours > 0 && r.actualHours > 0);
  if (valid.length === 0) return 1.07;
  const ratios = valid.map((r) => r.actualHours / r.estimatedHours);
  ratios.sort((a, b) => a - b);
  const mid = Math.floor(ratios.length / 2);
  const median = ratios.length % 2 === 0
    ? ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2
    : (ratios[mid] ?? 1.07);
  return Math.round(Math.min(3.0, Math.max(0.1, median)) * 100) / 100;
}

function computeToolCorrectionFactors(records: HistoricalRecord[]): Record<string, Record<string, number>> {
  const grouped = new Map<string, Map<string, number[]>>();
  for (const r of records) {
    if (r.estimatedHours <= 0 || r.actualHours <= 0) continue;
    const tool = r.tool ?? "unknown";
    if (!grouped.has(tool)) grouped.set(tool, new Map());
    const taskMap = grouped.get(tool)!;
    const arr = taskMap.get(r.taskType) ?? [];
    arr.push(r.actualHours / r.estimatedHours);
    taskMap.set(r.taskType, arr);
  }

  const result: Record<string, Record<string, number>> = {};
  for (const [tool, taskMap] of grouped) {
    result[tool] = {};
    for (const [taskType, ratios] of taskMap) {
      if (ratios.length < 3) continue;
      ratios.sort((a, b) => a - b);
      const mid = Math.floor(ratios.length / 2);
      const median = ratios.length % 2 === 0
        ? ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2
        : (ratios[mid] ?? 1.4);
      result[tool][taskType] = Math.round(Math.min(3.0, Math.max(0.1, median)) * 100) / 100;
    }
  }
  return result;
}

function computeComplexityCorrectionFactors(records: HistoricalRecord[]): Record<string, Record<number, number>> {
  const grouped = new Map<string, Map<number, number[]>>();
  for (const r of records) {
    if (r.estimatedHours <= 0 || r.actualHours <= 0) continue;
    if (r.complexity === undefined) continue;
    const taskMap = grouped.get(r.taskType) ?? new Map();
    const arr = taskMap.get(r.complexity) ?? [];
    arr.push(r.actualHours / r.estimatedHours);
    taskMap.set(r.complexity, arr);
    grouped.set(r.taskType, taskMap);
  }

  const result: Record<string, Record<number, number>> = {};
  for (const [taskType, taskMap] of grouped) {
    result[taskType] = {};
    for (const [complexity, ratios] of taskMap) {
      if (ratios.length < 3) continue;
      ratios.sort((a, b) => a - b);
      const mid = Math.floor(ratios.length / 2);
      const median = ratios.length % 2 === 0
        ? ((ratios[mid - 1] ?? 0) + (ratios[mid] ?? 0)) / 2
        : (ratios[mid] ?? 1.0);
      result[taskType][complexity] = Math.round(Math.min(3.0, Math.max(0.1, median)) * 100) / 100;
    }
  }
  return result;
}
