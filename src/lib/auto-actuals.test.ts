// ---------------------------------------------------------------------------
// Wave 2 auto-actuals — real-filesystem e2e coverage.
//
// Mirrors feedback-dedup.e2e.test.ts's pattern: a real EPOCH_DATA_DIR (never
// the live ~/.epoch), real recordEstimate()/getPendingEstimates() calls, and
// direct JSONL fixture writes to control estimatedAt precisely (so the
// sanity-gate bounds can be exercised deterministically instead of racing
// the real clock).
// ---------------------------------------------------------------------------

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const TEST_DIR = join(tmpdir(), `epoch-auto-actuals-e2e-${process.pid}`);

function estimatesPath(): string {
  return join(TEST_DIR, "estimates.jsonl");
}

function feedbackPath(): string {
  return join(TEST_DIR, "feedback.jsonl");
}

function writeEstimates(records: Array<Record<string, unknown>>): void {
  writeFileSync(estimatesPath(), records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

function readActuals(): Array<Record<string, unknown>> {
  try {
    return readFileSync(feedbackPath(), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

/** ISO timestamp `hoursAgo` hours before `now`. */
function isoHoursAgo(hoursAgo: number, now: Date): string {
  return new Date(now.getTime() - hoursAgo * 3_600_000).toISOString();
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("runAutoActuals — real filesystem e2e", () => {
  it("records auto_wallclock actuals for the session's pending estimates only, leaving other sessions and duplicates alone", async () => {
    const { runAutoActuals } = await import("./auto-actuals.js");
    const now = new Date("2026-07-10T12:00:00.000Z");

    writeEstimates([
      { id: "est-a", tool: "pert_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { totalHours: 5 }, estimatedAt: isoHoursAgo(2, now) },
      { id: "est-b", tool: "cocomo_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { personMonthsLlmAdjusted: 0.05 }, estimatedAt: isoHoursAgo(1, now) },
      { id: "est-c", tool: "pert_estimate", inputs: { session_id: "sess-OTHER", task_type: "feature" }, outputs: { totalHours: 5 }, estimatedAt: isoHoursAgo(2, now) },
    ]);

    const result = runAutoActuals("sess-1", false, now);

    expect(result.candidates).toBe(2);
    expect(result.recorded.map((r) => r.estimateId).sort()).toEqual(["est-a", "est-b"]);
    expect(result.skipped).toEqual([]);
    expect(result.summary).toContain("sess-1");
    expect(result.summary).toContain("2 actual(s) recorded");

    const actuals = readActuals();
    expect(actuals).toHaveLength(2);
    for (const actual of actuals) {
      expect(actual["calibrationProvenance"]).toBe("auto_wallclock");
      expect(actual["notes"]).toBe("auto-recorded at session end (wall-clock)");
    }
    const actualIds = actuals.map((a) => a["estimateId"]).sort();
    expect(actualIds).toEqual(["est-a", "est-b"]);

    // The other-session estimate must remain untouched (no actual recorded for it).
    expect(actuals.some((a) => a["estimateId"] === "est-c")).toBe(false);
  });

  it("is idempotent: re-running the same session after a successful run is a no-op", async () => {
    const { runAutoActuals } = await import("./auto-actuals.js");
    const now = new Date("2026-07-10T12:00:00.000Z");

    writeEstimates([
      { id: "est-a", tool: "pert_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { totalHours: 5 }, estimatedAt: isoHoursAgo(2, now) },
      { id: "est-b", tool: "pert_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { totalHours: 5 }, estimatedAt: isoHoursAgo(1, now) },
    ]);

    const first = runAutoActuals("sess-1", false, now);
    expect(first.recorded).toHaveLength(2);
    expect(readActuals()).toHaveLength(2);

    const second = runAutoActuals("sess-1", false, now);
    expect(second.candidates).toBe(0);
    expect(second.recorded).toEqual([]);
    expect(second.skipped).toEqual([]);
    expect(readActuals()).toHaveLength(2); // no duplicate rows written
  });

  it("dry-run previews without writing any actuals", async () => {
    const { runAutoActuals } = await import("./auto-actuals.js");
    const now = new Date("2026-07-10T12:00:00.000Z");

    writeEstimates([
      { id: "est-a", tool: "pert_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { totalHours: 5 }, estimatedAt: isoHoursAgo(2, now) },
    ]);

    const result = runAutoActuals("sess-1", true, now);
    expect(result.dryRun).toBe(true);
    expect(result.recorded).toHaveLength(1);
    expect(result.summary).toContain("would record");
    expect(readActuals()).toEqual([]); // nothing written

    // A real run afterward still sees the estimate as pending.
    const realRun = runAutoActuals("sess-1", false, now);
    expect(realRun.recorded).toHaveLength(1);
    expect(readActuals()).toHaveLength(1);
  });

  it("skips (does not record) an estimate whose wall-clock age is below the sanity-gate lower bound", async () => {
    const { runAutoActuals } = await import("./auto-actuals.js");
    const now = new Date("2026-07-10T12:00:00.000Z");

    writeEstimates([
      { id: "est-fresh", tool: "pert_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { totalHours: 5 }, estimatedAt: isoHoursAgo(0.01, now) }, // 36s old
    ]);

    const result = runAutoActuals("sess-1", false, now);
    expect(result.recorded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ estimateId: "est-fresh", reason: "auto_wallclock_out_of_bounds" });
    expect(readActuals()).toEqual([]);
  });

  it("skips (does not record) an estimate whose wall-clock age is above the sanity-gate upper bound", async () => {
    const { runAutoActuals } = await import("./auto-actuals.js");
    const now = new Date("2026-07-10T12:00:00.000Z");

    writeEstimates([
      { id: "est-stale", tool: "pert_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { totalHours: 5 }, estimatedAt: isoHoursAgo(20, now) }, // 20h old
    ]);

    const result = runAutoActuals("sess-1", false, now);
    expect(result.recorded).toEqual([]);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatchObject({ estimateId: "est-stale", reason: "auto_wallclock_out_of_bounds" });
    expect(readActuals()).toEqual([]);
  });

  it("skips an in-bounds wall-clock actual whose ratio to the matched estimate is unit-suspect", async () => {
    const { runAutoActuals } = await import("./auto-actuals.js");
    const now = new Date("2026-07-10T12:00:00.000Z");

    // 3h wall-clock is within [0.05h, 12h] on its own, but the estimate was
    // 0.1h — a 30x ratio, well past the unit-suspect threshold.
    writeEstimates([
      { id: "est-ratio", tool: "pert_estimate", inputs: { session_id: "sess-1", task_type: "feature" }, outputs: { totalHours: 0.1 }, estimatedAt: isoHoursAgo(3, now) },
    ]);

    const result = runAutoActuals("sess-1", false, now);
    expect(result.recorded).toEqual([]);
    expect(result.skipped[0]).toMatchObject({ estimateId: "est-ratio", reason: "auto_wallclock_out_of_bounds" });
    expect(readActuals()).toEqual([]);
  });

  it("returns zero candidates for a session with no pending estimates", async () => {
    const { runAutoActuals } = await import("./auto-actuals.js");
    writeEstimates([]);
    const result = runAutoActuals("sess-empty", false, new Date());
    expect(result).toMatchObject({ sessionId: "sess-empty", candidates: 0, recorded: [], skipped: [] });
  });

  it("never touches the live ~/.epoch data dir (isolated by EPOCH_DATA_DIR)", async () => {
    const { dataDir } = await import("./ledger.js");
    expect(dataDir()).toBe(TEST_DIR);
    expect(dataDir()).not.toContain(".epoch");
  });
});
