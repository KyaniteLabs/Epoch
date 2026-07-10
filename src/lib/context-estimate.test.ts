import { describe, it, expect } from "vitest";
import {
  classifyContext,
  resolveContextEstimateInputs,
  TASK_TYPES,
} from "./context-estimate.js";
import { taskTypeEnum } from "../schemas/index.js";

describe("TASK_TYPES parity with taskTypeEnum", () => {
  it("stays in sync with the canonical taskTypeEnum in schemas/index.ts", () => {
    expect([...TASK_TYPES].sort()).toEqual([...taskTypeEnum.options].sort());
  });
});

describe("classifyContext — task_type classification matrix", () => {
  it("classifies bugfix language", () => {
    const c = classifyContext("Fix a null pointer exception in the login flow, users are hitting a crash.");
    expect(c.taskType).toBe("bugfix");
    expect(c.signals).toContain("task_type_matched:bugfix");
  });

  it("classifies feature language", () => {
    const c = classifyContext("Add support for exporting reports as CSV. Implement a new download button.");
    expect(c.taskType).toBe("feature");
  });

  it("classifies refactor language", () => {
    const c = classifyContext("Refactor the billing module: clean up duplicated logic and simplify the pricing calculator, restructure the folder layout.");
    expect(c.taskType).toBe("refactor");
  });

  it("classifies migration language", () => {
    const c = classifyContext("Migrate the database schema to the new format and upgrade the ORM; this is a breaking change requiring a backfill.");
    expect(c.taskType).toBe("migration");
  });

  it("classifies infrastructure language", () => {
    const c = classifyContext("Update the CI pipeline to deploy via Docker and Kubernetes, provisioning new infrastructure with Terraform.");
    expect(c.taskType).toBe("infrastructure");
  });

  it("classifies documentation language", () => {
    const c = classifyContext("Update the README and add missing docstring comments across the docs.");
    expect(c.taskType).toBe("documentation");
  });

  it("classifies testing language", () => {
    const c = classifyContext("Add unit tests and an integration test for the new endpoint; improve test coverage with an e2e spec.");
    expect(c.taskType).toBe("testing");
  });

  it("classifies design language", () => {
    const c = classifyContext("Redo the UI layout in Figma, update the typography and color palette, rework the mockup and CSS styling.");
    expect(c.taskType).toBe("design");
  });

  it("defaults to feature with a defaulted signal when nothing matches", () => {
    const c = classifyContext("The quarterly numbers were reviewed by the committee yesterday afternoon.");
    expect(c.taskType).toBe("feature");
    expect(c.signals).toContain("task_type_defaulted");
  });

  it("breaks ties by TASK_TYPES declaration order", () => {
    // "fix" (bugfix) and "add" (feature) each match once — feature declared first wins on a tie... but
    // here bugfix has one match and feature has one match: with equal scores, the loop only overwrites
    // on strictly greater score, so the first category in TASK_TYPES order (feature) wins ties.
    const c = classifyContext("add a fix");
    expect(c.taskType).toBe("feature");
  });
});

describe("classifyContext — complexity signals", () => {
  it("stays at the baseline (3) for a plain, signal-free description", () => {
    // Deliberately long enough (>80 chars) to avoid the short_context signal,
    // short enough (<1200 chars) to avoid long_context, with no diff/file/
    // vocabulary signals — should land exactly on the neutral baseline.
    const c = classifyContext(
      "Add a new feature to the settings page so users can configure their notification preferences from a single screen.",
    );
    expect(c.complexity).toBe(3);
  });

  it("increases for a large diff (many +/- lines)", () => {
    const diffLines = Array.from({ length: 25 }, (_, i) => (i % 2 === 0 ? `+added line ${i}` : `-removed line ${i}`)).join("\n");
    const c = classifyContext(`Add a new feature.\n${diffLines}`);
    expect(c.complexity).toBeGreaterThan(3);
    expect(c.signals).toContain("diff_markers");
    expect(c.signals).toContain("large_diff");
  });

  it("increases for many-file mentions", () => {
    const c = classifyContext("Add a new feature touching 12 files across the codebase.");
    expect(c.complexity).toBeGreaterThan(3);
    expect(c.signals.some((s) => s.startsWith("multi_file"))).toBe(true);
    expect(c.signals).toContain("many_files");
  });

  it("decreases for trivial-scope vocabulary", () => {
    const c = classifyContext("This is a trivial one-line typo fix, nothing more.");
    expect(c.complexity).toBeLessThan(3);
    expect(c.signals).toContain("vocabulary_low");
  });

  it("increases for large-scope vocabulary", () => {
    const c = classifyContext("This is a significant overhaul — a major rewrite of the entire payment pipeline, a breaking change.");
    expect(c.complexity).toBeGreaterThan(3);
    expect(c.signals).toContain("vocabulary_high");
  });

  it("clamps complexity to [1, 5]", () => {
    const diffLines = Array.from({ length: 40 }, (_, i) => `+line ${i}`).join("\n");
    const bigText = `${"x".repeat(1500)} significant major rewrite overhaul breaking change across 50 files.\n${diffLines}`;
    const c = classifyContext(bigText);
    expect(c.complexity).toBeLessThanOrEqual(5);
    expect(c.complexity).toBeGreaterThanOrEqual(1);

    const tinyText = "typo";
    const tiny = classifyContext(tinyText);
    expect(tiny.complexity).toBeGreaterThanOrEqual(1);
  });

  it("bumps complexity for migration/infrastructure task types when the type was actually matched", () => {
    const c = classifyContext("Migrate the auth service to the new provider.");
    expect(c.taskType).toBe("migration");
    expect(c.signals).toContain("task_type_risk");
  });
});

