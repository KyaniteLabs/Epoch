import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

import { debugLog } from "./internal/logging.js";
import { percentileIndex } from "./estimation.js";

export interface ToolCallRecord {
  timestamp: string;
  tool: string;
  inputHash: string;
  outputOk: boolean;
  elapsedMs: number;
  model?: string;
  tokens?: number;
}

export interface ToolStats {
  tool: string;
  callCount: number;
  successRate: number;
  p50Ms: number;
  p95Ms: number;
  meanMs: number;
  windowDays: number;
  /**
   * Ticket 21: ISO timestamp of the newest record behind this row. Only
   * attached when getStats() is called with sinceByTool (the self-improvement
   * watermark path); default callers get the exact shape they had before.
   */
  newestTimestamp?: string;
}

export interface ModelStatsResult {
  avgTps: number;
  medianTps: number;
  sampleCount: number;
}

const DEFAULT_DATA_DIR = join(homedir(), ".epoch");
const TELEMETRY_FILE = "telemetry.jsonl";
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_BUFFER_SIZE = 50;
/** getModelStats() results are cached for this long — compare_models resolves 16 models per call and must not re-read the whole file per model. */
const MODEL_STATS_CACHE_TTL_MS = 60_000;

function dataDir(): string {
  return process.env["EPOCH_DATA_DIR"] ?? DEFAULT_DATA_DIR;
}

function hashInput(input: Record<string, unknown>): string {
  try {
    const str = JSON.stringify(input, Object.keys(input).sort());
    let h = 0;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h = ((h << 5) - h + c) | 0;
    }
    return Math.abs(h).toString(36);
  } catch {
    return "unknown";
  }
}

