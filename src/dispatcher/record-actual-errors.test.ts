// ---------------------------------------------------------------------------
// record_actual failure vocabulary (remediation ticket 04)
// ---------------------------------------------------------------------------
//
// Dispatcher-seam test: injects EVERY recordActualDetailed failure reason
// through the mocked lib boundary (same mock style as index.test.ts) and
// asserts the record_actual tool maps each to a distinct, actionable message
// — with no path left that can surface "Unknown error.".
//
// The lib-level counterparts (real ledger, per-entry reasons in
// batchRecordActuals) are covered by src/lib/feedback-batch.test.ts; the
// end-to-end happy path is covered by src/dispatcher/feedback-contract.test.ts.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/feedback.js", () => ({
  recordEstimate: vi.fn(() => "test-estimate-id"),
  recordToolCall: vi.fn(() => "test-tool-call-id"),
  recordActual: vi.fn(() => true),
  recordActualDetailed: vi.fn(() => ({ ok: true })),
  // Real text (kept in sync with feedback.ts's UNIT_SUSPECT_FLAG_HINT): the
  // flagHint surfaced by record_actual comes from this lib constant.
  UNIT_SUSPECT_FLAG_HINT:
    "Suspected unit mismatch: the actual is more than 10x the estimate — check the units (hours vs days/weeks/person-months). The record is saved and flagged; it is excluded from calibration math if the ratio exceeds 50x.",
  getPendingEstimates: vi.fn(() => []),
  batchRecordActuals: vi.fn(() => ({ total: 0, succeeded: 0, failed: 0, errors: [] })),
  getFeedbackHealthReport: vi.fn(() => ({
    totalEstimates: 0, totalActuals: 0, matchRate: 0,
    byTool: {}, byTaskType: {},
    selfImprovement: { readyTypes: [], callsUntilUpdate: 100 },
  })),
  getCalibrationData: vi.fn(() => []),
  matchEstimatesToActuals: vi.fn(() => []),
}));

vi.mock("../lib/telemetry.js", () => ({
  getTelemetry: vi.fn(() => ({
    record: vi.fn(),
    getStats: vi.fn(() => []),
  })),
}));

vi.mock("../lib/self-improve.js", () => ({
  notifyToolCall: vi.fn(),
  getGlobalCorrectionFactor: vi.fn(() => 1.07),
  updateReferenceDatabase: vi.fn(() => Promise.resolve()),
}));

import { dispatch } from "./index.js";
import { recordActualDetailed, batchRecordActuals } from "../lib/feedback.js";
import type { RecordActualResult } from "../lib/feedback.js";
import { defined } from "../test-support.js";

const mockRecordActualDetailed = vi.mocked(recordActualDetailed);
const mockBatchRecordActuals = vi.mocked(batchRecordActuals);

/** The complete closed set of record_actual failure reasons (lib contract). */
type FailureReason = Extract<RecordActualResult, { ok: false }>["reason"];
const FAILURE_REASONS: readonly FailureReason[] = [
  "below_threshold",
  "duplicate",
  "write_failed",
  "synthetic_id",
  "unknown_tool",
  "auto_wallclock_out_of_bounds",
];

/** Actionability spot-checks: each reason's message must say something specific. */
const REASON_SUBSTRINGS: Record<FailureReason, string> = {
  below_threshold: "must be positive",
  duplicate: "already exists",
  write_failed: "writable",
  synthetic_id: "synthetic",
  unknown_tool: "unrecognized tool name",
  auto_wallclock_out_of_bounds: "sanity gate",
};

beforeEach(() => {
  mockRecordActualDetailed.mockReset();
  mockRecordActualDetailed.mockReturnValue({ ok: true });
  mockBatchRecordActuals.mockReset();
  mockBatchRecordActuals.mockReturnValue({ total: 0, succeeded: 0, failed: 0, errors: [] });
});

