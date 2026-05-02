import { existsSync, mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

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
}

const DEFAULT_DATA_DIR = join(homedir(), ".epoch");
const TELEMETRY_FILE = "telemetry.jsonl";
const FLUSH_INTERVAL_MS = 10_000;
const FLUSH_BUFFER_SIZE = 50;

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

  constructor() {
    const dir = dataDir();
    this.filePath = join(dir, TELEMETRY_FILE);
    this.enabled = !!process.env["EPOCH_DATA_DIR"] || existsSync(dir);

    if (this.enabled && !existsSync(dir)) {
      try {
        mkdirSync(dir, { recursive: true });
      } catch {
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

    this.buffer.push({
      timestamp: new Date().toISOString(),
      tool,
      inputHash: input ? hashInput(input) : "none",
      outputOk: ok,
      elapsedMs: Math.round(elapsedMs * 100) / 100,
      ...(model && { model }),
      ...(tokens && { tokens }),
    });

    if (this.buffer.length >= FLUSH_BUFFER_SIZE) {
      this.flush();
    }
  }

  flush(): void {
    if (!this.enabled || this.buffer.length === 0) return;

    const lines = this.buffer.map((r) => JSON.stringify(r)).join("\n") + "\n";
    this.buffer = [];

    try {
      appendFileSync(this.filePath, lines, "utf-8");
    } catch {
      // silently fail — telemetry is non-critical
    }
  }

  getStats(toolName?: string, windowDays?: number): ToolStats[] {
    this.flush();

    if (!this.enabled || !existsSync(this.filePath)) return [];

    const cutoff = windowDays
      ? new Date(Date.now() - windowDays * 86_400_000).toISOString()
      : "0000";

    let content: string;
    try {
      content = readFileSync(this.filePath, "utf-8");
    } catch {
      return [];
    }

    const records: ToolCallRecord[] = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as ToolCallRecord; } catch { return null; }
      })
      .filter((r): r is ToolCallRecord => r !== null && r.timestamp >= cutoff);

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

  getModelStats(model: string, windowDays?: number): { avgTps: number; medianTps: number; sampleCount: number } | null {
    this.flush();

    if (!this.enabled || !existsSync(this.filePath)) return null;

    const cutoff = windowDays
      ? new Date(Date.now() - windowDays * 86_400_000).toISOString()
      : "0000";

    let content: string;
    try {
      content = readFileSync(this.filePath, "utf-8");
    } catch {
      return null;
    }

    const records = content
      .split("\n")
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line) as ToolCallRecord; } catch { return null; }
      })
      .filter((r): r is ToolCallRecord => r !== null && r.timestamp >= cutoff && r.model === model && typeof r.tokens === "number" && r.tokens > 0 && r.elapsedMs > 0);

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
    const idx = Math.min(Math.floor(n * p), n - 1);
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
