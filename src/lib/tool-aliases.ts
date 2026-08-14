// ---------------------------------------------------------------------------
// Epoch Tool Surface — Authoritative Definition + Name Canonicalization
// ---------------------------------------------------------------------------
//
// SINGLE SOURCE OF TRUTH for the canonical tool surface. This module defines
// the authoritative set of tool names, the estimation/non-estimation
// partition, and the derived tool count. Every consumer derives from it:
//
//   - src/dispatcher/tool-registry.ts derives its TOOL_NAMES,
//     ESTIMATION_TOOLS, NON_ESTIMATION_TOOLS exports (and its count claims)
//     from this module.
//   - src/lib/feedback.ts derives the feedback-health data-completeness
//     "calibrated tools" denominator list from ESTIMATION_TOOL_NAMES.
//   - docs/llms.txt's Tool Reference and the llms.txt count claims are pinned
//     to this set by the sync suite (src/dispatcher/tool-surface-sync.test.ts).
//
// It intentionally imports nothing (lib stays MCP-independent, and importing
// dispatcher/tool-registry.ts here would create a cycle: tool-registry ->
// lib/feedback -> lib/tool-aliases). When a tool is added, removed, or
// renamed, change THIS module first; the sync suite then fails until the
// registry registration, alias canonicalization targets, feedback-health
// list, and llms.txt tool reference are brought in line.
//
// canonicalizeToolName() additionally resolves any tool-name spelling seen in
// ingested estimate/actual records (legacy camelCase writers, manual/external
// ingest, or a garbled `tool` field) to one of the canonical names below.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §Phase 1 Task 1 ("tool-name canonicalization at ingest"); remediation
// ticket 03 ("authoritative tool surface in lib — kill all hand-copies").

/**
 * Canonical tool names — the authoritative Epoch tool surface.
 * Derivation direction: tool-registry.ts's TOOL_NAMES derives FROM this set,
 * never the other way around.
 */
export const CANONICAL_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_current_time",
  "convert_timezone",
  "parse_duration",
  "time_math",
  "add_business_days",
  "count_business_days",
  "pert_estimate",
  "cocomo_estimate",
  "sprint_forecast",
  "critical_path",
  "monte_carlo_schedule",
  "reference_class_estimate",
  "estimate_from_context",
  "calibrate_estimates",
  "token_time_bridge",
  "token_cost_estimate",
  "compare_models",
  "accuracy_trend",
  "schedule_risk",
  "cocomo_validate",
  "cocomo_ground_truth",
  "record_actual",
  "get_pending_estimates",
  "batch_record_actuals",
  "feedback_health",
]);

/**
 * The estimation partition: tools that PRODUCE a time/effort estimate, join
 * the estimates ledger (estimates.jsonl), and are eligible for record_actual
 * pairing. Every tool's feedbackRef must come from a tool in this set.
 * Semantic knowledge, so it is the one literal partition definition; the
 * complement below is derived, never hand-copied.
 */
export const ESTIMATION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "pert_estimate",
  "reference_class_estimate",
  "cocomo_estimate",
  "sprint_forecast",
  "monte_carlo_schedule",
  "schedule_risk",
  "critical_path",
  "token_time_bridge",
  // estimate_from_context produces a real reference-class-delegated hour
  // estimate (correctedEstimate), so it joins the ledger and is eligible for
  // record_actual pairing, same as reference_class_estimate.
  "estimate_from_context",
]);

/** The non-estimation partition: derived as the complement of the estimation partition. */
export const NON_ESTIMATION_TOOL_NAMES: ReadonlySet<string> = new Set(
  [...CANONICAL_TOOL_NAMES].filter((name) => !ESTIMATION_TOOL_NAMES.has(name)),
);

/** Total tool count, derived from the authoritative set. */
export const TOOL_COUNT = CANONICAL_TOOL_NAMES.size;

/** Estimation-tool count, derived from the authoritative partition. */
export const ESTIMATION_TOOL_COUNT = ESTIMATION_TOOL_NAMES.size;

/** Explicit aliases for tool-name spellings that don't camelCase-normalize to a canonical name. */
const TOOL_ALIASES: Readonly<Record<string, string>> = {
  manual_pert_estimate: "pert_estimate",
  manual_orchestration_pert: "pert_estimate",
};

/** Full-string UUID shape (version-agnostic): 8-4-4-4-12 hex, used to catch a `tool` field that was accidentally set to an id. */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Convert a camelCase (or PascalCase) string to snake_case. Best-effort; only used as a fallback lookup. */
function camelToSnake(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Resolve any tool-name spelling to its canonical snake_case form.
 * Returns null for raw UUIDs and any name that cannot be resolved to a
 * known tool — callers must treat null as "unresolvable", not "pass through".
 */
export function canonicalizeToolName(name: string | null | undefined): string | null {
  if (typeof name !== "string") return null;
  const trimmed = name.trim();
  if (trimmed.length === 0) return null;
  if (UUID_PATTERN.test(trimmed)) return null;

  if (CANONICAL_TOOL_NAMES.has(trimmed)) return trimmed;

  const alias = TOOL_ALIASES[trimmed];
  if (alias) return alias;

  const snake = camelToSnake(trimmed);
  if (CANONICAL_TOOL_NAMES.has(snake)) return snake;

  return null;
}
