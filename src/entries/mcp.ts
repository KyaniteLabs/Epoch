import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllMcpTools } from "../dispatcher/mcp-adapter.js";
import { getVersion } from "../version.js";

export function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "epoch",
    version: getVersion(),
  });

  registerAllMcpTools(server);

  const transport = new StdioServerTransport();
  return server.connect(transport);
}
