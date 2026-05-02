import { startMcpServer } from "./entries/mcp.js";
import { startHttpServer } from "./entries/http.js";
import { runCli } from "./entries/cli.js";
import { TOOL_NAMES } from "./dispatcher/index.js";

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

const CLI_SUBCOMMANDS = new Set([
  "get-current-time",
  "convert-timezone",
  "parse-duration",
  "time-math",
  "add-business-days",
  "count-business-days",
  "pert-estimate",
  "cocomo-estimate",
  "sprint-forecast",
  "critical-path",
  "monte-carlo-schedule",
  "reference-class-estimate",
  "calibrate-estimates",
  "token-time-bridge",
  "token-cost-estimate",
  "compare-models",
  "accuracy-trend",
  "schedule-risk",
  "cocomo-validate",
  "list-tools",
]);

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
