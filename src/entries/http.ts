import { Hono } from "hono";
import type { Context } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { dispatch, listTools, TOOL_NAMES, TOOL_REGISTRY } from "../dispatcher/index.js";
import { TOOL_COUNT } from "../lib/tool-aliases.js";
import { recordActualDetailed, getPendingEstimates, batchRecordActuals, getFeedbackHealthReport, UNIT_SUSPECT_FLAG_HINT } from "../lib/feedback.js";
import type { BatchActualEntry } from "../lib/feedback.js";
import { getTelemetry, resetTelemetry } from "../lib/telemetry.js";
import { receiveTelemetry } from "../lib/telemetry-receiver.js";
import { setTransport } from "../lib/telemetry-context.js";
import { isInternalError } from "../lib/internal/error-helpers.js";
import type { TaggedToolError } from "../lib/internal/error-helpers.js";
import type { ToolResult } from "../types/index.js";
import { z } from "zod";
import { getVersion } from "../version.js";

const VERSION = getVersion();

// ---- HTTP hardening limits (ticket 20) --------------------------------------
//
// Shared numeric limits for the HTTP seam. Kept as named constants (not
// inline magic numbers) because several of them are mirrored in route error
// messages, the OpenAPI document, and tests.

/** Maximum accepted request body (declared OR actually received): 1 MiB. */
const MAX_BODY_BYTES = 1_048_576;

/** Default per-key rate limit (requests per minute). */
const DEFAULT_RATE_LIMIT = 100;

/** Rate-limit window in milliseconds. */
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Default for GET /v1/feedback/pending's `limit` query parameter. */
const DEFAULT_PENDING_LIMIT = 50;

/** Upper bound for GET /v1/feedback/pending's `limit` query parameter. */
const MAX_PENDING_LIMIT = 200;

/**
 * Maximum entries per /v1/feedback/batch-record-actuals payload.
 * Mirrors batchRecordActualsSchema's `.max(500)` (src/schemas/index.ts) —
 * the HTTP route and the MCP tool must reject at the same cap.
 */
const BATCH_MAX_ENTRIES = 500;

/** Cache-Control value for immutable discoverability documents. */
const DOC_CACHE_CONTROL = "public, max-age=3600";

/** 413 envelope shared by every body-limit rejection path. */
const BODY_TOO_LARGE = {
  ok: false,
  error: {
    isError: true,
    message: "Request body too large (max 1 MB).",
    retryHint: "Reduce the number of tasks or use smaller payloads.",
  },
} as const;

/**
 * Resolve the per-minute rate-limit maximum from EPOCH_RATE_LIMIT.
 * Unset/empty → default; `0` → limiting disabled; invalid or negative values
 * (including partial numerics like "10abc", which parseInt used to accept)
 * fall back to the default with a warning. Always returns a non-negative
 * integer.
 */
function resolveRateLimitMax(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_RATE_LIMIT;
  const parsed = Number(raw.trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.warn(
      `[epoch] Invalid EPOCH_RATE_LIMIT value ${JSON.stringify(raw)} — falling back to the default of ${DEFAULT_RATE_LIMIT} requests/minute. Use a non-negative integer, or 0 to disable rate limiting.`,
    );
    return DEFAULT_RATE_LIMIT;
  }
  return Math.floor(parsed);
}

/**
 * Resolve the rate-limit bucket key for a request: the connection's remote
 * address, with forwarded headers (X-Forwarded-For / X-Real-IP) honored only
 * when EPOCH_TRUST_PROXY=1 (they are client-spoofable). Requests without
 * connection info (app.request() in tests, non-Node adapters) share the
 * single "unknown" bucket.
 */
function resolveRateLimitKey(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return `proxy:${forwarded}`;
    const realIp = c.req.header("x-real-ip")?.trim();
    if (realIp) return `proxy:${realIp}`;
  }
  try {
    const connInfo = getConnInfo(c as Parameters<typeof getConnInfo>[0]);
    if (connInfo.remote?.address) return connInfo.remote.address;
  } catch {
    // No connection info available — fall through to the shared bucket.
  }
  return "unknown";
}

/**
 * Validated request-body text, stashed per request by the body-limit
 * middleware (keyed on the per-request Context object). Route handlers call
 * {@link requestBodyText} instead of c.req.json()/c.req.text().
 */
const requestBodyTextByContext = new WeakMap<object, string>();

/** The size-validated request body text stashed by the body-limit middleware. */
function requestBodyText(c: Context): string {
  const text = requestBodyTextByContext.get(c);
  if (text === undefined) {
    // Only reachable if a POST /v1/* route were registered ahead of the
    // body-limit middleware; it stashes every POST body before handlers run.
    throw new Error("request body was not read through the body-limit middleware");
  }
  return text;
}

/** Parse the (already size-validated) request body as JSON. */
function requestBodyJson(c: Context): unknown {
  return JSON.parse(requestBodyText(c));
}

