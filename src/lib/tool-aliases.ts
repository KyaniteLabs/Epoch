// ---------------------------------------------------------------------------
// Epoch Tool Name Canonicalization
// ---------------------------------------------------------------------------
//
// Single source of truth for resolving any tool-name spelling seen in
// ingested estimate/actual records (legacy camelCase writers, manual/external
// ingest, or a garbled `tool` field) to the canonical snake_case tool name
// registered in src/dispatcher/tool-registry.ts's TOOL_REGISTRY.
//
// CANONICAL_TOOL_NAMES is DERIVED FROM (kept in sync with, not imported from)
// TOOL_NAMES in tool-registry.ts. It intentionally does not import that
// module: tool-registry.ts imports src/lib/feedback.ts, and feedback.ts
// imports this module, so importing tool-registry.ts here would create an
// import cycle (dispatcher/tool-registry -> lib/feedback -> lib/tool-aliases
// -> dispatcher/tool-registry). Keep this list in sync by hand when tools are
// added, removed, or renamed in tool-registry.ts.
//
// Plan reference: .omc/plans/2026-07-09-epoch-remediation-enhancement-plan.md
// §Phase 1 Task 1 ("tool-name canonicalization at ingest").

/** Canonical tool names, mirrors TOOL_NAMES in src/dispatcher/tool-registry.ts. */
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
