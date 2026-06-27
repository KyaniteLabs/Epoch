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
// ---------------------------------------------------------------------------

export type ParityComparison = "value" | "shape";
export type ParityExpectation = "ok" | "error";

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
    name: "batch_record_actuals/missing-entries",
    tool: "batch_record_actuals",
    cliCommand: "batch-record-actuals",
    input: {},
    expect: "error",
    note: "Missing entries array — both runtimes reject before any write.",
  },
] as const;
