// ---------------------------------------------------------------------------
// Epoch — TypeScript ↔ Rust Parity: Golden Cases
// Bounded, deterministic inputs exercising all 24 public tools across both
// runtimes. Each case declares the tool, its Rust CLI command, the shared
// input, and how the two outputs should be compared.
//
// Comparison modes:
//   "value" — outputs must deep-equal (numbers compared with float tolerance)
//   "shape" — only the key/type skeleton must match (used for time-volatile
//             tools like get_current_time)
//
// Expectations:
//   "ok"    — both runtimes must succeed and (per comparison mode) agree
//   "error" — both runtimes must reject the input (error compatibility)
//
// `ignoreFields` lists dotted paths blanked before comparison to absorb
// documented, acceptable nondeterminism. `feedbackRef` is always stripped
// (the TS dispatcher and the Rust dispatcher mint ids differently).
//
// `seedFixture`/`pendingRust`/`assertTs` (below) cover cases the Rust binary
// doesn't implement yet — deferred behavioral parity for exclusion.ts and
// ledger.ts overlay-merge semantics (Rust-freeze prerequisite; see plan
// .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md Phase 1).
// ---------------------------------------------------------------------------

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  ESTIMATES_FILE,
  ACTUALS_FILE,
  FLAGS_FILE,
  loadLedgerWithOverlays,
  type EstimateRecord,
  type ActualRecord,
  type OverlayRecordCore,
} from "../lib/ledger.js";

