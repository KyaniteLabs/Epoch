import { afterEach, describe, expect, it, vi } from "vitest";
import { monteCarloSim } from "../lib/estimation.js";
import { captureHistogram, renderHistogram } from "../lib/monte-carlo-histogram.js";
import { formatJson, formatTable } from "./formatters.js";
import { dispatch } from "./index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tasks = [{ name: "work", optimistic: 1, mostLikely: 3, pessimistic: 9 }];
const COUNT = /^\[[^)\]]*[)\]]\s+(\d+)/;
const binRows = (table: string): string[] => table.split("\n").filter(line => line.startsWith("["));
const rowCount = (row: string): number => Number(row.match(COUNT)?.[1]);

describe("Monte Carlo terminal histogram", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("survives the real dispatcher boundary", async () => {
    vi.stubEnv("EPOCH_DATA_DIR", mkdtempSync(join(tmpdir(), "epoch-histogram-")));
    const result = await dispatch("monte_carlo_schedule", { tasks: tasks.map(t => ({ name: t.name, optimistic: t.optimistic, most_likely: t.mostLikely, pessimistic: t.pessimistic })), iterations: 100, seed: 42 });
    expect(result.ok).toBe(true);
    expect(formatTable(result, "monte_carlo_schedule")).toContain("8h days · 100 runs · seed 42");
  });

  it("uses actual seeded totals and nearest-rank markers rather than a fitted curve", () => {
    // Independent replay of the documented triangular draw and Park–Miller seed.
    let state = 42;
    const totals = Array.from({ length: 100 }, () => {
      state = state * 16807 % 2147483647;
      const u = (state - 1) / 2147483646;
      return u < 0.25 ? 1 + Math.sqrt(u * 16) : 9 - Math.sqrt((1 - u) * 48);
    }).sort((a, b) => a - b);
    const min = totals[0] ?? 0;
    const max = totals[99] ?? 0;
    const expected = Array<number>(20).fill(0);
    for (const total of totals) {
      const index = Math.min(19, Math.floor((total - min) / (max - min) * 20));
      expected[index] = (expected[index] ?? 0) + 1;
    }
    const data = monteCarloSim(tasks, 100, 42);
    const table = formatTable({ ok: true, data }, "monte_carlo_schedule");
    const rows = binRows(table);
    expect(rows.map(rowCount)).toEqual(expected);
    // Markers carry the reported (rounded) percentile fields and sit in the
    // bin holding the unrounded nearest-rank totals[49] / totals[89].
    const bin = (v: number): number => Math.min(19, Math.floor((v - min) / (max - min) * 20));
    expect(rows[bin(totals[49] ?? 0)]).toContain(`P50 ${data.p50}`);
    expect(rows[bin(totals[89] ?? 0)]).toContain(`P90 ${data.p90}`);
    expect(data.p50).toBe(String(Math.round((totals[49] ?? 0) * 100) / 100));
    expect(data.p90).toBe(String(Math.round((totals[89] ?? 0) * 100) / 100));
    // Edges are printed at a shared precision; the last closes on the max.
    const decimals = rows[0]?.match(/^\[\s*-?\d+(?:\.(\d+))?,/)?.[1]?.length ?? 0;
    expect(rows[19]).toContain(`${max.toFixed(decimals)}]`);
    expect(rows[0]).toMatch(new RegExp(`^\\[\\s*${min.toFixed(decimals).replace(".", "\\.")},`));
  });

  it("shows a single exact value without a distribution", () => {
    const data = monteCarloSim(tasks, 1, 42);
    const table = formatTable({ ok: true, data }, "monte_carlo_schedule");
    expect(table).toMatch(/No distribution: one iteration \([\d.]+ days\)/);
    expect(binRows(table)).toHaveLength(0);
  });

  it("accounts for a constant multi-iteration sample without dividing by zero", () => {
    const data = monteCarloSim([{ name: "fixed", optimistic: 5, mostLikely: 5, pessimistic: 5 }], 10);
    const table = formatTable({ ok: true, data }, "monte_carlo_schedule");
    // One labelled point-mass line, not 20 zero-width bins.
    expect(binRows(table)).toHaveLength(0);
    expect(table).toContain("8h days · 10 runs · seed 42");
    expect(table).toContain("All runs: 5 days (point mass).");
    expect(table).not.toMatch(/NaN|Infinity/);
  });

  it("does not fabricate a histogram for invalid inputs or a JSON round-trip", () => {
    const data = monteCarloSim([], 10);
    expect(formatTable({ ok: true, data }, "monte_carlo_schedule")).not.toContain("8h days");
    const valid = monteCarloSim(tasks, 100);
    expect(formatTable({ ok: true, data: JSON.parse(JSON.stringify(valid)) }, "monte_carlo_schedule")).not.toContain("8h days");
  });
  it("renders all 20 real bins without changing JSON", () => {
    const data = monteCarloSim(tasks, 100, 42);
    const result = { ok: true as const, data };
    const table = formatTable(result, "monte_carlo_schedule");
    const rows = binRows(table);
    expect(rows).toHaveLength(20);
    expect(rows.reduce((sum, row) => sum + rowCount(row), 0)).toBe(100);
    expect(table).toContain("◀ P50");
    expect(table).toContain("◀ P90");
    expect(formatJson(result)).not.toContain("bins");
    expect(typeof data.p50).toBe("string");
  });

  it("fits every line inside the terminal width, clamped to 40..160 columns", () => {
    const data = monteCarloSim([...tasks, { name: "ui", optimistic: 2, mostLikely: 4, pessimistic: 12 }], 5000, 42);
    for (const [columns, bound] of [[10, 40], [40, 40], [80, 80], [120, 120], [200, 160]] as const) {
      const table = formatTable({ ok: true, data }, "monte_carlo_schedule", { columns });
      const chart = table.slice(table.indexOf("8h days"));
      const widest = Math.max(...chart.split("\n").map(line => line.length));
      expect(widest, `columns=${columns}`).toBeLessThanOrEqual(bound);
      // Markers line up in one column regardless of bar length.
      const markerCols = chart.split("\n").filter(l => l.includes("◀")).map(l => l.indexOf("◀"));
      expect(new Set(markerCols).size).toBe(1);
      expect(binRows(chart).reduce((n, r) => n + rowCount(r), 0)).toBe(5000);
    }
  });

  it("renders plain ASCII on request", () => {
    const data = monteCarloSim(tasks, 500, 42);
    const table = formatTable({ ok: true, data }, "monte_carlo_schedule", { ascii: true, columns: 80 });
    const chart = table.slice(table.indexOf("8h days"));
    expect(chart).toMatch(/^[\x20-\x7e\n]+$/);
    expect(chart).toContain("< P50");
  });

  it("stacks both markers on one row when P50 and P90 share a bin", () => {
    const sorted = [...Array<number>(95).fill(1), 2, 3, 50, 80, 100];
    const result = { p50: "1", p90: "1" };
    captureHistogram(result, sorted, 1, 1, 42);
    const chart = renderHistogram(result, { columns: 80 }) ?? "";
    const markerRows = chart.split("\n").filter(row => row.includes("◀"));
    expect(markerRows).toHaveLength(1);
    expect(markerRows[0]).toContain("◀ P50 1 · P90 1");
    expect(markerRows[0]?.startsWith("[")).toBe(true);
  });

  it("names the seed that produced the chart", () => {
    const data = monteCarloSim(tasks, 50, 7);
    expect(formatTable({ ok: true, data }, "monte_carlo_schedule")).toContain("seed 7");
  });

  it("puts each marker on the row whose printed range contains the printed value", () => {
    const wide = [{ name: "a", optimistic: 1, mostLikely: 3, pessimistic: 9 }, { name: "b", optimistic: 0.5, mostLikely: 4, pessimistic: 30 }];
    for (const iterations of [10, 999, 5000]) for (const seed of [0, 1, 7, 42, 123456]) {
      const data = monteCarloSim(wide, iterations, seed) as unknown as Record<string, string>;
      const rows = binRows(renderHistogram(data, { columns: 120 }) ?? "");
      for (const label of ["P50", "P90"]) {
        const row = rows.find(line => line.includes(label)) ?? "";
        const [, lo, hi] = /^\[\s*([\d.]+),\s*([\d.]+)/.exec(row) ?? [];
        const value = Number(data[label.toLowerCase()]);
        expect(value, `${label} seed ${seed} x${iterations}: ${row}`).toBeGreaterThanOrEqual(Number(lo));
        expect(value, `${label} seed ${seed} x${iterations}: ${row}`).toBeLessThanOrEqual(Number(hi));
      }
    }
  });
});
