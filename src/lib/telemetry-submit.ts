import { createHmac } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { getCalibrationData } from "./feedback.js";
import {
	isTelemetryEnabled,
	loadConfig,
	saveConfig,
	getInstallationId,
	isUsableTelemetryEndpoint,
} from "./config.js";

export interface AnonymizedRecord {
	task_type: string;
	complexity: number | null;
	tool: string;
	estimated_hours: number;
	actual_hours: number;
	ratio: number;
	date: string;
}

export interface SubmissionPayload {
	schema_version: 1;
	installation_id: string;
	epoch_version: string;
	records: AnonymizedRecord[];
	generated_at: string;
}

function getVersion(): string {
	try {
		const pkgPath = join(import.meta.dirname, "..", "..", "package.json");
		const raw = readFileSync(pkgPath, "utf-8");
		return JSON.parse(raw).version ?? "unknown";
	} catch {
		return "unknown";
	}
}

function dataDir(): string {
	return process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
}

export function extractAnonymizedRecords(
	sinceDate?: string,
): AnonymizedRecord[] {
	const windowDays = sinceDate
		? Math.ceil((Date.now() - new Date(sinceDate).getTime()) / 86_400_000) + 1
		: undefined;
	const sinceMs = sinceDate ? new Date(sinceDate).getTime() : undefined;

	const historical = getCalibrationData(undefined, undefined, windowDays);

	return historical
		.filter(
			(rec) =>
				sinceMs === undefined || new Date(rec.completedAt).getTime() > sinceMs,
		)
		.filter(
			(rec) => Number.isFinite(rec.estimatedHours) && rec.estimatedHours > 0,
		)
		.filter((rec) => Number.isFinite(rec.actualHours))
		.map(
			(rec): AnonymizedRecord => ({
				task_type: rec.taskType,
				complexity: rec.complexity ?? null,
				tool: rec.tool ?? "unknown",
				estimated_hours: Math.round(rec.estimatedHours * 100) / 100,
				actual_hours: Math.round(rec.actualHours * 100) / 100,
				ratio:
					Math.round((rec.actualHours / rec.estimatedHours) * 10000) / 10000,
				date: rec.completedAt.slice(0, 10),
			}),
		);
}

export function buildPayload(records: AnonymizedRecord[]): SubmissionPayload {
	return {
		schema_version: 1,
		installation_id: getInstallationId(),
		epoch_version: getVersion(),
		records,
		generated_at: new Date().toISOString(),
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

function isTelemetrySubmitRateLimited(lastSubmissionAt: string | null): boolean {
	if (!lastSubmissionAt || shouldBypassTelemetrySubmitInterval()) return false;
	const intervalHours = telemetrySubmitIntervalHours();
	if (intervalHours === 0) return false;
	const hoursSinceLast =
		(Date.now() - new Date(lastSubmissionAt).getTime()) / 3_600_000;
	return hoursSinceLast < intervalHours;
}

export async function submitTelemetry(): Promise<SubmissionResult> {
	const config = loadConfig();

	if (!isTelemetryEnabled()) {
		return { ok: false, recordCount: 0, error: "telemetry not enabled" };
	}

	if (!config.telemetry.endpoint) {
		return { ok: false, recordCount: 0, error: "no endpoint configured" };
	}

	if (!isUsableTelemetryEndpoint(config.telemetry.endpoint)) {
		return {
			ok: false,
			recordCount: 0,
			error: "placeholder endpoint configured",
		};
	}

	const lastSub = config.telemetry.lastSubmissionAt;
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
			const payload = buildPayload(chunk);
			const signature = signPayload(payload, payload.installation_id);
			const response = await fetch(config.telemetry.endpoint, {
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
			config.telemetry.lastSubmissionAt = new Date().toISOString();
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
		!isUsableTelemetryEndpoint(config.telemetry.endpoint)
	)
		return;

	const lastSub = config.telemetry.lastSubmissionAt;
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
