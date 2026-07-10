import { describe, expect, it } from "vitest";
import {
	MAX_RECORDS_PER_SUBMISSION,
	validatePayload,
} from "../src/validate.js";

function v1Record(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		task_type: "feature",
		complexity: 3,
		tool: "pert_estimate",
		estimated_hours: 8.5,
		actual_hours: 12,
		ratio: 1.41,
		date: "2026-07-01",
		...overrides,
	};
}

function v1Payload(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		schema_version: 1,
		installation_id: "install-1",
		epoch_version: "0.3.0",
		records: [v1Record()],
		generated_at: "2026-07-01T00:00:00.000Z",
		...overrides,
	};
}

function v2Payload(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		...v1Payload(),
		schema_version: 2,
		client_name: "claude-code",
		client_version: "1.2.3",
		transport: "mcp-stdio",
		runtime_hint: "agent",
		...overrides,
	};
}

describe("validatePayload", () => {
	it("accepts a valid schema_version 1 payload", () => {
		const result = validatePayload(JSON.stringify(v1Payload()));
		expect(result.ok).toBe(true);
		expect(result.payload?.schema_version).toBe(1);
	});

	it("accepts a valid schema_version 2 payload with agent qualification fields", () => {
		const result = validatePayload(JSON.stringify(v2Payload()));
		expect(result.ok).toBe(true);
		expect(result.payload?.schema_version).toBe(2);
		if (result.payload?.schema_version === 2) {
			expect(result.payload.client_name).toBe("claude-code");
			expect(result.payload.transport).toBe("mcp-stdio");
			expect(result.payload.runtime_hint).toBe("agent");
		}
	});

	it("accepts schema_version 2 with null qualification fields (CLI/HTTP callers)", () => {
		const result = validatePayload(
			JSON.stringify(
				v2Payload({
					client_name: null,
					client_version: null,
					transport: "cli",
					runtime_hint: "unknown",
				}),
			),
		);
		expect(result.ok).toBe(true);
	});

	it("rejects invalid JSON", () => {
		const result = validatePayload("not json");
		expect(result.ok).toBe(false);
		expect(result.status).toBe(400);
	});

	it("rejects an unsupported schema_version", () => {
		const result = validatePayload(JSON.stringify(v1Payload({ schema_version: 3 })));
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/schema_version/);
	});

	it("rejects missing installation_id", () => {
		const result = validatePayload(
			JSON.stringify(v1Payload({ installation_id: "" })),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects a v1 payload carrying v2-only fields (schema pinning)", () => {
		const result = validatePayload(
			JSON.stringify(v1Payload({ client_name: "claude-code" })),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/disallowed fields/);
	});

	it("rejects an unknown top-level field regardless of version", () => {
		const result = validatePayload(
			JSON.stringify(v2Payload({ unexpected_field: "leak" })),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/disallowed fields/);
	});

	it("rejects an unknown record-level field (privacy allowlist)", () => {
		const result = validatePayload(
			JSON.stringify(
				v1Payload({ records: [v1Record({ hostname: "leak.local" })] }),
			),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/invalid anonymized/);
	});

	it("rejects a record with a non-date-only date field", () => {
		const result = validatePayload(
			JSON.stringify(
				v1Payload({
					records: [v1Record({ date: "2026-07-01T12:34:56.000Z" })],
				}),
			),
		);
		expect(result.ok).toBe(false);
	});

	it("rejects more than the max records per submission", () => {
		const records = Array.from({ length: MAX_RECORDS_PER_SUBMISSION + 1 }, () =>
			v1Record(),
		);
		const result = validatePayload(JSON.stringify(v1Payload({ records })));
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/too many records/);
	});

	it("accepts exactly the max records per submission", () => {
		const records = Array.from({ length: MAX_RECORDS_PER_SUBMISSION }, () =>
			v1Record(),
		);
		const result = validatePayload(JSON.stringify(v1Payload({ records })));
		expect(result.ok).toBe(true);
	});

	it("rejects an invalid transport value", () => {
		const result = validatePayload(
			JSON.stringify(v2Payload({ transport: "carrier-pigeon" })),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/transport/);
	});

	it("rejects an invalid runtime_hint value", () => {
		const result = validatePayload(
			JSON.stringify(v2Payload({ runtime_hint: "robot" })),
		);
		expect(result.ok).toBe(false);
		expect(result.error).toMatch(/runtime_hint/);
	});

	it("rejects records that are not an array", () => {
		const result = validatePayload(JSON.stringify(v1Payload({ records: {} })));
		expect(result.ok).toBe(false);
	});

	it("rejects a top-level array instead of an object", () => {
		const result = validatePayload(JSON.stringify([v1Payload()]));
		expect(result.ok).toBe(false);
	});
});
