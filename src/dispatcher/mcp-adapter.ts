// ---------------------------------------------------------------------------
// Epoch MCP Server — MCP Adapter
// Derives MCP tool registrations from the canonical TOOL_REGISTRY.
// Single source of truth: tool-registry.ts is the authority for all surfaces.
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { TOOL_REGISTRY, type ToolDefinition } from "./tool-registry.js";

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

const WRITE_TOOLS = new Set(["record_actual"]);

export function registerAllMcpTools(server: McpServer): void {
  for (const [name, def] of TOOL_REGISTRY) {
    const annotations = WRITE_TOOLS.has(name) ? WRITE_ANNOTATIONS : READ_ONLY_ANNOTATIONS;

    // Extract ZodRawShape from the ZodObject schema — MCP SDK expects raw shape, not z.object()
    const shape = (def.inputSchema as z.ZodObject<z.ZodRawShape>).shape;

    // Bounded cast: MCP SDK validates via Zod before calling handler,
    // so Record<string, unknown> is safe here.
    server.tool(
      name,
      def.description,
      shape,
      annotations,
      (input: Record<string, unknown>) => {
        const result = def.handler(input);

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
