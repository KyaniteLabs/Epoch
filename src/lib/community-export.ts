// ---------------------------------------------------------------------------
// Epoch Community Export — Build community-data-compatible export files
// ---------------------------------------------------------------------------

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createHmac } from "node:crypto";
import { extractAnonymizedRecords } from "./telemetry-submit.js";
import { getInstallationId } from "./config.js";

// ---- Types ------------------------------------------------------------------

const VALID_TASK_TYPES = [
	"feature",
	"bugfix",
	"refactor",
	"migration",
	"infrastructure",
	"documentation",
	"testing",
	"design",
] as const;

type ValidTaskType = (typeof VALID_TASK_TYPES)[number];

export interface CommunityEstimationRecord {
	estimated_hours: number;
	actual_hours: number;
	task_type: ValidTaskType;
	complexity: number;
	timestamp: string;
	contributor_id?: string;
	/**
	 * Optional basis-era label (ticket 11, estimate-basis unification):
	 * 1 = legacy row (pre-unification), 2 = post-unification row
	 * (displayed estimate == recorded estimate). `estimated_hours` is
	 * ALWAYS the ledger-recorded basis in both eras; this label lets
	 * consumers keep v1/v2 ratio populations split. Not emitted by the
	 * local exporter (the anonymized extraction path does not carry the
	 * row stamp), but accepted on import so contributors can supply it —
	 * dual labeled fields per the PRD, for one minor version.
	 */
	estimate_basis_version?: 1 | 2;
}

export interface CommunityEstimationDataset {
	_schema: "estimation-record";
	description: string;
	records: CommunityEstimationRecord[];
}

export interface SkippedCounts {
	missingComplexity: number;
	invalidTaskType: number;
	invalidHours: number;
}

export interface CommunityExportResult {
	dataset: CommunityEstimationDataset;
	skipped: SkippedCounts;
}

export interface CommunityWriteResult {
	path: string;
	recordCount: number;
	skipped: SkippedCounts;
}

export interface CommunityValidationResult {
	valid: boolean;
	errors: string[];
}

// ---- Helpers ----------------------------------------------------------------

function dataDir(): string {
	return process.env["EPOCH_DATA_DIR"] ?? join(homedir(), ".epoch");
}

/** Deterministic pseudonym from installation ID */
function pseudonymizeContributorId(installationId: string): string {
	return createHmac("sha256", "epoch-community")
		.update(installationId)
		.digest("hex")
		.slice(0, 16);
}

// ---- Core export logic ------------------------------------------------------

export function buildCommunityEstimationDataset(options: {
	description: string;
	contributorId?: string;
	defaultComplexity?: number;
}): CommunityExportResult {
	const rawRecords = extractAnonymizedRecords();
	const skipped: SkippedCounts = {
		missingComplexity: 0,
		invalidTaskType: 0,
		invalidHours: 0,
	};

	const records: CommunityEstimationRecord[] = [];

	for (const raw of rawRecords) {
		// Validate task_type
		const taskType = raw.task_type as string;
		if (!VALID_TASK_TYPES.includes(taskType as ValidTaskType)) {
			skipped.invalidTaskType++;
			continue;
		}

		// Validate complexity
		let complexity: number | null = raw.complexity;
		if (complexity === null || complexity === undefined) {
			if (options.defaultComplexity !== undefined) {
				complexity = options.defaultComplexity;
			} else {
				skipped.missingComplexity++;
				continue;
			}
		}

		// Validate complexity is integer 1-5
		if (!Number.isInteger(complexity) || complexity < 1 || complexity > 5) {
			skipped.missingComplexity++;
			continue;
		}

		// Validate hours
		if (
			!Number.isFinite(raw.estimated_hours) ||
			raw.estimated_hours <= 0 ||
			!Number.isFinite(raw.actual_hours) ||
			raw.actual_hours < 0
		) {
			skipped.invalidHours++;
			continue;
		}

		// Build record — no notes, source, teamId, project, tool, ratio, or time-of-day
		const record: CommunityEstimationRecord = {
			estimated_hours: Math.round(raw.estimated_hours * 100) / 100,
			actual_hours: Math.round(raw.actual_hours * 100) / 100,
			task_type: taskType as ValidTaskType,
			complexity,
			timestamp: `${raw.date}T00:00:00Z`,
		};

		if (options.contributorId) {
			record.contributor_id = options.contributorId;
		}

		records.push(record);
	}

	return {
		dataset: {
			_schema: "estimation-record",
			description: options.description,
			records,
		},
		skipped,
	};
}

// ---- Write to file ----------------------------------------------------------

