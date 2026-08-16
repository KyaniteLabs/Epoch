// ---------------------------------------------------------------------------
// Phase 4 dedup get-or-create — real-filesystem e2e coverage.
//
// Complements the mocked-fs unit tests in feedback.test.ts with a real
// EPOCH_DATA_DIR + real recordEstimate()/dispatch() calls, mirroring the
// pattern in telemetry-integration.test.ts. Covers the plan's Pre-mortem
// Scenario 3 guard rails end to end: same-inputs/same-session/in-window
// ⇒ same id + no new row; different session ⇒ new id; no session_id ⇒ new
// id; window expired ⇒ new id.
// ---------------------------------------------------------------------------

import { appendFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertEstimateWritten, defined } from "../test-support.js";

const TEST_DIR = join(tmpdir(), `epoch-dedup-e2e-${process.pid}`);

function readEstimatesCount(): number {
  try {
    const content = readFileSync(join(TEST_DIR, "estimates.jsonl"), "utf-8");
    return content.split("\n").filter((l) => l.trim()).length;
  } catch {
    return 0;
  }
}

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(TEST_DIR, { recursive: true });
  process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
  delete process.env["EPOCH_DATA_DIR"];
  delete process.env["EPOCH_DEDUP_WINDOW"];
  delete process.env["EPOCH_DRY_RUN"];
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("recordEstimate dedup get-or-create — real filesystem e2e", () => {
  it("same-inputs/same-session/in-window ⇒ same id, exactly one row on disk", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "30";
    const { recordEstimate } = await import("./feedback.js");

    const id1 = recordEstimate("pert_estimate", { session_id: "sess-e2e-1", task_type: "feature", task_label: "issue-42" }, { expected: 6 });
    assertEstimateWritten(id1);
    const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-1", task_type: "feature", task_label: "issue-42" }, { expected: 6 });
    assertEstimateWritten(id2);
    const id3 = recordEstimate("pert_estimate", { session_id: "sess-e2e-1", task_type: "feature", task_label: "issue-42" }, { expected: 6 });
    assertEstimateWritten(id3);

    expect(id2).toBe(id1);
    expect(id3).toBe(id1);
    expect(readEstimatesCount()).toBe(1);
  });

  it("different session ⇒ two rows on disk with distinct ids", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "30";
    const { recordEstimate } = await import("./feedback.js");

    const id1 = recordEstimate("pert_estimate", { session_id: "sess-e2e-a", task_type: "feature" }, { expected: 6 });
    assertEstimateWritten(id1);
    const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-b", task_type: "feature" }, { expected: 6 });
    assertEstimateWritten(id2);

    expect(id2).not.toBe(id1);
    expect(readEstimatesCount()).toBe(2);
  });

  it("no session_id ⇒ every call mints a new row, even with the flag on", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "30";
    const { recordEstimate } = await import("./feedback.js");

    const id1 = recordEstimate("pert_estimate", { task_type: "feature" }, { expected: 6 });
    assertEstimateWritten(id1);
    const id2 = recordEstimate("pert_estimate", { task_type: "feature" }, { expected: 6 });
    assertEstimateWritten(id2);

    expect(id2).not.toBe(id1);
    expect(readEstimatesCount()).toBe(2);
  });

  it("window expired ⇒ new id once the dedup window has elapsed", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "10"; // 10-minute window
    const { recordEstimate } = await import("./feedback.js");

    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
      const id1 = recordEstimate("pert_estimate", { session_id: "sess-e2e-window", task_type: "feature" }, { expected: 6 });
      assertEstimateWritten(id1);
      expect(readEstimatesCount()).toBe(1);

      // 20 minutes later — past the 10-minute window.
      vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
      const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-window", task_type: "feature" }, { expected: 6 });
      assertEstimateWritten(id2);

      expect(id2).not.toBe(id1);
      expect(readEstimatesCount()).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("dedup is a no-op when EPOCH_DEDUP_WINDOW is unset — byte-identical to pre-Phase-4 behavior", async () => {
    delete process.env["EPOCH_DEDUP_WINDOW"];
    const { recordEstimate } = await import("./feedback.js");

    const id1 = recordEstimate("pert_estimate", { session_id: "sess-e2e-off", task_type: "feature" }, { expected: 6 });
    assertEstimateWritten(id1);
    const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-off", task_type: "feature" }, { expected: 6 });
    assertEstimateWritten(id2);

    expect(id2).not.toBe(id1);
    expect(readEstimatesCount()).toBe(2);
  });

  // Real dispatcher import + 3 real dispatch rounds takes ~3-4s even
  // unloaded; the 5s default is too tight under full-suite parallel load
  // (observed 3-of-4 full-run timeouts with zero assertion failures).
  // Explicit timeout de-flakes without touching what the test asserts.
  it("dispatch(): 3 identical pert_estimate calls in one session with the window set ⇒ 1 pending row", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "30";
    const { dispatch } = await import("../dispatcher/index.js");

    const input = { optimistic: 4, most_likely: 6, pessimistic: 10, session_id: "sess-e2e-dispatch", task_label: "issue-99" };
    const r1 = await dispatch("pert_estimate", input);
    const r2 = await dispatch("pert_estimate", input);
    const r3 = await dispatch("pert_estimate", input);

    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
    const ref1 = (r1 as { ok: true; data: Record<string, unknown> }).data["feedbackRef"];
    const ref2 = (r2 as { ok: true; data: Record<string, unknown> }).data["feedbackRef"];
    const ref3 = (r3 as { ok: true; data: Record<string, unknown> }).data["feedbackRef"];
    expect(ref2).toBe(ref1);
    expect(ref3).toBe(ref1);
    expect(readEstimatesCount()).toBe(1);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// Ticket 16 — recordActualDetailed dry-run ledger consistency, real filesystem.
// In dry-run mode the duplicate check and the estimate join must read the
// dry-run files (previously they read the production ledger while writes went
// to the dry-run one, so repeated dry-run records accumulated unbounded), and
// the unit_suspect flag must be persisted on the written record.
// ---------------------------------------------------------------------------

describe("recordActualDetailed dry-run consistency — real filesystem e2e", () => {
  function readJsonl(name: string): Array<Record<string, unknown>> {
    try {
      const content = readFileSync(join(TEST_DIR, name), "utf-8");
      return content.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  function exists(name: string): boolean {
    try {
      readFileSync(join(TEST_DIR, name), "utf-8");
      return true;
    } catch {
      return false;
    }
  }

  it("dry-run duplicate check + estimate join both use the dry-run ledger, and repeated writes stay bounded", async () => {
    process.env["EPOCH_DRY_RUN"] = "1";
    const { recordEstimate, recordActualDetailed } = await import("./feedback.js");

    const estimateId = recordEstimate("pert_estimate", { task_type: "feature" }, { expected: 5 });
    assertEstimateWritten(estimateId);
    expect(exists("estimates.dry-run.jsonl")).toBe(true);
    expect(exists("estimates.jsonl")).toBe(false); // production ledger untouched

    const first = recordActualDetailed(estimateId, 6);
    expect(first).toEqual({ ok: true });

    // The duplicate check must consult feedback.dry-run.jsonl — the second
    // write for the same estimate is rejected instead of appending forever.
    const second = recordActualDetailed(estimateId, 6);
    expect(second).toEqual({ ok: false, reason: "duplicate" });
    expect(readJsonl("feedback.dry-run.jsonl")).toHaveLength(1);
    expect(exists("feedback.jsonl")).toBe(false);
  });

  it("persists unitSuspect on the dry-run record for a >10x overrun", async () => {
    process.env["EPOCH_DRY_RUN"] = "1";
    const { recordEstimate, recordActualDetailed } = await import("./feedback.js");

    const estimateId = recordEstimate("pert_estimate", { task_type: "feature" }, { expected: 5 });
    assertEstimateWritten(estimateId);
    const result = recordActualDetailed(estimateId, 300); // 60x
    expect(result).toEqual({ ok: true, flagged: "unit_suspect" });

    const rows = readJsonl("feedback.dry-run.jsonl");
    expect(rows).toHaveLength(1);
    expect(defined(rows[0])["unitSuspect"]).toBe(true);
    expect(defined(rows[0])["actualHours"]).toBe(300);
  });

  it("rejects an unknown-tool estimate via the dry-run estimates file (join target resolved in dry-run)", async () => {
    process.env["EPOCH_DRY_RUN"] = "1";
    const { recordActualDetailed } = await import("./feedback.js");

    // Only the DRY-RUN estimates file carries this row; the production file
    // does not exist. The join must resolve against the dry-run file.
    appendFileSync(join(TEST_DIR, "estimates.dry-run.jsonl"), JSON.stringify({
      id: "dry-run-unknown-tool-1",
      tool: "bogus_external_tool",
      inputs: {},
      outputs: { totalHours: 5 },
      estimatedAt: new Date().toISOString(),
    }) + "\n", "utf-8");

    const result = recordActualDetailed("dry-run-unknown-tool-1", 4);
    expect(result).toEqual({ ok: false, reason: "unknown_tool", hint: expect.any(String) });
  });
});
