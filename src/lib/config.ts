import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

export interface EpochConfig {
  telemetry: {
    enabled: boolean;
    endpoint: string;
    lastSubmissionAt: string | null;
    lastSubmissionRecordCount: number;
    lastSubmissionAcceptedCount?: number;
    lastSubmissionDeduplicatedCount?: number;
    totalRecordsAccepted?: number;
    totalRecordsDeduplicated?: number;
    installationId: string;
  };
}

const DEFAULT_CONFIG: EpochConfig = {
  telemetry: {
    enabled: false,
    endpoint: "",
    lastSubmissionAt: null,
    lastSubmissionRecordCount: 0,
    lastSubmissionAcceptedCount: 0,
    lastSubmissionDeduplicatedCount: 0,
    totalRecordsAccepted: 0,
    totalRecordsDeduplicated: 0,
    installationId: "",
  },
};

const PLACEHOLDER_TELEMETRY_ENDPOINTS = new Set([
  "https://example.com",
  "https://example.com/v1/telemetry",
]);

function dataDir(): string {
  return process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
}

function configPath(): string {
  return join(dataDir(), "config.json");
}

function ensureDir(): void {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function loadConfig(): EpochConfig {
  try {
    const raw = readFileSync(configPath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<EpochConfig>;
    const endpointOverride = process.env["EPOCH_TELEMETRY_ENDPOINT"]?.trim();
    return {
      telemetry: {
        ...DEFAULT_CONFIG.telemetry,
        ...parsed?.telemetry,
        ...(endpointOverride ? { endpoint: endpointOverride } : {}),
      },
    };
  } catch {
    const config = structuredClone(DEFAULT_CONFIG);
    const endpointOverride = process.env["EPOCH_TELEMETRY_ENDPOINT"]?.trim();
    if (endpointOverride) config.telemetry.endpoint = endpointOverride;
    return config;
  }
}

export function saveConfig(config: EpochConfig): void {
  ensureDir();
  const dir = dataDir();
  const target = join(dir, "config.json");
  const tmp = join(dir, "config.json.tmp");
  writeFileSync(tmp, JSON.stringify(config, null, 2), "utf-8");
  renameSync(tmp, target);
}

export function isTelemetryEnabled(): boolean {
  const envVal = process.env["EPOCH_TELEMETRY"];
  if (envVal === "1" || envVal === "true") return true;
  if (envVal === "0" || envVal === "false") return false;
  return loadConfig().telemetry.enabled;
}

export function getInstallationId(): string {
  const config = loadConfig();
  if (config.telemetry.installationId) return config.telemetry.installationId;
  const id = randomUUID();
  config.telemetry.installationId = id;
  saveConfig(config);
  return id;
}

export function isPlaceholderTelemetryEndpoint(endpoint: string): boolean {
  const normalized = endpoint.trim().replace(/\/+$/, "");
  return PLACEHOLDER_TELEMETRY_ENDPOINTS.has(normalized);
}

export function isUsableTelemetryEndpoint(endpoint: string): boolean {
  return endpoint.trim().length > 0 && !isPlaceholderTelemetryEndpoint(endpoint);
}
