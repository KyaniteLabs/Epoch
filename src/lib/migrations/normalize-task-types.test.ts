import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runNormalizeTaskTypes, normalizeTaskType, TASKTYPE_FILE } from "./normalize-task-types.js";
import { ESTIMATES_FILE } from "../ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-normalize-tasktype-test-${Date.now()}`);

function writeLedger(): void {
  writeFileSync(
    join(TEST_DIR, ESTIMATES_FILE),
    [
      JSON.stringify({ id: "e1", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ id: "e2", tool: "pert_estimate", inputs: { task_type: "pricing_strategy" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ id: "e3", tool: "pert_estimate", inputs: { task_type: "revenue_copy" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ id: "e4", tool: "pert_estimate", inputs: { task_type: "resume-job-search-takeover-packet" }, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
      JSON.stringify({ id: "e5", tool: "pert_estimate", inputs: {}, outputs: { expected: 5, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
    ].join("\n") + "\n",
  );
}

beforeEach(() => {
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
  mkdirSync(TEST_DIR, { recursive: true });
  writeLedger();
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("normalizeTaskType", () => {
  it("passes through already-canonical values", () => {
    expect(normalizeTaskType("bugfix")).toBe("bugfix");
  });

  it("maps writing/copy/resume-style text to documentation", () => {
    expect(normalizeTaskType("revenue_copy")).toBe("documentation");
    expect(normalizeTaskType("writing_system")).toBe("documentation");
    expect(normalizeTaskType("resume-job-search-takeover-packet")).toBe("documentation");
  });

  it("falls back to feature for unrecognized free text", () => {
    expect(normalizeTaskType("pricing_strategy")).toBe("feature");
    expect(normalizeTaskType("website_offer_surface")).toBe("feature");
  });

  it("maps bug/infra/test/design keywords to their canonical bucket", () => {
    expect(normalizeTaskType("hotfix-payment")).toBe("bugfix");
    expect(normalizeTaskType("infra-deploy-pipeline")).toBe("infrastructure");
    expect(normalizeTaskType("qa-pass")).toBe("testing");
    expect(normalizeTaskType("ui-mockup-review")).toBe("design");
  });
});

describe("runNormalizeTaskTypes", () => {
  it("finds only the non-canonical rows, preserving taskTypeRaw", () => {
    const report = runNormalizeTaskTypes({ mode: "dry-run" });
    expect(report.candidateCount).toBe(3); // e2, e3, e4 (e1 canonical, e5 no task_type)
    expect(report.distinctRawValues).toEqual(["pricing_strategy", "resume-job-search-takeover-packet", "revenue_copy"]);
    const e3 = report.sample.find((c) => c.id === "e3");
    expect(e3).toMatchObject({ taskTypeRaw: "revenue_copy", taskTypeNormalized: "documentation" });
  });

  it("dry-run writes nothing", () => {
    runNormalizeTaskTypes({ mode: "dry-run" });
    expect(existsSync(join(TEST_DIR, TASKTYPE_FILE))).toBe(false);
  });

  it("apply writes one overlay record per candidate, never touching estimates.jsonl", () => {
    const estBefore = readFileSync(join(TEST_DIR, ESTIMATES_FILE), "utf-8");
    const report = runNormalizeTaskTypes({ mode: "apply" });
    expect(report.written).toBe(3);
    const overlays = readFileSync(join(TEST_DIR, TASKTYPE_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(overlays).toHaveLength(3);
    expect(readFileSync(join(TEST_DIR, ESTIMATES_FILE), "utf-8")).toBe(estBefore);
  });

  it("apply is idempotent — a second run finds nothing new", () => {
    runNormalizeTaskTypes({ mode: "apply" });
    const second = runNormalizeTaskTypes({ mode: "apply" });
    expect(second.candidateCount).toBe(0);
    expect(second.written).toBe(0);
  });
});
