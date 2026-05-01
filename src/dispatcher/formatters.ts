// ---------------------------------------------------------------------------
// Epoch MCP Server — Dispatcher: Output Formatters
// JSON and table formatting for tool results.
// ---------------------------------------------------------------------------

import type { ToolResult } from "../types/index.js";

// ---- JSON Formatter ---------------------------------------------------------

export function formatJson(result: ToolResult<unknown>): string {
  return JSON.stringify(result, null, 2);
}

// ---- Table Formatter --------------------------------------------------------

export function formatTable(result: ToolResult<unknown>, toolName: string): string {
  if (!result.ok) {
    return `Error (${toolName}): ${result.error.message}`;
  }

  const lines: string[] = [`=== ${toolName} ===`];
  formatValue(lines, result.data, 0);
  return lines.join("\n");
}

function formatValue(lines: string[], value: unknown, depth: number): void {
  const indent = "  ".repeat(depth);

  if (value === null || value === undefined) {
    lines.push(`${indent}(empty)`);
    return;
  }

  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    const entries = Object.entries(obj);

    if (entries.length === 0) {
      lines.push(`${indent}(empty object)`);
      return;
    }

    // Compute max key length for alignment at this depth
    const maxKeyLen = Math.max(...entries.map(([k]) => k.length));

    for (const [key, val] of entries) {
      if (val !== null && typeof val === "object" && !Array.isArray(val)) {
        lines.push(`${indent}${key}:`);
        formatValue(lines, val, depth + 1);
      } else if (Array.isArray(val)) {
        lines.push(`${indent}${key}: [${val.length} items]`);
        const preview = val.slice(0, 3);
        for (const item of preview) {
          if (typeof item === "object" && item !== null) {
            formatValue(lines, item, depth + 1);
          } else {
            lines.push(`${indent}  - ${String(item)}`);
          }
        }
        if (val.length > 3) {
          lines.push(`${indent}  ... and ${val.length - 3} more`);
        }
      } else {
        const paddedKey = key.padEnd(maxKeyLen);
        lines.push(`${indent}${paddedKey}  ${String(val)}`);
      }
    }
  } else if (Array.isArray(value)) {
    lines.push(`${indent}[${value.length} items]`);
    const preview = value.slice(0, 3);
    for (const item of preview) {
      if (typeof item === "object" && item !== null) {
        formatValue(lines, item, depth + 1);
      } else {
        lines.push(`${indent}  - ${String(item)}`);
      }
    }
    if (value.length > 3) {
      lines.push(`${indent}  ... and ${value.length - 3} more`);
    }
  } else {
    lines.push(`${indent}${String(value)}`);
  }
}
