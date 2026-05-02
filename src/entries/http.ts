import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { dispatch, listTools, TOOL_NAMES, TOOL_REGISTRY } from "../dispatcher/index.js";
import { recordActual, getPendingEstimates } from "../lib/feedback.js";
import type { ToolResult } from "../types/index.js";
import type { z } from "zod";

const VERSION = "0.1.0";

const AI_PLUGIN_MANIFEST = {
  schema_version: "v1",
  name_for_human: "Epoch",
  name_for_model: "epoch",
  description_for_human:
    "Time estimation tools for accurate scheduling and planning.",
  description_for_model:
    "Structured time estimation tools including PERT, COCOMO II, Monte Carlo simulation, sprint forecasting, and token-to-time mapping. 14 tools across 5 layers.",
  api: { type: "openapi", url: "/openapi.json" },
  auth: { type: "none" },
  legal_info_url:
    "https://github.com/KyaniteLabs/Epoch/blob/main/LICENSE",
} as const;

const LLMSTXT = `# Epoch
> Time Estimation MCP Server — structured temporal reasoning for AI agents

## Overview
Epoch provides 14 tools across 5 layers for accurate time estimation.
All tools are accessed via POST /v1/tools/{tool_name} with JSON request bodies.
All responses follow: {"ok": true, "data": {...}} or {"ok": false, "error": {"isError": true, "message": "...", "retryHint": "..."}}

## Layers
1. Temporal Primitives — current time, timezone conversion, duration parsing
2. Calendar Math — business days, holiday awareness
3. Estimation Algorithms — PERT, COCOMO II, Sprint Forecast, CPM, Monte Carlo
4. Data Integration — reference class forecasting, calibration
5. Advanced Analytics — token-to-time bridge, accuracy metrics

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
- Output: {"mape": 0.0, "bias": 0.0, "variance": 0.0, "sample_size": 0, "trend": "stable"}

### token_time_bridge
Estimates wall-clock time from token count and LLM model parameters.
- Input: {"tokens": 100000, "model": "claude-sonnet-4-20250514", "tool_calls": 20, "reasoning_depth": "deep"}
- Output: {"tokens": 100000, "model": "claude-sonnet-4-20250514", "estimatedSeconds": 1272, "estimatedMinutes": 21.2, "confidence": "likely", "urgency": "short", "breakdown": {"promptTokens": 30000, "completionTokens": 70000, "toolOverheadSeconds": 10}, "humanReadable": "Approximately 21.2 minutes for 100,000 tokens with claude-sonnet-4-20250514 (deep reasoning, 20 tool calls). Confidence: likely."}
- Supported models: gpt-4o, gpt-4o-mini, gpt-4-turbo, claude-sonnet-4-20250514, claude-opus-4-20250514, claude-3.5-haiku-20241022, gemini-2.0-flash, gemini-2.5-pro, llama-3.1-70b, llama-3.1-405b, mistral-large, deepseek-v3
- reasoning_depth: shallow, moderate, or deep

---

## Quick Start
curl -X POST http://localhost:3099/v1/tools/pert_estimate \\
  -H "Content-Type: application/json" \\
  -d '{"optimistic": 2, "most_likely": 4, "pessimistic": 12, "unit": "hours"}'
`;

// ---- Zod → JSON Schema converter -------------------------------------------

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

  return {
    openapi: "3.1.0",
    info: {
      title: "Epoch Time Estimation API",
      version: VERSION,
      description:
        "Structured time estimation for LLMs and AI agents. 14 tools across 5 layers.",
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

  app.get("/health", (c) => {
    return c.json({
      status: "ok",
      version: VERSION,
      tools: TOOL_NAMES.size,
      uptime: process.uptime(),
    });
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
      return c.json({ ok: false, error: { message: "Invalid JSON body." } }, 400);
    }

    const estimateId = body["estimate_id"] as string | undefined;
    const actualHours = body["actual_hours"] as number | undefined;

    if (!estimateId || actualHours === undefined || actualHours < 0) {
      return c.json({
        ok: false,
        error: {
          message: "Requires estimate_id (string) and actual_hours (non-negative number).",
          retryHint: "POST {estimate_id: '...', actual_hours: 8.5, notes: 'optional'}",
        },
      }, 400);
    }

    const notes = body["notes"] as string | undefined;
    const success = recordActual(estimateId, actualHours, notes);
    return c.json({ ok: success, data: { estimateId, actualHours, recorded: true } });
  });

  app.get("/v1/feedback/pending", (c) => {
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? "50"), 1), 200);
    const pending = getPendingEstimates(limit);
    return c.json({ ok: true, data: pending });
  });

  app.onError((err, c) => {
    return c.json(
      {
        ok: false,
        error: {
          isError: true,
          message: `Internal server error: ${err.message}`,
        },
      } satisfies ToolResult<unknown>,
      500,
    );
  });

  return app;
}

export function startHttpServer(
  port?: number,
  host?: string,
): void {
  const resolvedPort = port ?? parseInt(process.env["PORT"] ?? "3000", 10);
  const resolvedHost = host ?? process.env["HOST"] ?? "0.0.0.0";
  const app = createApiApp();

  serve({ fetch: app.fetch, port: resolvedPort, hostname: resolvedHost }, () => {
    console.error(`Epoch API server listening on http://${resolvedHost}:${resolvedPort}`);
  });
}
