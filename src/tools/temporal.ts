// ---------------------------------------------------------------------------
// Epoch MCP Server — Layer 1 & 2 Tool Registrations
// Exports registerTemporalTools() which wires lib functions to MCP tool calls.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  getCurrentTime,
  convertTimezone,
  parseDuration,
  formatElapsed,
  addDays,
  diffDates,
} from "../lib/temporal.js";
import {
  addBusinessDays,
  countBusinessDays,
} from "../lib/calendar.js";

// ---- Annotation constant --------------------------------------------------

const TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

// ---- Time Math operations -------------------------------------------------

const TIME_MATH_OPERATIONS = [
  "add_days",
  "add_business_days",
  "diff",
  "convert_tz",
  "parse_nl",
  "format_duration",
] as const;

type TimeMathOperation = (typeof TIME_MATH_OPERATIONS)[number];

// ---- Registration ---------------------------------------------------------

export function registerTemporalTools(server: McpServer): void {
  // -----------------------------------------------------------------------
  // 1. get_current_time
  // -----------------------------------------------------------------------
  server.tool(
    "get_current_time",
    "Returns the current date and time in the specified IANA timezone. " +
      "Useful for grounding the LLM in the user's local time. " +
      "Example timezones: 'UTC', 'America/New_York', 'Europe/London', 'Asia/Tokyo'.",
    {
      timezone: z
        .string()
        .describe(
          "IANA timezone identifier, e.g. 'America/New_York', 'Europe/Berlin', 'Asia/Tokyo'.",
        ),
    },
    TOOL_ANNOTATIONS,
    async ({ timezone }) => {
      const result = getCurrentTime(timezone);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // 2. convert_timezone
  // -----------------------------------------------------------------------
  server.tool(
    "convert_timezone",
    "Converts an ISO-8601 timestamp to a target IANA timezone. " +
      "The input timestamp must include timezone information or be in UTC. " +
      "Returns the localised time, UTC offset, and human-readable format.",
    {
      timestamp: z
        .string()
        .describe(
          "ISO-8601 timestamp to convert, e.g. '2026-05-01T14:30:00Z' or '2026-05-01T09:00:00-04:00'.",
        ),
      target_tz: z
        .string()
        .describe(
          "Target IANA timezone identifier, e.g. 'Asia/Tokyo', 'Europe/Paris'.",
        ),
    },
    TOOL_ANNOTATIONS,
    async ({ timestamp, target_tz }) => {
      const result = convertTimezone(timestamp, target_tz);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // 3. parse_duration
  // -----------------------------------------------------------------------
  server.tool(
    "parse_duration",
    "Parses a human-readable duration string into structured seconds. " +
      "Supports combinations of y (years), mo (months), w (weeks), d (days), h (hours), " +
      "m (minutes), s (seconds). Examples: '2h30m', '1d6h', '1w3d', '45m'.",
    {
      duration_string: z
        .string()
        .describe(
          "Duration string to parse, e.g. '2h30m', '1d6h', '1w3d12h', '45m', '90s'.",
        ),
    },
    TOOL_ANNOTATIONS,
    async ({ duration_string }) => {
      const result = parseDuration(duration_string);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // 4. time_math — registry dispatch for compound operations
  // -----------------------------------------------------------------------
  server.tool(
    "time_math",
    "Performs compound time-math operations. Dispatches to the appropriate " +
      "sub-operation based on the 'operation' parameter. " +
      "Operations: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.",
    {
      operation: z
        .enum(TIME_MATH_OPERATIONS)
        .describe(
          "The time operation to perform: " +
            "'add_days' — add calendar days to a date; " +
            "'add_business_days' — add business days skipping weekends/holidays; " +
            "'diff' — compute difference between two dates; " +
            "'convert_tz' — convert a timestamp to another timezone; " +
            "'parse_nl' — parse a natural-language duration string; " +
            "'format_duration' — format milliseconds as human-readable elapsed time.",
        ),
      operands: z
        .object({
          date: z.string().optional().describe("ISO date string for operations requiring a date."),
          end_date: z.string().optional().describe("ISO end date for diff operations."),
          days: z.number().optional().describe("Number of days to add."),
          timestamp: z.string().optional().describe("ISO timestamp for timezone conversion."),
          target_tz: z.string().optional().describe("Target IANA timezone for conversion."),
          duration_string: z.string().optional().describe("Duration string to parse."),
          milliseconds: z.number().optional().describe("Duration in milliseconds to format."),
          country: z.string().optional().describe("ISO-3166 country code for business-day calculations (US, UK, FR, DE, JP)."),
        })
        .describe("Named operands for the selected operation."),
    },
    TOOL_ANNOTATIONS,
    async ({ operation, operands }) => {
      const data = dispatchTimeMath(operation, operands);
      if ("isError" in data) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(data) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // 5. add_business_days
  // -----------------------------------------------------------------------
  server.tool(
    "add_business_days",
    "Adds N business (working) days to a start date, skipping weekends and " +
      "country-specific public holidays. Supports US, UK, FR, DE, and JP holidays.",
    {
      start_date: z
        .string()
        .describe("Start date in ISO format, e.g. '2026-05-01'."),
      days: z
        .number()
        .int()
        .describe("Number of business days to add. Use negative values to subtract."),
      country: z
        .string()
        .describe(
          "ISO-3166-1-alpha-2 country code for holiday awareness: 'US', 'UK', 'FR', 'DE', 'JP'.",
        ),
    },
    TOOL_ANNOTATIONS,
    async ({ start_date, days, country }) => {
      const result = addBusinessDays(start_date, days, country);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      };
    },
  );

  // -----------------------------------------------------------------------
  // 6. count_business_days
  // -----------------------------------------------------------------------
  server.tool(
    "count_business_days",
    "Counts the number of business (working) days between two dates, " +
      "excluding weekends and country-specific public holidays. " +
      "The count is exclusive of the start date and inclusive of the end date.",
    {
      start_date: z
        .string()
        .describe("Start date in ISO format, e.g. '2026-05-01'."),
      end_date: z
        .string()
        .describe("End date in ISO format, e.g. '2026-05-15'."),
      country: z
        .string()
        .describe(
          "ISO-3166-1-alpha-2 country code for holiday awareness: 'US', 'UK', 'FR', 'DE', 'JP'.",
        ),
    },
    TOOL_ANNOTATIONS,
    async ({ start_date, end_date, country }) => {
      const result = countBusinessDays(start_date, end_date, country);
      if (!result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
          isError: true,
        };
      }
      return {
        content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
      };
    },
  );
}

// ---- Time Math Dispatcher -------------------------------------------------

function dispatchTimeMath(
  operation: TimeMathOperation,
  operands: Record<string, unknown>,
): Record<string, unknown> {
  switch (operation) {
    case "add_days": {
      const date = operands["date"];
      const days = operands["days"];
      if (typeof date !== "string" || typeof days !== "number") {
        return makeDispatchError(
          "add_days requires 'date' (string) and 'days' (number) operands.",
        );
      }
      const result = addDays(date, days);
      return { date: result, operation: "add_days", input: { date, days } };
    }

    case "add_business_days": {
      const start_date = operands["start_date"] ?? operands["date"];
      const days = operands["days"];
      const country = operands["country"];
      if (typeof start_date !== "string" || typeof days !== "number" || typeof country !== "string") {
        return makeDispatchError(
          "add_business_days requires 'date' (or 'start_date'), 'days', and 'country' operands.",
        );
      }
      const result = addBusinessDays(start_date, days, country);
      if (!result.ok) return result.error as unknown as Record<string, unknown>;
      return result.data as unknown as Record<string, unknown>;
    }

    case "diff": {
      const date = operands["date"];
      const end_date = operands["end_date"];
      if (typeof date !== "string" || typeof end_date !== "string") {
        return makeDispatchError(
          "diff requires 'date' (start) and 'end_date' operands.",
        );
      }
      const result = diffDates(date, end_date);
      return { ...result, operation: "diff", input: { start: date, end: end_date } };
    }

    case "convert_tz": {
      const timestamp = operands["timestamp"];
      const target_tz = operands["target_tz"];
      if (typeof timestamp !== "string" || typeof target_tz !== "string") {
        return makeDispatchError(
          "convert_tz requires 'timestamp' and 'target_tz' operands.",
        );
      }
      const result = convertTimezone(timestamp, target_tz);
      if (!result.ok) return result.error as unknown as Record<string, unknown>;
      return result.data as unknown as Record<string, unknown>;
    }

    case "parse_nl": {
      const duration_string = operands["duration_string"];
      if (typeof duration_string !== "string") {
        return makeDispatchError(
          "parse_nl requires a 'duration_string' operand.",
        );
      }
      const result = parseDuration(duration_string);
      if (!result.ok) return result.error as unknown as Record<string, unknown>;
      return result.data as unknown as Record<string, unknown>;
    }

    case "format_duration": {
      const milliseconds = operands["milliseconds"];
      if (typeof milliseconds !== "number") {
        return makeDispatchError(
          "format_duration requires a 'milliseconds' operand (number).",
        );
      }
      const formatted = formatElapsed(milliseconds);
      return {
        formatted,
        milliseconds,
        operation: "format_duration",
      };
    }

    default:
      return makeDispatchError(
        `Unknown operation: "${operation}". Supported: ${TIME_MATH_OPERATIONS.join(", ")}.`,
      );
  }
}

function makeDispatchError(message: string): Record<string, unknown> {
  return {
    isError: true,
    message,
    retryHint: `Valid operations: ${TIME_MATH_OPERATIONS.join(", ")}. Check that all required operands are provided.`,
  };
}
