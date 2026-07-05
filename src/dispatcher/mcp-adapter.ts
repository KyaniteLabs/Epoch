// ---------------------------------------------------------------------------
// Epoch MCP Server — MCP Adapter
// Derives MCP tool registrations from the canonical TOOL_REGISTRY.
// Single source of truth: tool-registry.ts is the authority for all surfaces.
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_REGISTRY } from "./tool-registry.js";
import { dispatch } from "./index.js";
import { z } from "zod";

const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

const WRITE_TOOLS = new Set(["record_actual", "batch_record_actuals"]);

function unwrapObjectSchema(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  let current: unknown = schema;

  for (let depth = 0; depth < 10; depth += 1) {
    if (current instanceof z.ZodObject) {
      return current as z.ZodObject<z.ZodRawShape>;
    }

    if (!current || typeof current !== "object") {
      break;
    }

    const candidate = current as {
      unwrap?: () => unknown;
      innerType?: () => unknown;
      _def?: { innerType?: unknown; schema?: unknown; type?: unknown };
    };
    const def = candidate._def;
    const next =
      (typeof candidate.unwrap === "function" ? candidate.unwrap() : undefined) ??
      (typeof candidate.innerType === "function" ? candidate.innerType() : undefined) ??
      def?.innerType ??
      def?.schema ??
      (typeof def?.type === "object" ? def.type : undefined);

    if (!next || next === current) {
      break;
    }

    current = next;
  }

  throw new TypeError("Expected MCP tool input schema to unwrap to a ZodObject");
}

export function registerAllMcpTools(server: McpServer): void {
  for (const [name, def] of TOOL_REGISTRY) {
    const annotations = WRITE_TOOLS.has(name) ? WRITE_ANNOTATIONS : READ_ONLY_ANNOTATIONS;

    // Extract ZodRawShape. Zod v4 removed some v3 wrapper classes, so unwrap
    // via stable methods/internals instead of naming those classes directly.
    const shape = unwrapObjectSchema(def.inputSchema as z.ZodTypeAny).shape;

    // Bounded cast: MCP SDK validates via Zod before calling handler,
    // so Record<string, unknown> is safe here.
    server.tool(
      name,
      def.description,
      shape,
      annotations,
      async (input: Record<string, unknown>) => {
        const result = await dispatch(name, input);

        if (result.ok) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result.data) }],
          };
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.error) }],
          isError: true,
        };
      },
    );
  }
}
