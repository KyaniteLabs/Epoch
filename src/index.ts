import { startMcpServer } from "./entries/mcp.js";
import { startHttpServer } from "./entries/http.js";
import { runCli } from "./entries/cli.js";
import { TOOL_NAMES } from "./dispatcher/index.js";

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
    startHttpServer();
    return;
  }

  if (firstArg && (CLI_SUBCOMMANDS.has(firstArg) || firstArg === "--format" || firstArg === "--quiet" || firstArg === "-q" || firstArg === "-h" || firstArg === "--help" || firstArg === "-V" || firstArg === "--version")) {
    runCli();
    return;
  }

  startMcpServer().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

main();
