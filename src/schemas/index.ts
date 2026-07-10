// ---------------------------------------------------------------------------
// Epoch MCP Server — Zod Schemas for MCP Tools
// KyaniteLabs | Time Estimation for LLMs
//
// Patterns: .describe() on every field, branded IDs, discriminated unions,
//           no `any`, functional helpers.
// ---------------------------------------------------------------------------

import { z } from "zod";

// ---- Shared enum schemas --------------------------------------------------

export const timeUnitEnum = z
  .enum(["hours", "days", "weeks", "months"])
  .describe("Time unit used throughout the estimation result.");

export const taskTypeEnum = z
  .enum([
    "feature",
    "bugfix",
    "refactor",
    "migration",
    "infrastructure",
    "documentation",
    "testing",
    "design",
  ])
  .describe("Category of work being estimated for reference-class lookup.");

export const llmModelEnum = z
  .enum([
    "gpt-4o",
    "gpt-4o-mini",
    "gpt-4-turbo",
    "claude-sonnet-4-20250514",
    "claude-opus-4-20250514",
    "claude-3.5-haiku-20241022",
    "gemini-2.0-flash",
    "gemini-2.5-pro",
    "llama-3.1-70b",
    "llama-3.1-405b",
    "mistral-large",
    "deepseek-v3",
  ])
  .describe(
    "LLM model identifier used to estimate token-to-time conversion."
  );

/** AI ratio: 0.0 = fully human, 1.0 = fully AI-native, 0.5 = hybrid. Booleans accepted for backward compat. */
const aiNativeGradient = z
  .union([z.boolean(), z.coerce.number().min(0).max(1)])
  .transform((v) => (typeof v === "boolean" ? (v ? 1.0 : 0.0) : v))
  .describe("Degree of AI assistance: 0.0 = fully human, 1.0 = fully AI-native, 0.5 = hybrid. Accepts boolean for backward compatibility (true=1.0, false=0.0).")
  .default(1.0);

export const reasoningDepthEnum = z
  .enum(["shallow", "moderate", "deep"])
  .describe(
    "How much chain-of-thought reasoning the model is expected to perform. Deep reasoning multiplies estimated time."
  );

// ---- Shared provenance/routing fields (Phase 3 contract wave) -------------
// Optional on every estimation tool's input schema. Persisted verbatim on the
// estimate row (recordEstimate() stores the raw dispatch input) — no extra
// dispatcher plumbing is needed for persistence, only formal schema
// acceptance/validation and, for task_label, output surfacing (see
// get_pending_estimates in tool-registry.ts).

/** Reusable complexity scale (1=trivial .. 5=extreme). Bounds match referenceClassEstimateSchema's `complexity`. */
export const complexityScale = z
  .number()
  .min(1)
  .max(5)
  .describe("Fine-tuning complexity from 1 (trivial) to 5 (extreme).");

const taskLabelField = z
  .string()
  .min(1)
  .describe(
    "Optional free-text label identifying the task this estimate is for (e.g. an issue key or short title). Surfaced on get_pending_estimates output for triage."
  )
  .optional();

const projectField = z
  .string()
  .min(1)
  .describe(
    "Optional project/repo identifier this estimate belongs to, for cross-project analytics."
  )
  .optional();

const sessionIdField = z
  .string()
  .min(1)
  .describe(
    "Optional session identifier (minted by a calling agent/hook) used to deduplicate repeated estimate calls for the same task within a session."
  )
  .optional();

// ---- Shared record_actual/batch_record_actuals fields ----------------------

export const actualUnitEnum = z
  .enum(["minutes", "hours", "days", "weeks"])
  .describe(
    "Unit actual_hours is expressed in. Normalized to hours at ingest (days=8h, weeks=40h workday convention, matching estimation.ts's toHours()). Defaults to hours when omitted."
  );

export const calibrationProvenanceEnum = z
  .enum([
    "prospective",
    "backfilled_real_session",
    "backfilled_calibration",
    "synthetic",
    "smoke",
    "unknown",
  ])
  .describe(
    "Optional explicit provenance classification for this actual, consumed by the shared exclusion predicate (synthetic/smoke are excluded from calibration math)."
  );

