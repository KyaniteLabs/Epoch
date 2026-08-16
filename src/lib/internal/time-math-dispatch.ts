// ---------------------------------------------------------------------------
// Epoch MCP Server — Shared time_math dispatcher
// Single source of truth for the time_math tool's operation routing.
// Used by both the CLI/HTTP dispatcher (tool-registry) and MCP stdio (tools/).
// ---------------------------------------------------------------------------

import type { ToolResult } from "../../types/index.js";
import {
  convertTimezone,
  parseDuration,
  formatElapsed,
  addDays,
  diffDates,
} from "../temporal.js";
import { addBusinessDays } from "../calendar.js";
import { BUSINESS_DAYS_LIMIT } from "../../schemas/index.js";

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

/** Resolve an optional country operand: must be a string (2-letter ISO code) when present. */
function countryOperand(operands: Record<string, unknown>): string | ToolResult<never> {
  const raw = operands.country;
  if (raw === undefined) return "US";
  if (typeof raw !== "string") {
    return {
      ok: false as const,
      error: {
        isError: true as const,
        message: `country must be a 2-letter ISO-3166 country code string (e.g. "US"), but received ${typeof raw}.`,
        retryHint: 'Pass country as a string like "US", "UK", "FR", "DE", or "JP", or omit it for "US".',
      },
    };
  }
  return raw;
}

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
      if (!Number.isFinite(days)) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: `add_days days must be a finite number, but received ${String(operands.days)}.`,
            retryHint: "Pass days as a number (e.g. 7), not a non-numeric string.",
          },
        };
      }
      if (Math.abs(days) > BUSINESS_DAYS_LIMIT) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: `add_days days must be between -${BUSINESS_DAYS_LIMIT} and ${BUSINESS_DAYS_LIMIT}, but received ${days}.`,
            retryHint: `Reduce days to at most ${BUSINESS_DAYS_LIMIT} in magnitude, or convert to months/years.`,
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
      if (!Number.isFinite(days)) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: `add_business_days days must be a finite number, but received ${String(operands.days)}.`,
            retryHint: "Pass days as a number (e.g. 10), not a non-numeric string.",
          },
        };
      }
      if (Math.abs(days) > BUSINESS_DAYS_LIMIT) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: `add_business_days days must be between -${BUSINESS_DAYS_LIMIT} and ${BUSINESS_DAYS_LIMIT}, but received ${days}.`,
            retryHint: `Reduce days to at most ${BUSINESS_DAYS_LIMIT} in magnitude, or convert to calendar days.`,
          },
        };
      }
      const country = countryOperand(operands);
      if (typeof country === "object") return country;
      return addBusinessDays(start, days, country);
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
      if (!Number.isFinite(ms)) {
        return {
          ok: false as const,
          error: {
            isError: true as const,
            message: `format_duration milliseconds must be a finite number, but received ${String(operands.milliseconds)}.`,
            retryHint: "Pass milliseconds as a finite number (e.g. 90000).",
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