export function writeCommunityEstimationDataset(options: {
	output?: string;
	description: string;
	contributorId?: string;
	defaultComplexity?: number;
}): CommunityWriteResult {
	// Derive contributor ID from installation ID if not provided
	let contributorId = options.contributorId;
	if (!contributorId) {
		try {
			const instId = getInstallationId();
			if (instId) {
				contributorId = pseudonymizeContributorId(instId);
			}
		} catch {
			// No installation ID available — omit contributor_id
		}
	}

	const { dataset, skipped } = buildCommunityEstimationDataset({
		description: options.description,
		contributorId,
		defaultComplexity: options.defaultComplexity,
	});

	if (dataset.records.length === 0) {
		throw new Error(
			"No exportable records found. Use Epoch for a few tasks with actual-hour feedback, then run this again.",
		);
	}

	const dir = join(dataDir(), "exports");
	mkdirSync(dir, { recursive: true });
	const outputPath =
		options.output ??
		join(
			dir,
			`epoch-community-estimation-${new Date().toISOString().slice(0, 10)}.json`,
		);

	writeFileSync(outputPath, JSON.stringify(dataset, null, 2), "utf-8");

	return {
		path: outputPath,
		recordCount: dataset.records.length,
		skipped,
	};
}

// ---- Validation -------------------------------------------------------------

/**
 * Validate a community export file against the estimation-record schema rules.
 * Uses the same rules as scripts/validate-community-data.mjs but without
 * requiring a repo checkout.
 */
export function validateCommunityExport(
	filePath: string,
): CommunityValidationResult {
	const errors: string[] = [];

	if (!existsSync(filePath)) {
		return { valid: false, errors: [`File not found: ${filePath}`] };
	}

	let data: unknown;
	try {
		data = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
	} catch (err) {
		return {
			valid: false,
			errors: [
				`Invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
			],
		};
	}

	// Top-level structure
	if (typeof data !== "object" || data === null) {
		return { valid: false, errors: ["Top-level must be an object"] };
	}

	const obj = data as Record<string, unknown>;

	if (obj._schema !== "estimation-record") {
		errors.push(`Missing or invalid _schema: expected "estimation-record"`);
	}

	if (!Array.isArray(obj.records)) {
		errors.push('Missing or invalid "records": expected an array');
		return { valid: false, errors };
	}

	// Validate each record
	const records = obj.records as Record<string, unknown>[];
	const allowedKeys = new Set([
		"estimated_hours",
		"actual_hours",
		"task_type",
		"complexity",
		"timestamp",
		"contributor_id",
		"estimate_basis_version",
		"team_size",
		"model_used",
		"tokens_used",
		"tool_calls",
		"reasoning_depth",
		"sprint_length_days",
	]);

	for (let i = 0; i < records.length; i++) {
		const rec = records[i];
		if (!rec) {
			errors.push(`Record ${i}: null or undefined`);
			continue;
		}

		// Required fields
		for (const field of [
			"estimated_hours",
			"actual_hours",
			"task_type",
			"complexity",
			"timestamp",
		]) {
			if (rec[field] === undefined || rec[field] === null) {
				errors.push(`Record ${i}: missing required field "${field}"`);
			}
		}

		// Disallowed fields
		for (const key of Object.keys(rec)) {
			if (!allowedKeys.has(key)) {
				errors.push(`Record ${i}: unknown field "${key}"`);
			}
		}

		// Type checks
		const estimatedHours = rec["estimated_hours"];
		if (
			typeof estimatedHours !== "number" ||
			!Number.isFinite(estimatedHours)
		) {
			errors.push(`Record ${i}: estimated_hours must be a number`);
		} else if (estimatedHours < 0.1) {
			errors.push(`Record ${i}: estimated_hours must be >= 0.1`);
		}

		const actualHours = rec["actual_hours"];
		if (typeof actualHours !== "number" || !Number.isFinite(actualHours)) {
			errors.push(`Record ${i}: actual_hours must be a number`);
		} else if (actualHours < 0) {
			errors.push(`Record ${i}: actual_hours must be >= 0`);
		}

		const complexityVal = rec["complexity"];
		if (typeof complexityVal !== "number" || !Number.isFinite(complexityVal)) {
			errors.push(`Record ${i}: complexity must be an integer 1-5`);
		} else if (
			!Number.isInteger(complexityVal) ||
			complexityVal < 1 ||
			complexityVal > 5
		) {
			errors.push(`Record ${i}: complexity must be an integer 1-5`);
		}

		const taskTypeVal = rec["task_type"];
		if (typeof taskTypeVal !== "string") {
			errors.push(`Record ${i}: task_type must be a string`);
		} else if (!VALID_TASK_TYPES.includes(taskTypeVal as ValidTaskType)) {
			errors.push(
				`Record ${i}: task_type "${
					taskTypeVal
				}" is not one of: ${VALID_TASK_TYPES.join(", ")}`,
			);
		}

		const timestampVal = rec["timestamp"];
		if (typeof timestampVal !== "string") {
			errors.push(`Record ${i}: timestamp must be a valid ISO date-time`);
		} else if (isNaN(Date.parse(timestampVal))) {
			errors.push(`Record ${i}: timestamp must be a valid ISO date-time`);
		}

		// Optional basis-era label (ticket 11): when present it must be a
		// valid era integer; absent is always fine (legacy/unknown).
		const basisVersionVal = rec["estimate_basis_version"];
		if (
			basisVersionVal !== undefined &&
			(typeof basisVersionVal !== "number" ||
				!Number.isInteger(basisVersionVal) ||
				(basisVersionVal !== 1 && basisVersionVal !== 2))
		) {
			errors.push(`Record ${i}: estimate_basis_version must be the integer 1 or 2 when present`);
		}
	}

	return { valid: errors.length === 0, errors };
}
