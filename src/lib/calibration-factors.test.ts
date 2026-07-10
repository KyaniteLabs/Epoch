// ---------------------------------------------------------------------------
// Tests for src/lib/calibration-factors.ts
// ---------------------------------------------------------------------------

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
	computeTaskTypeCorrectionFactors,
	computeGlobalCorrectionFactor,
	computeToolTaskCorrectionFactors,
	computeComplexityCorrectionFactors,
	isCorrectionEligibleRecord,
	MIN_RECORDS_PER_FACTOR,
	isPertLearnedCorrectionEnabled,
	loadPertMatchedRecords,
	getPertToolTaskCorrection,
	composePertCorrectionFactor,
	PERT_CORRECTION_RECENCY_DEFAULT,
} from "./calibration-factors.js";
import type { HistoricalRecord } from "../types/index.js";

function makeRecord(
	overrides: Partial<HistoricalRecord> = {},
): HistoricalRecord {
	return {
		taskType: "feature",
		tool: "pert_estimate",
		estimatedHours: 8,
		actualHours: 10,
		completedAt: "2026-01-15",
		...overrides,
	};
}

describe("calibration-factors", () => {
	describe("isCorrectionEligibleRecord", () => {
		it("returns true when calibrationUsage is undefined", () => {
			expect(isCorrectionEligibleRecord(makeRecord())).toBe(true);
		});

		it("returns true when calibrationUsage is 'correction'", () => {
			expect(
				isCorrectionEligibleRecord(
					makeRecord({ calibrationUsage: "correction" }),
				),
			).toBe(true);
		});

		it("returns false when calibrationUsage is 'baseline'", () => {
			expect(
				isCorrectionEligibleRecord(
					makeRecord({ calibrationUsage: "baseline" }),
				),
			).toBe(false);
		});
	});

	describe("computeTaskTypeCorrectionFactors", () => {
		it("returns empty object with no records", () => {
			expect(computeTaskTypeCorrectionFactors([])).toEqual({});
		});

		it("returns empty when fewer than MIN_RECORDS_PER_FACTOR", () => {
			const records = [
				makeRecord({ taskType: "feature", estimatedHours: 8, actualHours: 10 }),
				makeRecord({ taskType: "feature", estimatedHours: 6, actualHours: 7 }),
			];
			const factors = computeTaskTypeCorrectionFactors(records);
			expect(factors).toEqual({});
		});

		it("computes correction factor from median ratios", () => {
			const records = [
				makeRecord({
					taskType: "feature",
					estimatedHours: 10,
					actualHours: 15,
				}),
				makeRecord({
					taskType: "feature",
					estimatedHours: 10,
					actualHours: 20,
				}),
				makeRecord({
					taskType: "feature",
					estimatedHours: 10,
					actualHours: 12,
				}),
			];
			const factors = computeTaskTypeCorrectionFactors(records);
			// median of [1.2, 1.5, 2.0] = 1.5
			expect(factors.feature).toBeCloseTo(1.5, 1);
		});

		it("handles multiple task types independently", () => {
			const records = [
				makeRecord({
					taskType: "feature",
					estimatedHours: 10,
					actualHours: 15,
				}),
				makeRecord({
					taskType: "feature",
					estimatedHours: 10,
					actualHours: 15,
				}),
				makeRecord({
					taskType: "feature",
					estimatedHours: 10,
					actualHours: 15,
				}),
				makeRecord({ taskType: "bugfix", estimatedHours: 4, actualHours: 2 }),
				makeRecord({ taskType: "bugfix", estimatedHours: 4, actualHours: 2 }),
				makeRecord({ taskType: "bugfix", estimatedHours: 4, actualHours: 2 }),
			];
			const factors = computeTaskTypeCorrectionFactors(records);
			expect(factors.feature).toBeDefined();
			expect(factors.bugfix).toBeDefined();
		});

		it("clamps factors to [0.1, 3.0]", () => {
			const records = Array(5)
				.fill(null)
				.map(() =>
					makeRecord({
						taskType: "feature",
						estimatedHours: 1,
						actualHours: 100,
					}),
				);
			const factors = computeTaskTypeCorrectionFactors(records);
			expect(factors.feature).toBeLessThanOrEqual(3.0);
		});
	});

	describe("computeGlobalCorrectionFactor", () => {
		it("returns fallback with no records", () => {
			expect(computeGlobalCorrectionFactor([])).toBe(1.07);
		});

		it("returns custom fallback", () => {
			expect(computeGlobalCorrectionFactor([], 2.0)).toBe(2.0);
		});

		it("computes median ratio across all records", () => {
			const records = [
				makeRecord({ estimatedHours: 10, actualHours: 12 }),
				makeRecord({ estimatedHours: 10, actualHours: 15 }),
				makeRecord({ estimatedHours: 10, actualHours: 20 }),
			];
			const factor = computeGlobalCorrectionFactor(records);
			expect(factor).toBeGreaterThan(1.0);
			expect(factor).toBeLessThanOrEqual(3.0);
		});
	});

	describe("computeToolTaskCorrectionFactors", () => {
		it("returns empty object with no records", () => {
			expect(computeToolTaskCorrectionFactors([])).toEqual({});
		});

		it("groups by tool then task type", () => {
			const records = Array(3)
				.fill(null)
				.map(() =>
					makeRecord({
						tool: "pert_estimate",
						taskType: "feature",
						estimatedHours: 10,
						actualHours: 12,
					}),
				);
			const factors = computeToolTaskCorrectionFactors(records);
			expect(factors.pert_estimate).toBeDefined();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(factors.pert_estimate!.feature).toBeCloseTo(1.2, 1);
		});

		describe("recency weighting", () => {
			it("with no recency option, behaves identically to the pre-recency-weighting default", () => {
				const records = [
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 15, completedAt: "2026-01-01" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-02-01" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 12, completedAt: "2026-03-01" }),
				];
				const withoutRecency = computeToolTaskCorrectionFactors(records);
				const withNoneScheme = computeToolTaskCorrectionFactors(records, { scheme: { kind: "none" } });
				expect(withNoneScheme).toEqual(withoutRecency);
			});

			it("exponential decay weights recent pairs more heavily, shifting the factor toward recent ratios", () => {
				// Old, low-ratio pairs far in the past; recent, high-ratio pairs near asOf.
				const asOf = "2026-06-01T00:00:00.000Z";
				const records = [
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-01" }), // ratio 1.0, ~151d old
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-02" }), // ratio 1.0, ~150d old
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 30, completedAt: "2026-05-31" }), // ratio 3.0, ~1d old
				];
				const unweighted = computeToolTaskCorrectionFactors(records);
				const weighted = computeToolTaskCorrectionFactors(records, { scheme: { kind: "exponential", halfLifeDays: 7 }, asOf });
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				expect(unweighted.pert_estimate!.feature).toBeCloseTo(1.0, 1); // median of [1,1,3] = 1
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				expect(weighted.pert_estimate!.feature).toBeGreaterThan(unweighted.pert_estimate!.feature!); // pulled toward the recent ratio-3.0 pair
			});

			it("hard window excludes pairs older than windowDays", () => {
				const asOf = "2026-06-01T00:00:00.000Z";
				const records = [
					// 3 old pairs (outside a 10-day window), ratio 1.0
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-01" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-02" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-03" }),
					// 3 recent pairs (inside a 10-day window), ratio 2.0
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-05-30" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-05-31" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-06-01" }),
				];
				const windowed = computeToolTaskCorrectionFactors(records, { scheme: { kind: "window", windowDays: 10 }, asOf });
				// Only the 3 recent (ratio 2.0) pairs are within the window, and 3 >= MIN_RECORDS_PER_FACTOR, so no all-history fallback.
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				expect(windowed.pert_estimate!.feature).toBeCloseTo(2.0, 1);
			});

			it("hard window falls back to all-history when the window itself has fewer than MIN_RECORDS_PER_FACTOR pairs", () => {
				const asOf = "2026-06-01T00:00:00.000Z";
				const records = [
					// 3 old pairs (outside a 1-day window), ratio 1.0 — only these exist, so the window will have 0.
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-01" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-02" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 10, completedAt: "2026-01-03" }),
				];
				const windowed = computeToolTaskCorrectionFactors(records, { scheme: { kind: "window", windowDays: 1 }, asOf });
				const unweighted = computeToolTaskCorrectionFactors(records);
				// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
				expect(windowed.pert_estimate!.feature).toBe(unweighted.pert_estimate!.feature);
			});

			it("low-n gate is evaluated on the raw pair count regardless of recency scheme", () => {
				const asOf = "2026-06-01T00:00:00.000Z";
				const records = [
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-05-31" }),
					makeRecord({ tool: "pert_estimate", taskType: "feature", estimatedHours: 10, actualHours: 20, completedAt: "2026-05-31" }),
				]; // only 2 pairs, below MIN_RECORDS_PER_FACTOR (3)
				const weighted = computeToolTaskCorrectionFactors(records, { scheme: { kind: "exponential", halfLifeDays: 7 }, asOf });
				expect(weighted.pert_estimate).toEqual({});
			});
		});
	});

	describe("computeComplexityCorrectionFactors", () => {
		it("returns empty object with no records", () => {
			expect(computeComplexityCorrectionFactors([])).toEqual({});
		});

		it("groups by task type then complexity", () => {
			const records = Array(3)
				.fill(null)
				.map(() =>
					makeRecord({
						taskType: "feature",
						complexity: 3,
						estimatedHours: 10,
						actualHours: 15,
					}),
				);
			const factors = computeComplexityCorrectionFactors(records);
			expect(factors.feature).toBeDefined();
			// eslint-disable-next-line @typescript-eslint/no-non-null-assertion
			expect(factors.feature![3]).toBeDefined();
		});

		it("skips records without complexity", () => {
			const records = Array(3)
				.fill(null)
				.map(() =>
					makeRecord({
						taskType: "feature",
						estimatedHours: 10,
						actualHours: 15,
					}),
				);
			const factors = computeComplexityCorrectionFactors(records);
			// complexity is undefined, so nothing should be grouped
			expect(Object.keys(factors)).toHaveLength(0);
		});
	});
});

