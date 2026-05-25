// ---------------------------------------------------------------------------
// Tests for src/lib/community-export.ts
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeAll, afterAll, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildCommunityEstimationDataset,
  writeCommunityEstimationDataset,
  validateCommunityExport,
} from "./community-export.js";

const TEST_DIR = join(tmpdir(), `epoch-community-export-test-${Date.now()}`);

beforeAll(() => {
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  try { rmSync(TEST_DIR, { recursive: true, force: true }); mkdirSync(TEST_DIR, { recursive: true }); } catch { /* cleanup */ }
});

afterAll(() => {
  delete process.env["EPOCH_DATA_DIR"];
  try { rmSync(TEST_DIR, { recursive: true, force: true }); } catch { /* cleanup */ }
});

/** Create sample estimate and feedback files that produce calibration data. */
function createSampleData(): void {
  writeFileSync(
    join(TEST_DIR, "estimates.jsonl"),
    JSON.stringify({
      id: "e1",
      tool: "pert_estimate",
      inputs: { task_type: "feature", complexity: 3 },
      outputs: { expected: 8, unit: "hours" },
      estimatedAt: "2026-05-24T12:00:00Z",
    }) + "\n" +
    JSON.stringify({
      id: "e2",
      tool: "pert_estimate",
      inputs: { task_type: "bugfix", complexity: 2 },
      outputs: { expected: 4, unit: "hours" },
      estimatedAt: "2026-05-24T12:00:00Z",
    }) + "\n" +
    JSON.stringify({
      id: "e3",
      tool: "pert_estimate",
      inputs: { task_type: "invalid_type", complexity: 1 },
      outputs: { expected: 2, unit: "hours" },
      estimatedAt: "2026-05-24T12:00:00Z",
    }) + "\n" +
    JSON.stringify({
      id: "e4",
      tool: "pert_estimate",
      inputs: { task_type: "feature", complexity: null },
      outputs: { expected: 6, unit: "hours" },
      estimatedAt: "2026-05-24T12:00:00Z",
    }) + "\n",
  );

  writeFileSync(
    join(TEST_DIR, "feedback.jsonl"),
    JSON.stringify({ estimateId: "e1", actualHours: 12, reportedAt: "2026-05-24T20:00:00Z" }) + "\n" +
    JSON.stringify({ estimateId: "e2", actualHours: 3, reportedAt: "2026-05-24T20:00:00Z" }) + "\n" +
    JSON.stringify({ estimateId: "e3", actualHours: 1, reportedAt: "2026-05-24T20:00:00Z" }) + "\n" +
    JSON.stringify({ estimateId: "e4", actualHours: 5, reportedAt: "2026-05-24T20:00:00Z" }) + "\n",
  );
}

// ---- buildCommunityEstimationDataset ----------------------------------------

describe("buildCommunityEstimationDataset", () => {
  it("produces correct dataset shape", () => {
    createSampleData();
    const result = buildCommunityEstimationDataset({
      description: "Test dataset",
    });

    expect(result.dataset._schema).toBe("estimation-record");
    expect(result.dataset.description).toBe("Test dataset");
    expect(Array.isArray(result.dataset.records)).toBe(true);
    expect(result.dataset.records.length).toBeGreaterThan(0);
  });

  it("skips records with null complexity by default", () => {
    createSampleData();
    const result = buildCommunityEstimationDataset({
      description: "Test",
    });

    expect(result.skipped.missingComplexity).toBeGreaterThan(0);
    for (const rec of result.dataset.records) {
      expect(rec.complexity).toBeGreaterThanOrEqual(1);
      expect(rec.complexity).toBeLessThanOrEqual(5);
    }
  });

  it("skips records with invalid task types", () => {
    createSampleData();
    const result = buildCommunityEstimationDataset({
      description: "Test",
    });

    expect(result.skipped.invalidTaskType).toBeGreaterThan(0);
    for (const rec of result.dataset.records) {
      expect([
        "feature", "bugfix", "refactor", "migration",
        "infrastructure", "documentation", "testing", "design",
      ]).toContain(rec.task_type);
    }
  });

  it("uses default complexity when provided", () => {
    createSampleData();
    const result = buildCommunityEstimationDataset({
      description: "Test",
      defaultComplexity: 3,
    });

    // The null-complexity record should now be included
    expect(result.skipped.missingComplexity).toBe(0);
  });

  it("timestamps are date-only ISO strings without time-of-day", () => {
    createSampleData();
    const result = buildCommunityEstimationDataset({
      description: "Test",
    });

    for (const rec of result.dataset.records) {
      // Should match YYYY-MM-DDT00:00:00Z pattern
      expect(rec.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T00:00:00Z$/);
    }
  });

  it("records contain no forbidden fields", () => {
    createSampleData();
    const result = buildCommunityEstimationDataset({
      description: "Test",
    });

    const forbiddenKeys = [
      "estimateId", "notes", "source", "teamId",
      "tool", "ratio", "calibration_provenance",
      "calibration_usage", "project",
    ];

    for (const rec of result.dataset.records) {
      for (const key of forbiddenKeys) {
        expect((rec as unknown as Record<string, unknown>)[key]).toBeUndefined();
      }
    }
  });
});

// ---- writeCommunityEstimationDataset ----------------------------------------

describe("writeCommunityEstimationDataset", () => {
  it("writes valid file to disk", () => {
    createSampleData();
    const outPath = join(TEST_DIR, "test-export.json");
    const result = writeCommunityEstimationDataset({
      output: outPath,
      description: "Test export",
    });

    expect(result.path).toBe(outPath);
    expect(result.recordCount).toBeGreaterThan(0);
    expect(existsSync(outPath)).toBe(true);

    const content = JSON.parse(readFileSync(outPath, "utf-8")) as Record<string, unknown>;
    expect(content._schema).toBe("estimation-record");
    expect(content.description).toBe("Test export");
    expect(Array.isArray(content.records)).toBe(true);
  });

  it("throws when no exportable records exist", () => {
    // Empty data dir — no estimates or feedback
    expect(() =>
      writeCommunityEstimationDataset({
        description: "Empty test",
      }),
    ).toThrow(/No exportable records/);
  });
});

// ---- validateCommunityExport ------------------------------------------------

describe("validateCommunityExport", () => {
  it("validates a correct export file", () => {
    createSampleData();
    const outPath = join(TEST_DIR, "validate-test.json");
    writeCommunityEstimationDataset({
      output: outPath,
      description: "Validation test",
    });

    const result = validateCommunityExport(outPath);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects missing file", () => {
    const result = validateCommunityExport(join(TEST_DIR, "nonexistent.json"));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects invalid JSON", () => {
    const badPath = join(TEST_DIR, "bad.json");
    writeFileSync(badPath, "not-json-at-all");
    const result = validateCommunityExport(badPath);
    expect(result.valid).toBe(false);
  });

  it("rejects missing _schema", () => {
    const badPath = join(TEST_DIR, "no-schema.json");
    writeFileSync(badPath, JSON.stringify({ records: [] }));
    const result = validateCommunityExport(badPath);
    expect(result.valid).toBe(false);
  });

  it("rejects records with unknown fields", () => {
    const badPath = join(TEST_DIR, "unknown-fields.json");
    writeFileSync(badPath, JSON.stringify({
      _schema: "estimation-record",
      records: [{
        estimated_hours: 8,
        actual_hours: 12,
        task_type: "feature",
        complexity: 3,
        timestamp: "2026-05-24T00:00:00Z",
        secret_field: "should not be here",
      }],
    }));
    const result = validateCommunityExport(badPath);
    expect(result.valid).toBe(false);
  });
});
