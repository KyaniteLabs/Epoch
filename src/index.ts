import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTemporalTools } from "./tools/temporal.js";
import { registerEstimationTools } from "./tools/estimation.js";
import { registerAnalyticsTools } from "./tools/analytics.js";

const server = new McpServer({
  name: "epoch",
  version: "0.1.0",
});

registerTemporalTools(server);
registerEstimationTools(server);
registerAnalyticsTools(server);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
