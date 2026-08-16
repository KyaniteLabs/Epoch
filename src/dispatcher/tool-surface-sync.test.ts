// ---------------------------------------------------------------------------
// Tool-surface sync suite (remediation ticket 03)
// ---------------------------------------------------------------------------
//
// Asserts DERIVATION, not parallel truth: the authoritative tool surface is
// defined once in src/lib/tool-aliases.ts, and every consumer — the
// dispatcher registry (registration keys + TOOL_NAMES/partition exports),
// the alias canonicalization targets, feedback-health's calibrated-tool
// denominator, and the llms.txt tool reference — must derive from (stay
// equal to) it. The historical failure mode this suite exists to prevent:
// estimate_from_context was registered in the registry but missing from the
// hand-copied lib alias set (24 vs 25), so record_actual rejected its
// feedbackRefs with "Unknown error.".
//
// The known 24-vs-25 gap is asserted as a LITERAL expectation (TOOL_COUNT
// === 25, estimate_from_context present) that is green with the fix — there
// are deliberately no xfail/inverted-pass markers anywhere in this suite.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { TOOL_REGISTRY, TOOL_NAMES, ESTIMATION_TOOLS, NON_ESTIMATION_TOOLS } from "./tool-registry.js";
import {
  CANONICAL_TOOL_NAMES,
  ESTIMATION_TOOL_NAMES,
  NON_ESTIMATION_TOOL_NAMES,
  TOOL_COUNT,
  ESTIMATION_TOOL_COUNT,
  canonicalizeToolName,
} from "../lib/tool-aliases.js";
import { FEEDBACK_HEALTH_CALIBRATION_TOOLS } from "../lib/feedback.js";

function readRepoFile(relativeToTestDir: string): string {
  return readFileSync(fileURLToPath(new URL(relativeToTestDir, import.meta.url)), "utf-8");
}

function setDiff(actual: Iterable<string>, expected: Iterable<string>): { missing: string[]; extra: string[] } {
  const a = new Set(actual);
  const e = new Set(expected);
  return {
    missing: [...e].filter((name) => !a.has(name)).sort(),
    extra: [...a].filter((name) => !e.has(name)).sort(),
  };
}

