import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTemporalTools } from "../tools/temporal.js";
import { registerEstimationTools } from "../tools/estimation.js";
import { registerAnalyticsTools } from "../tools/analytics.js";

export function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "epoch",
    version: "0.1.0",
  });

  registerTemporalTools(server);
  registerEstimationTools(server);
  registerAnalyticsTools(server);

  const transport = new StdioServerTransport();
  return server.connect(transport);
}
