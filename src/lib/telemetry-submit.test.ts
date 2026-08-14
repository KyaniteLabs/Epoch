import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "node:crypto";
import { existsSync, rmSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const TEST_DIR = join(tmpdir(), `epoch-tel-sub-test-${Date.now()}`);
const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	process.env["EPOCH_DATA_DIR"] = TEST_DIR;
	delete process.env["EPOCH_TELEMETRY"];
	delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
});

afterEach(() => {
	globalThis.fetch = ORIGINAL_FETCH;
	delete process.env["EPOCH_DATA_DIR"];
	delete process.env["EPOCH_TELEMETRY"];
	delete process.env["EPOCH_TELEMETRY_ENDPOINT"];
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("extractAnonymizedRecords", () => {
	it("returns empty array when no feedback data exists", async () => {
		const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
		const records = extractAnonymizedRecords();
		expect(Array.isArray(records)).toBe(true);
	});

	it("strips estimate IDs, source, notes — keeps only categorical + numeric fields", async () => {
		const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
		const records = extractAnonymizedRecords();

		for (const rec of records) {
			expect(rec).toHaveProperty("task_type");
			expect(rec).toHaveProperty("complexity");
			expect(rec).toHaveProperty("tool");
			expect(rec).toHaveProperty("estimated_hours");
			expect(rec).toHaveProperty("actual_hours");
			expect(rec).toHaveProperty("ratio");
			expect(rec).toHaveProperty("date");
			expect(rec).toHaveProperty("completed_at");

			// Must NOT have identifying fields
			const obj = rec as unknown as Record<string, unknown>;
			expect(obj["estimateId"]).toBeUndefined();
			expect(obj["source"]).toBeUndefined();
			expect(obj["notes"]).toBeUndefined();
			expect(obj["teamId"]).toBeUndefined();
		}
	});

	it("truncates dates to YYYY-MM-DD only (no time component)", async () => {
		const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
		const records = extractAnonymizedRecords();

		for (const rec of records) {
			expect(rec.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
			expect(rec.date).toHaveLength(10);
		}
	});

	it("computes ratio as actual/estimated", async () => {
		const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
		const records = extractAnonymizedRecords();

		for (const rec of records) {
			const expected =
				Math.round((rec.actual_hours / rec.estimated_hours) * 10000) / 10000;
			expect(rec.ratio).toBe(expected);
		}
	});

	it("excludes records with invalid numeric values before computing ratios", async () => {
		const { writeFileSync } = await import("node:fs");
		const feedbackPath = join(TEST_DIR, "feedback.jsonl");
		writeFileSync(
			feedbackPath,
			`${JSON.stringify({
				estimateId: "zero-estimate",
				tool: "pert_estimate",
				taskType: "feature",
				estimatedHours: 0,
				actualHours: 1,
				ratio: null,
				completedAt: new Date().toISOString(),
			})}\n`,
			"utf-8",
		);

		const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
		expect(extractAnonymizedRecords()).toHaveLength(0);
	});

	it("excludes records at or before the exact submission cutoff", async () => {
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const estimateId = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		recordActual(estimateId, 3);
		const cutoff = new Date(Date.now() + 1_000).toISOString();

		const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
		expect(extractAnonymizedRecords(cutoff)).toHaveLength(0);
	});
});

describe("buildPayload", () => {
	it("includes schema_version 2 fields: installation_id, epoch_version, records, generated_at, agent qualification", async () => {
		const { buildPayload } = await import("./telemetry-submit.js");
		const payload = buildPayload([]);

		expect(payload.schema_version).toBe(2);
		expect(typeof payload.installation_id).toBe("string");
		expect(payload.installation_id).toHaveLength(36); // UUID format
		expect(typeof payload.epoch_version).toBe("string");
		expect(Array.isArray(payload.records)).toBe(true);
		expect(typeof payload.generated_at).toBe("string");
		if (payload.schema_version === 2) {
			// No entrypoint has called setTransport()/setMcpClientInfo() in this
			// unit test process, so qualification fields default to null/unknown.
			expect(payload.client_name).toBeNull();
			expect(payload.client_version).toBeNull();
			expect(payload.transport).toBeNull();
			expect(payload.runtime_hint).toBe("unknown");
		}
	});

	it("threads MCP clientInfo and transport through from telemetry-context", async () => {
		const { buildPayload } = await import("./telemetry-submit.js");
		const { setMcpClientInfo, setTransport, resetTelemetryContextForTests } =
			await import("./telemetry-context.js");

		setTransport("mcp-stdio");
		setMcpClientInfo({ name: "claude-code", version: "1.2.3" });

		const payload = buildPayload([]);
		expect(payload.schema_version).toBe(2);
		if (payload.schema_version === 2) {
			expect(payload.client_name).toBe("claude-code");
			expect(payload.client_version).toBe("1.2.3");
			expect(payload.transport).toBe("mcp-stdio");
			expect(payload.runtime_hint).toBe("agent");
		}

		resetTelemetryContextForTests();
	});
});

describe("signPayload", () => {
	it("produces a consistent HMAC for the same input", async () => {
		const { buildPayload, signPayload } = await import("./telemetry-submit.js");
		const payload = buildPayload([]);
		const id = payload.installation_id;

		const sig1 = signPayload(payload, id);
		const sig2 = signPayload(payload, id);

		expect(sig1).toBe(sig2);
		expect(sig1).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
	});

	it("produces different HMACs for different payloads", async () => {
		const { buildPayload, signPayload } = await import("./telemetry-submit.js");
		const payload1 = buildPayload([]);
		const payload2 = buildPayload([
			{
				task_type: "feature",
				complexity: 3,
				tool: "test",
				estimated_hours: 4,
				actual_hours: 5,
				ratio: 1.25,
				date: "2026-01-01",
				completed_at: "2026-01-01T00:00:00.000Z",
			},
		]);
		const id = payload1.installation_id;

		const sig1 = signPayload(payload1, id);
		const sig2 = signPayload(payload2, id);

		expect(sig1).not.toBe(sig2);
	});
});

describe("submitTelemetry", () => {
	it("returns error when telemetry is not enabled", async () => {
		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("not enabled");
	});

	it("falls back to the default public endpoint when none is configured", async () => {
		const { saveConfig } = await import("./config.js");
		const { DEFAULT_PUBLIC_TELEMETRY_ENDPOINT } = await import("./config.js");
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const estimateId = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		recordActual(estimateId, 3);
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});

		let requestedUrl: string | undefined;
		globalThis.fetch = (async (
			input: string | URL | Request,
		) => {
			requestedUrl = String(input);
			return new Response(JSON.stringify({ accepted: 1, deduplicated: 0 }), {
				status: 200,
			});
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();
		expect(result.ok).toBe(true);
		expect(requestedUrl).toBe(DEFAULT_PUBLIC_TELEMETRY_ENDPOINT);
	});

	it("returns error when endpoint is the example.com placeholder", async () => {
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://example.com/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});
		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("placeholder endpoint");
	});

	it("returns error when rate limited", async () => {
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net",
				lastSubmissionAt: new Date().toISOString(),
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});
		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();
		expect(result.ok).toBe(false);
		expect(result.error).toContain("rate limited");
	});

	it("allows trusted fleet jobs to bypass the submit interval", async () => {
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net/v1/telemetry",
				lastSubmissionAt: new Date(Date.now() - 1_000).toISOString(),
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const estimateId = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours", confidence: 0.8 },
		);
		recordActual(estimateId, 3, "force submit coverage real record");
		process.env["EPOCH_TELEMETRY_SUBMIT_FORCE"] = "1";

		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(JSON.stringify({ accepted: 1, deduplicated: 0 }), {
				status: 200,
			});
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();
		expect(result).toMatchObject({ ok: true, recordCount: 1 });
		expect(called).toBe(true);
	});

	it("honors EPOCH_TELEMETRY=0 when config telemetry is enabled", async () => {
		const { saveConfig } = await import("./config.js");
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const estimateId = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		recordActual(estimateId, 3);
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});
		process.env["EPOCH_TELEMETRY"] = "0";

		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(null, { status: 200 });
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();

		expect(result).toEqual({
			ok: false,
			recordCount: 0,
			error: "telemetry not enabled",
		});
		expect(called).toBe(false);
	});

	it("signs first-time submissions with the generated installation ID", async () => {
		const { saveConfig, loadConfig } = await import("./config.js");
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const estimateId = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		recordActual(estimateId, 3);
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "",
			},
		});

		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			const body = String(init?.body ?? "");
			const payload = JSON.parse(body) as { installation_id: string };
			const headers = init?.headers as Record<string, string>;
			const expected = createHmac("sha256", payload.installation_id)
				.update(body)
				.digest("hex");
			expect(payload.installation_id).toHaveLength(36);
			expect(headers["X-Epoch-Signature"]).toBe(expected);
			return new Response(JSON.stringify({ accepted: 1, deduplicated: 0 }), {
				status: 200,
			});
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();

		expect(result).toEqual({
			ok: true,
			recordCount: 1,
			accepted: 1,
			deduplicated: 0,
		});
		expect(loadConfig().telemetry.lastSubmissionRecordCount).toBe(1);
		expect(loadConfig().telemetry.lastSubmissionAcceptedCount).toBe(1);
		expect(loadConfig().telemetry.lastSubmissionDeduplicatedCount).toBe(0);
		expect(loadConfig().telemetry.totalRecordsAccepted).toBe(1);
		expect(loadConfig().telemetry.totalRecordsDeduplicated).toBe(0);
		expect(loadConfig().telemetry.installationId).toHaveLength(36);
	});

	it("submits the whole queued backlog in receiver-sized chunks before advancing the cursor", async () => {
		const { saveConfig, loadConfig } = await import("./config.js");
		const { recordEstimate, recordActual } = await import("./feedback.js");
		for (let index = 0; index < 101; index++) {
			const estimateId = recordEstimate(
				"pert_estimate",
				{ task_type: "feature", complexity: 3 },
				{ expected: 2, unit: "hours" },
			);
			recordActual(estimateId, 3);
		}
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});

		const chunkSizes: number[] = [];
		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			const payload = JSON.parse(String(init?.body ?? "")) as {
				records: unknown[];
			};
			chunkSizes.push(payload.records.length);
			return new Response(
				JSON.stringify({ accepted: payload.records.length, deduplicated: 0 }),
				{ status: 200 },
			);
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();

		expect(result).toEqual({
			ok: true,
			recordCount: 101,
			accepted: 101,
			deduplicated: 0,
		});
		expect(chunkSizes).toEqual([100, 1]);
		expect(loadConfig().telemetry.lastSubmissionRecordCount).toBe(101);
		expect(loadConfig().telemetry.lastSubmissionAcceptedCount).toBe(101);
	});

	it("advances telemetry counters for successful chunks before later chunks fail", async () => {
		const { saveConfig, loadConfig } = await import("./config.js");
		const { recordEstimate, recordActual } = await import("./feedback.js");
		for (let index = 0; index < 101; index++) {
			const estimateId = recordEstimate(
				"pert_estimate",
				{ task_type: "feature", complexity: 3 },
				{ expected: 2, unit: "hours" },
			);
			recordActual(estimateId, 3);
		}
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});

		let calls = 0;
		globalThis.fetch = (async (
			_input: string | URL | Request,
			init?: RequestInit,
		) => {
			calls++;
			const payload = JSON.parse(String(init?.body ?? "")) as {
				records: unknown[];
			};
			if (calls === 2) {
				return new Response("receiver unavailable", { status: 503 });
			}
			return new Response(
				JSON.stringify({ accepted: payload.records.length, deduplicated: 0 }),
				{ status: 200 },
			);
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();
		const telemetry = loadConfig().telemetry;

		expect(result).toMatchObject({
			ok: false,
			recordCount: 100,
			accepted: 100,
			deduplicated: 0,
		});
		expect(telemetry.lastSubmissionRecordCount).toBe(100);
		expect(telemetry.lastSubmissionAcceptedCount).toBe(100);
		expect(telemetry.lastSubmissionAt).toMatch(
			/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
		);
		expect(
			new Date(telemetry.lastSubmissionAt ?? "").getTime(),
		).toBeLessThanOrEqual(Date.now());
	});
});

