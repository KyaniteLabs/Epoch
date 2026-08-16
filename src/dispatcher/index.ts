// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Main Dispatch Function
// Routes tool calls to registered handlers.
// Records telemetry and triggers self-improvement.
// ---------------------------------------------------------------------------

import { ZodError } from "zod";
import type { ToolResult } from "../types/index.js";
import { TOOL_REGISTRY, TOOL_NAMES, isEstimationTool } from "./tool-registry.js";
import { getTelemetry } from "../lib/telemetry.js";
import { recordEstimate, recordToolCall } from "../lib/feedback.js";
import { notifyToolCall } from "../lib/self-improve.js";
import { formatZodIssues, makeInternalError, makeStorageError, makeValidationError } from "../lib/internal/error-helpers.js";

// ---- Dispatch ---------------------------------------------------------------

export async function dispatch(
  toolName: string,
  rawInput: Record<string, unknown>,
): Promise<ToolResult<unknown>> {
  const definition = TOOL_REGISTRY.get(toolName);

  if (!definition) {
    const available = [...TOOL_NAMES].sort().join(", ");
    return {
      ok: false,
      error: {
        isError: true,
        message: `Unknown tool: "${toolName}".`,
        retryHint: `Available tools: ${available}`,
      },
    };
  }

  const startMs = performance.now();

  try {
    const result = definition.handler(rawInput);
    const elapsedMs = performance.now() - startMs;

    const telemetry = getTelemetry();
    telemetry.record(toolName, elapsedMs, result.ok, rawInput);

    if (result.ok) {
      const data = (result as { ok: true; data: unknown }).data;
      if (data && typeof data === "object") {
        const d = data as Record<string, unknown>;
        // Phase 1 Task 3: only tools that produce a time/effort estimate join
        // the estimates ledger (and are eligible for record_actual pairing).
        // Everything else is non-estimation telemetry — routed to a separate
        // stream so it never inflates totalEstimates/matchRate.
        if (isEstimationTool(toolName)) {
          const estimateId = recordEstimate(toolName, rawInput, d, resolveSource());
          // Ticket 18 (write-failure propagation): recordEstimate returns null
          // when the ledger append failed — the estimate never persisted, so
          // NO feedbackRef may be issued (no phantom tokens) and the tool call
          // fails instead of reporting success. Mirrors record_actual's
          // write_failed mapping on the estimate side.
          if (estimateId === null) {
            notifyToolCall();
            return {
              ok: false as const,
              // errorKind "storage" (review M3): server-side persistence
              // failure — 500-class at the HTTP seam, message surfaced
              // verbatim (crafted safe, no paths/stack).
              error: makeStorageError(
                `Failed to write estimate to feedback storage — ensure the Epoch data directory is writable. The ${toolName} result was computed but NOT recorded.`,
                "Fix permissions/disk on the Epoch data directory and re-run the estimation tool; no feedbackRef was issued.",
              ),
            };
          }
          if (hasHourEstimate(d)) {
            d.feedbackRef = estimateId;
          }
        } else {
          recordToolCall(toolName, rawInput, d, resolveSource());
        }
      }
    }

    notifyToolCall();

    return result;
  } catch (err: unknown) {
    const elapsedMs = performance.now() - startMs;
    getTelemetry().record(toolName, elapsedMs, false, rawInput);
    notifyToolCall();

    // Ticket 06 (agent-readable errors): a ZodError from the tool's input
    // schema is a caller-fixable validation failure, not an internal crash.
    // Render one `path: message` line per issue instead of zod's raw JSON
    // issues blob, tag the error "validation" so the HTTP seam maps it to
    // 422, and keep the offending values (from rawInput) in the text.
    if (err instanceof ZodError) {
      return {
        ok: false,
        error: makeValidationError(
          `Invalid input for ${toolName}:\n${formatZodIssues(err, rawInput)}`,
          "Fix the listed input fields and retry.",
        ),
      };
    }

    // Any other thrown error is internal: the caller cannot fix it by editing
    // inputs. Error.message is preserved for stdio/MCP consumers (agents need
    // the real reason), but the errorKind: "internal" tag lets the HTTP seam
    // replace it with a generic-safe message (no path/stack leakage) and a
    // 500 status. The retryHint matches that seam's vocabulary: server-side,
    // not an input problem (ticket 06).
    const message =
      err instanceof Error ? err.message : "Unexpected handler error.";
    return {
      ok: false,
      error: makeInternalError(
        message,
        `Tool "${toolName}" failed with a server-side error — this is not an input problem. Retry, and file an issue at https://github.com/KyaniteLabs/Epoch/issues if it persists.`,
      ),
    };
  }
}

// ---- Helpers ----------------------------------------------------------------

/** Resolve source project from env var or package.json. */
function resolveSource(): string | undefined {
  return process.env["EPOCH_SOURCE"];
}

const HOUR_FIELDS = [
  "expected", "totalHours", "estimatedHours", "estimatedMinutes",
  "estimatedSeconds", "personMonthsLlmAdjusted", "correctedEstimate",
  "total_duration",
] as const;

function hasHourEstimate(data: Record<string, unknown>): boolean {
  return HOUR_FIELDS.some((f) => typeof data[f] === "number");
}

export function listTools(): Array<{ name: string; description: string }> {
  return [...TOOL_REGISTRY.values()].map((def) => ({
    name: def.name,
    description: def.description,
  }));
}

// Re-export registry utilities
export { TOOL_REGISTRY, TOOL_NAMES } from "./tool-registry.js";