// ---------------------------------------------------------------------------
// PERT learned-correction wiring (Phase 1 Task 0)
// ---------------------------------------------------------------------------

describe("isPertLearnedCorrectionEnabled", () => {
	const original = process.env["EPOCH_PERT_LEARNED_CORRECTION"];

	afterEach(() => {
		if (original === undefined) {
			delete process.env["EPOCH_PERT_LEARNED_CORRECTION"];
		} else {
			process.env["EPOCH_PERT_LEARNED_CORRECTION"] = original;
		}
	});

	it("defaults to disabled (unset)", () => {
		delete process.env["EPOCH_PERT_LEARNED_CORRECTION"];
		expect(isPertLearnedCorrectionEnabled()).toBe(false);
	});

	it("is enabled for '1'", () => {
		process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "1";
		expect(isPertLearnedCorrectionEnabled()).toBe(true);
	});

	it("is enabled for 'true'", () => {
		process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "true";
		expect(isPertLearnedCorrectionEnabled()).toBe(true);
	});

	it("is disabled for '0'", () => {
		process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "0";
		expect(isPertLearnedCorrectionEnabled()).toBe(false);
	});

	it("is disabled for any other value", () => {
		process.env["EPOCH_PERT_LEARNED_CORRECTION"] = "yes";
		expect(isPertLearnedCorrectionEnabled()).toBe(false);
	});
});

