// ---------------------------------------------------------------------------
// Epoch MCP Server — Shared time_math dispatcher
// Single source of truth for the time_math tool's operation routing.
// Used by both the CLI/HTTP dispatcher (tool-registry) and MCP stdio (tools/).
// ---------------------------------------------------------------------------

import type { ToolResult } from "../../types/index.js";
import {
  getCurrentTime,
  convertTimezone,
  parseDuration,
  formatElapsed,
  addDays,
  diffDates,
} from "../temporal.js";
import { addBusinessDays } from "../calendar.js";

// ---- Types -----------------------------------------------------------------

/** All recognised time_math sub-operations. */
export type TimeMathOp =
  | "add_days"
  | "add_business_days"
  | "diff"
  | "convert_tz"
  | "parse_nl"
  | "format_duration";

// ---- Shared dispatcher -----------------------------------------------------

/**
 * Dispatches a time_math sub-operation to the appropriate lib function.
 * Returns a canonical {@link ToolResult} so callers can translate to their
 * own response format (CLI ToolResult or MCP content array).
 */
export function dispatchTimeMath(
  operation: TimeMathOp,
  operands: Record<string, unknown>,
): ToolResult<unknown> {
  // Flexible operand extractors — tolerate alternate field names from LLMs
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : typeof v === "number" ? String(v) : undefined;
  const num = (v: unknown, fallback?: number): number | undefined =>
    typeof v === "number" ? v : typeof v === "string" ? Number(v) : fallback;

  switch (operation) {
    case "add_days": {
      const date =
        str(operands.start_date) ??
        str(operands.date) ??
        str(operands.from_date) ??
        str(operands.startDate);
      const days = num(operands.days);
      if (!date || days === undefined) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: "add_days requires operands: {start_date, days}.",
            retryHint:
              "Pass start_date as an ISO date string and days as a number.",
          },
        };
      }
      return { ok: true as const, data: addDays(date, days) };
    }

    case "add_business_days": {
      const start =
        str(operands.start_date) ??
        str(operands.date) ??
        str(operands.from_date) ??
        str(operands.startDate);
      const days = num(operands.days);
      if (!start || days === undefined) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message:
              "add_business_days requires operands: {start_date, days, country?}.",
            retryHint:
              "Pass start_date as an ISO date string and days as a number.",
          },
        };
      }
      return addBusinessDays(start, days, (operands.country as string) ?? "US");
    }

    case "diff": {
      const start =
        str(operands.start_date) ??
        str(operands.date) ??
        str(operands.from_date) ??
        str(operands.startDate);
      const end =
        str(operands.end_date) ??
        str(operands.to_date) ??
        str(operands.endDate) ??
        str(operands.end);
      if (!start || !end) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: "diff requires operands: {start_date, end_date}.",
            retryHint:
              "Pass both start_date and end_date as ISO date strings.",
          },
        };
      }
      return { ok: true as const, data: diffDates(start, end) };
    }

    case "convert_tz": {
      const ts = str(operands.timestamp);
      const tz = str(operands.target_tz);
      if (!ts || !tz) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: "convert_tz requires operands: {timestamp, target_tz}.",
            retryHint:
              "Pass an ISO timestamp and a target IANA timezone.",
          },
        };
      }
      return convertTimezone(ts, tz);
    }

    case "parse_nl": {
      const dur = str(operands.duration_string);
      if (!dur) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: "parse_nl requires operands: {duration_string}.",
            retryHint: 'Pass a duration string like "2h30m" or "1d6h".',
          },
        };
      }
      return parseDuration(dur);
    }

    case "format_duration": {
      const ms = num(operands.milliseconds);
      if (ms === undefined) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: "format_duration requires operands: {milliseconds}.",
            retryHint: "Pass a number of milliseconds.",
          },
        };
      }
      return { ok: true as const, data: formatElapsed(ms) };
    }

    default:
      return {
        ok: false as const,
        error: {
          isError: true as const,
          message: `Unknown time_math operation: ${operation as string}`,
          retryHint:
            "Use one of: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
        },
      };
  }
}
