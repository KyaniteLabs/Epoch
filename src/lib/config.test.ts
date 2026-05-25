import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = join(tmpdir(), `epoch-config-test-${Date.now()}`);

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	process.env["EPOCH_DATA_DIR"] = TEST_DIR;
	delete process.env["EPOCH_TELEMETRY"];
	delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
});

afterEach(() => {
	delete process.env["EPOCH_DATA_DIR"];
	delete process.env["EPOCH_TELEMETRY"];
	delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("loadConfig", () => {
	it("returns defaults when no config file exists", async () => {
		const { loadConfig } = await import("./config.js");
		const config = loadConfig();
		expect(config.telemetry.enabled).toBe(false);
		expect(config.telemetry.endpoint).toBe("");
		expect(config.telemetry.lastSubmissionAt).toBeNull();
		expect(config.telemetry.lastSubmissionRecordCount).toBe(0);
		expect(config.telemetry.lastSubmissionAcceptedCount).toBe(0);
		expect(config.telemetry.lastSubmissionDeduplicatedCount).toBe(0);
		expect(config.telemetry.totalRecordsAccepted).toBe(0);
		expect(config.telemetry.totalRecordsDeduplicated).toBe(0);
		expect(config.telemetry.installationId).toBe("");
	});

	it("returns saved config", async () => {
		const { loadConfig, saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://example.com",
				lastSubmissionAt: "2026-01-01T00:00:00Z",
				lastSubmissionRecordCount: 42,
				installationId: "test-uuid",
			},
		});
		const config = loadConfig();
		expect(config.telemetry.enabled).toBe(true);
		expect(config.telemetry.endpoint).toBe("https://example.com");
		expect(config.telemetry.lastSubmissionAt).toBe("2026-01-01T00:00:00Z");
		expect(config.telemetry.lastSubmissionRecordCount).toBe(42);
		expect(config.telemetry.installationId).toBe("test-uuid");
	});

	it("handles corrupt JSON gracefully", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(join(TEST_DIR, "config.json"), "{broken json", "utf-8");
		const { loadConfig } = await import("./config.js");
		const config = loadConfig();
		expect(config.telemetry.enabled).toBe(false);
	});

	it("merges partial config with defaults", async () => {
		const { writeFileSync } = await import("node:fs");
		writeFileSync(
			join(TEST_DIR, "config.json"),
			JSON.stringify({
				telemetry: { enabled: true },
			}),
			"utf-8",
		);
		const { loadConfig } = await import("./config.js");
		const config = loadConfig();
		expect(config.telemetry.enabled).toBe(true);
		expect(config.telemetry.endpoint).toBe("");
		expect(config.telemetry.lastSubmissionRecordCount).toBe(0);
	});

	it("allows EPOCH_TELEMETRY_ENDPOINT to override config endpoint", async () => {
		const { loadConfig, saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://configured.example.com/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-uuid",
			},
		});
		process.env["EPOCH_TELEMETRY_ENDPOINT"] =
			"https://env.example.com/v1/telemetry";

		expect(loadConfig().telemetry.endpoint).toBe(
			"https://env.example.com/v1/telemetry",
		);
	});

	it("does not persist EPOCH_TELEMETRY_ENDPOINT override when saving config", async () => {
		const { loadConfig, saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://configured.example.com/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-uuid",
			},
		});
		process.env["EPOCH_TELEMETRY_ENDPOINT"] =
			"https://env.example.com/v1/telemetry";

		const config = loadConfig();
		config.telemetry.enabled = false;
		saveConfig(config);

		delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
		expect(loadConfig().telemetry.endpoint).toBe(
			"https://configured.example.com/v1/telemetry",
		);
		expect(loadConfig().telemetry.enabled).toBe(false);
	});
});

describe("saveConfig", () => {
	it("writes valid JSON to config file", async () => {
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: false,
				endpoint: "",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "abc-123",
			},
		});
		expect(existsSync(join(TEST_DIR, "config.json"))).toBe(true);
		const raw = readFileSync(join(TEST_DIR, "config.json"), "utf-8");
		const parsed = JSON.parse(raw);
		expect(parsed.telemetry.installationId).toBe("abc-123");
	});

	it("overwrites existing config", async () => {
		const { saveConfig, loadConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: false,
				endpoint: "",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "v1",
			},
		});
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://x.com",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "v2",
			},
		});
		const config = loadConfig();
		expect(config.telemetry.enabled).toBe(true);
		expect(config.telemetry.installationId).toBe("v2");
	});
});

describe("isTelemetryEnabled", () => {
	it("returns false by default", async () => {
		const { isTelemetryEnabled } = await import("./config.js");
		expect(isTelemetryEnabled()).toBe(false);
	});

	it("returns true when env var is 1", async () => {
		process.env["EPOCH_TELEMETRY"] = "1";
		const { isTelemetryEnabled } = await import("./config.js");
		expect(isTelemetryEnabled()).toBe(true);
	});

	it("returns true when env var is true", async () => {
		process.env["EPOCH_TELEMETRY"] = "true";
		const { isTelemetryEnabled } = await import("./config.js");
		expect(isTelemetryEnabled()).toBe(true);
	});

	it("returns false when env var is 0 even if config says enabled", async () => {
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "",
			},
		});
		process.env["EPOCH_TELEMETRY"] = "0";
		const { isTelemetryEnabled } = await import("./config.js");
		expect(isTelemetryEnabled()).toBe(false);
	});

	it("returns false when env var is false even if config says enabled", async () => {
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "",
			},
		});
		process.env["EPOCH_TELEMETRY"] = "false";
		const { isTelemetryEnabled } = await import("./config.js");
		expect(isTelemetryEnabled()).toBe(false);
	});

	it("falls back to config when env var is not set", async () => {
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "",
			},
		});
		const { isTelemetryEnabled } = await import("./config.js");
		expect(isTelemetryEnabled()).toBe(true);
	});
});

describe("getInstallationId", () => {
	it("generates and persists a UUID", async () => {
		const { getInstallationId } = await import("./config.js");
		const id = getInstallationId();
		expect(id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
		);
		// Reading again returns the same ID
		const { loadConfig } = await import("./config.js");
		expect(loadConfig().telemetry.installationId).toBe(id);
	});

	it("returns existing ID if already generated", async () => {
		const { saveConfig, getInstallationId } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: false,
				endpoint: "",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "existing-id",
			},
		});
		expect(getInstallationId()).toBe("existing-id");
	});
});

describe("telemetry endpoint helpers", () => {
	it("rejects example.com placeholders as usable telemetry endpoints", async () => {
		const { isPlaceholderTelemetryEndpoint, isUsableTelemetryEndpoint } =
			await import("./config.js");

		expect(
			isPlaceholderTelemetryEndpoint("https://example.com/v1/telemetry"),
		).toBe(true);
		expect(isUsableTelemetryEndpoint("https://example.com/v1/telemetry")).toBe(
			false,
		);
		expect(
			isUsableTelemetryEndpoint("https://collector.example.net/v1/telemetry"),
		).toBe(true);
	});
});