describe("classifyContext — confidence + adversarial inputs", () => {
  it("empty string yields low confidence and the defaulted feature/3 baseline", () => {
    const c = classifyContext("");
    expect(c.taskType).toBe("feature");
    expect(c.complexity).toBe(3);
    expect(c.confidence).toBe("low");
    expect(c.signals).toEqual(["task_type_defaulted"]);
  });

  it("whitespace-only string behaves like empty", () => {
    const c = classifyContext("   \n\t  ");
    expect(c.confidence).toBe("low");
  });

  it("random noise with no recognizable vocabulary yields low confidence", () => {
    const c = classifyContext("qwzxk vrplm jjjjj zzzzzz 0000000");
    expect(c.confidence).toBe("low");
  });

  it("a strong task-type match plus 2+ complexity signals yields high confidence", () => {
    const diffLines = Array.from({ length: 30 }, (_, i) => `+line ${i}`).join("\n");
    const c = classifyContext(`Fix a critical crash bug touching 15 files, this is a significant fix.\n${diffLines}`);
    expect(c.confidence).toBe("high");
  });

  it("a single weak signal yields medium confidence", () => {
    const c = classifyContext("This is a trivial change.");
    expect(c.confidence).toBe("medium");
  });

  it("is a pure function — same input always yields the same output", () => {
    const text = "Fix the null pointer bug across 4 files, a significant regression.";
    const a = classifyContext(text);
    const b = classifyContext(text);
    expect(a).toEqual(b);
  });
});

describe("resolveContextEstimateInputs — hint override", () => {
  it("uses the classification when no hints are supplied", () => {
    const classification = classifyContext("Fix the login crash.");
    const resolved = resolveContextEstimateInputs(classification);
    expect(resolved.taskType).toBe(classification.taskType);
    expect(resolved.complexity).toBe(classification.complexity);
    expect(resolved.taskTypeFromHint).toBe(false);
    expect(resolved.complexityFromHint).toBe(false);
  });

  it("hints always win over classification", () => {
    const classification = classifyContext("Fix the login crash.");
    expect(classification.taskType).toBe("bugfix");

    const resolved = resolveContextEstimateInputs(classification, { taskType: "design", complexity: 5 });
    expect(resolved.taskType).toBe("design");
    expect(resolved.complexity).toBe(5);
    expect(resolved.taskTypeFromHint).toBe(true);
    expect(resolved.complexityFromHint).toBe(true);
  });

  it("hints can be applied independently (task_type only, complexity only)", () => {
    const classification = classifyContext("Fix the login crash.");
    const resolvedTypeOnly = resolveContextEstimateInputs(classification, { taskType: "testing" });
    expect(resolvedTypeOnly.taskType).toBe("testing");
    expect(resolvedTypeOnly.complexity).toBe(classification.complexity);
    expect(resolvedTypeOnly.complexityFromHint).toBe(false);

    const resolvedComplexityOnly = resolveContextEstimateInputs(classification, { complexity: 2 });
    expect(resolvedComplexityOnly.taskType).toBe(classification.taskType);
    expect(resolvedComplexityOnly.complexity).toBe(2);
    expect(resolvedComplexityOnly.taskTypeFromHint).toBe(false);
  });
});