class TelemetryStore {
  private buffer: ToolCallRecord[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private filePath: string;
  private enabled: boolean;
  /** TTL cache for getModelStats() — key `${model}\u0000${windowDays ?? "all"}`. */
  private modelStatsCache = new Map<string, { value: ModelStatsResult | null; expiresAt: number }>();

  constructor() {
    const dir = dataDir();
    this.filePath = join(dir, TELEMETRY_FILE);
    this.enabled = !!process.env["EPOCH_DATA_DIR"] || existsSync(dir);

    if (this.enabled && !existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch (err) {
        debugLog("telemetry.mkdir", err);
        this.enabled = false;
      }
    }

    if (this.enabled) {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      this.flushTimer.unref();
    }
  }

  record(
    tool: string,
    elapsedMs: number,
    ok: boolean,
    input?: Record<string, unknown>,
    model?: string,
    tokens?: number,
  ): void {
    if (!this.enabled) return;

    // Token tools (token_time_bridge / token_cost_estimate) carry the model
    // and token count in their raw dispatch input — record them so
    // getModelStats() has real per-model data to calibrate from (explicit
    // arguments still win when a caller passes them).
    const recordedModel = model
      ?? (input !== undefined && typeof input["model"] === "string" && input["model"].length > 0 ? input["model"] : undefined);
    const recordedTokens = tokens
      ?? (input !== undefined && typeof input["tokens"] === "number" && Number.isFinite(input["tokens"]) ? input["tokens"] : undefined);

    this.buffer.push({
      timestamp: new Date().toISOString(),
      tool,
      inputHash: input ? hashInput(input) : "none",
      outputOk: ok,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      ...(recordedModel && { model: recordedModel }),
      ...(recordedTokens && { tokens: recordedTokens }),
    });

    if (this.buffer.length >= FLUSH_BUFFER_SIZE) {
      this.flush();
    }
  }

  flush(): void {
    if (!this.enabled || this.buffer.length === 0) return;

    const lines = this.buffer.map((r) => JSON.stringify(r)).join("\n") + "\n";

    try {
      appendFileSync(this.filePath, lines, "utf-8");
      // Ticket 19: clear the buffer ONLY after a successful append. The old
      // order (clear, then append) silently dropped every buffered record
      // whenever the append failed (ENOSPC, EACCES, vanished data dir); now
      // failed batches stay buffered and retry on the next interval tick or
      // record()-triggered flush.
      this.buffer = [];
    } catch (err) {
      debugLog("telemetry.flush", err);
    }
  }

  getStats(toolName?: string, windowDays?: number, sinceByTool?: Record<string, string>): ToolStats[] {
    this.flush();

    if (!this.enabled || !existsSync(this.filePath)) return [];

    const cutoff = windowDays
      ? new Date(Date.now() - windowDays * 86_400_000).toISOString()
      : "0000";

    let content: string;
    try {
      content = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      debugLog("telemetry.read", err);
      return [];
    }

    const records: ToolCallRecord[] = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as ToolCallRecord; } catch { return null; }
      })
      .filter((r): r is ToolCallRecord => r !== null && r.timestamp >= cutoff);

    // Ticket 21 (per-tool watermarks): when sinceByTool is provided, each
    // tool's row aggregates ONLY records strictly newer than its watermark
    // (an ISO timestamp string compare — both sides are UTC ISO). Tools with
    // no new records are omitted entirely so the self-improvement merge loop
    // treats them as "nothing to merge, watermark untouched". Each returned
    // row carries newestTimestamp (the delta's max) so the caller can
    // advance the watermark without re-reading. Without sinceByTool the
    // behavior is byte-identical to before (full window, no extra field).
    if (sinceByTool) {
      const deltaGrouped = new Map<string, ToolCallRecord[]>();
      for (const r of records) {
        if (toolName && r.tool !== toolName) continue;
        const since = sinceByTool[r.tool];
        if (since !== undefined && r.timestamp <= since) continue;
        const arr = deltaGrouped.get(r.tool) ?? [];
        arr.push(r);
        deltaGrouped.set(r.tool, arr);
      }
      return [...deltaGrouped.entries()]
        .map(([tool, recs]) => ({
          ...aggregate(recs, windowDays ?? 90),
          tool,
          newestTimestamp: recs.reduce((max, r) => (r.timestamp > max ? r.timestamp : max), recs[0]?.timestamp ?? ""),
        }))
        .sort((a, b) => b.callCount - a.callCount);
    }

    if (toolName) {
      const filtered = records.filter((r) => r.tool === toolName);
      return filtered.length > 0 ? [aggregate(filtered, windowDays ?? 90)] : [];
    }

    const grouped = new Map<string, ToolCallRecord[]>();
    for (const r of records) {
      const arr = grouped.get(r.tool) ?? [];
      arr.push(r);
      grouped.set(r.tool, arr);
    }

    return [...grouped.entries()]
      .map(([, recs]) => aggregate(recs, windowDays ?? 90))
      .sort((a, b) => b.callCount - a.callCount);
  }

  getModelStats(model: string, windowDays?: number, sinceTimestamp?: string): ModelStatsResult | null {
    // TTL cache: analytics resolves one calibration per token-tool call and
    // compare_models walks all 16 catalog models — without this, each call
    // re-reads and re-parses the entire telemetry file per model. Staleness is
    // bounded by MODEL_STATS_CACHE_TTL_MS (60s); resetTelemetry() drops it
    // with the instance.
    const cacheKey = `${model}\u0000${windowDays ?? "all"}\u0000${sinceTimestamp ?? ""}`;
    const cached = this.modelStatsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    const value = this.computeModelStats(model, windowDays, sinceTimestamp);
    this.modelStatsCache.set(cacheKey, { value, expiresAt: Date.now() + MODEL_STATS_CACHE_TTL_MS });
    return value;
  }

  private computeModelStats(model: string, windowDays?: number, sinceTimestamp?: string): ModelStatsResult | null {
    this.flush();

    if (!this.enabled || !existsSync(this.filePath)) return null;

    const cutoff = windowDays
      ? new Date(Date.now() - windowDays * 86_400_000).toISOString()
      : "0000";

    let content: string;
    try {
      content = readFileSync(this.filePath, "utf-8");
    } catch (err) {
      debugLog("telemetry.model-read", err);
      return null;
    }

    const records = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as ToolCallRecord; } catch { return null; }
      })
      .filter((r): r is ToolCallRecord => r !== null && r.timestamp >= cutoff
        && (sinceTimestamp === undefined || r.timestamp > sinceTimestamp)
        && r.model === model && typeof r.tokens === "number" && r.tokens > 0 && r.elapsedMs > 0);

    if (records.length < 10) return null;

    const tpsValues = records.map((r) => (r.tokens ?? 0) / (r.elapsedMs / 1000));
    tpsValues.sort((a, b) => a - b);
    const mid = Math.floor(tpsValues.length / 2);
    const medianTps = tpsValues.length % 2 === 0
      ? ((tpsValues[mid - 1] ?? 0) + (tpsValues[mid] ?? 0)) / 2
      : (tpsValues[mid] ?? 0);
    const avgTps = tpsValues.reduce((a, b) => a + b, 0) / tpsValues.length;

    return { avgTps: Math.round(avgTps * 10) / 10, medianTps: Math.round(medianTps * 10) / 10, sampleCount: records.length };
  }

  destroy(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    this.flush();
  }
}

function aggregate(records: ToolCallRecord[], windowDays: number): ToolStats {
  const elapsed = records.map((r) => r.elapsedMs).sort((a, b) => a - b);
  const successes = records.filter((r) => r.outputOk).length;
  const n = elapsed.length;

  const percentile = (p: number): number => {
    const idx = percentileIndex(n, p);
    return Math.round((elapsed[idx] ?? 0) * 100) / 100;
  };

  const mean = elapsed.reduce((a, b) => a + b, 0) / n;

  return {
    tool: records[0]?.tool ?? "unknown",
    callCount: n,
    successRate: Math.round((successes / n) * 1000) / 1000,
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    meanMs: Math.round(mean * 100) / 100,
    windowDays,
  };
}

let _instance: TelemetryStore | null = null;

process.on("exit", () => { _instance?.flush(); });

export function getTelemetry(): TelemetryStore {
  if (!_instance) {
    _instance = new TelemetryStore();
  }
  return _instance;
}

export function resetTelemetry(): void {
  if (_instance) {
    _instance.destroy();
    _instance = null;
  }
}
