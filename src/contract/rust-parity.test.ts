import { describe, expect, it } from "vitest";
import { TOOL_REGISTRY } from "../dispatcher/index.js";
import { RUST_PARITY_CASES } from "./rust-parity-cases.js";
import {
  firstDiff,
  normalize,
  resolveRustBinary,
  runRustParity,
  runTypeScript,
  shapeDiff,
} from "./rust-parity.js";
import {
  EXPECTED_CLI_COMMAND_PATHS,
  EXPECTED_MCP_TOOL_NAMES,
} from "./public-surface.js";

describe("rust parity — golden case integrity", () => {
  it("covers every one of the 25 public tools exactly", () => {
    const tools = new Set(RUST_PARITY_CASES.map((c) => c.tool));
    expect([...tools].sort()).toEqual([...EXPECTED_MCP_TOOL_NAMES].sort());
    expect(tools.size).toBe(25);
  });

  it("uses unique, non-empty case names", () => {
    const names = RUST_PARITY_CASES.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.length > 0)).toBe(true);
  });

  it("routes each case to a real TS tool and a real Rust CLI command", () => {
    for (const c of RUST_PARITY_CASES) {
      expect(TOOL_REGISTRY.has(c.tool), `TS tool missing: ${c.tool}`).toBe(true);
      expect(
        EXPECTED_CLI_COMMAND_PATHS.includes(c.cliCommand as never),
        `Rust CLI command missing: ${c.cliCommand}`,
      ).toBe(true);
    }
  });

  it("exercises both success and error expectations", () => {
    const expectations = new Set(RUST_PARITY_CASES.map((c) => c.expect));
    expect(expectations.has("ok")).toBe(true);
    expect(expectations.has("error")).toBe(true);
  });
});

describe("rust parity — normalization", () => {
  it("strips per-runtime feedbackRef recursively", () => {
    const normalized = normalize({
      expected: 2.17,
      feedbackRef: "rust-estimate-1",
      nested: { feedbackRef: "x", keep: 1 },
    });
    expect(normalized).toEqual({ expected: 2.17, nested: { keep: 1 } });
  });

  it("blanks documented ignore paths", () => {
    const normalized = normalize({ a: { b: "volatile" }, c: 1 }, ["a.b"]);
    expect(normalized).toEqual({ a: { b: null }, c: 1 });
  });
});

describe("rust parity — comparison", () => {
  it("treats numbers within float tolerance as equal", () => {
    expect(firstDiff({ x: 1.0 }, { x: 1.0 + 1e-9 })).toBeNull();
  });

  it("reports a numeric divergence with its path", () => {
    expect(firstDiff({ x: 1 }, { x: 2 })).toBe("$.x: ts=1 rust=2");
  });

  it("detects runtime-only keys", () => {
    expect(firstDiff({ total_seconds: 1 }, { totalSeconds: 1 })).toContain(
      "ts-only keys [total_seconds]",
    );
  });

  it("detects array length mismatches", () => {
    expect(firstDiff([1, 2], [1])).toBe("$: length ts=2 rust=1");
  });

  it("matches identical key/type skeletons under shape comparison", () => {
    expect(shapeDiff({ iso: "a", n: 1 }, { iso: "b", n: 99 })).toBeNull();
    expect(shapeDiff({ iso: "a" }, { iso: "a", extra: 1 })).not.toBeNull();
  });
});

describe("rust parity — TypeScript runtime", () => {
  it("executes a real handler and returns structured data", () => {
    const result = runTypeScript("pert_estimate", {
      optimistic: 1,
      most_likely: 2,
      pessimistic: 4,
    });
    expect(result.ok).toBe(true);
    expect((result.value as { expected: number }).expected).toBeCloseTo(2.17, 2);
  });

  it("turns invalid input (thrown ZodError) into an error result", () => {
    const result = runTypeScript("pert_estimate", { optimistic: 5, most_likely: 2 });
    expect(result.ok).toBe(false);
    expect(result.error?.message).toBeTruthy();
  });
});

describe("rust parity — full harness (requires built epoch-cli)", () => {
  const binary = resolveRustBinary();

  it.skipIf(!binary)("runs both runtimes across all 25 tools with compatible errors", () => {
    const report = runRustParity();
    expect(report.rustBinary).toBeTruthy();
    expect(report.toolsCovered).toHaveLength(25);
    // Every golden case executed end-to-end (no spawn crash / should-pass error).
    expect(report.diffs.some((d) => d.kind === "unexpected-error")).toBe(false);
    // Error handling must be byte-for-behavior compatible across runtimes.
    expect(report.errorCompatibilityPercent).toBe(100);
    // Parity metrics are well-formed percentages.
    expect(report.outputParityPercent).toBeGreaterThanOrEqual(0);
    expect(report.outputParityPercent).toBeLessThanOrEqual(100);
    expect(report.matchedCases).toBeLessThanOrEqual(report.totalCases);
  });
});

describe("rust parity — deferred behavioral parity (pendingRust)", () => {
  // pendingRust cases never touch Rust — force it unavailable so this suite
  // is deterministic regardless of whether epoch-cli happens to be built.
  it("pins every pendingRust case's TS-only assertion (exclusion + overlay-merge semantics)", () => {
    const report = runRustParity({ binary: null });
    expect(report.pendingRustCases).toBeGreaterThan(0);
    expect(report.pendingRustDiffs).toEqual([]);
    expect(report.pendingRustMatched).toBe(report.pendingRustCases);
  });

  it("keeps pendingRust cases out of the ts-vs-rust gate denominators", () => {
    const report = runRustParity({ binary: null });
    expect(report.outputCases + report.errorCases + report.pendingRustCases).toBe(report.totalCases);
  });

  it("isolates each fixture-seeded case in its own EPOCH_DATA_DIR (order-independent)", () => {
    const forward = runRustParity({ binary: null }).pendingRustDiffs;
    const reversed = runRustParity({ binary: null, cases: [...RUST_PARITY_CASES].reverse() }).pendingRustDiffs;
    expect(forward).toEqual([]);
    expect(reversed).toEqual([]);
  });
});
