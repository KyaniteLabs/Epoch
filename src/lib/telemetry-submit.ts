import { createHmac } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync } from "node:fs";
import { getCalibrationData } from "./feedback.js";
import { readPackageVersion } from "../version.js";
import {
	isTelemetryEnabled,
	loadConfig,
	saveConfig,
	getInstallationId,
	isPlaceholderTelemetryEndpoint,
	resolveTelemetryEndpoint,
} from "./config.js";
import {
	computeRuntimeHint,
	getMcpClientInfo,
	getTransport,
	type RuntimeHint,
	type Transport,
} from "./telemetry-context.js";

export interface AnonymizedRecord {
	task_type: string;
	complexity: number | null;
	tool: string;
	estimated_hours: number;
	actual_hours: number;
	ratio: number;
	date: string;
	/**
	 * Full-precision local timestamp used ONLY as the submission cursor.
	 * NEVER transmitted: buildPayload() strips it so no time-of-day leaves
	 * the machine (the wire carries date-only `date`), keeping the
	 * PRIVACY.md/TELEMETRY.md "no time-of-day" promise.
	 */
	completed_at: string;
}

/** The record shape actually transmitted — completed_at is stripped. */
export type WireAnonymizedRecord = Omit<AnonymizedRecord, "completed_at">;

/** schema_version 1 payload — still accepted by all receivers. */
export interface SubmissionPayloadV1 {
	schema_version: 1;
	installation_id: string;
	epoch_version: string;
	records: WireAnonymizedRecord[];
	generated_at: string;
}

/**
 * schema_version 2 payload — adds agent-qualification fields at the payload
 * level (per-record fields are unchanged; see docs/TELEMETRY.md). All new
 * fields are nullable: null for CLI/HTTP callers or when the client did not
 * report an MCP `clientInfo`.
 */
export interface SubmissionPayloadV2 {
	schema_version: 2;
	installation_id: string;
	epoch_version: string;
	records: WireAnonymizedRecord[];
	generated_at: string;
	client_name: string | null;
	client_version: string | null;
	transport: Transport | null;
	runtime_hint: RuntimeHint;
}

export type SubmissionPayload = SubmissionPayloadV1 | SubmissionPayloadV2;

let _cachedVersion: string | undefined;

/**
 * Ticket 19: dist-safe version resolution. The old hand-rolled reader
 * joined `../../package.json` off this module — correct from `src/lib/`
 * (dev/tsx) but wrong once tsup inlines this module into `dist/*.js`, where
 * the package.json is only ONE hop up, so installed builds silently reported
 * "unknown". The depth chain [2, 1] resolves both layouts; per the
 * src/version.ts contract there is no "unknown" fallback — a missing
 * version throws (caught by submitTelemetry's chunk loop) instead of lying
 * in the payload.
 */
function getVersion(): string {
	_cachedVersion ??= readPackageVersion([2, 1], import.meta.url);
	return _cachedVersion;
}

function dataDir(): string {
	return process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
}

