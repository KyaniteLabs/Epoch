import { afterEach, describe, expect, it, vi } from "vitest";
import { monteCarloSim } from "../lib/estimation.js";
import { formatJson, formatTable } from "./formatters.js";
import { dispatch } from "./index.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tasks = [{ name: "work", optimistic: 1, mostLikely: 3, pessimistic: 9 }];

describe("Monte Carlo terminal histogram", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("survives the real dispatcher boundary", async () => {
    vi.stubEnv("EPOCH_DATA_DIR", mkdtempSync(join(tmpdir(), "epoch-histogram-")));
    const result = await dispatch("monte_carlo_schedule", { tasks: tasks.map(t => ({ name: t.name, optimistic: t.optimistic, most_likely: t.mostLikely, pessimistic: t.pessimistic })), iterations: 100, seed: 42 });
    expect(result.ok).toBe(true);
    expect(formatTable(result, "monte_carlo_schedule")).toContain("Duration histogram");
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
    const rows = table.split("\n").filter(line => line.startsWith("["));
    expect(rows.map(row => Number(row.match(/count=(\d+)/)?.[1]))).toEqual(expected);
    expect(table).toContain(`Median (p50) = ${totals[49]} days`);
    expect(table).toContain(`P90 = ${totals[89]} days`);
    expect(rows[19]).toContain(`${max}]`);
  });

  it("shows a single exact value without a distribution", () => {
    const data = monteCarloSim(tasks, 1, 42);
    const table = formatTable({ ok: true, data }, "monte_carlo_schedule");
    expect(table).toMatch(/Single completed iteration: [\d.]+ days \(no distribution\)/);
    expect(table).not.toContain("Duration histogram");
    expect(table).not.toContain("count=");
  });

  it("accounts for a constant multi-iteration sample without dividing by zero", () => {
    const data = monteCarloSim([{ name: "fixed", optimistic: 5, mostLikely: 5, pessimistic: 5 }], 10);
    const table = formatTable({ ok: true, data }, "monte_carlo_schedule");
    const counts = [...table.matchAll(/count=(\d+)/g)].map(match => Number(match[1]));
    expect(counts).toEqual([10, ...Array<number>(19).fill(0)]);
    expect(table).toContain("Median (p50) = 5 days");
    expect(table).toContain("P90 = 5 days");
    expect(table).not.toMatch(/NaN|Infinity/);
  });

  it("does not fabricate a histogram for invalid inputs or a JSON round-trip", () => {
    const data = monteCarloSim([], 10);
    expect(formatTable({ ok: true, data }, "monte_carlo_schedule")).not.toContain("Duration histogram");
    const valid = monteCarloSim(tasks, 100);
    expect(formatTable({ ok: true, data: JSON.parse(JSON.stringify(valid)) }, "monte_carlo_schedule")).not.toContain("Duration histogram");
  });
  it("renders all 20 real bins without changing JSON", () => {
    const data = monteCarloSim(tasks, 100, 42);
    const result = { ok: true as const, data };
    const table = formatTable(result, "monte_carlo_schedule");
    const rows = table.split("\n").filter(line => /^\[/.test(line));
    expect(rows).toHaveLength(20);
    expect(rows.reduce((sum, row) => sum + Number(row.match(/count=(\d+)/)?.[1]), 0)).toBe(100);
    expect(table).toContain("Median (p50)");
    expect(table).toContain("P90");
    expect(formatJson(result)).not.toContain("bins");
    expect(typeof data.p50).toBe("string");
  });
});
