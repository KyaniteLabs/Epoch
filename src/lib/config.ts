import {
	existsSync,
	readFileSync,
	writeFileSync,
	renameSync,
	mkdirSync,
} from "node:fs";
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
		/** Whether the first-run telemetry nudge has already been shown or superseded by an explicit enable/disable. */
		nudgeShown?: boolean;
	};
}

/**
 * Default public telemetry receiver. Baking this in does NOT enable
 * telemetry — `enabled` stays `false` by default; endpoint presence alone
 * sends nothing. Used whenever telemetry is enabled and no endpoint has been
 * explicitly configured. See docs/TELEMETRY.md and docs/PRIVACY.md.
 */
export const DEFAULT_PUBLIC_TELEMETRY_ENDPOINT =
	"https://telemetry.kyanitelabs.tech/v1/telemetry";

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
		nudgeShown: false,
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

export function persistedConfigSnapshot(config: EpochConfig): EpochConfig {
	const endpointOverride = process.env["EPOCH_TELEMETRY_ENDPOINT"]?.trim();
	if (!endpointOverride || config.telemetry.endpoint !== endpointOverride) {
		return config;
	}

	const persisted = structuredClone(config);
	try {
		const raw = readFileSync(configPath(), "utf-8");
		const parsed = JSON.parse(raw) as Partial<EpochConfig>;
		persisted.telemetry.endpoint =
			parsed.telemetry?.endpoint ?? DEFAULT_CONFIG.telemetry.endpoint;
	} catch {
		persisted.telemetry.endpoint = DEFAULT_CONFIG.telemetry.endpoint;
	}
	return persisted;
}

export function saveConfig(config: EpochConfig): void {
	ensureDir();
	const dir = dataDir();
	const target = join(dir, "config.json");
	const tmp = join(dir, "config.json.tmp");
	writeFileSync(
		tmp,
		JSON.stringify(persistedConfigSnapshot(config), null, 2),
		"utf-8",
	);
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
	return (
		endpoint.trim().length > 0 && !isPlaceholderTelemetryEndpoint(endpoint)
	);
}

/**
 * The effective telemetry endpoint: the configured endpoint if one was set,
 * otherwise the baked-in public default. An explicit placeholder endpoint
 * (e.g. "https://example.com") is returned as-is so callers can still reject
 * it via `isUsableTelemetryEndpoint`/`isPlaceholderTelemetryEndpoint`.
 * Endpoint resolution alone never sends anything — submission still
 * requires `isTelemetryEnabled()`.
 */
export function resolveTelemetryEndpoint(config: EpochConfig): string {
	const configured = config.telemetry.endpoint.trim();
	return configured.length > 0 ? configured : DEFAULT_PUBLIC_TELEMETRY_ENDPOINT;
}