const AI_PLUGIN_MANIFEST = {
  schema_version: "v1",
  name_for_human: "Epoch",
  name_for_model: "epoch",
  description_for_human:
    "Time estimation tools for accurate scheduling and planning.",
  description_for_model:
    `Structured time estimation tools including PERT, COCOMO II, Monte Carlo simulation, sprint forecasting, and token-to-time mapping. ${TOOL_COUNT} tools across 6 layers. Works with Claude Code, Cursor, Codex CLI, Cline, Zed, and any MCP client.`,
  api: { type: "openapi", url: "/openapi.json" },
  auth: { type: "none" },
  legal_info_url:
    "https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE",
} as const;

const LLMSTXT = `# Epoch
> Time Estimation MCP Server — structured temporal reasoning for AI agents

## Overview
Epoch provides ${TOOL_COUNT} tools across 6 layers for accurate time estimation.
All tools are accessed via POST /v1/tools/{tool_name} with JSON request bodies.
All responses follow: {"ok": true, "data": {...}} or {"ok": false, "error": {"isError": true, "message": "...", "retryHint": "..."}}

## Layers
1. Temporal Primitives — current time, timezone conversion, duration parsing
2. Calendar Math — business days, holiday awareness
3. Estimation Algorithms — PERT, COCOMO II, Sprint Forecast, CPM, Monte Carlo
4. Data Integration — reference class forecasting, calibration
5. Advanced Analytics — token-to-time bridge, accuracy metrics
6. Feedback & Telemetry — estimate-vs-actual feedback, anonymous telemetry receipt testing

## Supported Countries
US, UK, FR, DE, JP (for holiday-aware business day calculations)

---

## Tool Reference

### get_current_time
Returns the current time in the specified IANA timezone.
- Input: {"timezone": "America/New_York"}
- Output: {"iso": "2026-05-01T14:30:00-04:00", "humanReadable": "Friday, May 1, 2026 at 2:30 PM (EDT)", "timezone": "America/New_York", "utcOffset": "-04:00"}

### convert_timezone
Converts a timestamp from its embedded timezone to a target timezone.
- Input: {"timestamp": "2026-05-01T14:30:00Z", "target_tz": "Asia/Tokyo"}
- Output: {"iso": "2026-05-01T23:30:00+09:00", "humanReadable": "...", "timezone": "Asia/Tokyo", "utcOffset": "+09:00"}

### parse_duration
Parses a duration string into seconds and human-readable form.
- Input: {"duration_string": "2h30m"}
- Output: {"input": "2h30m", "totalSeconds": 9000, "humanReadable": "2 hours 30 minutes"}

### time_math
Performs time arithmetic. Operations: add_days, add_business_days, diff, convert_tz, parse_nl, format_duration.
- Input: {"operation": "diff", "operands": {"date": "2026-05-01", "end_date": "2026-05-31"}}
- Output: {"days": 30, "hours": 0, "minutes": 0, "total_seconds": 2592000}

### add_business_days
Adds N business days to a start date, skipping weekends and holidays.
- Input: {"start_date": "2026-05-01", "days": 10, "country": "US"}
- Output: {"startDate": "2026-05-01", "endDate": "2026-05-15", "businessDays": 10, "countryCode": "US", "humanReadable": "10 business days from 2026-05-01 to 2026-05-15 (US)."}

### count_business_days
Counts business days between two dates, skipping weekends and holidays.
- Input: {"start_date": "2026-05-01", "end_date": "2026-05-31", "country": "US"}
- Output: {"startDate": "2026-05-01", "endDate": "2026-05-31", "businessDays": 19, "countryCode": "US", "humanReadable": "19 business days between 2026-05-01 and 2026-05-31 (US)."}

### pert_estimate
Computes a PERT three-point estimate with expected value, standard deviation, and confidence intervals.
- Input: {"optimistic": 2, "most_likely": 5, "pessimistic": 20, "unit": "hours"}
- Output: {"optimistic": 2, "mostLikely": 5, "pessimistic": 20, "expected": 7, "variance": 9, "stdDeviation": 3, "confidence95": [1, 13], "confidence99": [0, 16], "unit": "hours", "urgencyCategory": "medium", "humanReadable": "Expected: 7 hours. 95% confidence: 1 to 13 hours. 99% confidence: 0 to 16 hours."}
- The "expected" field is the PERT weighted average: (O + 4*ML + P) / 6
- confidence95 is the 95% confidence interval [lower, upper] = expected +/- 2*stdDev

### cocomo_estimate
Estimates effort using COCOMO II adjusted for LLM-assisted workflows.
- Input: {"kloc": 10, "reasoning_complexity": 1.2, "context_completeness": 0.8, "transformation_impact": 1.0, "iterative_cycles": 3, "human_oversight": 0.5}
- Output: {"kloc": 10, "personMonthsNominal": 31.4, "personMonthsLlmAdjusted": 14.2, "effortMultipliers": {...}, "assumptions": [...]}

### sprint_forecast
Forecasts sprints needed to clear a backlog based on historical velocity.
- Input: {"backlog_points": 120, "velocity_history": [25, 30, 28, 32], "sprint_length_days": 14, "hours_per_sprint": 80}
- Output: {"backlogPoints": 120, "averageVelocity": 28.8, "requiredSprints": 4.2, "pessimisticSprints": 5.8, "hoursPerPoint": 2.78, "totalHours": 333.3, "completionDays": 56, "sprintLengthDays": 14}

### critical_path
Computes the critical path through a task graph with merge-bias adjustment.
- Input: {"tasks": [{"name": "design", "duration": 5, "predecessors": []}, {"name": "build", "duration": 10, "predecessors": ["design"]}]}
- Output: {"critical_path": ["design", "build"], "slack_per_task": {"design": 0, "build": 0}, "total_duration": 15, "merge_bias_adjustment": 0}

### monte_carlo_schedule
Runs a Monte Carlo simulation on a task list with three-point estimates.
- Input: {"tasks": [{"name": "backend-api", "optimistic": 3, "most_likely": 7, "pessimistic": 15}], "iterations": 5000}
- Output: {"p10": "5.12", "p50": "7.99", "p80": "10.54", "p95": "12.81", "criticalPathProbability": 0.8, "riskEvents": [...], "humanReadable": "Monte Carlo simulation (5000 iterations): ..."}
- p50 = median estimate in days, p95 = conservative estimate

### reference_class_estimate
Estimates effort using reference-class forecasting from historical data.
- Input: {"task_type": "feature", "complexity": 1.5}
- Output: {"rawEstimate": 1.5, "correctedEstimate": 2.7, "correctionFactor": 1.8, "sampleSize": 0, "confidence": "optimistic"}
- Uses industry correction factors when no historical data available

### calibrate_estimates
Calibrates estimation accuracy using historical team data.
- Input: {"team_id": "alpha", "period_days": 90, "minimum_samples": 5}
- Output: {"mape": 0.0, "mdape": 0.0, "bias": 0.0, "variance": 0.0, "sample_size": 0, "trend": "stable"}

### token_time_bridge
Estimates wall-clock time from token count and LLM model parameters.
- Input: {"tokens": 100000, "model": "claude-sonnet-4-20250514", "tool_calls": 20, "reasoning_depth": "deep"}
- Output: {"tokens": 100000, "model": "claude-sonnet-4-20250514", "estimatedSeconds": 1272, "estimatedMinutes": 21.2, "confidence": "likely", "urgency": "short", "breakdown": {"promptTokens": 30000, "completionTokens": 70000, "toolOverheadSeconds": 10}, "humanReadable": "Approximately 21.2 minutes for 100,000 tokens with claude-sonnet-4-20250514 (deep reasoning, 20 tool calls). Confidence: likely."}
- Supported models: gpt-4o, gpt-4o-mini, gpt-4-turbo, claude-sonnet-4-20250514, claude-opus-4-20250514, claude-3.5-haiku-20241022, gemini-2.0-flash, gemini-2.5-pro, llama-3.1-70b, llama-3.1-405b, mistral-large, deepseek-v3
- reasoning_depth: shallow, moderate, or deep

### token_cost_estimate
Estimates wall-clock time AND dollar cost from token count and LLM model.
- Input: {"tokens": 100000, "model": "claude-sonnet-4-20250514", "reasoning_depth": "deep"}
- Output: {"tokens": 100000, "model": "claude-sonnet-4-20250514", "estimatedSeconds": 1272, "estimatedMinutes": 21.2, "estimatedCost": 1.05, "confidence": "likely", "humanReadable": "Approximately 21.2 minutes and $1.05 for 100,000 tokens with claude-sonnet-4-20250514."}

### compare_models
Compares all LLM models side-by-side for a given token budget.
- Input: {"tokens": 100000, "tool_calls": 20, "reasoning_depth": "deep"}
- Output: {"models": [{"model": "claude-sonnet-4-20250514", "estimatedSeconds": 1272, "estimatedCost": 1.05}, ...], "humanReadable": "Model comparison for 100,000 tokens (deep reasoning, 20 tool calls): ..."}

### accuracy_trend
Tracks estimation accuracy over time with sliding-window MAPE.
- Input: {"team_id": "alpha", "window_size": 50, "minimum_samples": 5}
- Output: {"teamId": "alpha", "mape": 0.18, "trend": "improving", "sampleSize": 12, "windowDays": 30, "humanReadable": "Accuracy trend for team alpha: MAPE 18% (improving) over 30 days with 12 samples."}

### schedule_risk
Assesses schedule risk using historical accuracy data.
- Input: {"estimated_hours": 80, "confidence_level": 0.9, "team_id": "alpha"}
- Output: {"estimatedHours": 80, "adjustedHours": 96, "riskMultiplier": 1.2, "confidenceLevel": 0.9, "riskLevel": "medium", "humanReadable": "Schedule risk: 80h planned -> 96h adjusted (medium risk, 90% confidence)."}

### cocomo_validate
Validates COCOMO estimation model against historical projects.
- Input: {"kloc": 10, "actual_person_months": 12, "project_type": "organic", "team_id": "alpha"}
- Output: {"kloc": 10, "estimatedMonths": 14.2, "actualMonths": 12, "deviation": -2.2, "deviationPercent": -15.5, "accuracy": "good", "humanReadable": "COCOMO validation: estimated 14.2 months, actual 12 months (15.5% overestimate, good accuracy)."}

---

## Quick Start
curl -X POST http://localhost:3000/v1/tools/pert_estimate \\
  -H "Content-Type: application/json" \\
  -d '{"optimistic": 2, "most_likely": 4, "pessimistic": 12, "unit": "hours"}'
`;

