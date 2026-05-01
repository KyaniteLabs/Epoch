import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { dispatch, listTools, TOOL_NAMES } from "../dispatcher/index.js";
import type { ToolResult } from "../types/index.js";

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

function buildOpenApiSpec(): Record<string, unknown> {
  const tools = listTools();
  const paths: Record<string, unknown> = {};

  for (const tool of tools) {
    paths[`/v1/tools/${tool.name}`] = {
      post: {
        operationId: tool.name,
        summary: tool.description,
        requestBody: {
          required: true,
          content: {
            "application/json": { schema: { type: "object" } },
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
    return c.json(result);
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
