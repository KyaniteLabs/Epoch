import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllMcpTools } from "../dispatcher/mcp-adapter.js";
import { getVersion } from "../version.js";
import { setMcpClientInfo, setTransport } from "../lib/telemetry-context.js";
import { createStdioGuardTransform } from "../lib/jsonrpc-stdio-guard.js";

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

	// Line-wise JSON-RPC hygiene guard (CGO-12 cure pattern, achiote lineage):
	// answers params:null with -32602, non-JSON lines with -32700, batches
	// with -32600, and pre-initialize requests with -32002 — instead of the
	// SDK transport's silent drops. Well-formed lines pass through untouched.
	const guardedStdin = createStdioGuardTransform();
	process.stdin.pipe(guardedStdin);
	const transport = new StdioServerTransport(guardedStdin);
	return server.connect(transport);
}
