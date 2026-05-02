import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { recordActual, getPendingEstimates } from "../lib/feedback.js";

const writeAnnotations = {
  readOnlyHint: false as const,
  destructiveHint: false as const,
  idempotentHint: false as const,
  openWorldHint: false as const,
};

export function registerFeedbackTools(server: McpServer): void {
  server.tool(
    "record_actual",
    `Submit actual hours for a previous estimate to improve future accuracy.

Pairs with any estimation tool. The estimate_id comes from the estimate response.
Actuals feed into the self-improvement loop — after enough samples, correction factors
update automatically to reduce estimation bias.`,
    {
      estimate_id: z.string().describe("ID of the estimate being updated (from the estimate response)."),
      actual_hours: z.number().positive().describe("Actual hours spent on the task."),
      notes: z.string().optional().describe("Optional context about what affected the actual time."),
    },
    writeAnnotations,
    async ({ estimate_id, actual_hours, notes }) => {
      const ok = recordActual(estimate_id, actual_hours, notes);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            recorded: ok,
            estimate_id,
            actual_hours,
            message: "Actual recorded. Correction factors will update after more feedback accumulates.",
          }),
        }],
      };
    },
  );

  server.tool(
    "get_pending_estimates",
    `List recent estimates that have not yet received actual-hour feedback.

Returns estimates awaiting actuals so you can submit feedback via record_actual.
Use this to close the estimation feedback loop and improve accuracy over time.`,
    {
      limit: z.number().int().positive().max(100).default(20).describe("Maximum estimates to return."),
    },
    {
      readOnlyHint: true as const,
      destructiveHint: false as const,
      idempotentHint: true as const,
      openWorldHint: false as const,
    },
    async ({ limit }) => {
      const pending = getPendingEstimates(limit);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            count: pending.length,
            estimates: pending.map((e) => ({
              id: e.id,
              tool: e.tool,
              estimatedAt: e.estimatedAt,
              hasActual: e.hasActual,
            })),
          }),
        }],
      };
    },
  );
}
