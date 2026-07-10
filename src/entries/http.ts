import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { dispatch, listTools, TOOL_NAMES, TOOL_REGISTRY } from "../dispatcher/index.js";
import { recordActualDetailed, getPendingEstimates, batchRecordActuals, getFeedbackHealthReport } from "../lib/feedback.js";
import { getTelemetry, resetTelemetry } from "../lib/telemetry.js";
import { receiveTelemetry } from "../lib/telemetry-receiver.js";
import { setTransport } from "../lib/telemetry-context.js";
import type { ToolResult } from "../types/index.js";
import type { z } from "zod";
import { getVersion } from "../version.js";

const VERSION = getVersion();

const AI_PLUGIN_MANIFEST = {
  schema_version: "v1",
  name_for_human: "Epoch",
  name_for_model: "epoch",
  description_for_human:
    "Time estimation tools for accurate scheduling and planning.",
  description_for_model:
    "Structured time estimation tools including PERT, COCOMO II, Monte Carlo simulation, sprint forecasting, and token-to-time mapping. 24 tools across 6 layers. Works with Claude Code, Cursor, Codex CLI, Cline, Zed, and any MCP client.",
  api: { type: "openapi", url: "/openapi.json" },
  auth: { type: "none" },
  legal_info_url:
    "https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE",
} as const;

