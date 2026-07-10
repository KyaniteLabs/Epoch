// ---------------------------------------------------------------------------
// Epoch MCP Server — MCP Adapter
// Derives MCP tool registrations from the canonical TOOL_REGISTRY.
// Single source of truth: tool-registry.ts is the authority for all surfaces.
// ---------------------------------------------------------------------------

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_REGISTRY } from "./tool-registry.js";
import { dispatch } from "./index.js";
import type { z } from "zod";

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

/**
 * Zod v4 dropped the v3 ZodEffects/ZodBranded classes; wrapper kinds
 * (`.transform()`/`.refine()` -> ZodPipe, `.default()` -> ZodDefault, etc.)
 * are now discriminated at runtime by `schema.type`, with the wrapped
 * schema reachable via `schema.def.in` (ZodPipe — the pre-transform side)
 * or `schema.def.innerType` (every other single-inner-type wrapper:
 * default/prefault/optional/nullable/nonoptional/readonly/catch/success).
 * `.brand()` is a type-only marker in v4 (no runtime wrapper), so it needs
 * no unwrap step. Plain (already-unwrapped) ZodObject schemas have
 * `schema.type === "object"` immediately, so the loop is a no-op for them.
 */
type ZodWrapperDef = { in?: z.ZodTypeAny; innerType?: z.ZodTypeAny };

function unwrapToObjectSchema(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> {
  let current: z.ZodTypeAny = schema;
  while (current.type !== "object") {
    const def = current.def as ZodWrapperDef;
    const next = current.type === "pipe" ? def.in : def.innerType;
    if (!next) break;
    current = next;
  }
  return current as z.ZodObject<z.ZodRawShape>;
}

export function registerAllMcpTools(server: McpServer): void {
  for (const [name, def] of TOOL_REGISTRY) {
    const annotations = WRITE_TOOLS.has(name) ? WRITE_ANNOTATIONS : READ_ONLY_ANNOTATIONS;

    // Extract ZodRawShape — unwrap wrapper types to reach the inner ZodObject
    const shape = unwrapToObjectSchema(def.inputSchema as z.ZodTypeAny).shape;

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