// ---- Branded helpers ------------------------------------------------------

/** Brand a string to prevent accidental ID interchange. */
const brandedString = (label: string) =>
  z.string().describe(`${label} identifier`).brand<string>();

// ---- Tool 2: timeMath -----------------------------------------------------

const timeMathOperationEnum = z
  .enum([
    "add_days",
    "add_business_days",
    "diff",
    "convert_tz",
    "parse_nl",
    "format_duration",
  ])
  .describe(
    "The time arithmetic operation to perform. Each operation expects specific operands."
  );

export const timeMathSchema = z.object({
  operation: timeMathOperationEnum,
  operands: z
    .record(z.string(), z.unknown())
    .describe(
      "Key-value pairs matching the chosen operation's expected fields. See operation documentation for required keys."
    ),
});

export type TimeMathInput = z.infer<typeof timeMathSchema>;

// ---- Tool 3: pertEstimate -------------------------------------------------

export const pertEstimateSchema = z.object({
  optimistic: z
    .coerce.number()
    .positive()
    .describe(
      "Best-case duration. Do NOT use your initial optimistic guess — this should be the absolute minimum if everything goes perfectly."
    ),
  most_likely: z
    .coerce.number()
    .positive()
    .describe(
      "Mode of the distribution — the single most probable outcome."
    ),
  pessimistic: z
    .coerce.number()
    .positive()
    .describe(
      "Worst-case duration accounting for known risks and unknown unknowns."
    ),
  unit: timeUnitEnum.default("hours").describe("Time unit for all three PERT estimates."),
  task_type: taskTypeEnum
    .describe("Optional task type for feedback matching. Enables per-task-type accuracy tracking.")
    .optional(),
  ai_native: aiNativeGradient,
  complexity: complexityScale
    .describe(
      "Optional complexity hint from 1 (trivial) to 5 (extreme). Reserved for future per-complexity correction-factor conditioning; not yet applied to the headline estimate."
    )
    .optional(),
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type PertEstimateInput = z.infer<typeof pertEstimateSchema>;

// ---- Tool 4: cocomoEstimate -----------------------------------------------

export const cocomoEstimateSchema = z.object({
  kloc: z
    .coerce.number()
    .positive()
    .describe(
      "Estimated thousands of lines of code. Count actual code, not comments/blank lines."
    ),
  reasoning_complexity: z
    .coerce.number()
    .min(0.5)
    .max(2.0)
    .describe(
      "Multiplier for reasoning complexity of the codebase. 0.5 = trivial CRUD, 1.0 = average, 2.0 = novel algorithm/R&D."
    )
    .default(1.0),
  context_completeness: z
    .coerce.number()
    .min(0.5)
    .max(2.0)
    .describe(
      "How complete is the context provided to the LLM? 0.5 = exhaustive specs, 1.0 = typical, 2.0 = vague requirements."
    )
    .default(1.0),
  transformation_impact: z
    .coerce.number()
    .min(0.5)
    .max(2.0)
    .describe(
      "Scale of transformation relative to existing code. 0.5 = small patch, 1.0 = new module, 2.0 = architectural rewrite."
    )
    .default(1.0),
  iterative_cycles: z
    .coerce.number()
    .min(0.5)
    .max(10.0)
    .describe(
      "Iteration overhead multiplier or literal cycle count. Multiplier scale: 0.5 = one-shot, 1.0 = typical debug loop, 2.0 = heavy back-and-forth. Values above 2.0 are accepted as literal cycle counts and normalized internally."
    )
    .default(1.0),
  human_oversight: z
    .coerce.number()
    .min(0.5)
    .max(2.0)
    .describe(
      "Human review overhead multiplier. 0.5 = auto-merged, 1.0 = standard PR review, 2.0 = compliance/security review."
    )
    .default(1.0),
  task_type: taskTypeEnum
    .describe("Optional task type for feedback matching.")
    .optional(),
  ai_native: aiNativeGradient,
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type CocomoEstimateInput = z.infer<typeof cocomoEstimateSchema>;

// ---- Tool 5: sprintForecast -----------------------------------------------

export const sprintForecastSchema = z.object({
  backlog_points: z
    .coerce.number()
    .positive()
    .describe(
      "Total story points or effort units remaining in the backlog."
    ),
  velocity_history: z
    .array(z.coerce.number().positive().describe("Velocity in points for a single sprint (must be > 0)."))
    .min(1)
    .describe(
      "Historical velocities from completed sprints. Minimum 1 data point; 3+ recommended for meaningful forecasts."
    ),
  sprint_length_days: z
    .coerce.number()
    .positive()
    .describe("Calendar days in a single sprint cycle.")
    .default(14),
  hours_per_sprint: z
    .coerce.number()
    .positive()
    .describe(
      "Total productive engineering hours available per sprint (accounts for meetings, overhead)."
    )
    .default(300),
  task_type: taskTypeEnum
    .describe("Optional task type for feedback matching.")
    .optional(),
  ai_native: aiNativeGradient,
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type SprintForecastInput = z.infer<typeof sprintForecastSchema>;

// ---- Tool 6: criticalPath -------------------------------------------------

const taskSchema = z.object({
  name: z
    .string()
    .min(1)
    .describe("Unique task identifier used in predecessor references."),
  duration: z
    .coerce.number()
    .positive()
    .describe("Estimated task duration in days."),
  predecessors: z
    .array(z.string().describe("Name of a preceding task that must finish first."))
    .describe(
      "List of task names this task depends on. Use an empty array for start nodes."
    ),
});

export const criticalPathSchema = z.object({
  tasks: z
    .array(taskSchema)
    .min(1)
    .describe(
      "All tasks in the project graph. Each task must have a unique name."
    ),
  task_type: taskTypeEnum
    .describe("Optional task type for feedback matching.")
    .optional(),
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type CriticalPathInput = z.infer<typeof criticalPathSchema>;

// ---- Tool 8: referenceClassEstimate ---------------------------------------

export const referenceClassEstimateSchema = z.object({
  task_type: taskTypeEnum,
  scope: z
    .enum(["small", "medium", "large", "xl"])
    .describe(
      "Rough size of the task: small=tiny fix/tweak, medium=typical task, large=significant effort, xl=epic-scale. When omitted, inferred from complexity (1-2=small, 3=medium, 4=large, 5=xl)."
    )
    .optional(),
  complexity: z
    .number()
    .min(1)
    .max(5)
    .describe(
      "Fine-tuning complexity from 1 (trivial) to 5 (extreme). Adjusts within the scope band: low complexity shortens, high complexity lengthens the estimate."
    )
    .default(3),
  team_id: brandedString("Team")
    .describe(
      "Optional team identifier to scope historical data to a specific team."
    )
    .optional(),
  ai_native: aiNativeGradient,
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type ReferenceClassEstimateInput = z.infer<
  typeof referenceClassEstimateSchema
>;

// ---- Tool 9: monteCarlo ---------------------------------------------------

export const monteCarloSchema = z.object({
  tasks: z
    .array(
      z.object({
        name: z.string().min(1).describe("Task name / identifier."),
        optimistic: z
          .coerce.number()
          .positive()
          .describe("Best-case duration in days."),
        most_likely: z
          .coerce.number()
          .positive()
          .describe("Most probable duration in days."),
        pessimistic: z
          .coerce.number()
          .positive()
          .describe("Worst-case duration in days."),
      }).refine(
        (t) => t.optimistic <= t.most_likely && t.most_likely <= t.pessimistic,
        { message: "Estimates must satisfy optimistic <= most_likely <= pessimistic." },
      )
    )
    .min(1)
    .describe(
      "Task list with PERT-style three-point estimates and dependency edges."
    ),
  iterations: z
    .coerce.number()
    .min(1)
    .max(100000)
    .describe("Number of Monte Carlo simulation iterations (1–100,000). Higher = more stable percentiles.")
    .default(10000),
  seed: z.number().int().optional().describe("Optional seed for reproducible results."),
  task_type: taskTypeEnum
    .describe("Optional task type for feedback matching. Enables per-task-type accuracy tracking.")
    .optional(),
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type MonteCarloInput = z.infer<typeof monteCarloSchema>;

// ---- Tool 10: calibrateEstimates ------------------------------------------

export const calibrateEstimatesSchema = z.object({
  team_id: brandedString("Team").describe(
    "Team identifier whose historical accuracy data should be analysed."
  ),
  period_days: z
    .coerce.number()
    .positive()
    .describe("Lookback window in calendar days for calibration data.")
    .default(90),
  minimum_samples: z
    .coerce.number()
    .positive()
    .describe(
      "Minimum number of completed tasks required before producing a calibration factor."
    )
    .default(10),
});

export type CalibrateEstimatesInput = z.infer<typeof calibrateEstimatesSchema>;

// ---- Tool 11: tokenTimeBridge ---------------------------------------------

export const tokenTimeBridgeSchema = z.object({
  tokens: z
    .coerce.number()
    .positive()
    .describe("Total number of tokens in the LLM request (prompt + completion)."),
  model: z.string().describe("LLM model identifier. Unknown models fall back to generic estimates."),
  tool_calls: z
    .coerce.number()
    .nonnegative()
    .describe(
      "Number of tool calls expected in the agentic loop. Each adds overhead latency."
    )
    .default(0),
  reasoning_depth: reasoningDepthEnum
    .describe(
      "Expected depth of chain-of-thought reasoning. Deep reasoning adds significant per-token latency."
    )
    .default("moderate"),
  task_type: taskTypeEnum
    .describe("Optional task type for feedback matching.")
    .optional(),
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type TokenTimeBridgeInput = z.infer<typeof tokenTimeBridgeSchema>;

// ---- Tool 15: tokenCostEstimate -------------------------------------------

export const tokenCostEstimateSchema = z.object({
  tokens: z
    .coerce.number()
    .positive()
    .describe("Total number of tokens in the LLM request (prompt + completion)."),
  model: z.string().describe("LLM model identifier. Unknown models fall back to generic estimates."),
  tool_calls: z
    .coerce.number()
    .nonnegative()
    .describe("Number of tool calls expected in the agentic loop.")
    .default(0),
  reasoning_depth: reasoningDepthEnum
    .describe("Expected depth of chain-of-thought reasoning.")
    .default("moderate"),
  task_type: taskTypeEnum
    .describe("Optional task type for feedback matching.")
    .optional(),
});

export type TokenCostEstimateInput = z.infer<typeof tokenCostEstimateSchema>;

// ---- Tool 16: compareModels -----------------------------------------------

export const compareModelsSchema = z.object({
  tokens: z
    .coerce.number()
    .positive()
    .describe("Total number of tokens to estimate across all models."),
  tool_calls: z
    .coerce.number()
    .nonnegative()
    .describe("Number of tool calls expected.")
    .default(0),
  reasoning_depth: reasoningDepthEnum
    .describe("Expected depth of chain-of-thought reasoning.")
    .default("moderate"),
  sort_by: z
    .enum(["cost", "time"])
    .describe("Sort models by cost (default) or estimated time.")
    .default("cost"),
});

export type CompareModelsInput = z.infer<typeof compareModelsSchema>;

// ---- Tool 17: accuracyTrend -----------------------------------------------

export const accuracyTrendSchema = z.object({
  team_id: brandedString("Team")
    .describe("Optional team identifier to scope historical data.")
    .optional(),
  window_size: z
    .coerce.number()
    .min(5)
    .describe("Number of records per sliding window.")
    .default(50),
});

export type AccuracyTrendInput = z.infer<typeof accuracyTrendSchema>;

// ---- Tool 18: scheduleRisk ------------------------------------------------

export const scheduleRiskSchema = z.object({
  estimated_hours: z
    .coerce.number()
    .positive()
    .describe("The estimated effort in hours to assess risk for."),
  task_type: taskTypeEnum
    .describe("Optional task type to refine historical accuracy lookup.")
    .optional(),
  team_id: brandedString("Team")
    .describe("Optional team identifier to scope historical data.")
    .optional(),
  complexity: z
    .number()
    .min(1)
    .max(5)
    .describe("Task complexity from 1 (trivial) to 5 (extreme). Higher complexity widens confidence intervals.")
    .optional(),
  ai_native: aiNativeGradient,
  task_label: taskLabelField,
  project: projectField,
  session_id: sessionIdField,
});

export type ScheduleRiskInput = z.infer<typeof scheduleRiskSchema>;

// ---- Tool 19: cocomoValidate ----------------------------------------------

export const cocomoValidateSchema = z.object({
  dataset_filter: z
    .array(z.string().describe("Dataset name: COCOMO81, NASA93, Albrecht, or Kemerer."))
    .describe("Optional filter to validate against specific datasets only.")
    .optional(),
});

export type CocomoValidateInput = z.infer<typeof cocomoValidateSchema>;

// ---- Tool 20: cocomoGroundTruth --------------------------------------------

export const cocomoGroundTruthSchema = z.object({
  dataset_filter: z
    .array(z.string().describe("Dataset name: COCOMO81, NASA93, Albrecht, or Kemerer."))
    .describe("Optional filter to validate against specific datasets only.")
    .optional(),
});

export type CocomoGroundTruthInput = z.infer<typeof cocomoGroundTruthSchema>;

// ---- Tool 21: batchRecordActuals -------------------------------------------

export const batchRecordActualsSchema = z.object({
  entries: z
    .array(
      z.object({
        estimate_id: z.string().describe("ID of the estimate to update."),
        actual_hours: z.number().positive().describe("Actual hours spent."),
        notes: z.string().optional().describe("Optional context."),
        unit: actualUnitEnum.optional(),
        calibration_provenance: calibrationProvenanceEnum.optional(),
      }),
    )
    .min(1)
    .max(500)
    .describe("Array of actual-hour records (1–500 entries)."),
});

export type BatchRecordActualsInput = z.infer<typeof batchRecordActualsSchema>;

// ---- Tool 22: feedbackHealth -----------------------------------------------

export const feedbackHealthSchema = z.object({});

export type FeedbackHealthInput = z.infer<typeof feedbackHealthSchema>;

// ---- Tool: recordActual ----------------------------------------------------
// Moved here from dispatcher/tool-registry.ts (Phase 3 contract wave) so all
// tool input schemas live in one place, matching batchRecordActualsSchema.

export const recordActualSchema = z.object({
  estimate_id: z.string().describe("ID of the estimate to update."),
  actual_hours: z.number().positive().describe("Actual hours spent."),
  notes: z.string().optional().describe("Optional context."),
  unit: actualUnitEnum.optional(),
  calibration_provenance: calibrationProvenanceEnum.optional(),
});

export type RecordActualInput = z.infer<typeof recordActualSchema>;

// ---- Tool: estimateFromContext (Phase 3 registration; logic lands Phase 5) -
//
// Registered now so its contract lands before the Rust parity freeze; the
// handler currently returns a structured "not implemented yet" response.
// See .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md §3 Phase 3
// Task 4 and Phase 5.

export const estimateFromContextSchema = z.object({
  context: z
    .string()
    .min(1)
    .describe(
      "Free-text context describing the task to estimate — issue body, PR/diff description, or task summary. Will be used to classify task_type and complexity and delegate to reference_class_estimate / PERT correction once classification logic ships (Phase 5)."
    ),
  task_type: taskTypeEnum
    .describe("Optional pre-classified task type hint; used once classification logic ships.")
    .optional(),
  complexity: complexityScale
    .describe("Optional pre-assessed complexity hint (1-5); used once classification logic ships.")
    .optional(),
  team_id: brandedString("Team")
    .describe("Optional team identifier to scope historical data once classification logic ships.")
    .optional(),
});

export type EstimateFromContextInput = z.infer<typeof estimateFromContextSchema>;