// ---- Zod -> JSON Schema converter -------------------------------------------
//
// zod v4 ships a native JSON Schema converter (z.toJSONSchema). The previous
// hand-rolled walker read zod v3 internals (`_def.typeName`), which are dead
// under zod 4 — every tool path rendered an empty schema. We now convert with
// the native API (io: "input", since request bodies describe what callers
// send, pre-transform/pre-coercion) and degrade per tool: a schema zod cannot
// represent (e.g. z.date()) falls back to the documented object below instead
// of failing the whole /openapi.json document.

interface JsonSchema {
  [key: string]: unknown;
}

/** Documented fallback for a tool whose zod input schema has no JSON Schema representation. */
const UNREPRESENTABLE_SCHEMA_FALLBACK: JsonSchema = {
  type: "object",
  additionalProperties: true,
  description:
    "Input schema unavailable: this tool's zod schema could not be converted to JSON Schema. Send a JSON object per the tool's documentation.",
};

/**
 * Convert a zod schema to a JSON Schema for the OpenAPI request body.
 * Never throws: an unrepresentable schema degrades to
 * {@link UNREPRESENTABLE_SCHEMA_FALLBACK} for that tool only.
 */
function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  try {
    const converted = z.toJSONSchema(schema, { io: "input" }) as JsonSchema;
    // $schema belongs on the document root, not on every embedded schema.
    delete converted.$schema;
    return converted;
  } catch {
    return { ...UNREPRESENTABLE_SCHEMA_FALLBACK };
  }
}

