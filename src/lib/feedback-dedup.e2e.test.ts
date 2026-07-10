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

import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("recordEstimate dedup get-or-create — real filesystem e2e", () => {
  it("same-inputs/same-session/in-window ⇒ same id, exactly one row on disk", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "30";
    const { recordEstimate } = await import("./feedback.js");

    const id1 = recordEstimate("pert_estimate", { session_id: "sess-e2e-1", task_type: "feature", task_label: "issue-42" }, { expected: 6 });
    const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-1", task_type: "feature", task_label: "issue-42" }, { expected: 6 });
    const id3 = recordEstimate("pert_estimate", { session_id: "sess-e2e-1", task_type: "feature", task_label: "issue-42" }, { expected: 6 });

    expect(id2).toBe(id1);
    expect(id3).toBe(id1);
    expect(readEstimatesCount()).toBe(1);
  });

  it("different session ⇒ two rows on disk with distinct ids", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "30";
    const { recordEstimate } = await import("./feedback.js");

    const id1 = recordEstimate("pert_estimate", { session_id: "sess-e2e-a", task_type: "feature" }, { expected: 6 });
    const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-b", task_type: "feature" }, { expected: 6 });

    expect(id2).not.toBe(id1);
    expect(readEstimatesCount()).toBe(2);
  });

  it("no session_id ⇒ every call mints a new row, even with the flag on", async () => {
    process.env["EPOCH_DEDUP_WINDOW"] = "30";
    const { recordEstimate } = await import("./feedback.js");

    const id1 = recordEstimate("pert_estimate", { task_type: "feature" }, { expected: 6 });
    const id2 = recordEstimate("pert_estimate", { task_type: "feature" }, { expected: 6 });

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
      expect(readEstimatesCount()).toBe(1);

      // 20 minutes later — past the 10-minute window.
      vi.setSystemTime(new Date("2026-01-01T00:20:00.000Z"));
      const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-window", task_type: "feature" }, { expected: 6 });

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
    const id2 = recordEstimate("pert_estimate", { session_id: "sess-e2e-off", task_type: "feature" }, { expected: 6 });

    expect(id2).not.toBe(id1);
    expect(readEstimatesCount()).toBe(2);
  });

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
  });
});