describe("composePertCorrectionFactor", () => {
	it("REPLACES the profile factor with the learned factor when n >= MIN_RECORDS_PER_FACTOR", () => {
		const result = composePertCorrectionFactor({ factor: 2.0, n: MIN_RECORDS_PER_FACTOR }, 1.8);
		expect(result.factor).toBe(2.0);
		expect(result.source).toBe("learned");
		expect(result.note).toBeUndefined();
	});

	it("never multiplies the learned factor with the profile factor", () => {
		const result = composePertCorrectionFactor({ factor: 2.0, n: 5 }, 1.5);
		expect(result.factor).toBe(2.0);
		expect(result.factor).not.toBe(2.0 * 1.5);
	});

	it("keeps the developer-profile factor unchanged when n < MIN_RECORDS_PER_FACTOR", () => {
		const result = composePertCorrectionFactor({ factor: 2.0, n: 2 }, 1.8);
		expect(result.factor).toBe(1.8);
		expect(result.source).toBe("profile");
		expect(result.note).toBeUndefined();
	});

	it("falls back to a neutral 1.0 with a human-readable low-n note when there is no profile factor", () => {
		const result = composePertCorrectionFactor({ factor: 2.0, n: 1 }, undefined);
		expect(result.factor).toBe(1.0);
		expect(result.source).toBe("default");
		expect(result.note).toBeDefined();
		expect(result.note).toContain("n=1");
		expect(result.note).toContain(`< ${MIN_RECORDS_PER_FACTOR}`);
	});

	it("treats n === MIN_RECORDS_PER_FACTOR as sufficient (boundary)", () => {
		const result = composePertCorrectionFactor({ factor: 1.5, n: MIN_RECORDS_PER_FACTOR }, 1.8);
		expect(result.source).toBe("learned");
	});

	it("treats n === MIN_RECORDS_PER_FACTOR - 1 as insufficient (boundary)", () => {
		const result = composePertCorrectionFactor({ factor: 1.5, n: MIN_RECORDS_PER_FACTOR - 1 }, 1.8);
		expect(result.source).toBe("profile");
	});
});