const LLMSTXT = `# Epoch
> Time Estimation MCP Server — structured temporal reasoning for AI agents

## Overview
Epoch provides 24 tools across 6 layers for accurate time estimation.
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

interface JsonSchema {
  [key: string]: unknown;
}

function zodToJsonSchema(schema: z.ZodType): JsonSchema {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def;

  if (!def) return {};

  switch (def.typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, JsonSchema> = {};
      const required: string[] = [];

      for (const [key, fieldSchema] of Object.entries(shape)) {
        const resolved = resolveField(fieldSchema as z.ZodType);
        properties[key] = resolved.schema;
        if (!resolved.isOptional) {
          required.push(key);
        }
      }

      const result: JsonSchema = { type: "object", properties };
      if (required.length > 0) {
        result.required = required;
      }
      return result;
    }

    case "ZodString":
      return withDescription({ type: "string" }, def);

    case "ZodNumber": {
      const result: JsonSchema = { type: "number" };
      if (def.checks) {
        for (const check of def.checks as Array<{ kind: string; value?: unknown }>) {
          if (check.kind === "int") (result as Record<string, unknown>).format = "integer";
          if (check.kind === "min") result.minimum = check.value;
          if (check.kind === "max") result.maximum = check.value;
        }
      }
      return withDescription(result, def);
    }

    case "ZodBoolean":
      return withDescription({ type: "boolean" }, def);

    case "ZodEnum":
      return withDescription({ type: "string", enum: def.values }, def);

    case "ZodNativeEnum": {
      const values = Object.values(def.values as Record<string, string>);
      return withDescription({ type: "string", enum: values }, def);
    }

    case "ZodArray": {
      const items = zodToJsonSchema(def.type);
      return withDescription({ type: "array", items }, def);
    }

    case "ZodTuple": {
      const items = (def.items as z.ZodType[]).map((t: z.ZodType) => zodToJsonSchema(t));
      return withDescription({ type: "array", items }, def);
    }

    case "ZodRecord":
      return withDescription(
        { type: "object", additionalProperties: zodToJsonSchema(def.valueType) },
        def,
      );

    case "ZodDefault": {
      const inner = zodToJsonSchema(def.innerType);
      inner.default = def.defaultValue();
      return inner;
    }

    case "ZodOptional":
      return zodToJsonSchema(def.innerType);

    case "ZodNullable": {
      const inner = zodToJsonSchema(def.innerType);
      return { anyOf: [inner, { type: "null" }] };
    }

    case "ZodEffects":
      return zodToJsonSchema(def.innerType || def.schema);

    case "ZodBranded":
      return zodToJsonSchema(def.type);

    case "ZodLiteral":
      return { const: def.value };

    case "ZodUnion":
      return { anyOf: (def.options as z.ZodType[]).map((o: z.ZodType) => zodToJsonSchema(o)) };

    case "ZodDiscriminatedUnion":
      return { anyOf: (def.options as z.ZodType[]).map((o: z.ZodType) => zodToJsonSchema(o)) };

    default:
      return {};
  }
}

/** Resolve a field, tracking whether it is optional (via ZodOptional or ZodDefault). */
function resolveField(schema: z.ZodType): { schema: JsonSchema; isOptional: boolean } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const def = (schema as any)._def;
  if (!def) return { schema: {}, isOptional: false };

  if (def.typeName === "ZodOptional") {
    return { schema: zodToJsonSchema(schema), isOptional: true };
  }
  if (def.typeName === "ZodDefault") {
    return { schema: zodToJsonSchema(schema), isOptional: true };
  }
  return { schema: zodToJsonSchema(schema), isOptional: false };
}

/** Attach description from a Zod def's description field, if present. */
function withDescription(schema: JsonSchema, def: { description?: string }): JsonSchema {
  if (def.description) {
    schema.description = def.description;
  }
  return schema;
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
      "200": { description: "Batch feedback result." },
      "400": { description: "Invalid batch payload." },
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
        "Structured time estimation for LLMs and AI agents. 24 tools across 6 layers.",
    },
    servers: [
      { url: "http://localhost:3000", description: "Local development" },
    ],
    paths,
  };
}

export function createApiApp(): Hono {
  const app = new Hono();

  app.use("*", cors());

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

  // ---- Rate limiter (in-memory sliding window) ------------------------------
  const rateLimitWindowMs = 60_000;
  const rateLimitMax = Number.isFinite(parseInt(process.env["EPOCH_RATE_LIMIT"] ?? "100", 10))
    ? parseInt(process.env["EPOCH_RATE_LIMIT"] ?? "100", 10)
    : 100;
  const requestCounts = new Map<string, { count: number; resetAt: number }>();

  const trustProxy = process.env["EPOCH_TRUST_PROXY"] === "1";

  app.use("/v1/*", async (c, next) => {
    const ip = trustProxy
      ? (c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
        ?? c.req.header("x-real-ip")
        ?? "unknown")
      : "unknown";
    const now = Date.now();

    if (requestCounts.size > 10_000) {
      for (const [key, val] of requestCounts) {
        if (now > val.resetAt) requestCounts.delete(key);
      }
    } else if (requestCounts.size > 0 && Math.random() < 0.01) {
      for (const [key, val] of requestCounts) {
        if (now > val.resetAt) requestCounts.delete(key);
      }
    }

    const entry = requestCounts.get(ip);
    if (!entry || now > entry.resetAt) {
      requestCounts.set(ip, { count: 1, resetAt: now + rateLimitWindowMs });
      return next();
    }
    entry.count++;
    if (entry.count > rateLimitMax) {
      return c.json(
        { ok: false, error: { isError: true, message: "Rate limit exceeded.", retryHint: `Max ${rateLimitMax} requests per minute. Retry after ${Math.ceil((entry.resetAt - now) / 1000)}s.` } },
        429,
      );
    }
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

    const contentLength = c.req.header("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > 1_048_576) {
      return c.json(
        {
          ok: false,
          error: {
            isError: true,
            message: "Request body too large (max 1 MB).",
            retryHint: "Reduce the number of tasks or use smaller payloads.",
          },
        },
        413,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
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
    const status = result.ok ? 200 : 422;
    return c.json(result, status);
  });

  app.post("/v1/telemetry", async (c) => {
    const contentLength = c.req.header("content-length");
    if (contentLength && Number.parseInt(contentLength, 10) > 1_048_576) {
      return c.json({ accepted: 0, deduplicated: 0, error: "payload too large" }, 400);
    }

    const rawBody = await c.req.text().catch(() => "");
    const result = receiveTelemetry(rawBody, c.req.header("x-epoch-signature"));
    if (!result.ok) {
      return c.json(
        { accepted: 0, deduplicated: 0, error: result.error ?? "telemetry rejected" },
        result.status,
      );
    }

    return c.json({ accepted: result.accepted, deduplicated: result.deduplicated });
  });

  app.get("/.well-known/ai-plugin.json", (c) => {
    return c.json(AI_PLUGIN_MANIFEST);
  });

  app.get("/llms.txt", (c) => {
    return c.text(LLMSTXT, 200, { "Content-Type": "text/plain; charset=utf-8" });
  });

  let cachedSpec: Record<string, unknown> | undefined;
  app.get("/openapi.json", (c) => {
    if (!cachedSpec) cachedSpec = buildOpenApiSpec();
    return c.json(cachedSpec);
  });

  // ---- Feedback endpoints ----------------------------------------------------

  app.post("/v1/feedback/record-actual", async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ ok: false, error: { isError: true, message: "Invalid JSON body.", retryHint: "Send a valid JSON body with estimate_id and actual_hours." } }, 400);
    }

    const estimateId = body["estimate_id"] as string | undefined;
    const actualHours = body["actual_hours"] as number | undefined;

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

    const notes = body["notes"] as string | undefined;
    const result = recordActualDetailed(estimateId, actualHours, notes);
    if (!result.ok) {
      const status = result.reason === "duplicate"
        ? 409
        : result.reason === "below_threshold" || result.reason === "synthetic_id"
          ? 400
          : 500;
      return c.json({
        ok: false,
        error: {
          isError: true,
          message: `Failed to record actual: ${result.reason}.`,
          retryHint: "Use a real estimate_id, positive actual_hours, and avoid duplicate submissions.",
        },
      }, status);
    }
    return c.json({ ok: true, data: { estimateId, actualHours, recorded: true } });
  });

  app.get("/v1/feedback/pending", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
    const pending = getPendingEstimates(limit);
    return c.json({ ok: true, data: pending });
  });

  app.post("/v1/feedback/batch-record-actuals", async (c) => {
    const body = await c.req.json().catch(() => null) as Record<string, unknown> | null;
    if (!body || typeof body !== "object" || !Array.isArray(body["entries"]) || (body["entries"] as unknown[]).length === 0) {
      return c.json({
        ok: false,
        error: { isError: true, message: "Requires entries array (1–500 items) with estimate_id (string) and actual_hours (positive number) per entry.", retryHint: "POST {entries: [{estimate_id: '...', actual_hours: 8.5}]}" },
      }, 400);
    }

    const rawEntries = (body["entries"] as Array<Record<string, unknown>>).slice(0, 500);
    const entries = rawEntries
      .filter((e) => typeof e["estimate_id"] === "string" && e["estimate_id"] !== "" && typeof e["actual_hours"] === "number" && Number.isFinite(e["actual_hours"] as number) && (e["actual_hours"] as number) > 0)
      .map((e) => ({
        estimateId: e["estimate_id"] as string,
        actualHours: e["actual_hours"] as number,
        notes: e["notes"] as string | undefined,
      }));

    if (entries.length === 0) {
      return c.json({
        ok: false,
        error: { isError: true, message: "No valid entries after filtering. Each entry needs estimate_id (non-empty string) and actual_hours (positive number).", retryHint: "Check that estimate_id is a non-empty string and actual_hours is a positive number." },
      }, 400);
    }

    const result = batchRecordActuals(entries);
    return c.json({ ok: true, data: result });
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
