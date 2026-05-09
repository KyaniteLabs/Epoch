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
  buildPayload,
  extractAnonymizedRecords,
  exportToFile,
  maybeSubmitTelemetry,
  signPayload,
  submitTelemetry,
} from "./lib/telemetry-submit.js";
export { receiveTelemetry } from "./lib/telemetry-receiver.js";
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

const isEntrypoint = process.argv[1] !== undefined
  && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isEntrypoint) {
  main();
}
