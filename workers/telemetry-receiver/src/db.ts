import type { AnonymizedRecord, Env, SubmissionPayload } from "./types.js";

export const DAILY_RECORD_CAP_PER_INSTALLATION = 10_000;

export async function keyExists(env: Env, key: string): Promise<boolean> {
	const row = await env.DB.prepare(
		"SELECT 1 FROM dedup_keys WHERE key = ?1 LIMIT 1",
	)
		.bind(key)
		.first();
	return row !== null;
}

export async function insertDedupKey(
	env: Env,
	key: string,
	receivedAt: string,
): Promise<void> {
	await env.DB.prepare(
		"INSERT OR IGNORE INTO dedup_keys (key, received_at) VALUES (?1, ?2)",
	)
		.bind(key, receivedAt)
		.run();
}

export interface InsertRecordParams {
	payload: SubmissionPayload;
	record: AnonymizedRecord;
	receivedAt: string;
	receivedDay: string;
}

export async function insertRecord(
	env: Env,
	{ payload, record, receivedAt, receivedDay }: InsertRecordParams,
): Promise<void> {
	const isV2 = payload.schema_version === 2;
	await env.DB.prepare(
		`INSERT INTO records (
			installation_id, schema_version, epoch_version,
			client_name, client_version, transport, runtime_hint,
			task_type, complexity, tool, estimated_hours, actual_hours, ratio,
			record_date, completed_at, received_at, received_day
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17)`,
	)
		.bind(
			payload.installation_id,
			payload.schema_version,
			payload.epoch_version,
			isV2 ? payload.client_name : null,
			isV2 ? payload.client_version : null,
			isV2 ? payload.transport : null,
			isV2 ? payload.runtime_hint : null,
			record.task_type,
			record.complexity,
			record.tool,
			record.estimated_hours,
			record.actual_hours,
			record.ratio,
			record.date,
			record.completed_at ?? null,
			receivedAt,
			receivedDay,
		)
		.run();
}

export interface InsertReceiptParams {
	receivedAt: string;
	installationId: string;
	schemaVersion: number;
	epochVersion: string;
	accepted: number;
	deduplicated: number;
}

export async function insertReceipt(
	env: Env,
	{
		receivedAt,
		installationId,
		schemaVersion,
		epochVersion,
		accepted,
		deduplicated,
	}: InsertReceiptParams,
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO receipts (
			received_at, installation_id, schema_version, epoch_version, accepted, deduplicated
		) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
	)
		.bind(
			receivedAt,
			installationId,
			schemaVersion,
			epochVersion,
			accepted,
			deduplicated,
		)
		.run();
}

export async function countAcceptedToday(
	env: Env,
	installationId: string,
	receivedDay: string,
): Promise<number> {
	const row = await env.DB.prepare(
		"SELECT COUNT(*) as c FROM records WHERE installation_id = ?1 AND received_day = ?2",
	)
		.bind(installationId, receivedDay)
		.first<{ c: number }>();
	return row?.c ?? 0;
}

/** Retention sweep: delete staging rows (and their dedup keys) older than the cutoff. */
export async function purgeOlderThan(
	env: Env,
	cutoffIso: string,
): Promise<{ deletedRecords: number; deletedDedupKeys: number }> {
	const recordsResult = await env.DB.prepare(
		"DELETE FROM records WHERE received_at < ?1",
	)
		.bind(cutoffIso)
		.run();
	const dedupResult = await env.DB.prepare(
		"DELETE FROM dedup_keys WHERE received_at < ?1",
	)
		.bind(cutoffIso)
		.run();
	return {
		deletedRecords: recordsResult.meta.changes ?? 0,
		deletedDedupKeys: dedupResult.meta.changes ?? 0,
	};
}