export function extractAnonymizedRecords(
	sinceDate?: string,
): AnonymizedRecord[] {
	// Ticket 19: a corrupt submission cursor must neither wedge extraction
	// (Date.parse garbage -> NaN -> the old Math.ceil(NaN) windowDays made
	// matchEstimatesToActuals throw RangeError on Invalid Date.toISOString())
	// nor silently NaN-filter out every record (NaN > sinceMs is always
	// false). Unparsable cursors are treated as "no cursor".
	const parsedSinceMs = sinceDate !== undefined ? Date.parse(sinceDate) : NaN;
	const sinceMs = Number.isFinite(parsedSinceMs) ? parsedSinceMs : undefined;
	const windowDays = sinceMs !== undefined
		? Math.ceil((Date.now() - sinceMs) / 86_400_000) + 1
		: undefined;

	const historical = getCalibrationData(undefined, undefined, windowDays);

	return historical
		.filter((rec) => {
			// Ticket 19: filter non-parsable/empty completedAt AT EXTRACTION.
			// A single malformed ledger row used to make
			// new Date(rec.completedAt).toISOString() below throw RangeError,
			// wedging the first-ever submission (the cursor never advances
			// past a record that can never be extracted successfully).
			const completedMs = Date.parse(rec.completedAt);
			return (
				Number.isFinite(completedMs) &&
				(sinceMs === undefined || completedMs > sinceMs)
			);
		})
		.filter(
			(rec) => Number.isFinite(rec.estimatedHours) && rec.estimatedHours > 0,
		)
		.filter((rec) => Number.isFinite(rec.actualHours))
		.map((rec): AnonymizedRecord => {
			const completedMs = Date.parse(rec.completedAt);
			const completedIso = new Date(completedMs).toISOString();
			return {
				task_type: rec.taskType,
				complexity: rec.complexity ?? null,
				tool: rec.tool ?? "unknown",
				estimated_hours: Math.round(rec.estimatedHours * 100) / 100,
				actual_hours: Math.round(rec.actualHours * 100) / 100,
				ratio:
					Math.round((rec.actualHours / rec.estimatedHours) * 10000) / 10000,
				date: completedIso.slice(0, 10),
				completed_at: completedIso,
			};
		});
}

export function buildPayload(records: AnonymizedRecord[]): SubmissionPayload {
	const wireRecords: WireAnonymizedRecord[] = records.map(
		({ completed_at: _localCursorOnly, ...wire }) => wire,
	);
	const clientInfo = getMcpClientInfo();
	return {
		schema_version: 2,
		installation_id: getInstallationId(),
		epoch_version: getVersion(),
		records: wireRecords,
		generated_at: new Date().toISOString(),
		client_name: clientInfo.name,
		client_version: clientInfo.version,
		transport: getTransport(),
		runtime_hint: computeRuntimeHint(),
	};
}

export function signPayload(
	payload: SubmissionPayload,
	installationId: string,
): string {
	const data = JSON.stringify(payload, null, 0);
	return createHmac("sha256", installationId).update(data).digest("hex");
}

export interface SubmissionResult {
	ok: boolean;
	recordCount: number;
	accepted?: number;
	deduplicated?: number;
	error?: string;
}

function receiverCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
		? value
		: undefined;
}

function telemetrySubmitIntervalHours(): number {
	const raw = process.env["EPOCH_TELEMETRY_SUBMIT_INTERVAL_HOURS"]?.trim();
	if (raw === undefined || raw === "") return 1;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed < 0) return 1;
	return parsed;
}

function shouldBypassTelemetrySubmitInterval(): boolean {
	const raw = process.env["EPOCH_TELEMETRY_SUBMIT_FORCE"]?.trim().toLowerCase();
	return raw === "1" || raw === "true" || raw === "yes";
}

function isTelemetrySubmitRateLimited(
	lastSubmissionAt: string | null,
): boolean {
	if (!lastSubmissionAt || shouldBypassTelemetrySubmitInterval()) return false;
	const intervalHours = telemetrySubmitIntervalHours();
	if (intervalHours === 0) return false;
	const hoursSinceLast =
		(Date.now() - new Date(lastSubmissionAt).getTime()) / 3_600_000;
	return hoursSinceLast < intervalHours;
}

/**
 * Ticket 19: validate the cursor when read. A corrupt lastSubmissionAt
 * (manually edited config, partial write) must never wedge or NaN-poison
 * submission math — unparsable values are treated as "never submitted",
 * which resubmits (the receiver deduplicates) instead of silently dropping
 * the entire backlog.
 */
function sanitizedLastSubmissionAt(last: string | null): string | null {
	if (!last) return null;
	return Number.isFinite(Date.parse(last)) ? last : null;
}

