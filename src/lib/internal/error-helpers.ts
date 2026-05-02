// ---------------------------------------------------------------------------
// Epoch MCP Server — Shared error helper
// Single source of truth for creating ToolError objects.
// ---------------------------------------------------------------------------

import type { ToolError } from "../../types/index.js";

/**
 * Creates a structured {@link ToolError} with an optional retry hint.
 * Every lib module should use this instead of hand-rolling error objects.
 */
export function makeError(message: string, retryHint?: string): ToolError {
  return { isError: true, message, retryHint };
}
