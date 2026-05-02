// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Main Dispatch Function
// Routes tool calls to registered handlers with schema validation.
// Records telemetry and triggers self-improvement.
// ---------------------------------------------------------------------------

import type { ToolResult } from "../types/index.js";
import { TOOL_REGISTRY, TOOL_NAMES } from "./tool-registry.js";
import { getTelemetry } from "../lib/telemetry.js";
import { recordEstimate } from "../lib/feedback.js";
import { notifyToolCall } from "../lib/self-improve.js";

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

  const parsed = definition.inputSchema.safeParse(rawInput);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const path = issue.path.join(".");
        return path ? `${path}: ${issue.message}` : issue.message;
      })
      .join("; ");

    return {
      ok: false,
      error: {
        isError: true,
        message: `Validation error: ${issues}`,
        retryHint: `Check the input schema for "${toolName}".`,
      },
    };
  }

  const startMs = performance.now();

  try {
    const result = definition.handler(parsed.data as Record<string, unknown>);
    const elapsedMs = performance.now() - startMs;

    const telemetry = getTelemetry();
    telemetry.record(toolName, elapsedMs, result.ok, parsed.data);

    if (result.ok) {
      const data = (result as { ok: true; data: unknown }).data;
      if (data && typeof data === "object") {
        recordEstimate(toolName, parsed.data, data as Record<string, unknown>);
      }
    }

    notifyToolCall();

    return result;
  } catch (err: unknown) {
    const elapsedMs = performance.now() - startMs;
    getTelemetry().record(toolName, elapsedMs, false, parsed.data);
    notifyToolCall();

    const message =
      err instanceof Error ? err.message : "Unexpected handler error.";
    return {
      ok: false,
      error: {
        isError: true,
        message,
        retryHint: `Tool "${toolName}" encountered an internal error. Check inputs and try again.`,
      },
    };
  }
}

// ---- Helpers ----------------------------------------------------------------

export function listTools(): Array<{ name: string; description: string }> {
  return [...TOOL_REGISTRY.values()].map((def) => ({
    name: def.name,
    description: def.description,
  }));
}

// Re-export registry utilities
export { TOOL_REGISTRY, TOOL_NAMES } from "./tool-registry.js";