export async function submitTelemetry(): Promise<SubmissionResult> {
	const config = loadConfig();

	if (!isTelemetryEnabled()) {
		return { ok: false, recordCount: 0, error: "telemetry not enabled" };
	}

	if (isPlaceholderTelemetryEndpoint(config.telemetry.endpoint)) {
		return {
			ok: false,
			recordCount: 0,
			error: "placeholder endpoint configured",
		};
	}
	const endpoint = resolveTelemetryEndpoint(config);

	const lastSub = sanitizedLastSubmissionAt(config.telemetry.lastSubmissionAt);
	if (isTelemetrySubmitRateLimited(lastSub)) {
		return {
			ok: false,
			recordCount: 0,
			error: `rate limited: less than ${telemetrySubmitIntervalHours()} hour(s) since last submission`,
		};
	}

	const records = extractAnonymizedRecords(lastSub ?? undefined);
	if (records.length === 0) {
		return { ok: false, recordCount: 0, error: "no new records to submit" };
	}

	let submitted = 0;
	let accepted = 0;
	let deduplicated = 0;

	try {
		for (let offset = 0; offset < records.length; offset += 100) {
			const chunk = records.slice(offset, offset + 100);
			const chunkCursor = chunk.at(-1)?.completed_at;
			const payload = buildPayload(chunk);
			const signature = signPayload(payload, payload.installation_id);
			const response = await fetch(endpoint, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Epoch-Signature": signature,
					"X-Epoch-Version": payload.epoch_version,
				},
				body: JSON.stringify(payload),
			});

			if (!response.ok) {
				const detail = await response.text().catch(() => "");
				const suffix = detail.trim().slice(0, 200);
				return {
					ok: false,
					recordCount: submitted,
					accepted,
					deduplicated,
					error: suffix
						? `server returned ${response.status}: ${suffix}`
						: `server returned ${response.status}`,
				};
			}

			let chunkAccepted = chunk.length;
			let chunkDeduplicated = 0;
			try {
				const body = (await response.json()) as Record<string, unknown>;
				chunkAccepted = receiverCount(body["accepted"]) ?? chunkAccepted;
				chunkDeduplicated =
					receiverCount(body["deduplicated"]) ?? chunkDeduplicated;
			} catch {
				// Older receivers returned an empty 200 body; keep legacy submitted-count accounting.
			}

			submitted += chunk.length;
			accepted += chunkAccepted;
			deduplicated += chunkDeduplicated;

			config.telemetry.installationId = payload.installation_id;
			if (chunkCursor) {
				config.telemetry.lastSubmissionAt = chunkCursor;
			}
			config.telemetry.lastSubmissionRecordCount += chunk.length;
			config.telemetry.lastSubmissionAcceptedCount = accepted;
			config.telemetry.lastSubmissionDeduplicatedCount = deduplicated;
			config.telemetry.totalRecordsAccepted =
				(config.telemetry.totalRecordsAccepted ?? 0) + chunkAccepted;
			config.telemetry.totalRecordsDeduplicated =
				(config.telemetry.totalRecordsDeduplicated ?? 0) + chunkDeduplicated;
			saveConfig(config);
		}

		return { ok: true, recordCount: submitted, accepted, deduplicated };
	} catch (err) {
		const message = err instanceof Error ? err.message : "network error";
		return { ok: false, recordCount: 0, error: message };
	}
}

let _callCount = 0;

export function maybeSubmitTelemetry(): void {
	_callCount++;
	if (_callCount % 100 !== 0) return;

	const config = loadConfig();
	if (
		!isTelemetryEnabled() ||
		isPlaceholderTelemetryEndpoint(config.telemetry.endpoint)
	)
		return;

	const lastSub = sanitizedLastSubmissionAt(config.telemetry.lastSubmissionAt);
	if (isTelemetrySubmitRateLimited(lastSub)) return;

	submitTelemetry().catch(() => {
		/* non-critical, silent */
	});
}

export function resetCallCount(): void {
	_callCount = 0;
}

export function exportToFile(filename?: string): string {
	const records = extractAnonymizedRecords();
	const dir = join(dataDir(), "exports");
	mkdirSync(dir, { recursive: true });
	const outputPath =
		filename ??
		join(dir, `epoch-export-${new Date().toISOString().slice(0, 10)}.json`);
	writeFileSync(outputPath, JSON.stringify(records, null, 2), "utf-8");
	return outputPath;
}
