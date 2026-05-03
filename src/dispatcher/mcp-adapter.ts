// ---------------------------------------------------------------------------
// Epoch MCP Server — MCP Adapter
// Derives MCP tool registrations from the canonical TOOL_REGISTRY.
// Single source of truth: tool-registry.ts is the authority for all surfaces.
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_REGISTRY, type ToolDefinition } from "./tool-registry.js";
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

export function registerAllMcpTools(server: McpServer): void {
  for (const [name, def] of TOOL_REGISTRY) {
    const annotations = WRITE_TOOLS.has(name) ? WRITE_ANNOTATIONS : READ_ONLY_ANNOTATIONS;

    // Extract ZodRawShape — unwrap ZodEffects/ZodBranded to reach the inner ZodObject
    let schema: z.ZodTypeAny = def.inputSchema as z.ZodTypeAny;
    while (schema instanceof z.ZodEffects || schema instanceof z.ZodBranded) {
      schema = schema instanceof z.ZodEffects ? schema.innerType() : schema.unwrap();
    }
    const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;

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
