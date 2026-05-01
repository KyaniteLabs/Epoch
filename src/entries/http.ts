import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { dispatch, listTools, TOOL_NAMES, TOOL_REGISTRY } from "../dispatcher/index.js";
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
> Time Estimation MCP Server - structured temporal reasoning for AI agents

## What is Epoch?
Epoch provides 14 tools across 5 layers for accurate time estimation.

## Layers
1. Temporal Primitives - current time, timezone conversion, duration parsing
2. Calendar Math - business days, holiday awareness, working hours
3. Estimation Algorithms - PERT, COCOMO II, Sprint Forecast, CPM, Monte Carlo
4. Data Integration - reference class forecasting, calibration
5. Advanced Analytics - token-to-time bridge, accuracy metrics

## API
POST /v1/tools/{tool_name}
Content-Type: application/json

Tool names: ${[...TOOL_NAMES].sort().join(", ")}

## Example
curl -X POST http://localhost:3000/v1/tools/pert_estimate \\
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
                        data: { type: "object" },
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
