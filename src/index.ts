import { startMcpServer } from "./entries/mcp.js";
import { startHttpServer } from "./entries/http.js";
import { runCli } from "./entries/cli.js";
// Re-export types for consumers
export type {
  UrgencyCategory,
  ConfidenceLevel,
  TimeUnit,
  Hours,
  Days,
  Weeks,
  Kloc,
  CostUsd,
  Tokens,
  TokensPerSecond,
  Percentage,
  TaskType,
  ToolError,
  LLMModel,
  ReasoningDepth,
  DeveloperProfile,
} from "./types/index.js";

function main(): void {
  const transport = process.env["EPOCH_TRANSPORT"];

  if (transport === "http") {
    startHttpServer();
    return;
  }

  const args = process.argv.slice(2);
  const firstArg = args[0];

  if (firstArg === "serve" || firstArg === "--http") {
    const portIdx = args.indexOf("--port");
    const portStr = portIdx !== -1 ? args[portIdx + 1] : undefined;
    const port = portStr ? parseInt(portStr, 10) : undefined;
    startHttpServer(port !== undefined && !isNaN(port) ? port : undefined);
    return;
  }

  if (firstArg && firstArg !== "serve" && firstArg !== "--http" && transport !== "http") {
    runCli();
    return;
  }

  startMcpServer().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

main();