/** Extract the tool names documented under a llms.txt "## Tool Reference" heading (#### entries). */
function llmsToolReferenceToolNames(content: string): string[] {
  const reference = content.split(/^## Tool Reference$/m)[1] ?? "";
  return [...reference.matchAll(/^#### ([a-z0-9_]+)$/gm)].map((m) => m[1] as string);
}

// ---------------------------------------------------------------------------
// 1. The authoritative lib set (literal pin — flips green with ticket 03)
// ---------------------------------------------------------------------------

describe("authoritative tool surface (src/lib/tool-aliases.ts)", () => {
  it("defines exactly 25 canonical tools, including estimate_from_context", () => {
    expect(TOOL_COUNT).toBe(25);
    expect(CANONICAL_TOOL_NAMES.size).toBe(25);
    // The tool whose absence broke the feedback contract (ticket 04's root
    // cause) is in the authoritative set.
    expect(CANONICAL_TOOL_NAMES.has("estimate_from_context")).toBe(true);
  });

  it("defines a 9-tool estimation partition that includes estimate_from_context", () => {
    expect(ESTIMATION_TOOL_COUNT).toBe(9);
    expect(ESTIMATION_TOOL_NAMES.has("estimate_from_context")).toBe(true);
  });

  it("partition is disjoint and covers every canonical tool", () => {
    for (const name of ESTIMATION_TOOL_NAMES) {
      expect(NON_ESTIMATION_TOOL_NAMES.has(name)).toBe(false);
    }
    const diff = setDiff(
      [...ESTIMATION_TOOL_NAMES, ...NON_ESTIMATION_TOOL_NAMES],
      CANONICAL_TOOL_NAMES,
    );
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect([...ESTIMATION_TOOL_NAMES, ...NON_ESTIMATION_TOOL_NAMES]).toHaveLength(TOOL_COUNT);
  });
});

// ---------------------------------------------------------------------------
// 2. Registry derives from lib (registration keys + exported sets)
// ---------------------------------------------------------------------------

describe("dispatcher registry derives from the authoritative set", () => {
  it("registers exactly the canonical tools — none missing, none extra", () => {
    const diff = setDiff(TOOL_REGISTRY.keys(), CANONICAL_TOOL_NAMES);
    expect(diff.missing).toEqual([]); // registered-but-unknown-to-lib tools
    expect(diff.extra).toEqual([]); // lib tools that were never registered
    expect(TOOL_REGISTRY.size).toBe(TOOL_COUNT);
  });

  it("TOOL_NAMES is the lib-authoritative set, not an independent copy", () => {
    expect(TOOL_NAMES).toEqual(CANONICAL_TOOL_NAMES);
  });

  it("ESTIMATION_TOOLS / NON_ESTIMATION_TOOLS are the lib partition, not independent copies", () => {
    expect(ESTIMATION_TOOLS).toEqual(ESTIMATION_TOOL_NAMES);
    expect(NON_ESTIMATION_TOOLS).toEqual(NON_ESTIMATION_TOOL_NAMES);
    expect(ESTIMATION_TOOLS.size).toBe(ESTIMATION_TOOL_COUNT);
  });
});

// ---------------------------------------------------------------------------
// 3. Alias canonicalization targets the authoritative set
// ---------------------------------------------------------------------------

describe("canonicalizeToolName targets the authoritative set", () => {
  it("every canonical name canonicalizes to itself", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      expect(canonicalizeToolName(name)).toBe(name);
    }
  });

  it("the camelCase spelling of every canonical tool resolves back into the set", () => {
    for (const name of CANONICAL_TOOL_NAMES) {
      const camel = name.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
      expect(canonicalizeToolName(camel)).toBe(name);
    }
  });

  it("estimate_from_context is canonicalizable (the ticket-04 regression pin)", () => {
    expect(canonicalizeToolName("estimate_from_context")).toBe("estimate_from_context");
    expect(canonicalizeToolName("estimateFromContext")).toBe("estimate_from_context");
  });
});

// ---------------------------------------------------------------------------
// 4. Feedback-health calibrated-tool list derives from the estimation partition
// ---------------------------------------------------------------------------

describe("feedback-health calibrated-tool list derives from the partition", () => {
  it("FEEDBACK_HEALTH_CALIBRATION_TOOLS equals the estimation partition", () => {
    const diff = setDiff(FEEDBACK_HEALTH_CALIBRATION_TOOLS, ESTIMATION_TOOL_NAMES);
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(FEEDBACK_HEALTH_CALIBRATION_TOOLS).toHaveLength(ESTIMATION_TOOL_COUNT);
    // The tool the hand-copy used to miss.
    expect(FEEDBACK_HEALTH_CALIBRATION_TOOLS).toContain("estimate_from_context");
  });
});

// ---------------------------------------------------------------------------
// 5. llms.txt tool reference + count strings
// ---------------------------------------------------------------------------

describe("llms.txt tool reference matches the authoritative surface", () => {
  const docsLlms = readRepoFile("../../docs/llms.txt");
  const rootLlms = readRepoFile("../../llms.txt");

  it("docs/llms.txt Tool Reference lists exactly the 25 canonical names — none missing, none stale", () => {
    const documented = llmsToolReferenceToolNames(docsLlms);
    const diff = setDiff(documented, CANONICAL_TOOL_NAMES);
    expect(diff.missing).toEqual([]);
    expect(diff.extra).toEqual([]);
    expect(documented).toHaveLength(TOOL_COUNT);
  });

  it("docs/llms.txt count claims equal the derived tool count", () => {
    expect(docsLlms).toContain(`${TOOL_COUNT} structured tools`);
    expect(docsLlms).toContain(`Six layers, ${TOOL_COUNT} tools`);
  });

  it("root llms.txt count claim equals the derived tool count", () => {
    expect(rootLlms).toContain(`${TOOL_COUNT} structured tools`);
  });
});
