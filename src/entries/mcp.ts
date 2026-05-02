import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerTemporalTools } from "../tools/temporal.js";
import { registerEstimationTools } from "../tools/estimation.js";
import { registerAnalyticsTools } from "../tools/analytics.js";
import { registerFeedbackTools } from "../tools/feedback.js";
import { getVersion } from "../version.js";

export function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "epoch",
    version: getVersion(),
  });

  registerTemporalTools(server);
  registerEstimationTools(server);
  registerAnalyticsTools(server);
  registerFeedbackTools(server);

  const transport = new StdioServerTransport();
  return server.connect(transport);
}
