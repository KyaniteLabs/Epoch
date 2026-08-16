import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { startMcpServer } from "./entries/mcp.js";
import { startHttpServer } from "./entries/http.js";
import { runCli } from "./entries/cli.js";

export {
  cocomoEstimate,
  criticalPath,
  monteCarloSim,
  pertEstimate,
  sprintForecast,
} from "./lib/estimation.js";
export {
  calibrateEstimates,
  computeAccuracyMetrics,
  referenceClassEstimate,
  tokenTimeBridge,
} from "./lib/analytics.js";
export { compareModels, tokenCostEstimate } from "./lib/cost.js";
export { scheduleRisk } from "./lib/risk.js";
export {
  batchRecordActuals,
  getCalibrationData,
  getFeedbackHealthReport,
  getPendingEstimates,
  recordActual,
  recordActualDetailed,
  recordEstimate,
} from "./lib/feedback.js";
export {
  getInstallationId,
  isPlaceholderTelemetryEndpoint,
  isTelemetryEnabled,
  isUsableTelemetryEndpoint,
  loadConfig,
  saveConfig,
  type EpochConfig,
} from "./lib/config.js";
export {
  buildPayload,
  extractAnonymizedRecords,
  exportToFile,
  maybeSubmitTelemetry,
  signPayload,
  submitTelemetry,
} from "./lib/telemetry-submit.js";
export { receiveTelemetry } from "./lib/telemetry-receiver.js";
export { getReferenceDbStatus, type ReferenceDbStatus } from "./lib/self-improve.js";
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

  // Any argument routes to the CLI. `serve` is a real commander subcommand
  // there (validated --port/--host, listed in `epoch --help`), so no
  // pre-command intercept is needed — and `epoch serve --help` prints help
  // instead of starting a server. No arguments starts the stdio MCP server.
  if (process.argv.slice(2)[0]) {
    runCli();
    return;
  }

  startMcpServer().catch((err: unknown) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}

function isCurrentFileEntrypoint(): boolean {
  const entrypoint = process.argv[1];

  if (!entrypoint) {
    return false;
  }

  try {
    return import.meta.url === pathToFileURL(realpathSync(entrypoint)).href;
  } catch {
    return import.meta.url === pathToFileURL(entrypoint).href;
  }
}

const isEntrypoint = isCurrentFileEntrypoint();

if (isEntrypoint) {
  main();
}
