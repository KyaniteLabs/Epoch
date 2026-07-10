import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllMcpTools } from "../dispatcher/mcp-adapter.js";
import { getVersion } from "../version.js";
import { setMcpClientInfo, setTransport } from "../lib/telemetry-context.js";

export function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: "epoch",
    version: getVersion(),
  });

  registerAllMcpTools(server);

  setTransport("mcp-stdio");
  // Capture the connecting client's identity (e.g. "claude-code") for
  // schema v2 agent-qualified telemetry. No behavior depends on this beyond
  // the coarse runtime_hint computed in telemetry-context.ts.
  server.server.oninitialized = () => {
    setMcpClientInfo(server.server.getClientVersion());
  };

  const transport = new StdioServerTransport();
  return server.connect(transport);
}
