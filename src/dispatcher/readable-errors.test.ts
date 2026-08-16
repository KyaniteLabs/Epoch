// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Agent-readable error formatting (ticket 06)
//
// Pins the contract that validation failures surface as short actionable
// `path: message` sentences (never zod's raw JSON issues blob) and that
// internal thrown errors are distinguishable from validation errors via the
// errorKind tag. The token_time_bridge tokens:0 case is the canary's
// zero-tokens regression guard — it must keep matching the canary regex.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { dispatch } from "./index.js";
import { TOOL_REGISTRY } from "./tool-registry.js";
import type { ToolDefinition } from "./tool-registry.js";
import type { TaggedToolError } from "../lib/internal/error-helpers.js";

const TEST_DIR = join(tmpdir(), `epoch-readable-errors-${process.pid}`);

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

/** Narrow a failed result's error to its optional classification tag. */
function errorOf(result: { ok: false; error: { isError: true; message: string; retryHint?: string } }): TaggedToolError {
  return result.error as TaggedToolError;
}

const CANARY_ZERO_TOKENS_REGEX = /positive|greater|must be/i;

describe("dispatch — validation errors are readable sentences (ticket 06)", () => {
  it("token_time_bridge tokens:0 returns an actionable bound message (canary zero-tokens guard)", async () => {
    const result = await dispatch("token_time_bridge", {
      tokens: 0,
      model: "claude-sonnet-4-20250514",
      tool_calls: 0,
      reasoning_depth: "shallow",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = errorOf(result);
    // The canary's failure-mode assertion, verbatim.
    expect(error.message).toMatch(CANARY_ZERO_TOKENS_REGEX);
    // Readable sentence form: the offending field leads the line and the
    // rejected value is named.
    expect(error.message).toContain("tokens");
    expect(error.message).toContain("greater than 0");
    expect(error.message).toContain("got 0");
    // Tagged as caller-fixable at the seam.
    expect(error.errorKind).toBe("validation");
    expect(error.retryHint).toBeTruthy();
  });

  it("never leaks zod's raw JSON issues blob into error.message", async () => {
    const result = await dispatch("pert_estimate", {
      optimistic: "not-a-number",
      most_likely: 5,
      pessimistic: 10,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const message = result.error.message;
    expect(message).not.toMatch(/^\s*\[\s*\{/); // not a stringified issues array
    expect(message).not.toContain('"code"');
    expect(message).not.toContain('"expected"');
    // The offending field and its rejected value are named in prose.
    expect(message).toContain("optimistic");
    expect(message).toContain("not-a-number");
  });

  it("formats one `path: message` line per issue for multi-field failures", async () => {
    const result = await dispatch("record_actual", {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const lines = result.error.message.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(lines.some((l) => l.startsWith("estimate_id:"))).toBe(true);
    expect(lines.some((l) => l.startsWith("actual_hours:"))).toBe(true);
    expect(errorOf(result).errorKind).toBe("validation");
  });

  it("rewrites zod's default bound phrasing into must-be form", async () => {
    // iterations has no custom schema message, so this exercises the default
    // "Too big: expected number to be <=100000" rewrite path.
    const result = await dispatch("monte_carlo_schedule", {
      tasks: [{ name: "t1", optimistic: 1, most_likely: 5, pessimistic: 10 }],
      iterations: 1000001,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("iterations");
    expect(result.error.message).toContain("must be at most 100000");
    expect(result.error.message).toContain("got 1000001");
  });

  it("preserves custom schema bound messages verbatim (guidance text survives)", async () => {
    const result = await dispatch("add_business_days", {
      start_date: "2026-05-01",
      days: 1e9,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Custom schema message kept, with the offending value appended.
    expect(result.error.message).toContain("days must be <= 100000");
    expect(result.error.message).toContain("For larger shifts");
    expect(result.error.message).toContain("got 1000000000");
  });

  it("digs into nested paths for per-entry batch failures", async () => {
    const result = await dispatch("batch_record_actuals", {
      entries: [{ estimate_id: "", actual_hours: -1 }],
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toMatch(/entries\.0\.(estimate_id|actual_hours)/);
  });
});

describe("dispatch — internal errors are distinguishable from validation errors (ticket 06)", () => {
  const FIXTURE = "fixture_throwing_tool";

  beforeEach(() => {
    TOOL_REGISTRY.set(FIXTURE, {
      name: FIXTURE,
      description: "Test fixture: handler that throws a non-validation error.",
      inputSchema: z.object({}),
      outputSchema: { type: "object" },
      handler: () => {
        throw new Error("EACCES: permission denied, /Users/secret/.epoch/estimates.jsonl");
      },
    } satisfies ToolDefinition);
  });

  afterEach(() => {
    TOOL_REGISTRY.delete(FIXTURE);
  });

  it("preserves Error.message for the caller but tags the error internal", async () => {
    const result = await dispatch(FIXTURE, {});

    expect(result.ok).toBe(false);
    if (result.ok) return;
    const error = errorOf(result);
    // stdio/MCP consumers get the real reason (agents need it to escalate).
    expect(error.message).toContain("EACCES");
    expect(error.errorKind).toBe("internal");
    expect(error.isError).toBe(true);
  });

  it("unknown-tool errors keep their actionable routing message", async () => {
    const result = await dispatch("no_such_tool", {});
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain("Unknown tool");
    expect(result.error.retryHint).toContain("Available tools");
  });
});
