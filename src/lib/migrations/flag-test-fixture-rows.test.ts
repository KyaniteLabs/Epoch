import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runFlagTestFixtureRows, isTestFixtureId, TEST_FIXTURE_ID_PREFIXES } from "./flag-test-fixture-rows.js";
import { FLAGS_FILE, ESTIMATES_FILE, ACTUALS_FILE } from "../ledger.js";

const TEST_DIR = join(tmpdir(), `epoch-flag-test-fixture-rows-test-${Date.now()}`);

function sha256(path: string): string | null {
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeLedger(): void {
  writeFileSync(
    join(TEST_DIR, ESTIMATES_FILE),
    [
      // A genuinely-leaked estimate-side fixture row (defensive coverage —
      // the verified live corpus has none of these, but the script must
      // still handle them correctly if they ever appear).
      JSON.stringify({ id: "fb-batch-001-999", tool: "pert_estimate", inputs: { task_type: "feature" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
      // A clean, real estimate — must never be touched.
      JSON.stringify({ id: "clean-1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T10:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  writeFileSync(
    join(TEST_DIR, ACTUALS_FILE),
    [
      // Matches the estimate-side fixture row above — not orphaned.
      JSON.stringify({ estimateId: "fb-batch-001-999", actualHours: 8, reportedAt: "2026-06-02T00:00:00.000Z" }),
      // Orphaned test-fixture actuals — no matching estimate on file.
      JSON.stringify({ estimateId: "http-test-estimate-1111", actualHours: 1, reportedAt: "2026-06-03T00:00:00.000Z" }),
      JSON.stringify({ estimateId: "fb-max-0-2222", actualHours: 2, reportedAt: "2026-06-03T00:00:00.000Z" }),
      JSON.stringify({ estimateId: "fb-single-001-3333", actualHours: 3, reportedAt: "2026-06-03T00:00:00.000Z" }),
      // Real orphan — not a test-fixture prefix, must never be touched.
      JSON.stringify({ estimateId: "some-genuinely-orphaned-id", actualHours: 4, reportedAt: "2026-06-03T00:00:00.000Z" }),
      // Clean matched pair.
      JSON.stringify({ estimateId: "clean-1", actualHours: 9, reportedAt: "2026-06-02T00:00:00.000Z" }),
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

describe("isTestFixtureId / TEST_FIXTURE_ID_PREFIXES", () => {
  for (const prefix of TEST_FIXTURE_ID_PREFIXES) {
    it(`flags ids starting with "${prefix}"`, () => {
      expect(isTestFixtureId(`${prefix}123`)).toBe(true);
    });
  }

  it("does not flag ordinary ids", () => {
    expect(isTestFixtureId("clean-1")).toBe(false);
    expect(isTestFixtureId(crypto.randomUUID())).toBe(false);
  });
});

describe("runFlagTestFixtureRows", () => {
  it("identifies the estimate-side fixture row and not the clean estimate", () => {
    const report = runFlagTestFixtureRows({ mode: "dry-run" });
    expect(report.estimateCandidateCount).toBe(1);
    expect(report.estimateSample[0]?.id).toBe("fb-batch-001-999");
  });

  it("identifies exactly the three orphaned test-fixture actuals, not the genuine orphan or the matched pair", () => {
    const report = runFlagTestFixtureRows({ mode: "dry-run" });
    expect(report.orphanCandidateCount).toBe(3);
    const ids = report.orphanSample.map((o) => o.estimateId).sort();
    expect(ids).toEqual(["fb-max-0-2222", "fb-single-001-3333", "http-test-estimate-1111"].sort());
  });

  it("dry-run writes nothing — estimates.flags.jsonl does not exist", () => {
    runFlagTestFixtureRows({ mode: "dry-run" });
    expect(existsSync(join(TEST_DIR, FLAGS_FILE))).toBe(false);
  });

  it("dry-run does not touch estimates.jsonl or feedback.jsonl (hot ledger untouched)", () => {
    const estBefore = sha256(join(TEST_DIR, ESTIMATES_FILE));
    const actBefore = sha256(join(TEST_DIR, ACTUALS_FILE));
    runFlagTestFixtureRows({ mode: "dry-run" });
    expect(sha256(join(TEST_DIR, ESTIMATES_FILE))).toBe(estBefore);
    expect(sha256(join(TEST_DIR, ACTUALS_FILE))).toBe(actBefore);
  });

  it("before/after clean-pair count is unchanged — isExcluded() already excludes the estimate-side fixture row via its now-synthetic id prefix; quarantining makes that exclusion an explicit, auditable overlay flag rather than changing which rows are excluded", () => {
    const report = runFlagTestFixtureRows({ mode: "dry-run" });
    // fb-batch-001-999 is already excluded by isSyntheticId() (exclusion.ts's
    // SYNTHETIC_ID_PREFIXES) before any overlay flag exists — only clean-1
    // counts as a clean pair, before and after.
    expect(report.before.cleanPairCount).toBe(1);
    expect(report.after.cleanPairCount).toBe(1);
  });

  it("apply writes one estimate-side flag and three orphan-side flags (4 total), never rewriting the hot ledger", () => {
    const estBefore = sha256(join(TEST_DIR, ESTIMATES_FILE));
    const actBefore = sha256(join(TEST_DIR, ACTUALS_FILE));

    const report = runFlagTestFixtureRows({ mode: "apply" });
    expect(report.written).toBe(4);

    expect(sha256(join(TEST_DIR, ESTIMATES_FILE))).toBe(estBefore);
    expect(sha256(join(TEST_DIR, ACTUALS_FILE))).toBe(actBefore);

    const flags = readFileSync(join(TEST_DIR, FLAGS_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(flags).toHaveLength(4);
    const estimateFlag = flags.find((f) => f.id === "fb-batch-001-999");
    expect(estimateFlag).toMatchObject({ quarantined: true, reason: "test_fixture" });
    expect(estimateFlag.orphan).toBeUndefined();

    const orphanFlag = flags.find((f) => f.id === "http-test-estimate-1111");
    expect(orphanFlag).toMatchObject({ quarantined: true, orphan: true, reason: "test_fixture" });
  });

  it("apply's after clean-pair count matches the dry-run simulation", () => {
    const report = runFlagTestFixtureRows({ mode: "apply" });
    expect(report.after.cleanPairCount).toBe(1);
  });

  it("apply is idempotent — a second apply run flags nothing new", () => {
    runFlagTestFixtureRows({ mode: "apply" });
    const second = runFlagTestFixtureRows({ mode: "apply" });
    expect(second.estimateCandidateCount).toBe(0);
    expect(second.orphanCandidateCount).toBe(0);
    expect(second.written).toBe(0);
    const flags = readFileSync(join(TEST_DIR, FLAGS_FILE), "utf-8").trim().split("\n");
    expect(flags).toHaveLength(4);
  });

  it("conservation invariant: estimates.jsonl and feedback.jsonl line counts are unchanged after apply", () => {
    const estLinesBefore = readFileSync(join(TEST_DIR, ESTIMATES_FILE), "utf-8").trim().split("\n").length;
    const actLinesBefore = readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8").trim().split("\n").length;
    runFlagTestFixtureRows({ mode: "apply" });
    expect(readFileSync(join(TEST_DIR, ESTIMATES_FILE), "utf-8").trim().split("\n").length).toBe(estLinesBefore);
    expect(readFileSync(join(TEST_DIR, ACTUALS_FILE), "utf-8").trim().split("\n").length).toBe(actLinesBefore);
  });

  it("does not flag a genuinely-orphaned actual with a non-fixture id", () => {
    const report = runFlagTestFixtureRows({ mode: "apply" });
    const flags = readFileSync(join(TEST_DIR, FLAGS_FILE), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(flags.some((f) => f.id === "some-genuinely-orphaned-id")).toBe(false);
    expect(report.written).toBe(4);
  });
});
