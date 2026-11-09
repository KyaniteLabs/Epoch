import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTOGRAM_BINS, renderHistogram } from "../lib/monte-carlo-histogram.js";
import { dispatch } from "./index.js";
import { registerAllMcpTools } from "./mcp-adapter.js";
import { defined } from "../test-support.js";

const tasks = [
  { name: "a", optimistic: 1, most_likely: 3, pessimistic: 9 },
  { name: "b", optimistic: 2, most_likely: 4, pessimistic: 12, depends_on: ["a"] },
];

type Dist = { unit: string; iterations: number; seed: number; edges: number[]; counts: number[]; min: number; max: number; p50Bin: number; p90Bin: number };

async function run(extra: Record<string, unknown>) {
  vi.stubEnv("EPOCH_DATA_DIR", mkdtempSync(join(tmpdir(), "epoch-dist-")));
  const result = await dispatch("monte_carlo_schedule", { tasks, iterations: 500, seed: 7, ...extra });
  expect(result.ok).toBe(true);
  return result.ok ? (result.data as Record<string, unknown>) : {};
}

describe("monte_carlo_schedule distribution (opt-in chart data)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("is absent unless asked for", async () => {
    expect(await run({})).not.toHaveProperty("distribution");
    expect(await run({ distribution: false })).not.toHaveProperty("distribution");
  });

  it("returns bins that match the terminal chart", async () => {
    const data = await run({ distribution: true });
    const d = data.distribution as Dist;
    expect(d.unit).toBe("days");
    expect(d.seed).toBe(7);
    expect(d.iterations).toBe(500);
    expect(d.edges).toHaveLength(HISTOGRAM_BINS + 1);
    expect(d.counts).toHaveLength(HISTOGRAM_BINS);
    expect(d.counts.reduce((a, b) => a + b, 0)).toBe(500);
    for (let i = 1; i < d.edges.length; i++) expect(d.edges[i]).toBeGreaterThanOrEqual(d.edges[i - 1] as number);
    expect(d.edges[0]).toBe(d.min);
    expect(d.edges.at(-1)).toBe(d.max);
    expect(d.p50Bin).toBeLessThanOrEqual(d.p90Bin);
    // Same counts, in order, as the rendered chart rows.
    const rows = (renderHistogram(data) ?? "").split("\n").filter(l => l.startsWith("["));
    expect(rows.map(r => Number(r.match(/^\[[^)\]]*[)\]]\s+(\d+)/)?.[1]))).toEqual(d.counts);
    expect(rows[d.p50Bin]).toMatch(/P50/);
    expect(rows[d.p90Bin]).toMatch(/P90/);
    // Survives JSON (what CLI --json and MCP text carry).
    expect(JSON.parse(JSON.stringify(data)).distribution).toEqual(d);
  });

  it("is deterministic for a seed", async () => {
    const a = (await run({ distribution: true })).distribution;
    const b = (await run({ distribution: true })).distribution;
    expect(a).toEqual(b);
  });

  it("rejects a non-boolean flag", async () => {
    vi.stubEnv("EPOCH_DATA_DIR", mkdtempSync(join(tmpdir(), "epoch-dist-")));
    const result = await dispatch("monte_carlo_schedule", { tasks, iterations: 100, seed: 1, distribution: "yes" });
    expect(result.ok).toBe(false);
  });
});

describe("MCP structuredContent", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("returns the parsed object alongside the text block", async () => {
    const handlers = new Map<string, (input: unknown) => Promise<{ content: { text: string }[]; structuredContent?: unknown; isError?: boolean }>>();
    const server = { tool: (name: string, _d: string, _s: unknown, _a: unknown, h: never) => void handlers.set(name, h) } as unknown as McpServer;
    registerAllMcpTools(server);
    vi.stubEnv("EPOCH_DATA_DIR", mkdtempSync(join(tmpdir(), "epoch-dist-")));
    const out = await defined(handlers.get("monte_carlo_schedule"))({ tasks, iterations: 200, seed: 3, distribution: true });
    expect(out.isError).toBeFalsy();
    const parsed = JSON.parse(defined(out.content[0]).text);
    expect(out.structuredContent).toEqual(parsed);
    expect((out.structuredContent as { distribution: Dist }).distribution.counts.reduce((a, b) => a + b, 0)).toBe(200);
  });
});
