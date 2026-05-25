import { describe, it, expect } from "vitest";
import { formatJson, formatTable } from "./formatters.js";
import { defined } from "../test-support.js";


describe("formatJson", () => {
  it("formats a success result as pretty JSON", () => {
    const result = { ok: true as const, data: { hours: 7, unit: "hours" } };
    const out = formatJson(result);
    expect(out).toBe(JSON.stringify(result, null, 2));
  });

  it("formats an error result as pretty JSON", () => {
    const result = {
      ok: false as const,
      error: { isError: true as const, message: "bad input", retryHint: "fix it" },
    };
    const out = formatJson(result);
    expect(out).toBe(JSON.stringify(result, null, 2));
  });
});

describe("formatTable", () => {
  it("formats an error result", () => {
    const result = {
      ok: false as const,
      error: { isError: true as const, message: "bad input", retryHint: "fix it" },
    };
    expect(formatTable(result, "pert_estimate")).toBe(
      "Error (pert_estimate): bad input",
    );
  });

  it("formats a flat object with key alignment", () => {
    const result = {
      ok: true as const,
      data: { expected: 7, unit: "hours", stdDeviation: 3 },
    };
    const out = formatTable(result, "pert_estimate");
    expect(out).toContain("=== pert_estimate ===");
    expect(out).toContain("expected");
    expect(out).toContain("7");
    expect(out).toContain("unit");
    expect(out).toContain("hours");
  });

  it("handles null data", () => {
    const result = { ok: true as const, data: null };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("(empty)");
  });

  it("handles undefined data", () => {
    const result = { ok: true as const, data: undefined };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("(empty)");
  });

  it("handles empty object", () => {
    const result = { ok: true as const, data: {} };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("(empty object)");
  });

  it("formats nested objects with increased indentation", () => {
    const result = {
      ok: true as const,
      data: {
        name: "project",
        breakdown: { design: 5, build: 10, total: 15 },
      },
    };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("breakdown:");
    expect(out).toContain("design");
    expect(out).toContain("build");
  });

  it("formats short arrays inline with count", () => {
    const result = {
      ok: true as const,
      data: { items: ["a", "b"] },
    };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("[2 items]");
    expect(out).toContain("- a");
    expect(out).toContain("- b");
  });

  it("truncates long arrays to 3 items with overflow note", () => {
    const result = {
      ok: true as const,
      data: { items: [1, 2, 3, 4, 5] },
    };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("[5 items]");
    expect(out).toContain("- 1");
    expect(out).toContain("- 2");
    expect(out).toContain("- 3");
    expect(out).toContain("... and 2 more");
    expect(out).not.toContain("- 4");
  });

  it("formats arrays of objects recursively", () => {
    const result = {
      ok: true as const,
      data: {
        tasks: [{ name: "design", hours: 5 }, { name: "build", hours: 10 }],
      },
    };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("[2 items]");
    expect(out).toContain("name");
    expect(out).toContain("design");
    expect(out).toContain("build");
  });

  it("formats a top-level array", () => {
    const result = {
      ok: true as const,
      data: [10, 20, 30],
    };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("[3 items]");
    expect(out).toContain("- 10");
    expect(out).toContain("- 20");
    expect(out).toContain("- 30");
  });

  it("formats a primitive value", () => {
    const result = { ok: true as const, data: 42 };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("42");
  });

  it("pads keys to max length for alignment", () => {
    const result = {
      ok: true as const,
      data: { x: 1, longerKey: 2 },
    };
    const out = formatTable(result, "test_tool");
    const lines = out.split("\n").slice(1);
    const keyLines = lines.filter((l) => l.includes("x") || l.includes("longerKey"));
    for (const line of keyLines) {
      const beforeValue = defined(line.split(/\d/)[0]);
      expect(beforeValue.length).toBeGreaterThan(0);
    }
  });

  it("formats deeply nested structures", () => {
    const result = {
      ok: true as const,
      data: {
        level1: {
          level2: {
            level3: "deep",
          },
        },
      },
    };
    const out = formatTable(result, "test_tool");
    expect(out).toContain("level1:");
    expect(out).toContain("level2:");
    expect(out).toContain("level3");
    expect(out).toContain("deep");
  });
});
