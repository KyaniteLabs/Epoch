// ---------------------------------------------------------------------------
// Privacy allowlist pin.
//
// This test PINS the exact set of fields Epoch is allowed to emit in
// anonymized telemetry records and submission payloads. If someone adds a
// new field to AnonymizedRecord / SubmissionPayload without deliberately
// updating this pinned list (and the receiver allowlists in
// src/lib/telemetry-receiver.ts and workers/telemetry-receiver/src/validate.ts),
// this test fails. That is the point: any future field addition must be a
// conscious, reviewed privacy decision, not a silent side effect.
// ---------------------------------------------------------------------------

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assertEstimateWritten } from "../test-support.js";

const TEST_DIR = join(tmpdir(), `epoch-telemetry-privacy-test-${Date.now()}`);

const PINNED_RECORD_FIELDS = [
	"task_type",
	"complexity",
	"tool",
	"estimated_hours",
	"actual_hours",
	"ratio",
	"date",
].sort();

const PINNED_PAYLOAD_FIELDS_V1 = [
	"schema_version",
	"installation_id",
	"epoch_version",
	"records",
	"generated_at",
].sort();

const PINNED_PAYLOAD_FIELDS_V2 = [
	...PINNED_PAYLOAD_FIELDS_V1,
	"client_name",
	"client_version",
	"transport",
	"runtime_hint",
].sort();

beforeEach(() => {
	mkdirSync(TEST_DIR, { recursive: true });
	process.env["EPOCH_DATA_DIR"] = TEST_DIR;
});

afterEach(() => {
	delete process.env["EPOCH_DATA_DIR"];
	rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("telemetry privacy field allowlist (pinned)", () => {
	it("transmitted (wire) records expose exactly the pinned field set — no more, no less", async () => {
		const { recordEstimate, recordActual } = await import("./feedback.js");
		const { extractAnonymizedRecords, buildPayload } = await import(
			"./telemetry-submit.js"
		);

		const estimateId = recordEstimate(
			"pert_estimate",
			{ task_type: "feature", complexity: 3 },
			{ expected: 2, unit: "hours" },
		);
		assertEstimateWritten(estimateId);
		recordActual(estimateId, 3);

		const extracted = extractAnonymizedRecords();
		expect(extracted[0]).toBeDefined();
		// The internal record intentionally carries completed_at as the local
		// submission cursor; the wire pin below is what privacy guarantees.
		const [record] = buildPayload(extracted).records;
		expect(Object.keys(record as object).sort()).toEqual(PINNED_RECORD_FIELDS);
	});

	it("buildPayload emits exactly the pinned schema_version 2 payload field set", async () => {
		const { extractAnonymizedRecords, buildPayload } = await import(
			"./telemetry-submit.js"
		);
		const payload = buildPayload(extractAnonymizedRecords());
		expect(payload.schema_version).toBe(2);
		expect(Object.keys(payload).sort()).toEqual(PINNED_PAYLOAD_FIELDS_V2);
	});

	it("receiveTelemetry rejects any record field outside the pinned allowlist", async () => {
		const { createHmac } = await import("node:crypto");
		const { receiveTelemetry } = await import("./telemetry-receiver.js");

		for (const leakField of ["hostname", "path", "notes", "ip", "user_agent"]) {
			const payload = {
				schema_version: 1,
				installation_id: "privacy-pin-test",
				epoch_version: "0.0.0-test",
				records: [
					{
						task_type: "feature",
						complexity: 3,
						tool: "pert_estimate",
						estimated_hours: 4,
						actual_hours: 5,
						ratio: 1.25,
						date: "2026-07-10",
						[leakField]: "should-be-rejected",
					},
				],
				generated_at: new Date().toISOString(),
			};
			const rawBody = JSON.stringify(payload);
			const signature = createHmac("sha256", payload.installation_id)
				.update(rawBody)
				.digest("hex");

			const result = receiveTelemetry(rawBody, signature);
			expect(result.ok, `expected rejection for leaked field "${leakField}"`).toBe(
				false,
			);
			expect(result.status).toBe(400);
		}
	});

	it("receiveTelemetry rejects any top-level payload field outside the pinned allowlist", async () => {
		const { createHmac } = await import("node:crypto");
		const { receiveTelemetry } = await import("./telemetry-receiver.js");

		for (const leakField of ["hostname", "ip_address", "user_email", "notes"]) {
			const payload: Record<string, unknown> = {
				schema_version: 2,
				installation_id: "privacy-pin-test",
				epoch_version: "0.0.0-test",
				records: [],
				generated_at: new Date().toISOString(),
				client_name: null,
				client_version: null,
				transport: null,
				runtime_hint: "unknown",
				[leakField]: "should-be-rejected",
			};
			const rawBody = JSON.stringify(payload);
			const signature = createHmac("sha256", payload["installation_id"] as string)
				.update(rawBody)
				.digest("hex");

			const result = receiveTelemetry(rawBody, signature);
			expect(result.ok, `expected rejection for leaked field "${leakField}"`).toBe(
				false,
			);
			expect(result.status).toBe(400);
		}
	});
});

describe("time-of-day never leaves the machine (PRIVACY.md promise)", () => {
	it("buildPayload strips completed_at from every transmitted record", async () => {
		const { buildPayload } = await import("./telemetry-submit.js");
		const payload = buildPayload([
			{
				task_type: "feature",
				complexity: 3,
				tool: "pert_estimate",
				estimated_hours: 2,
				actual_hours: 1.5,
				ratio: 0.75,
				date: "2026-07-10",
				completed_at: "2026-07-10T13:37:42.123Z",
			},
		]);
		for (const rec of payload.records) {
			expect(Object.keys(rec)).not.toContain("completed_at");
			for (const value of Object.values(rec)) {
				if (typeof value === "string") {
					expect(value).not.toMatch(/T\d{2}:\d{2}/);
				}
			}
		}
	});
});