// ---- OpenAPI spec builder ---------------------------------------------------

const telemetryPath = {
  post: {
    operationId: "receiveTelemetry",
    summary: "Receive signed anonymized Epoch telemetry payloads.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["schema_version", "installation_id", "epoch_version", "records", "generated_at"],
            properties: {
              schema_version: { type: "integer", const: 1 },
              installation_id: { type: "string" },
              epoch_version: { type: "string" },
              generated_at: { type: "string", format: "date-time" },
              records: {
                type: "array",
                maxItems: 100,
                items: {
                  type: "object",
                  required: ["task_type", "complexity", "tool", "estimated_hours", "actual_hours", "ratio", "date"],
                  properties: {
                    task_type: { type: "string" },
                    complexity: { anyOf: [{ type: "number" }, { type: "null" }] },
                    tool: { type: "string" },
                    estimated_hours: { type: "number" },
                    actual_hours: { type: "number" },
                    ratio: { type: "number" },
                    date: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
                    calibration_provenance: {
                      type: "string",
                      enum: [
                        "prospective",
                        "backfilled_real_session",
                        "backfilled_calibration",
                        "synthetic",
                        "smoke",
                        "unknown",
                      ],
                      description:
                        "Non-identifying provenance class for calibration records. Optional for backward-compatible clients.",
                    },
                    calibration_usage: {
                      type: "string",
                      enum: ["correction", "baseline", "exclude"],
                      description:
                        "Whether the record may influence correction factors, is baseline-only, or should be excluded.",
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Accepted telemetry counts." },
      "400": { description: "Invalid payload." },
      "401": { description: "Missing or invalid signature." },
    },
  },
} satisfies Record<string, unknown>;

const feedbackRecordActualPath = {
  post: {
    operationId: "recordActualFeedback",
    summary: "Record actual hours for a pending estimate.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["estimate_id", "actual_hours"],
            properties: {
              estimate_id: { type: "string" },
              actual_hours: { type: "number", exclusiveMinimum: 0 },
              notes: { type: "string" },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Actual hours recorded." },
      "400": { description: "Invalid feedback payload." },
      "500": { description: "Estimate could not be updated." },
    },
  },
} satisfies Record<string, unknown>;

const feedbackPendingPath = {
  get: {
    operationId: "listPendingFeedback",
    summary: "List estimates waiting for actual-hours feedback.",
    parameters: [
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
    ],
    responses: {
      "200": { description: "Pending estimates." },
    },
  },
} satisfies Record<string, unknown>;

const feedbackBatchPath = {
  post: {
    operationId: "batchRecordActualFeedback",
    summary: "Record actual hours for multiple pending estimates.",
    requestBody: {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required: ["entries"],
            properties: {
              entries: {
                type: "array",
                minItems: 1,
                maxItems: 500,
                description:
                  "Array of actual-hour records (1–500 entries; over-limit batches are rejected with 400 naming the cap). Entries failing validation are reported per-entry in the response errors instead of being dropped.",
                items: {
                  type: "object",
                  required: ["estimate_id", "actual_hours"],
                  properties: {
                    estimate_id: { type: "string" },
                    actual_hours: { type: "number", exclusiveMinimum: 0 },
                    notes: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    responses: {
      "200": { description: "Batch feedback result with per-entry errors for any entries that failed validation or recording." },
      "400": { description: "Invalid batch payload, or more than 500 entries (the cap is named in the message)." },
      "422": { description: "Every entry failed — per-entry errors are attached to the error envelope." },
    },
  },
} satisfies Record<string, unknown>;

const feedbackHealthPath = {
  get: {
    operationId: "getFeedbackHealth",
    summary: "Get feedback-loop health and calibration status.",
    responses: {
      "200": { description: "Feedback health report." },
    },
  },
} satisfies Record<string, unknown>;

function buildOpenApiSpec(): Record<string, unknown> {
  const tools = listTools();
  const paths: Record<string, unknown> = {};

  for (const tool of tools) {
    const definition = TOOL_REGISTRY.get(tool.name);
    const requestSchema = definition
      ? zodToJsonSchema(definition.inputSchema)
      : { type: "object" };
    const responseSchema = definition
      ? definition.outputSchema
      : { type: "object" };

    paths[`/v1/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: requestSchema },
          },
        },
        responses: {
          "200": {
            description: "Tool result",
            content: {
              "application/json": {
                schema: {
                  oneOf: [
                    {
                      type: "object",
                      properties: {
                        ok: { type: "boolean", enum: [true] },
                        data: responseSchema,
                      },
                    },
                    {
                      type: "object",
                      properties: {
                        ok: { type: "boolean", enum: [false] },
                        error: {
                          type: "object",
                          properties: {
                            isError: { type: "boolean" },
                            errorKind: {
                              type: "string",
                              enum: ["validation", "internal"],
                              description:
                                'Failure class: "validation" (caller-fixable, HTTP 422) or "internal" (server-side, HTTP 500).',
                            },
                            message: { type: "string" },
                            retryHint: { type: "string" },
                          },
                        },
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    };
  }

  paths["/v1/telemetry"] = telemetryPath;
  paths["/v1/feedback/record-actual"] = feedbackRecordActualPath;
  paths["/v1/feedback/pending"] = feedbackPendingPath;
  paths["/v1/feedback/batch-record-actuals"] = feedbackBatchPath;
  paths["/v1/feedback/health"] = feedbackHealthPath;

  return {
    openapi: "3.1.0",
    info: {
      title: "Epoch Time Estimation API",
      version: VERSION,
      description:
        `Structured time estimation for LLMs and AI agents. ${TOOL_COUNT} tools across 6 layers.`,
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
    ],
    paths,
  };
}

export function createApiApp(): Hono {
  const app = new Hono();

  // ---- CORS (ticket 20) ------------------------------------------------------
  // Default: NO CORS headers. The HTTP entry is a loopback service for local
  // agents and CLI clients (curl/MCP clients are not subject to CORS); the
  // previous blanket `cors()` reflected a wildcard origin on every route,
  // which let any website read responses from a locally running server.
  // Cross-origin browser access now requires an explicit allowlist via
  // EPOCH_CORS_ORIGINS (comma-separated origins; "*" restores allow-any for
  // operators who deliberately want it). Preflight OPTIONS requests are
  // always answered (204) — allowed origins get the CORS headers, everything
  // else fails cleanly in the browser without reaching route handlers.
  const corsOrigins = (process.env["EPOCH_CORS_ORIGINS"] ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);
  app.use(
    "*",
    cors(corsOrigins.includes("*") ? { origin: "*" } : { origin: corsOrigins, maxAge: 3600 }),
  );

  // ---- Security headers ----------------------------------------------------
  app.use("*", async (_c, next) => {
    await next();
    _c.header("X-Content-Type-Options", "nosniff");
    _c.header("X-Frame-Options", "DENY");
    _c.header("Referrer-Policy", "strict-origin-when-cross-origin");
    _c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    _c.header("X-Request-Id", crypto.randomUUID());
  });

  // ---- Request logging -----------------------------------------------------
  app.use("/v1/*", async (c, next) => {
    const start = Date.now();
    const method = c.req.method;
    const path = c.req.path;
    await next();
    const duration = Date.now() - start;
    const status = c.res.status;
    if (process.env["EPOCH_LOG_REQUESTS"] === "1") {
      console.log(`[epoch] ${method} ${path} ${status} ${duration}ms`);
    }
  });

  // ---- Rate limiter (in-memory fixed window, ticket 20) ----------------------
  //
  // Keyed on the connection's remote address so distinct clients get distinct
  // buckets. The X-Forwarded-For / X-Real-IP headers are only honored when
  // EPOCH_TRUST_PROXY=1 — those headers are client-spoofable, so trusting
  // them by default would let one caller cycle buckets at will. 429 responses
  // carry a Retry-After header (seconds until the window resets).
  // EPOCH_RATE_LIMIT=0 disables limiting entirely; invalid or negative values
  // fall back to the default with a warning.

  const rateLimitMax = resolveRateLimitMax(process.env["EPOCH_RATE_LIMIT"]);
  const trustProxy = process.env["EPOCH_TRUST_PROXY"] === "1";

  if (rateLimitMax !== 0) {
    const requestCounts = new Map<string, { count: number; resetAt: number }>();

    app.use("/v1/*", async (c, next) => {
      const key = resolveRateLimitKey(c, trustProxy);
      const now = Date.now();

      if (requestCounts.size > 10_000) {
        for (const [mapKey, val] of requestCounts) {
          if (now > val.resetAt) requestCounts.delete(mapKey);
        }
      } else if (requestCounts.size > 0 && Math.random() < 0.01) {
        for (const [mapKey, val] of requestCounts) {
          if (now > val.resetAt) requestCounts.delete(mapKey);
        }
      }

      const entry = requestCounts.get(key);
      if (!entry || now > entry.resetAt) {
        requestCounts.set(key, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
        return next();
      }
      entry.count++;
      if (entry.count > rateLimitMax) {
        const retryAfterSeconds = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
        c.header("Retry-After", String(retryAfterSeconds));
        return c.json(
          {
            ok: false,
            error: {
              isError: true,
              message: "Rate limit exceeded.",
              retryHint: `Max ${rateLimitMax} requests per minute. Retry after ${retryAfterSeconds}s.`,
            },
          },
          429,
        );
      }
      return next();
    });
  }

  // ---- Body size limit (ticket 20) -------------------------------------------
  //
  // The client-declared Content-Length header is a fast-reject hint only: a
  // chunked request (or a lying/absent header) previously carried no cap at
  // all, and the feedback endpoints had none even on paper. Every POST body
  // under /v1/* is read through this middleware, which counts the bytes
  // actually received and aborts the stream once the cap is exceeded.
  // Handlers read the validated body text via requestBodyText() — c.req.json()
  // / c.req.text() would re-read the already-consumed raw stream.

  app.use("/v1/*", async (c, next) => {
    if (c.req.method !== "POST") return next();

    const declared = c.req.header("content-length");
    if (declared !== undefined) {
      const declaredBytes = Number(declared.trim());
      if (Number.isFinite(declaredBytes) && declaredBytes > MAX_BODY_BYTES) {
        return c.json(BODY_TOO_LARGE, 413);
      }
    }

    const stream = c.req.raw.body;
    if (!stream) {
      requestBodyTextByContext.set(c, "");
      return next();
    }

    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > MAX_BODY_BYTES) {
          // Abort the transfer: stop draining the client's stream so an
          // oversized upload does not keep arriving after rejection.
          await reader.cancel().catch(() => {});
          return c.json(BODY_TOO_LARGE, 413);
        }
        chunks.push(value);
      }
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            isError: true,
            message: "Invalid request body.",
            retryHint: "The request body could not be read (aborted or malformed transfer).",
          },
        },
        400,
      );
    }

    let total = 0;
    for (const chunk of chunks) total += chunk.byteLength;
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    requestBodyTextByContext.set(c, new TextDecoder().decode(bytes));
    return next();
  });

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      version: VERSION,
      tools: TOOL_NAMES.size,
      uptime: process.uptime(),
    });
  });

  app.get("/v1/tools", (c) => {
    return c.json({ ok: true, tools: listTools() });
  });

  app.post("/v1/tools/:toolName", async (c) => {
    const toolName = c.req.param("toolName");

    // Body-size cap and the JSON read both happen in the /v1/* body-limit
    // middleware (ticket 20): the previous client-declared content-length
    // check lived here and chunked requests bypassed it entirely.
    let body: Record<string, unknown>;
    try {
      body = requestBodyJson(c) as Record<string, unknown>;
    } catch {
      return c.json(
        {
          ok: false,
          error: {
            isError: true,
            message: "Invalid JSON body.",
            retryHint: "Send a valid JSON object in the request body.",
          },
        } satisfies ToolResult<unknown>,
        400,
      );
    }

    if (!TOOL_NAMES.has(toolName)) {
      const available = [...TOOL_NAMES].sort().join(", ");
      return c.json(
        {
          ok: false,
          error: {
            isError: true,
            message: `Unknown tool: "${toolName}".`,
            retryHint: `Available tools: ${available}`,
          },
        } satisfies ToolResult<unknown>,
        404,
      );
    }

    const result = await dispatch(toolName, body);
    // Ticket 06 (422/500 split at the HTTP seam): caller-fixable failures —
    // validation (errorKind "validation", e.g. malformed/invalid inputs) and
    // handler-produced actionable errors — map to 422 with the formatted
    // message intact. Internal failures (errorKind "internal": a thrown
    // non-validation error inside dispatch) map to 500 with a generic-safe
    // message — the dispatcher's preserved Error.message may embed
    // filesystem paths or stack details that must not leak over HTTP.
    if (result.ok) {
      return c.json(result, 200);
    }
    if (isInternalError(result.error)) {
      return c.json(
        {
          ok: false,
          error: {
            isError: true,
            errorKind: "internal",
            message: `Internal error while executing "${toolName}".`,
            retryHint: "This is a server-side failure, not an input problem. Retry, and file an issue at https://github.com/KyaniteLabs/Epoch/issues if it persists.",
          },
        } satisfies { ok: false; error: TaggedToolError },
        500,
      );
    }
    return c.json(result, 422);
  });

  app.post("/v1/telemetry", async (c) => {
    // Size-validated by the body-limit middleware (ticket 20): the previous
    // client-declared content-length check returned a 400 envelope and chunked
    // requests bypassed it; oversize bodies now get the uniform 413.
    const rawBody = requestBodyText(c);
    const result = receiveTelemetry(rawBody, c.req.header("x-epoch-signature"));
    if (!result.ok) {
      return c.json(
        { accepted: 0, deduplicated: 0, error: result.error ?? "telemetry rejected" },
        result.status,
      );
    }

    return c.json({ accepted: result.accepted, deduplicated: result.deduplicated, quarantined: result.quarantined });
  });

  app.get("/.well-known/ai-plugin.json", (c) => {
    // Ticket 20: these discoverability documents are static per process —
    // cacheable by intermediaries for an hour.
    c.header("Cache-Control", DOC_CACHE_CONTROL);
    return c.json(AI_PLUGIN_MANIFEST);
  });

  app.get("/llms.txt", (c) => {
    return c.text(LLMSTXT, 200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": DOC_CACHE_CONTROL,
    });
  });

  let cachedSpec: Record<string, unknown> | undefined;
  app.get("/openapi.json", (c) => {
    if (!cachedSpec) cachedSpec = buildOpenApiSpec();
    c.header("Cache-Control", DOC_CACHE_CONTROL);
    return c.json(cachedSpec);
  });

  // ---- Feedback endpoints ----------------------------------------------------

  app.post("/v1/feedback/record-actual", async (c) => {
    // Size-validated by the body-limit middleware (ticket 20): this endpoint
    // previously had no body cap at all.
    let body: unknown;
    try {
      body = requestBodyJson(c);
    } catch {
      return c.json({ ok: false, error: { isError: true, message: "Invalid JSON body.", retryHint: "Send a valid JSON body with estimate_id and actual_hours." } }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({ ok: false, error: { isError: true, message: "Invalid JSON body.", retryHint: "Send a JSON object with estimate_id and actual_hours." } }, 400);
    }

    const record = body as Record<string, unknown>;
    const estimateId = record["estimate_id"] as string | undefined;
    const actualHours = record["actual_hours"] as number | undefined;

    if (!estimateId || actualHours === undefined || !Number.isFinite(actualHours) || actualHours <= 0) {
      return c.json({
        ok: false,
        error: {
          isError: true,
          message: "Requires estimate_id (string) and actual_hours (positive number).",
          retryHint: "POST {estimate_id: '...', actual_hours: 8.5, notes: 'optional'}",
        },
      }, 400);
    }

    const notes = record["notes"] as string | undefined;
    const result = recordActualDetailed(estimateId, actualHours, notes);
    if (!result.ok) {
      const status = result.reason === "duplicate"
        ? 409
        : result.reason === "below_threshold" || result.reason === "synthetic_id"
          ? 400
          : 500;
      // Ticket 16 (unknown-tool policy): append the lib's actionable hint
      // (currently unknown_tool's canonical estimation-tool set) so the
      // rejection is never a silent contract severance.
      const reasonEcho = `Failed to record actual: ${result.reason}.`;
      return c.json({
        ok: false,
        error: {
          isError: true,
          message: result.hint ? `${reasonEcho} ${result.hint}` : reasonEcho,
          retryHint: "Use a real estimate_id, positive actual_hours, and avoid duplicate submissions.",
        },
      }, status);
    }
    // Ticket 16 (unit_suspect lifecycle): surface the persisted flag with an
    // actionable hint — the record is saved, but the caller should verify the
    // units (hours vs days/weeks/person-months).
    return c.json({
      ok: true,
      data: {
        estimateId,
        actualHours,
        recorded: true,
        ...(result.flagged === "unit_suspect" && {
          flagged: "unit_suspect" as const,
          flagHint: UNIT_SUSPECT_FLAG_HINT,
        }),
      },
    });
  });

  app.get("/v1/feedback/pending", (c) => {
    // Ticket 20 (NaN limit): a non-numeric `limit` previously produced NaN,
    // which slipped through the clamp and made .slice(-NaN) return the entire
    // ledger. Non-numeric/empty values now fall back to the default.
    const raw = c.req.query("limit");
    let limit = DEFAULT_PENDING_LIMIT;
    if (raw !== undefined && raw !== "") {
      const parsed = Number(raw);
      limit = Number.isFinite(parsed)
        ? Math.min(Math.max(Math.trunc(parsed), 1), MAX_PENDING_LIMIT)
        : DEFAULT_PENDING_LIMIT;
    }
    const pending = getPendingEstimates(limit);
    return c.json({ ok: true, data: pending });
  });

  app.post("/v1/feedback/batch-record-actuals", async (c) => {
    // Size-validated by the body-limit middleware (ticket 20): this endpoint
    // previously had no body cap at all.
    let body: unknown;
    try {
      body = requestBodyJson(c);
    } catch {
      return c.json({
        ok: false,
        error: { isError: true, message: "Invalid JSON body.", retryHint: "Send a JSON body with an entries array." },
      }, 400);
    }
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return c.json({
        ok: false,
        error: { isError: true, message: "Invalid JSON body.", retryHint: "Send a JSON object with an entries array." },
      }, 400);
    }

    const entries = (body as Record<string, unknown>)["entries"];
    if (!Array.isArray(entries) || entries.length === 0) {
      return c.json({
        ok: false,
        error: { isError: true, message: `Requires entries array (1–${BATCH_MAX_ENTRIES} items) with estimate_id (string) and actual_hours (positive number) per entry.`, retryHint: "POST {entries: [{estimate_id: '...', actual_hours: 8.5}]}" },
      }, 400);
    }

    // Ticket 20 (batch parity): over-limit batches are rejected explicitly,
    // naming the cap, instead of being silently truncated to the first 500.
    // The cap mirrors batchRecordActualsSchema's `.max(500)` so the HTTP
    // route and the MCP tool reject at the same boundary.
    if (entries.length > BATCH_MAX_ENTRIES) {
      return c.json({
        ok: false,
        error: {
          isError: true,
          message: `entries array exceeds the maximum of ${BATCH_MAX_ENTRIES} entries per batch (got ${entries.length}).`,
          retryHint: `Split feedback into batches of at most ${BATCH_MAX_ENTRIES} entries.`,
        },
      }, 400);
    }

    // Ticket 20 (batch parity): invalid entries are reported per-entry with
    // their index instead of being silently filtered out. Only entries that
    // clear validation reach the ledger; everything else comes back in
    // `errors` so the caller can self-correct.
    const valid: BatchActualEntry[] = [];
    const validationErrors: string[] = [];
    entries.forEach((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        validationErrors.push(`Entry ${index}: must be an object with estimate_id (non-empty string) and actual_hours (positive number).`);
        return;
      }
      const record = entry as Record<string, unknown>;
      const estimateId = record["estimate_id"];
      const actualHours = record["actual_hours"];
      const idOk = typeof estimateId === "string" && estimateId !== "";
      const hoursOk = typeof actualHours === "number" && Number.isFinite(actualHours) && actualHours > 0;
      if (idOk && hoursOk) {
        const notes = record["notes"];
        valid.push({
          estimateId,
          actualHours,
          ...(typeof notes === "string" && notes !== "" ? { notes } : {}),
        });
        return;
      }
      const problems: string[] = [];
      if (!idOk) problems.push("estimate_id must be a non-empty string");
      if (!hoursOk) problems.push("actual_hours must be a positive number");
      validationErrors.push(
        `Entry ${index}${idOk && typeof estimateId === "string" ? ` (estimate_id "${estimateId}")` : ""}: ${problems.join("; ")}.`,
      );
    });

    const recorded = valid.length > 0
      ? batchRecordActuals(valid)
      : { total: 0, succeeded: 0, failed: 0, errors: [] as string[] };
    const errors = [...validationErrors, ...recorded.errors];
    const total = entries.length;
    const succeeded = recorded.succeeded;

    if (succeeded === 0 && errors.length > 0) {
      // Mirror the dispatcher's all-failed envelope for batch_record_actuals,
      // but keep every per-entry error attached (ticket 04 + ticket 20) so
      // nothing is silently dropped.
      return c.json({
        ok: false,
        error: {
          isError: true,
          message: `All ${total} entries failed to record. First failure: ${errors[0] ?? "no per-entry error reported"}`,
          retryHint: "Each entry needs a non-empty estimate_id (from get_pending_estimates) and a positive actual_hours value.",
          errors,
        },
      }, 422);
    }

    return c.json({ ok: true, data: { total, succeeded, failed: errors.length, errors } });
  });

  app.get("/v1/feedback/health", (c) => {
    const report = getFeedbackHealthReport();
    return c.json({ ok: true, data: report });
  });

  app.onError((err, c) => {
    console.error("[epoch] Unhandled error:", err);
    return c.json(
      {
        ok: false,
        error: {
          isError: true,
          message: "Internal server error.",
          retryHint: "This is an internal error. Try again later or file an issue at https://github.com/KyaniteLabs/Epoch/issues.",
        },
      } satisfies ToolResult<unknown>,
      500,
    );
  });

  app.notFound((c) => {
    return c.json({
      ok: false,
      error: {
        isError: true,
        message: `Not found: ${c.req.path}`,
        retryHint: "Available endpoints: /health, /openapi.json, /llms.txt, /.well-known/ai-plugin.json, /v1/tools/{tool_name}, /v1/telemetry, /v1/feedback/record-actual, /v1/feedback/pending, /v1/feedback/batch-record-actuals, /v1/feedback/health",
      },
    }, 404);
  });

  return app;
}

export function startHttpServer(
  port?: number,
  host?: string,
): void {
  const resolvedPort = port ?? (Number.isFinite(parseInt(process.env["EPOCH_PORT"] ?? process.env["PORT"] ?? "3000", 10))
    ? parseInt(process.env["EPOCH_PORT"] ?? process.env["PORT"] ?? "3000", 10)
    : 3000);
  const resolvedHost = host ?? process.env["EPOCH_HOST"] ?? "127.0.0.1";
  setTransport("rest");
  const app = createApiApp();

  const server = serve({ fetch: app.fetch, port: resolvedPort, hostname: resolvedHost }, () => {
    console.error(`Epoch API server listening on http://${resolvedHost}:${resolvedPort}`);
  });

  const shutdown = () => {
    getTelemetry().flush();
    server.close(() => {
      resetTelemetry();
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 5000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