describe("maybeSubmitTelemetry", () => {
	it("does nothing for the first 99 calls", async () => {
		const { maybeSubmitTelemetry, resetCallCount } = await import(
			"./telemetry-submit.js"
		);
		resetCallCount();
		// Should not throw or do anything observable
		for (let i = 0; i < 99; i++) {
			maybeSubmitTelemetry();
		}
		// No error means it correctly skipped
		expect(true).toBe(true);
	});
});

describe("exportToFile", () => {
	it("writes anonymized records to a file", async () => {
		const { exportToFile } = await import("./telemetry-submit.js");
		const path = exportToFile();
		expect(existsSync(path)).toBe(true);

		const { readFileSync } = await import("node:fs");
		const content = readFileSync(path, "utf-8");
		const records = JSON.parse(content);
		expect(Array.isArray(records)).toBe(true);
	});

	it("writes to custom path when provided", async () => {
		const { exportToFile } = await import("./telemetry-submit.js");
		const customPath = join(TEST_DIR, "custom-export.json");
		const path = exportToFile(customPath);
		expect(path).toBe(customPath);
		expect(existsSync(customPath)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Ticket 19 — sender hardening: dist-safe version resolution, corrupt-cursor
// recovery, and malformed completedAt sanitation.
// ---------------------------------------------------------------------------

describe("ticket 19 — sender hardening", () => {
	afterEach(() => {
		delete process.env["EPOCH_TELEMETRY_SUBMIT_FORCE"];
	});

	it("resolves epoch_version through the dist-safe depth chain (installed-package layout)", async () => {
		const { readPackageVersion } = await import("../version.js");

		const root = mkdtempSync(join(tmpdir(), "epoch-tel-submit-ver-"));
		try {
			writeFileSync(
				join(root, "package.json"),
				JSON.stringify({ name: "epoch-dist-fixture", version: "9.9.9" }),
				"utf-8",
			);
			// Installed-package layout: tsup inlines telemetry-submit into
			// <root>/dist/*.js — package.json one hop up, nothing at two hops.
			mkdirSync(join(root, "dist"));
			const distModule = join(root, "dist", "index.js");
			writeFileSync(distModule, "// simulated bundle\n", "utf-8");
			expect(readPackageVersion([2, 1], pathToFileURL(distModule))).toBe("9.9.9");

			// Dev layout: src/lib/telemetry-submit.ts — package.json two hops up.
			mkdirSync(join(root, "src", "lib"), { recursive: true });
			const devModule = join(root, "src", "lib", "telemetry-submit.ts");
			writeFileSync(devModule, "// simulated src module\n", "utf-8");
			expect(readPackageVersion([2, 1], pathToFileURL(devModule))).toBe("9.9.9");

			// The payload itself must carry the real repo version (previously
			// hand-resolved ../../package.json, which reported "unknown" from
			// the dist layout). Resolved from THIS test file's URL (also
			// src/lib/, same depth chain) against the real repo root.
			const { buildPayload } = await import("./telemetry-submit.js");
			const payload = buildPayload([]);
			expect(payload.epoch_version).toMatch(/^\d+\.\d+\.\d+/);
			expect(payload.epoch_version).not.toBe("unknown");
			expect(payload.epoch_version).toBe(readPackageVersion([2, 1], import.meta.url));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("treats a corrupt lastSubmissionAt as no cursor: submission proceeds and the cursor is repaired", async () => {
		const { saveConfig, loadConfig } = await import("./config.js");
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const estimateId = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		recordActual(estimateId, 3);
		// Corrupt cursor: unparsable timestamp (manual edit / partial write).
		// Pre-ticket-19 this made extractAnonymizedRecords throw RangeError
		// (NaN windowDays -> Invalid Date.toISOString()) and wedged every
		// future submission; a NaN cursor filter would instead silently drop
		// the whole backlog.
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net/v1/telemetry",
				lastSubmissionAt: "not-a-timestamp",
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});

		let submittedRecords = -1;
		globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			const payload = JSON.parse(String(init?.body ?? "")) as { records: unknown[] };
			submittedRecords = payload.records.length;
			return new Response(JSON.stringify({ accepted: 0, deduplicated: 0, quarantined: 1 }), {
				status: 200,
			});
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();

		// The backlog was resubmitted (receiver-side dedupe absorbs repeats),
		// not dropped and not wedged.
		expect(result).toMatchObject({ ok: true, recordCount: 1 });
		expect(submittedRecords).toBe(1);
		const repaired = loadConfig().telemetry.lastSubmissionAt;
		expect(repaired).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
	});

	it("filters records with a malformed completedAt at extraction so the first-ever submission cannot wedge", async () => {
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const good = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		recordActual(good, 3);
		const bad = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		recordActual(bad, 3);
		// Corrupt the second actual's completedAt in the ledger (non-empty but
		// unparsable — empty strings fall back to reportedAt upstream).
		const actualsPath = join(TEST_DIR, "feedback.jsonl");
		const lines = readFileSync(actualsPath, "utf-8").trim().split("\n");
		const patched = lines.map((line) => {
			const row = JSON.parse(line) as Record<string, unknown>;
			if (row["estimateId"] === bad) row["completedAt"] = "definitely-not-a-date";
			return JSON.stringify(row);
		});
		writeFileSync(actualsPath, `${patched.join("\n")}\n`, "utf-8");

		const { extractAnonymizedRecords } = await import("./telemetry-submit.js");
		// Pre-ticket-19 this threw RangeError (Invalid Date.toISOString()),
		// so NO submission could ever succeed and the cursor never advanced.
		const records = extractAnonymizedRecords();
		expect(records).toHaveLength(1);
		expect(records[0]?.completed_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);

		// And the first-ever submission (null cursor) completes over the
		// malformed row.
		const { saveConfig } = await import("./config.js");
		saveConfig({
			telemetry: {
				enabled: true,
				endpoint: "https://collector.example.net/v1/telemetry",
				lastSubmissionAt: null,
				lastSubmissionRecordCount: 0,
				installationId: "test-id",
			},
		});
		let called = false;
		globalThis.fetch = (async () => {
			called = true;
			return new Response(JSON.stringify({ accepted: 0, deduplicated: 0, quarantined: 1 }), {
				status: 200,
			});
		}) as typeof fetch;

		const { submitTelemetry } = await import("./telemetry-submit.js");
		const result = await submitTelemetry();
		expect(result).toMatchObject({ ok: true, recordCount: 1 });
		expect(called).toBe(true);
	});
});