describe("record_actual failure vocabulary (dispatcher seam)", () => {
  it.each(FAILURE_REASONS)("maps %s to a specific, actionable message — never 'Unknown error.'", async (reason) => {
    mockRecordActualDetailed.mockReturnValueOnce({ ok: false, reason });

    const result = await dispatch("record_actual", { estimate_id: "err-fixture", actual_hours: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toBe("Unknown error.");
      expect(result.error.message.length).toBeGreaterThan(0);
      expect(result.error.message).toContain(REASON_SUBSTRINGS[reason]);
      expect(defined(result.error.retryHint).length).toBeGreaterThan(0);
    }
  });

  it("all six failure reasons map to six DISTINCT messages", async () => {
    const messages: string[] = [];
    for (const reason of FAILURE_REASONS) {
      mockRecordActualDetailed.mockReturnValueOnce({ ok: false, reason });
      const result = await dispatch("record_actual", { estimate_id: "err-fixture", actual_hours: 2 });
      expect(result.ok).toBe(false);
      if (!result.ok) messages.push(result.error.message);
    }
    expect(messages).toHaveLength(6);
    expect(new Set(messages).size).toBe(6);
  });

  it("an unrecognized future reason surfaces honestly with its reason string, not 'Unknown error.'", async () => {
    // Simulates lib gaining a seventh reason before the dispatcher map is
    // updated: the fallback must still be actionable and name the reason.
    // The cast is the point — an out-of-union value smuggled through the
    // (compile-time-closed) lib boundary.
    const unseenReason = "brand_new_reason" as FailureReason;
    mockRecordActualDetailed.mockReturnValueOnce({ ok: false, reason: unseenReason });

    const result = await dispatch("record_actual", { estimate_id: "err-fixture", actual_hours: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).not.toBe("Unknown error.");
      expect(result.error.message).toContain("brand_new_reason");
      expect(result.error.message).toContain("err-fixture");
    }
  });

  it("success path is unaffected: recorded true with a confirmation message", async () => {
    const result = await dispatch("record_actual", { estimate_id: "ok-fixture", actual_hours: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)["recorded"]).toBe(true);
      expect((result.data as Record<string, unknown>)["message"]).toBeDefined();
    }
  });

  // ---- Ticket 16: unit_suspect surfaced + unknown_tool hint appended ----

  it("a flagged unit_suspect success surfaces flagged + flagHint + a warning message", async () => {
    mockRecordActualDetailed.mockReturnValueOnce({ ok: true, flagged: "unit_suspect" });

    const result = await dispatch("record_actual", { estimate_id: "unit-suspect-fixture", actual_hours: 300 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data["recorded"]).toBe(true);
      expect(data["flagged"]).toBe("unit_suspect");
      expect(String(data["flagHint"])).toContain("unit mismatch");
      expect(String(data["message"])).toContain("unit_suspect");
    }
  });

  it("an unflagged success carries no flagged field", async () => {
    const result = await dispatch("record_actual", { estimate_id: "ok-fixture", actual_hours: 2 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.data as Record<string, unknown>)["flagged"]).toBeUndefined();
    }
  });

  it("the lib's unknown_tool hint is appended to the error message (canonical name set visible)", async () => {
    mockRecordActualDetailed.mockReturnValueOnce({
      ok: false,
      reason: "unknown_tool",
      hint: "Actuals can only join estimates produced by Epoch's estimation tools: pert_estimate, reference_class_estimate.",
    });

    const result = await dispatch("record_actual", { estimate_id: "unknown-tool-fixture", actual_hours: 2 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("unrecognized tool name"); // ticket 04 vocabulary retained
      expect(result.error.message).toContain("pert_estimate"); // ticket 16 hint appended
    }
  });
});

describe("batch_record_actuals per-entry reasons (dispatcher seam)", () => {
  it("all-failed envelope surfaces the first per-entry reason instead of swallowing them", async () => {
    mockBatchRecordActuals.mockReturnValueOnce({
      total: 2,
      succeeded: 0,
      failed: 2,
      errors: [
        "Failed to record actual for estimate a (reason: duplicate)",
        "Failed to record actual for estimate b (reason: synthetic_id)",
      ],
    });

    const result = await dispatch("batch_record_actuals", {
      entries: [
        { estimate_id: "a", actual_hours: 2 },
        { estimate_id: "b", actual_hours: 2 },
      ],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("All 2 entries failed");
      expect(result.error.message).toContain("reason: duplicate");
      expect(defined(result.error.retryHint).length).toBeGreaterThan(0);
    }
  });

  it("partial success returns ok with per-entry reason strings in data.errors", async () => {
    mockBatchRecordActuals.mockReturnValueOnce({
      total: 2,
      succeeded: 1,
      failed: 1,
      errors: ["Failed to record actual for estimate b (reason: duplicate)"],
    });

    const result = await dispatch("batch_record_actuals", {
      entries: [
        { estimate_id: "a", actual_hours: 2 },
        { estimate_id: "b", actual_hours: 2 },
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      const data = result.data as Record<string, unknown>;
      expect(data["succeeded"]).toBe(1);
      expect(data["failed"]).toBe(1);
      expect(defined((data["errors"] as string[])[0])).toContain("reason: duplicate");
    }
  });
});