describe("loadPertMatchedRecords / getPertToolTaskCorrection (ledger integration)", () => {
	let previousDataDir: string | undefined;
	let tempDataDir: string;

	beforeEach(() => {
		previousDataDir = process.env["EPOCH_DATA_DIR"];
		tempDataDir = mkdtempSync(join(tmpdir(), "epoch-pert-correction-test-"));
		process.env["EPOCH_DATA_DIR"] = tempDataDir;
	});

	afterEach(() => {
		if (previousDataDir === undefined) {
			delete process.env["EPOCH_DATA_DIR"];
		} else {
			process.env["EPOCH_DATA_DIR"] = previousDataDir;
		}
		rmSync(tempDataDir, { recursive: true, force: true });
	});

	function writeJsonl(filename: string, records: unknown[]): void {
		writeFileSync(
			join(tempDataDir, filename),
			records.map((r) => JSON.stringify(r)).join("\n") + "\n",
			"utf-8",
		);
	}

	it("returns an empty list when no ledger files exist", () => {
		expect(loadPertMatchedRecords()).toEqual([]);
	});

	it("loads matched pert_estimate pairs and computes the learned factor + n", () => {
		writeJsonl("estimates.jsonl", [
			{ id: "pe-1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T00:00:00.000Z" },
			{ id: "pe-2", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-02T00:00:00.000Z" },
			{ id: "pe-3", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-03T00:00:00.000Z" },
		]);
		writeJsonl("feedback.jsonl", [
			{ estimateId: "pe-1", actualHours: 20, reportedAt: "2026-06-01T01:00:00.000Z" },
			{ estimateId: "pe-2", actualHours: 20, reportedAt: "2026-06-02T01:00:00.000Z" },
			{ estimateId: "pe-3", actualHours: 20, reportedAt: "2026-06-03T01:00:00.000Z" },
		]);

		const records = loadPertMatchedRecords();
		expect(records).toHaveLength(3);
		expect(records.every((r) => r.taskType === "bugfix")).toBe(true);

		const correction = getPertToolTaskCorrection("bugfix");
		expect(correction.n).toBe(3);
		// median ratio of [2.0, 2.0, 2.0] = 2.0
		expect(correction.factor).toBeCloseTo(2.0, 1);
	});

	it("reports n below matched pairs when fewer than MIN_RECORDS_PER_FACTOR are present", () => {
		writeJsonl("estimates.jsonl", [
			{ id: "pe-1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T00:00:00.000Z" },
		]);
		writeJsonl("feedback.jsonl", [
			{ estimateId: "pe-1", actualHours: 20, reportedAt: "2026-06-01T01:00:00.000Z" },
		]);

		const correction = getPertToolTaskCorrection("bugfix");
		expect(correction.n).toBe(1);
		expect(correction.n).toBeLessThan(MIN_RECORDS_PER_FACTOR);
	});

	it("excludes records for tools other than pert_estimate", () => {
		writeJsonl("estimates.jsonl", [
			{ id: "ce-1", tool: "cocomo_estimate", inputs: { task_type: "bugfix" }, outputs: { personMonthsLlmAdjusted: 1 }, estimatedAt: "2026-06-01T00:00:00.000Z" },
		]);
		writeJsonl("feedback.jsonl", [
			{ estimateId: "ce-1", actualHours: 20, reportedAt: "2026-06-01T01:00:00.000Z" },
		]);

		expect(loadPertMatchedRecords()).toEqual([]);
	});

	it("excludes synthetic-id records via the shared exclusion predicate", () => {
		writeJsonl("estimates.jsonl", [
			{ id: "seed-pe-1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T00:00:00.000Z" },
		]);
		writeJsonl("feedback.jsonl", [
			{ estimateId: "seed-pe-1", actualHours: 20, reportedAt: "2026-06-01T01:00:00.000Z" },
		]);

		expect(loadPertMatchedRecords()).toEqual([]);
	});

	it("excludes quarantine-flagged overlay records", () => {
		writeJsonl("estimates.jsonl", [
			{ id: "pe-q1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T00:00:00.000Z" },
		]);
		writeJsonl("feedback.jsonl", [
			{ estimateId: "pe-q1", actualHours: 20, reportedAt: "2026-06-01T01:00:00.000Z" },
		]);
		writeJsonl("estimates.flags.jsonl", [
			{ id: "pe-q1", seq: 1, recordedAt: "2026-06-01T02:00:00.000Z", quarantined: true, reason: "test" },
		]);

		expect(loadPertMatchedRecords()).toEqual([]);
	});

	it("defaults getPertToolTaskCorrection to factor 1.0 with n=0 for an unknown task type", () => {
		const correction = getPertToolTaskCorrection("nonexistent-type");
		expect(correction).toEqual({ factor: 1.0, n: 0 });
	});

	it("PERT_CORRECTION_RECENCY_DEFAULT is 'none' (unweighted) — the backtest found no recency scheme that robustly beats it", () => {
		// Locks in the current default so a future change to the constant is a
		// deliberate, reviewed decision (re-run scripts/backtest-pert-correction.mjs
		// before changing this), not an accidental drift.
		expect(PERT_CORRECTION_RECENCY_DEFAULT).toEqual({ scheme: { kind: "none" } });
	});

	it("getPertToolTaskCorrection with an explicit recency override differs from its default only when the scheme differs", () => {
		writeJsonl("estimates.jsonl", [
			{ id: "pe-1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-01-01T00:00:00.000Z" },
			{ id: "pe-2", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-01-01T00:00:00.000Z" },
			{ id: "pe-3", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: "2026-06-01T00:00:00.000Z" },
		]);
		writeJsonl("feedback.jsonl", [
			{ estimateId: "pe-1", actualHours: 10, reportedAt: "2026-01-01T01:00:00.000Z" },
			{ estimateId: "pe-2", actualHours: 10, reportedAt: "2026-01-01T01:00:00.000Z" },
			{ estimateId: "pe-3", actualHours: 30, reportedAt: "2026-06-01T01:00:00.000Z" },
		]);

		const withDefault = getPertToolTaskCorrection("bugfix");
		const withExplicitNone = getPertToolTaskCorrection("bugfix", { scheme: { kind: "none" } });
		expect(withDefault).toEqual(withExplicitNone); // default IS "none", so these must match

		const withExponential = getPertToolTaskCorrection("bugfix", { scheme: { kind: "exponential", halfLifeDays: 7 }, asOf: "2026-06-01T00:00:00.000Z" });
		expect(withExponential.factor).toBeGreaterThan(withDefault.factor); // pulled toward the recent, higher-ratio pair
	});
});
