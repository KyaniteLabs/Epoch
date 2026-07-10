// Pure validation logic ported from src/lib/telemetry-receiver.ts, extended
// to accept schema_version 1 AND 2 (client_name/client_version/transport/
// runtime_hint) with a strict field allowlist at both the payload and
// record level. No I/O, no Cloudflare bindings — safe to unit test directly.

import type {
	AnonymizedRecord,
	RuntimeHint,
	SubmissionPayload,
	Transport,
} from "./types.js";

export const MAX_RECORDS_PER_SUBMISSION = 100;
export const MAX_BODY_BYTES = 1_000_000; // 1 MB

const V1_TOP_LEVEL_FIELDS = new Set([
	"schema_version",
	"installation_id",
	"epoch_version",
	"records",
	"generated_at",
]);

const V2_TOP_LEVEL_FIELDS = new Set([
	...V1_TOP_LEVEL_FIELDS,
	"client_name",
	"client_version",
	"transport",
	"runtime_hint",
]);

const RECORD_FIELDS = new Set([
	"task_type",
	"complexity",
	"tool",
	"estimated_hours",
	"actual_hours",
	"ratio",
	"date",
	"completed_at",
]);

const VALID_TRANSPORTS: ReadonlySet<string> = new Set([
	"mcp-stdio",
	"mcp-http",
	"cli",
	"rest",
]);

const VALID_RUNTIME_HINTS: ReadonlySet<string> = new Set([
	"agent",
	"human",
	"unknown",
]);

export interface ValidationOutcome {
	ok: boolean;
	status: 400;
	error?: string;
	payload?: SubmissionPayload;
}

function hasOnlyAllowedKeys(
	obj: Record<string, unknown>,
	allowed: ReadonlySet<string>,
): boolean {
	return Object.keys(obj).every((key) => allowed.has(key));
}

function isNullableString(value: unknown): value is string | null {
	return value === null || typeof value === "string";
}

function isAnonymizedRecord(value: unknown): value is AnonymizedRecord {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	if (!hasOnlyAllowedKeys(record, RECORD_FIELDS)) return false;
	return (
		typeof record["task_type"] === "string" &&
		record["task_type"].length > 0 &&
		record["task_type"].length <= 100 &&
		(typeof record["complexity"] === "number" ||
			record["complexity"] === null) &&
		typeof record["tool"] === "string" &&
		record["tool"].length > 0 &&
		record["tool"].length <= 100 &&
		typeof record["estimated_hours"] === "number" &&
		Number.isFinite(record["estimated_hours"]) &&
		typeof record["actual_hours"] === "number" &&
		Number.isFinite(record["actual_hours"]) &&
		typeof record["ratio"] === "number" &&
		Number.isFinite(record["ratio"]) &&
		typeof record["date"] === "string" &&
		/^\d{4}-\d{2}-\d{2}$/.test(record["date"]) &&
		(record["completed_at"] === undefined ||
			typeof record["completed_at"] === "string")
	);
}

function fail(error: string): ValidationOutcome {
	return { ok: false, status: 400, error };
}

export function validatePayload(rawBody: string): ValidationOutcome {
	let parsed: unknown;
	try {
		parsed = JSON.parse(rawBody);
	} catch {
		return fail("invalid JSON body");
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		return fail("payload must be a JSON object");
	}
	const payload = parsed as Record<string, unknown>;

	const schemaVersion = payload["schema_version"];
	if (schemaVersion !== 1 && schemaVersion !== 2) {
		return fail("unsupported schema_version");
	}

	const allowedTopLevel =
		schemaVersion === 2 ? V2_TOP_LEVEL_FIELDS : V1_TOP_LEVEL_FIELDS;
	if (!hasOnlyAllowedKeys(payload, allowedTopLevel)) {
		return fail("payload contains disallowed fields");
	}

	const installationId = payload["installation_id"];
	if (
		typeof installationId !== "string" ||
		installationId.length === 0 ||
		installationId.length > 200
	) {
		return fail("missing installation_id");
	}

	const epochVersion = payload["epoch_version"];
	if (typeof epochVersion !== "string" || epochVersion.length === 0) {
		return fail("missing epoch_version");
	}

	const generatedAt = payload["generated_at"];
	if (typeof generatedAt !== "string" || generatedAt.length === 0) {
		return fail("missing generated_at");
	}

	const records = payload["records"];
	if (!Array.isArray(records)) {
		return fail("records must be an array");
	}
	if (records.length > MAX_RECORDS_PER_SUBMISSION) {
		return fail("too many records");
	}
	if (!records.every(isAnonymizedRecord)) {
		return fail("records contain invalid anonymized telemetry fields");
	}

	if (schemaVersion === 2) {
		const clientName = payload["client_name"];
		const clientVersion = payload["client_version"];
		const transport = payload["transport"];
		const runtimeHint = payload["runtime_hint"];

		if (clientName !== undefined && !isNullableString(clientName)) {
			return fail("client_name must be a string or null");
		}
		if (clientVersion !== undefined && !isNullableString(clientVersion)) {
			return fail("client_version must be a string or null");
		}
		if (
			transport !== undefined &&
			transport !== null &&
			(typeof transport !== "string" || !VALID_TRANSPORTS.has(transport))
		) {
			return fail("invalid transport");
		}
		if (
			runtimeHint !== undefined &&
			runtimeHint !== null &&
			(typeof runtimeHint !== "string" || !VALID_RUNTIME_HINTS.has(runtimeHint))
		) {
			return fail("invalid runtime_hint");
		}

		return {
			ok: true,
			status: 400,
			payload: {
				schema_version: 2,
				installation_id: installationId,
				epoch_version: epochVersion,
				generated_at: generatedAt,
				records: records as AnonymizedRecord[],
				client_name: (clientName as string | null | undefined) ?? null,
				client_version: (clientVersion as string | null | undefined) ?? null,
				transport: (transport as Transport | null | undefined) ?? null,
				runtime_hint: (runtimeHint as RuntimeHint | null | undefined) ?? null,
			},
		};
	}

	return {
		ok: true,
		status: 400,
		payload: {
			schema_version: 1,
			installation_id: installationId,
			epoch_version: epochVersion,
			generated_at: generatedAt,
			records: records as AnonymizedRecord[],
		},
	};
}

/** Deterministic string used to derive the receiver-local dedup key (hashed by the caller). */
export function recordContentKeySeed(
	installationId: string,
	record: AnonymizedRecord,
): string {
	return JSON.stringify({ installationId, record });
}