/** Write JSONL rows to `filename` under `dataDir` (mirrors ledger.ts's on-disk format: one JSON object per line). */
function writeJsonl(dataDir: string, filename: string, rows: readonly unknown[]): void {
  writeFileSync(join(dataDir, filename), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

/**
 * `assertTs` factory for the overlay-merge cases below: ignores the carrier
 * tool's own result and instead inspects `loadLedgerWithOverlays()` directly
 * — valid because the harness still has `EPOCH_DATA_DIR` pointed at this
 * case's seeded fixture dir when `assertTs` runs.
 */
function assertMergedFlags(
  id: string,
  expected: { quarantined: boolean; quarantineReason?: string; orphan: boolean },
) {
  return (result: { ok: boolean; error?: { message?: string } }): string | null => {
    if (!result.ok) return `expected the carrier tool to succeed; error: ${result.error?.message ?? ""}`;
    const merged = loadLedgerWithOverlays().find((r) => r.id === id);
    if (!merged) return `expected a merged ledger record for id=${id}, found none`;
    if (merged.flags.quarantined !== expected.quarantined) {
      return `flags.quarantined: expected ${expected.quarantined}, got ${merged.flags.quarantined}`;
    }
    if (merged.flags.quarantineReason !== expected.quarantineReason) {
      return `flags.quarantineReason: expected ${String(expected.quarantineReason)}, got ${String(merged.flags.quarantineReason)}`;
    }
    if (merged.flags.orphan !== expected.orphan) {
      return `flags.orphan: expected ${expected.orphan}, got ${merged.flags.orphan}`;
    }
    return null;
  };
}

export type ParityComparison = "value" | "shape";
export type ParityExpectation = "ok" | "error";

/** Minimal shape of a TypeScript-runtime execution result — mirrors rust-parity.ts's RuntimeResult without importing it (rust-parity.ts imports FROM this module; importing back would cycle). */
export interface ParityTsResult {
  readonly ok: boolean;
  readonly value?: unknown;
  readonly error?: { readonly message?: string };
}

export interface ParityCase {
  /** Unique, stable case id (used in the diff report). */
  readonly name: string;
  /** MCP tool name (snake_case) — routes the TypeScript handler. */
  readonly tool: string;
  /** Rust CLI command path — routes the compiled `epoch-cli` binary. */
  readonly cliCommand: string;
  /** Shared input passed verbatim to both runtimes. */
  readonly input: Record<string, unknown>;
  /** Whether both runtimes are expected to succeed or to reject. */
  readonly expect: ParityExpectation;
  /** How successful outputs are compared. Defaults to "value". */
  readonly comparison?: ParityComparison;
  /** Dotted paths blanked before comparison (documented nondeterminism). */
  readonly ignoreFields?: readonly string[];
  /** Short human note explaining intent or any tolerated divergence. */
  readonly note?: string;
  /**
   * Writes fixture rows (e.g. estimates.jsonl / feedback.jsonl / overlay
   * sidecars) into `dataDir` before this case executes. The harness points
   * `EPOCH_DATA_DIR` at a fresh, case-isolated temp directory for the
   * duration of this case only (restored afterward) — fixture-seeded cases
   * never see each other's rows or the shared harness-wide data dir,
   * killing order-dependence between them.
   */
  readonly seedFixture?: (dataDir: string) => void;
  /**
   * When set (a short reason string), this case is NOT run against the Rust
   * binary — the compiled epoch-cli doesn't implement the behavior under
   * test yet. The TS side still runs (via `tool`/`input`) and must satisfy
   * `assertTs`, pinning expected behavior now; drop this field (and verify
   * `assertTs` still passes) once the Rust branch implements it, at which
   * point the case can migrate to the normal ts-vs-rust comparison path.
   */
  readonly pendingRust?: string;
  /**
   * Required when `pendingRust` is set. Runs after the TS tool call (with
   * `EPOCH_DATA_DIR` still pointed at this case's seeded fixture dir, so it
   * may independently inspect ledger/overlay state, e.g. via
   * `loadLedgerWithOverlays()`). Return `null` when the pinned expectation
   * holds, or a description of the mismatch.
   */
  readonly assertTs?: (result: ParityTsResult) => string | null;
}

export const RUST_PARITY_CASES: readonly ParityCase[] = [
  // ---- Temporal -----------------------------------------------------------
  {
    name: "get_current_time/utc-shape",
    tool: "get_current_time",
    cliCommand: "get-current-time",
    input: { timezone: "UTC" },
    expect: "ok",
    comparison: "shape",
    note: "Wall-clock values are time-dependent; only the response skeleton is stable.",
  },
  {
    name: "convert_timezone/utc-to-la",
    tool: "convert_timezone",
    cliCommand: "convert-timezone",
    input: { timestamp: "2026-06-24T12:00:00Z", target_tz: "America/Los_Angeles" },
    expect: "ok",
  },
  {
    name: "convert_timezone/bad-timezone",
    tool: "convert_timezone",
    cliCommand: "convert-timezone",
    input: { timestamp: "2026-06-24T12:00:00Z", target_tz: "Not/AZone" },
    expect: "error",
  },
  {
    name: "parse_duration/compound",
    tool: "parse_duration",
    cliCommand: "parse-duration",
    input: { duration_string: "1w2d6h30m" },
    expect: "ok",
  },
  {
    name: "parse_duration/garbage",
    tool: "parse_duration",
    cliCommand: "parse-duration",
    input: { duration_string: "banana" },
    expect: "error",
  },
  {
    name: "time_math/add-days",
    tool: "time_math",
    cliCommand: "time-math",
    input: { operation: "add_days", operands: { start_date: "2026-06-24", days: 10 } },
    expect: "ok",
  },
  {
    name: "time_math/add-business-days",
    tool: "time_math",
    cliCommand: "time-math",
    input: {
      operation: "add_business_days",
      operands: { start_date: "2026-06-24", days: 3, country: "US" },
    },
    expect: "ok",
  },
  {
    name: "time_math/diff",
    tool: "time_math",
    cliCommand: "time-math",
    input: { operation: "diff", operands: { start_date: "2026-06-24", end_date: "2026-06-30" } },
    expect: "ok",
  },
  {
    name: "time_math/format-duration",
    tool: "time_math",
    cliCommand: "time-math",
    input: { operation: "format_duration", operands: { milliseconds: 93784000 } },
    expect: "ok",
  },
  {
    name: "time_math/convert-tz",
    tool: "time_math",
    cliCommand: "time-math",
    input: {
      operation: "convert_tz",
      operands: { timestamp: "2026-03-08T09:30:00Z", target_tz: "America/New_York" },
    },
    expect: "ok",
  },
  {
    name: "time_math/parse-nl",
    tool: "time_math",
    cliCommand: "time-math",
    input: { operation: "parse_nl", operands: { duration_string: "2d4h" } },
    expect: "ok",
  },
  {
    name: "add_business_days/forward",
    tool: "add_business_days",
    cliCommand: "add-business-days",
    input: { start_date: "2026-06-24", days: 5, country: "US" },
    expect: "ok",
  },
  {
    name: "add_business_days/backward",
    tool: "add_business_days",
    cliCommand: "add-business-days",
    input: { start_date: "2026-07-06", days: -3, country: "US" },
    expect: "ok",
  },
  {
    name: "count_business_days/span",
    tool: "count_business_days",
    cliCommand: "count-business-days",
    input: { start_date: "2026-06-01", end_date: "2026-06-30", country: "US" },
    expect: "ok",
  },

  // ---- Estimation ---------------------------------------------------------
  {
    name: "pert_estimate/basic",
    tool: "pert_estimate",
    cliCommand: "pert-estimate",
    input: { optimistic: 1, most_likely: 2, pessimistic: 4 },
    expect: "ok",
  },
  {
    name: "pert_estimate/days-unit",
    tool: "pert_estimate",
    cliCommand: "pert-estimate",
    input: { optimistic: 3, most_likely: 5, pessimistic: 12, unit: "days" },
    expect: "ok",
  },
  {
    name: "pert_estimate/confidence-rounding-boundary",
    tool: "pert_estimate",
    cliCommand: "pert-estimate",
    input: { optimistic: 2, most_likely: 5, pessimistic: 10 },
    expect: "ok",
    note: "Pins confidence-bound rounding to the TypeScript oracle: round the final bound, not the expected value first.",
  },
  {
    name: "pert_estimate/invalid-order",
    tool: "pert_estimate",
    cliCommand: "pert-estimate",
    input: { optimistic: 5, most_likely: 2, pessimistic: 4 },
    expect: "error",
  },
  {
    name: "cocomo_estimate/with-drivers",
    tool: "cocomo_estimate",
    cliCommand: "cocomo-estimate",
    input: { kloc: 10, reasoning_complexity: 1.2, human_oversight: 1.1 },
    expect: "ok",
  },
  {
    name: "cocomo_estimate/non-positive-kloc",
    tool: "cocomo_estimate",
    cliCommand: "cocomo-estimate",
    input: { kloc: 0 },
    expect: "error",
  },
  {
    name: "sprint_forecast/multi-sprint",
    tool: "sprint_forecast",
    cliCommand: "sprint-forecast",
    input: { backlog_points: 80, velocity_history: [18, 22, 20, 19] },
    expect: "ok",
  },
  {
    name: "sprint_forecast/custom-capacity",
    tool: "sprint_forecast",
    cliCommand: "sprint-forecast",
    input: {
      backlog_points: 42,
      velocity_history: [9, 12, 11],
      sprint_length_days: 7,
      hours_per_sprint: 160,
      ai_native: 0.8,
    },
    expect: "ok",
  },
  {
    name: "critical_path/diamond",
    tool: "critical_path",
    cliCommand: "critical-path",
    input: {
      tasks: [
        { name: "A", duration: 2, predecessors: [] },
        { name: "B", duration: 3, predecessors: ["A"] },
        { name: "C", duration: 1, predecessors: ["A"] },
        { name: "D", duration: 2, predecessors: ["B", "C"] },
      ],
    },
    expect: "ok",
  },
  {
    name: "critical_path/empty",
    tool: "critical_path",
    cliCommand: "critical-path",
    input: { tasks: [] },
    expect: "error",
  },
  {
    name: "critical_path/missing-predecessor",
    tool: "critical_path",
    cliCommand: "critical-path",
    input: { tasks: [{ name: "A", duration: 1, predecessors: ["missing"] }] },
    expect: "error",
  },
  {
    name: "monte_carlo_schedule/seeded",
    tool: "monte_carlo_schedule",
    cliCommand: "monte-carlo-schedule",
    input: {
      tasks: [
        { name: "A", optimistic: 1, most_likely: 2, pessimistic: 4 },
        { name: "B", optimistic: 2, most_likely: 3, pessimistic: 7 },
      ],
      iterations: 2000,
      seed: 1337,
    },
    expect: "ok",
    note: "Both runtimes share an identical seeded LCG (16807 / 2147483647), so seeded runs match by value.",
  },
  {
    name: "monte_carlo_schedule/zero-iterations",
    tool: "monte_carlo_schedule",
    cliCommand: "monte-carlo-schedule",
    input: {
      tasks: [{ name: "A", optimistic: 1, most_likely: 2, pessimistic: 3 }],
      iterations: 0,
    },
    expect: "error",
  },

  // ---- Analytics ----------------------------------------------------------
  {
    name: "reference_class_estimate/bugfix-small",
    tool: "reference_class_estimate",
    cliCommand: "reference-class-estimate",
    input: { task_type: "bugfix", complexity: 2, scope: "small" },
    expect: "ok",
  },
  {
    name: "reference_class_estimate/feature-large-hybrid",
    tool: "reference_class_estimate",
    cliCommand: "reference-class-estimate",
    input: { task_type: "feature", complexity: 4, scope: "large", ai_native: 0.5 },
    expect: "ok",
    note: "Pins sparse-data correction-factor lookup for non-AI-native reference-class estimates.",
  },
  {
    name: "calibrate_estimates/baseline",
    tool: "calibrate_estimates",
    cliCommand: "calibrate-estimates",
    input: { team_id: "parity-team" },
    expect: "ok",
    note: "Empty EPOCH_DATA_DIR ⇒ baseline reference-DB factor, matching Rust's empty in-memory store.",
  },
  {
    name: "token_time_bridge/shallow",
    tool: "token_time_bridge",
    cliCommand: "token-time-bridge",
    input: { tokens: 1200, model: "gpt-4o-mini", reasoning_depth: "shallow" },
    expect: "ok",
  },
  {
    name: "accuracy_trend/empty",
    tool: "accuracy_trend",
    cliCommand: "accuracy-trend",
    input: {},
    expect: "ok",
  },

  // ---- Cost ---------------------------------------------------------------
  {
    name: "token_cost_estimate/moderate",
    tool: "token_cost_estimate",
    cliCommand: "token-cost-estimate",
    input: { tokens: 5000, model: "gpt-4o-mini", reasoning_depth: "moderate" },
    expect: "ok",
  },
  {
    name: "token_cost_estimate/unknown-with-tools",
    tool: "token_cost_estimate",
    cliCommand: "token-cost-estimate",
    input: { tokens: 10000, model: "unknown-model", reasoning_depth: "deep", tool_calls: 3 },
    expect: "ok",
    note: "Pins Rust to the same reference-DB _default token-time calibration TypeScript uses for unknown models.",
  },
  {
    name: "compare_models/by-cost",
    tool: "compare_models",
    cliCommand: "compare-models",
    input: { tokens: 1200, sort_by: "cost" },
    expect: "ok",
  },
  {
    name: "compare_models/by-time",
    tool: "compare_models",
    cliCommand: "compare-models",
    input: { tokens: 1200, sort_by: "time" },
    expect: "ok",
  },

  // ---- Risk ---------------------------------------------------------------
  {
    name: "schedule_risk/feature",
    tool: "schedule_risk",
    cliCommand: "schedule-risk",
    input: { estimated_hours: 12, task_type: "feature" },
    expect: "ok",
  },

  // ---- Validation ---------------------------------------------------------
  {
    name: "cocomo_validate/nasa93",
    tool: "cocomo_validate",
    cliCommand: "cocomo-validate",
    input: { dataset_filter: ["NASA93"] },
    expect: "ok",
  },
  {
    name: "cocomo_ground_truth/nasa93",
    tool: "cocomo_ground_truth",
    cliCommand: "cocomo-ground-truth",
    input: { dataset_filter: ["NASA93"] },
    expect: "ok",
  },

  // ---- Feedback -----------------------------------------------------------
  {
    name: "get_pending_estimates/empty",
    tool: "get_pending_estimates",
    cliCommand: "get-pending-estimates",
    input: {},
    expect: "ok",
    note: "Both runtimes start from an empty estimate store in this harness.",
  },
  {
    name: "feedback_health/empty",
    tool: "feedback_health",
    cliCommand: "feedback-health",
    input: {},
    expect: "ok",
  },
  {
    name: "record_actual/missing-hours",
    tool: "record_actual",
    cliCommand: "record-actual",
    input: { estimate_id: "parity-1" },
    expect: "error",
    note: "Missing required actual_hours — both runtimes reject before any write.",
  },
  {
    name: "record_actual/synthetic-id-rejected",
    tool: "record_actual",
    cliCommand: "record-actual",
    input: { estimate_id: "seed-parity-001", actual_hours: 4 },
    expect: "error",
    note: "Exclusion semantics (Phase 3): synthetic/seed-prefixed estimate ids are rejected before any ledger write — pins the isSyntheticId() class of the shared exclusion predicate (src/lib/exclusion.ts) that both runtimes must replicate byte-identically. Stateless/non-mutating by design so it is safe to run repeatedly within the shared-directory golden-case harness.",
  },
  {
    name: "batch_record_actuals/missing-entries",
    tool: "batch_record_actuals",
    cliCommand: "batch-record-actuals",
    input: {},
    expect: "error",
    note: "Missing entries array — both runtimes reject before any write.",
  },

  // ---- Context-driven estimation (registered Phase 3; logic lands Phase 5) -
  {
    name: "estimate_from_context/not-implemented",
    tool: "estimate_from_context",
    cliCommand: "estimate-from-context",
    input: { context: "Fix a null pointer exception in the login flow." },
    expect: "ok",
    note: "Tool registration lands in Phase 3 (contract wave, before the Rust freeze); classification/delegation logic lands in Phase 5. Until the Rust CLI adds a matching stub, this case is expected to diverge on a live Rust binary — it is registered now so both runtimes converge on the same not-implemented contract once the Rust branch rebases onto main (see plan §3 Phase 3 merge order).",
  },

  // ---- Deferred behavioral parity: exclusion semantics (pendingRust) ------
  // Each case seeds a fresh (estimate, actual) pair exercising one
  // isExcluded() branch (src/lib/exclusion.ts), then observes the effect
  // through a real read-path tool — feedback_health or get_pending_estimates
  // — rather than asserting on the internal predicate directly. The Rust CLI
  // doesn't implement this yet (pendingRust), so only the TS side runs; the
  // Rust branch un-skips these (drops pendingRust) once it lands.
  ...(
    [
      {
        id: "parity-excl-backfill-1",
        estimatedHours: 10,
        estimatedAt: "2026-05-05T09:00:00.000Z",
        actualHours: 10,
        reportedAt: "2026-05-05T10:00:00.000Z",
        caseName: "exclusion/backfill-signature",
        reason: "exclusion.ts backfill_signature semantics (exact-match + 2026-05-05 date) not yet implemented in epoch-cli",
        note: "Pins isExcluded()'s backfill_signature reason: BOTH an exact actual/estimate match (within EXACT_MATCH_EPSILON) AND a 2026-05-05 UTC date signature are required together (Pre-mortem Scenario 1) — deferred parity case, see exclusion.ts.",
      },
      {
        id: "parity-excl-seednotes-1",
        estimatedHours: 10,
        estimatedAt: "2026-06-01T09:00:00.000Z",
        actualHours: 12,
        reportedAt: "2026-06-01T10:00:00.000Z",
        notes: "seed data for calibration baseline",
        caseName: "exclusion/seed-notes",
        reason: "exclusion.ts seed_notes semantics not yet implemented in epoch-cli",
        note: "Pins isExcluded()'s seed_notes reason: an actual whose notes mention seed/synthetic/dogfood-seed/test data is excluded regardless of id shape — deferred parity case, see exclusion.ts hasSeedNotes().",
      },
      {
        id: "parity-excl-ratio-1",
        estimatedHours: 100,
        estimatedAt: "2026-06-02T09:00:00.000Z",
        actualHours: 1,
        reportedAt: "2026-06-02T10:00:00.000Z",
        caseName: "exclusion/ratio-outlier",
        reason: "exclusion.ts ratio_outlier semantics not yet implemented in epoch-cli",
        note: "Pins isExcluded()'s ratio_outlier reason: actual/estimate ratio below MIN_RATIO (0.03) is excluded as synthetic/seed data — deferred parity case, see exclusion.ts.",
      },
    ] satisfies Array<{
      id: string;
      estimatedHours: number;
      estimatedAt: string;
      actualHours: number;
      reportedAt: string;
      notes?: string;
      caseName: string;
      reason: string;
      note: string;
    }>
  ).map(
    (spec): ParityCase => ({
      name: spec.caseName,
      tool: "feedback_health",
      cliCommand: "feedback-health",
      input: {},
      expect: "ok",
      pendingRust: spec.reason,
      note: spec.note,
      seedFixture: (dataDir) => {
        writeJsonl(dataDir, ESTIMATES_FILE, [
          {
            id: spec.id,
            tool: "pert_estimate",
            inputs: {},
            outputs: { estimatedHours: spec.estimatedHours },
            estimatedAt: spec.estimatedAt,
          },
        ] satisfies EstimateRecord[]);
        writeJsonl(dataDir, ACTUALS_FILE, [
          {
            estimateId: spec.id,
            actualHours: spec.actualHours,
            reportedAt: spec.reportedAt,
            ...(spec.notes !== undefined && { notes: spec.notes }),
          },
        ] satisfies ActualRecord[]);
      },
      assertTs: (result) => {
        if (!result.ok) return `expected feedback_health to succeed; error: ${result.error?.message ?? ""}`;
        const data = result.value as {
          totalEstimates: number;
          totalActuals: number;
          matchedPairs: number;
          seedRecordsFiltered: number;
        };
        if (data.totalEstimates !== 1) return `totalEstimates: expected 1, got ${data.totalEstimates}`;
        if (data.totalActuals !== 1) return `totalActuals: expected 1, got ${data.totalActuals}`;
        if (data.seedRecordsFiltered !== 1) {
          return `seedRecordsFiltered: expected 1 (record should be excluded), got ${data.seedRecordsFiltered}`;
        }
        if (data.matchedPairs !== 0) {
          return `matchedPairs: expected 0 (excluded record must not be correction-eligible), got ${data.matchedPairs}`;
        }
        return null;
      },
    }),
  ),
  {
    name: "exclusion/ttl-expired",
    tool: "get_pending_estimates",
    cliCommand: "get-pending-estimates",
    input: {},
    expect: "ok",
    pendingRust: "exclusion.ts ttl_expired semantics not yet implemented in epoch-cli",
    seedFixture: (dataDir) => {
      writeJsonl(dataDir, ESTIMATES_FILE, [
        {
          id: "parity-excl-ttl-expired",
          tool: "pert_estimate",
          inputs: {},
          outputs: { estimatedHours: 5 },
          estimatedAt: "2020-01-01T00:00:00.000Z",
          expiresAt: "2020-01-02T00:00:00.000Z",
        },
        {
          id: "parity-excl-ttl-live",
          tool: "pert_estimate",
          inputs: {},
          outputs: { estimatedHours: 5 },
          estimatedAt: "2026-06-01T00:00:00.000Z",
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      ] satisfies EstimateRecord[]);
    },
    assertTs: (result) => {
      if (!result.ok) return `expected get_pending_estimates to succeed; error: ${result.error?.message ?? ""}`;
      const data = result.value as { estimates: Array<{ id: string }> };
      const ids = data.estimates.map((r) => r.id).sort();
      if (ids.length !== 1 || ids[0] !== "parity-excl-ttl-live") {
        return `expected only the non-expired pending estimate to survive; got ids=[${ids.join(", ")}]`;
      }
      return null;
    },
    note: "Pins isExcluded()'s ttl_expired reason for pending (actual-less) estimates: get_pending_estimates() must drop a row whose expiresAt is in the past while keeping a live one — deferred parity case, see exclusion.ts and feedback.ts's getPendingEstimates().",
  },

  // ---- Deferred behavioral parity: overlay-merge semantics (pendingRust) --
  // ledger.ts's resolveOverlayConflicts()/mergeFlagsForId() apply flags/
  // labels sidecar records last-write-wins by `recordedAt`, tiebreak on
  // equal timestamps by monotonic `seq` — NOT file/line order (cross-
  // filesystem/cross-language safe). These cases seed conflicting overlay
  // rows in an order that would give the WRONG answer under a file-order or
  // seq-only merge, to pin the actual recordedAt-then-seq rule the Rust
  // binary must replicate. No dispatcher tool currently surfaces merged
  // overlay state (feedback.ts's read paths don't route through the overlay
  // loader yet — see ledger.ts's header), so `assertTs` inspects
  // loadLedgerWithOverlays() directly; get_pending_estimates is used only as
  // a lightweight, always-registered carrier tool for the `tool`/`cliCommand`
  // fields the harness requires.
  {
    name: "overlay-merge/last-write-wins-by-recordedAt",
    tool: "get_pending_estimates",
    cliCommand: "get-pending-estimates",
    input: {},
    expect: "ok",
    pendingRust: "ledger.ts overlay-merge (resolveOverlayConflicts/mergeFlagsForId) semantics not yet implemented in epoch-cli",
    seedFixture: (dataDir) => {
      writeJsonl(dataDir, ESTIMATES_FILE, [
        {
          id: "parity-overlay-recordedat",
          tool: "pert_estimate",
          inputs: {},
          outputs: { estimatedHours: 5 },
          estimatedAt: "2026-06-01T00:00:00.000Z",
        },
      ] satisfies EstimateRecord[]);
      // Written in seq order (1 then 2) but with recordedAt OUT of seq
      // order — proves the merge sorts by recordedAt, not by seq or
      // file/line order.
      writeJsonl(dataDir, FLAGS_FILE, [
        { id: "parity-overlay-recordedat", seq: 1, recordedAt: "2026-06-02T00:00:00.000Z", quarantined: true, reason: "manual-quarantine-A" },
        { id: "parity-overlay-recordedat", seq: 2, recordedAt: "2026-06-01T00:00:00.000Z", quarantined: false },
      ] satisfies OverlayRecordCore[]);
    },
    assertTs: assertMergedFlags("parity-overlay-recordedat", {
      quarantined: true,
      quarantineReason: "manual-quarantine-A",
      orphan: false,
    }),
    note: "Pins last-write-wins by recordedAt (not seq, not file order): the record with the LATER recordedAt (06-02) wins even though it has the LOWER seq (1) and appears first in the file — deferred parity case, see ledger.ts resolveOverlayConflicts().",
  },
  {
    name: "overlay-merge/seq-tiebreak-on-equal-recordedAt",
    tool: "get_pending_estimates",
    cliCommand: "get-pending-estimates",
    input: {},
    expect: "ok",
    pendingRust: "ledger.ts overlay-merge (resolveOverlayConflicts/mergeFlagsForId) semantics not yet implemented in epoch-cli",
    seedFixture: (dataDir) => {
      writeJsonl(dataDir, ESTIMATES_FILE, [
        {
          id: "parity-overlay-seqtiebreak",
          tool: "pert_estimate",
          inputs: {},
          outputs: { estimatedHours: 5 },
          estimatedAt: "2026-06-01T00:00:00.000Z",
        },
      ] satisfies EstimateRecord[]);
      // Equal recordedAt on both rows; written in seq order (5 then 2) so a
      // file-order merge would pick the WRONG (lower-seq) row as "last".
      writeJsonl(dataDir, FLAGS_FILE, [
        { id: "parity-overlay-seqtiebreak", seq: 5, recordedAt: "2026-06-01T00:00:00.000Z", quarantined: false },
        { id: "parity-overlay-seqtiebreak", seq: 2, recordedAt: "2026-06-01T00:00:00.000Z", quarantined: true, reason: "tiebreak-B" },
      ] satisfies OverlayRecordCore[]);
    },
    assertTs: assertMergedFlags("parity-overlay-seqtiebreak", {
      quarantined: false,
      quarantineReason: "tiebreak-B",
      orphan: false,
    }),
    note: "Pins the monotonic-seq tiebreak on equal recordedAt: the HIGHER-seq record (5) wins the quarantined flag even though it was written FIRST in the file (a file-order merge would pick seq=2's quarantined:true last). quarantineReason independently retains the last record that SET it (seq=2's 'tiebreak-B'), since seq=5's record leaves `reason` unset — each field last-write-wins independently, not whole-record replacement. Deferred parity case, see ledger.ts mergeFlagsForId().",
  },
] as const;
