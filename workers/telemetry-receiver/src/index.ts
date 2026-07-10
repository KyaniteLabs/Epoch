import { hmacSha256Hex, sha256Hex, timingSafeEqualHex } from "./crypto.js";
import {
	countAcceptedToday,
	DAILY_RECORD_CAP_PER_INSTALLATION,
	insertDedupKey,
	insertReceipt,
	insertRecord,
	keyExists,
	purgeOlderThan,
} from "./db.js";
import type { Env } from "./types.js";
import { MAX_BODY_BYTES, recordContentKeySeed, validatePayload } from "./validate.js";

const RETENTION_DAYS = 365;

function json(body: unknown, status: number): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

async function handleTelemetry(request: Request, env: Env): Promise<Response> {
	const contentLength = request.headers.get("content-length");
	if (contentLength && Number(contentLength) > MAX_BODY_BYTES) {
		return json({ ok: false, error: "payload too large" }, 413);
	}

	const rawBody = await request.text();
	if (rawBody.length > MAX_BODY_BYTES) {
		return json({ ok: false, error: "payload too large" }, 413);
	}

	const outcome = validatePayload(rawBody);
	if (!outcome.ok || !outcome.payload) {
		return json({ ok: false, error: outcome.error ?? "invalid payload" }, outcome.status);
	}
	const payload = outcome.payload;

	const signature = request.headers.get("x-epoch-signature");
	if (!signature) {
		return json({ ok: false, error: "missing signature" }, 401);
	}
	const expected = await hmacSha256Hex(payload.installation_id, rawBody);
	if (!timingSafeEqualHex(signature, expected)) {
		return json({ ok: false, error: "invalid signature" }, 401);
	}

	const receivedAt = new Date().toISOString();
	const receivedDay = receivedAt.slice(0, 10);

	const todayCount = await countAcceptedToday(env, payload.installation_id, receivedDay);
	const remainingQuota = DAILY_RECORD_CAP_PER_INSTALLATION - todayCount;
	if (remainingQuota <= 0) {
		return json(
			{ ok: false, error: "daily record cap exceeded for installation" },
			429,
		);
	}

	let accepted = 0;
	let deduplicated = 0;

	for (const record of payload.records) {
		if (accepted >= remainingQuota) break;

		const key = await sha256Hex(recordContentKeySeed(payload.installation_id, record));
		if (await keyExists(env, key)) {
			deduplicated += 1;
			continue;
		}

		await insertDedupKey(env, key, receivedAt);
		await insertRecord(env, { payload, record, receivedAt, receivedDay });
		accepted += 1;
	}

	await insertReceipt(env, {
		receivedAt,
		installationId: payload.installation_id,
		schemaVersion: payload.schema_version,
		epochVersion: payload.epoch_version,
		accepted,
		deduplicated,
	});

	return json({ accepted, deduplicated }, 200);
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === "/health") {
			return json({ ok: true, service: "epoch-telemetry", time: new Date().toISOString() }, 200);
		}

		if (request.method === "POST" && url.pathname === "/v1/telemetry") {
			return handleTelemetry(request, env);
		}

		return json({ ok: false, error: "not found" }, 404);
	},

	async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
		const cutoff = new Date(Date.now() - RETENTION_DAYS * 86_400_000).toISOString();
		await purgeOlderThan(env, cutoff);
	},
};
