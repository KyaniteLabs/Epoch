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
	loadReferenceClassMatchedRecords,
	getReferenceClassToolTaskCorrection,
	RCE_CORRECTION_RECENCY_DEFAULT,
	weightedMedian,
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

	describe("weightedMedian", () => {
		/** The file's own unweighted median(): average of the two middle values for even n. */
		function median(values: number[]): number {
			const sorted = [...values].sort((a, b) => a - b);
			const mid = Math.floor(sorted.length / 2);
			return sorted.length % 2 === 0
				? ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2
				: (sorted[mid] ?? 0);
		}

		it("equal weights reduce exactly to the unweighted median for even n (W2 parity fix)", () => {
			// Previously the >= half-weight comparison returned the LOWER median
			// (1), diverging from median([1,3]) = 2.
			expect(weightedMedian([{ value: 1, weight: 1 }, { value: 3, weight: 1 }], 0)).toBe(2);
			expect(
				weightedMedian(
					[1, 2, 3, 4].map((v) => ({ value: v, weight: 2 })),
					0,
				),
			).toBe(2.5);
		});

		it("equal weights reduce exactly to the unweighted median for odd n", () => {
			expect(
				weightedMedian([1, 3, 5].map((v) => ({ value: v, weight: 1 })), 0),
			).toBe(3);
		});

		it("equal weights match median() on a deterministic sweep of lengths and orderings", () => {
			for (let n = 1; n <= 17; n += 1) {
				const values = Array.from({ length: n }, (_, i) => ((i * 7) % 11) - 5);
				const wm = weightedMedian(values.map((v) => ({ value: v, weight: 1 })), 0);
				expect(wm).toBe(median(values));
			}
		});

		it("respects weights: a 3:1 split picks the heavier side", () => {
			expect(
				weightedMedian(
					[
						{ value: 1, weight: 3 },
						{ value: 3, weight: 1 },
					],
					0,
				),
			).toBe(1);
			expect(
				weightedMedian(
					[
						{ value: 1, weight: 1 },
						{ value: 3, weight: 3 },
					],
					0,
				),
			).toBe(3);
		});

		it("returns fallback for empty input or all-zero weights", () => {
			expect(weightedMedian([], 1.4)).toBe(1.4);
			expect(
				weightedMedian([{ value: 5, weight: 0 }], 1.4),
			).toBe(1.4);
		});

		it("single item returns its own value", () => {
			expect(weightedMedian([{ value: 5, weight: 0.5 }], 1.4)).toBe(5);
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

// ---------------------------------------------------------------------------
// reference_class_estimate learned-correction wiring (issue #42, wave-2 recency)
//
// Mirrors the PERT suite above through the reference_class path: the loader
// trains on the PRE-correction basis (outputs.rawEstimate), the default
// recency scheme is win60, and the machinery's gates apply unchanged.
// Fixture dates are relative to Date.now() so pairs stay inside the win60
// default window on every run (same convention as estimate-basis.test.ts).
// ---------------------------------------------------------------------------

describe("loadReferenceClassMatchedRecords / getReferenceClassToolTaskCorrection (ledger integration)", () => {
	let previousDataDir: string | undefined;
	let tempDataDir: string;

	beforeEach(() => {
		previousDataDir = process.env["EPOCH_DATA_DIR"];
		tempDataDir = mkdtempSync(join(tmpdir(), "epoch-rce-correction-test-"));
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

	function daysAgo(days: number): string {
		return new Date(Date.now() - days * 86_400_000).toISOString();
	}

	function seedReferenceClassPairs(
		pairs: Array<{
			id: string;
			raw?: number;
			corrected?: number;
			actual: number;
			completedDaysAgo: number;
			taskType?: string;
			team?: string;
			provenance?: string;
			notes?: string;
			outputs?: Record<string, unknown>;
			tool?: string;
		}>,
	): void {
		writeJsonl("estimates.jsonl", pairs.map((p) => ({
			id: p.id,
			tool: p.tool ?? "reference_class_estimate",
			inputs: {
				task_type: p.taskType ?? "bugfix",
				complexity: 3,
				...(p.team !== undefined && { team_id: p.team }),
			},
			outputs: p.outputs ?? {
				rawEstimate: p.raw,
				correctedEstimate: p.corrected ?? Math.round((p.raw ?? 0) * 1.8 * 10) / 10,
				correctionFactor: 1.8,
			},
			estimatedAt: daysAgo(p.completedDaysAgo + 1),
		})));
		writeJsonl("feedback.jsonl", pairs.map((p) => ({
			estimateId: p.id,
			actualHours: p.actual,
			reportedAt: daysAgo(p.completedDaysAgo),
			...(p.provenance !== undefined && { calibrationProvenance: p.provenance }),
			...(p.notes !== undefined && { notes: p.notes }),
		})));
	}

	it("returns an empty list when no ledger files exist", () => {
		expect(loadReferenceClassMatchedRecords()).toEqual([]);
	});

	it("loads matched reference_class pairs and computes the learned factor + n on the PRE-correction (rawEstimate) basis", () => {
		seedReferenceClassPairs([
			{ id: "rce-1", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 5 },
			{ id: "rce-2", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 4 },
			{ id: "rce-3", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 3 },
		]);

		const records = loadReferenceClassMatchedRecords();
		expect(records).toHaveLength(3);
		// estimatedHours is the raw basis, NOT the recorded correctedEstimate (18).
		expect(records.every((r) => r.estimatedHours === 10)).toBe(true);
		expect(records.every((r) => r.taskType === "bugfix" && r.tool === "reference_class_estimate")).toBe(true);

		const correction = getReferenceClassToolTaskCorrection("bugfix");
		expect(correction.n).toBe(3);
		// median of act/rawEstimate ratios [2.0, 2.0, 2.0] = 2.0
		expect(correction.factor).toBeCloseTo(2.0, 1);
	});

	it("basis regression: the learned factor reflects act/rawEstimate ratios, not act/correctedEstimate (the removed feedback loop)", () => {
		// raw 10 → corrected 18 (×1.8); actuals 20. act/raw = 2.0 (what the wave-2
		// wiring trains on); act/corrected = 1.11 (what the removed inline
		// post-correction median trained on — a factor fed its own output).
		seedReferenceClassPairs([
			{ id: "rce-basis-1", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 9 },
			{ id: "rce-basis-2", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 8 },
			{ id: "rce-basis-3", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 7 },
			{ id: "rce-basis-4", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 6 },
			{ id: "rce-basis-5", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 5 },
		]);

		const correction = getReferenceClassToolTaskCorrection("bugfix");
		expect(correction.factor).toBe(2.0); // the old post-correction training would return ~1.11
	});

	it("falls back to correctedEstimate as the basis only for legacy rows without rawEstimate", () => {
		writeJsonl("estimates.jsonl", [1, 2, 3].map((i) => ({
			id: `rce-legacy-${i}`,
			tool: "reference_class_estimate",
			inputs: { task_type: "bugfix", complexity: 3 },
			outputs: { correctedEstimate: 10 }, // legacy shape: no rawEstimate recorded
			estimatedAt: daysAgo(4 + i),
		})));
		writeJsonl("feedback.jsonl", [1, 2, 3].map((i) => ({
			estimateId: `rce-legacy-${i}`,
			actualHours: 20,
			reportedAt: daysAgo(3 + i),
		})));

		const records = loadReferenceClassMatchedRecords();
		expect(records).toHaveLength(3);
		expect(records.every((r) => r.estimatedHours === 10)).toBe(true);
		expect(getReferenceClassToolTaskCorrection("bugfix").factor).toBeCloseTo(2.0, 1);
	});

	it("excludes records for tools other than reference_class_estimate", () => {
		writeJsonl("estimates.jsonl", [
			{ id: "pe-1", tool: "pert_estimate", inputs: { task_type: "bugfix" }, outputs: { expected: 10, unit: "hours" }, estimatedAt: daysAgo(4) },
		]);
		writeJsonl("feedback.jsonl", [
			{ estimateId: "pe-1", actualHours: 20, reportedAt: daysAgo(3) },
		]);

		expect(loadReferenceClassMatchedRecords()).toEqual([]);
	});

	it("excludes synthetic-id records via the shared exclusion predicate", () => {
		seedReferenceClassPairs([
			{ id: "seed-rce-1", raw: 10, actual: 20, completedDaysAgo: 5 },
		]);

		expect(loadReferenceClassMatchedRecords()).toEqual([]);
	});

	it("excludes quarantine-flagged overlay records", () => {
		seedReferenceClassPairs([
			{ id: "rce-q1", raw: 10, actual: 20, completedDaysAgo: 5 },
		]);
		writeJsonl("estimates.flags.jsonl", [
			{ id: "rce-q1", seq: 1, recordedAt: daysAgo(4), quarantined: true, reason: "test" },
		]);

		expect(loadReferenceClassMatchedRecords()).toEqual([]);
	});

	it("does not train on baseline-usage (backfilled) rows or count them as verified", () => {
		seedReferenceClassPairs(
			[1, 2, 3, 4, 5, 6].map((i) => ({
				id: `rce-bf-${i}`,
				raw: 10,
				actual: 25,
				completedDaysAgo: 10 - i,
				provenance: "backfilled_calibration",
			})),
		);

		expect(loadReferenceClassMatchedRecords()).toEqual([]);
		expect(getReferenceClassToolTaskCorrection("bugfix")).toEqual({
			factor: 1.0,
			n: 0,
			counts: { total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 },
		});
	});

	it("normalises legacy/camelCase tool spellings like the old matching path", () => {
		seedReferenceClassPairs(
			[1, 2, 3].map((i) => ({
				id: `rce-alias-${i}`,
				tool: "referenceClassEstimate",
				raw: 10,
				actual: 20,
				completedDaysAgo: 10 - i,
			})),
		);

		expect(loadReferenceClassMatchedRecords()).toHaveLength(3);
		expect(getReferenceClassToolTaskCorrection("bugfix").n).toBe(3);
	});

	it("defaults to factor 1.0 with n=0 for an unknown task type", () => {
		expect(getReferenceClassToolTaskCorrection("nonexistent-type")).toEqual({
			factor: 1.0,
			n: 0,
			counts: { total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 },
		});
	});

	it("rejects present-but-malformed rawEstimate values — the correctedEstimate fallback is reserved for legacy absent-field rows (security review finding 3)", () => {
		// rawEstimate present but invalid (string / null / zero / negative):
		// none of these may silently train on correctedEstimate — that would
		// reintroduce post-correction training for modern malformed rows. The
		// old code produced a learned factor of ~1.11 (median 20/18) here.
		const malformed = [
			{ id: "rce-bad-str", outputs: { rawEstimate: "bad", correctedEstimate: 18, correctionFactor: 1.8 } },
			{ id: "rce-bad-null", outputs: { rawEstimate: null, correctedEstimate: 18, correctionFactor: 1.8 } },
			{ id: "rce-bad-zero", outputs: { rawEstimate: 0, correctedEstimate: 18, correctionFactor: 1.8 } },
			{ id: "rce-bad-neg", outputs: { rawEstimate: -5, correctedEstimate: 18, correctionFactor: 1.8 } },
			{ id: "rce-bad-nan", outputs: { rawEstimate: NaN, correctedEstimate: 18, correctionFactor: 1.8 } },
		];
		seedReferenceClassPairs(malformed.map((m, i) => ({
			id: m.id,
			actual: 20,
			completedDaysAgo: 5 - i,
			outputs: m.outputs,
		})));

		expect(loadReferenceClassMatchedRecords()).toEqual([]);
		const correction = getReferenceClassToolTaskCorrection("bugfix");
		expect(correction.n).toBe(0);
		expect(correction.factor).toBe(1.0);
		expect(correction.counts).toEqual({ total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 });

		// Control: alongside five valid pairs, the malformed rows neither
		// train nor corrupt — the factor stays the valid pairs' median (2.0),
		// not the post-correction ~1.11 the malformed rows would produce.
		seedReferenceClassPairs([
			...malformed.map((m, i) => ({ id: m.id, actual: 20, completedDaysAgo: 15 - i, outputs: m.outputs })),
			{ id: "rce-ok-1", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 5 },
			{ id: "rce-ok-2", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 4 },
			{ id: "rce-ok-3", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 3 },
			{ id: "rce-ok-4", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 2 },
			{ id: "rce-ok-5", raw: 10, corrected: 18, actual: 20, completedDaysAgo: 1 },
		]);
		const mixed = getReferenceClassToolTaskCorrection("bugfix");
		expect(mixed.n).toBe(5);
		expect(mixed.factor).toBe(2.0); // old code: ~1.11 (trained on 18s)
		expect(mixed.counts.total).toBe(5);
	});

	it("preserves the explicit team selector through the loader and the trainer (security review finding 2)", () => {
		seedReferenceClassPairs([
			// six team-b pairs, ratio 2.0 (raw 10 → actual 20), recent
			...[1, 2, 3, 4, 5, 6].map((i) => ({ id: `rce-tb-${i}`, raw: 10, actual: 20, completedDaysAgo: 10 - i, team: "team-b" })),
			// three team-a pairs, ratio 3.0 (raw 10 → actual 30), recent
			...[1, 2, 3].map((i) => ({ id: `rce-ta-${i}`, raw: 10, actual: 30, completedDaysAgo: 10 - i, team: "team-a" })),
			// three unscoped pairs, ratio 1.0
			...[1, 2, 3].map((i) => ({ id: `rce-no-team-${i}`, raw: 10, actual: 10, completedDaysAgo: 10 - i })),
		]);

		const teamB = loadReferenceClassMatchedRecords("team-b");
		expect(teamB).toHaveLength(6);
		expect(teamB.every((r) => r.teamId === "team-b" && r.estimatedHours === 10)).toBe(true);

		const teamA = loadReferenceClassMatchedRecords("team-a");
		expect(teamA).toHaveLength(3);

		// No selector: the intended unscoped behavior — every clean row trains.
		expect(loadReferenceClassMatchedRecords()).toHaveLength(12);

		// Team selectors never cross: team-a's factor reflects team-a's ratio
		// 3.0 (clamped by roundFactor), not team-b's 2.0 — and vice versa.
		expect(getReferenceClassToolTaskCorrection("bugfix", undefined, "team-a")).toEqual({
			factor: 3.0,
			n: 3,
			counts: { total: 3, gitDerived: 0, verified: 3, autoWallclock: 0 },
		});
		expect(getReferenceClassToolTaskCorrection("bugfix", undefined, "team-b").factor).toBeCloseTo(2.0, 1);
		expect(getReferenceClassToolTaskCorrection("bugfix", undefined, "team-c")).toEqual({
			factor: 1.0,
			n: 0,
			counts: { total: 0, gitDerived: 0, verified: 0, autoWallclock: 0 },
		});
		// Unscoped median of [2×6, 3×3, 1×3] = 2.0 over n=12.
		const unscoped = getReferenceClassToolTaskCorrection("bugfix");
		expect(unscoped.n).toBe(12);
		expect(unscoped.factor).toBeCloseTo(2.0, 1);
		expect(unscoped.counts.total).toBe(12);
	});

	it("stamps canonical provenance so counts describe the population that trained the factor (security review finding 1)", () => {
		seedReferenceClassPairs([
			{ id: "rce-prov-git-1", raw: 10, actual: 20, completedDaysAgo: 7, provenance: "git_derived" },
			{ id: "rce-prov-git-2", raw: 10, actual: 20, completedDaysAgo: 6, provenance: "git_derived" },
			{ id: "rce-prov-git-3", raw: 10, actual: 20, completedDaysAgo: 5, provenance: "git_derived" },
			{ id: "rce-prov-git-4", raw: 10, actual: 20, completedDaysAgo: 4, provenance: "git_derived" },
			{ id: "rce-prov-auto-1", raw: 10, actual: 8, completedDaysAgo: 3, provenance: "auto_wallclock" },
			{ id: "rce-prov-auto-2", raw: 10, actual: 8, completedDaysAgo: 3, provenance: "auto_wallclock" },
			{ id: "rce-prov-none-1", raw: 10, actual: 20, completedDaysAgo: 2 }, // unstamped → prospective
			{ id: "rce-prov-none-2", raw: 10, actual: 20, completedDaysAgo: 1 }, // unstamped → prospective
		]);

		const records = loadReferenceClassMatchedRecords();
		expect(records.filter((r) => r.calibrationProvenance === "git_derived")).toHaveLength(4);
		expect(records.filter((r) => r.calibrationProvenance === "auto_wallclock")).toHaveLength(2);
		expect(records.filter((r) => r.calibrationProvenance === "prospective")).toHaveLength(2);
		expect(records.every((r) => r.calibrationUsage === "correction")).toBe(true);

		// counts.total === n: the counts describe exactly the population that
		// trained the factor — the invariant the dispatcher's public
		// calibrationCounts/sampleSize pair now rests on.
		const correction = getReferenceClassToolTaskCorrection("bugfix");
		expect(correction.n).toBe(8);
		expect(correction.counts).toEqual({ total: 8, gitDerived: 4, verified: 2, autoWallclock: 2 });
	});

	it("baseline-usage rows (e.g. 'ingested from' backfills) are held out of the training population and counts", () => {
		// Only usage="correction" rows train the factor, matching the
		// getCalibrationData(..., "correction") population; counts.total === n.
		seedReferenceClassPairs([
			...[1, 2, 3, 4, 5].map((i) => ({ id: `rce-corr-${i}`, raw: 10, actual: 20, completedDaysAgo: 10 - i })),
			{ id: "rce-base-1", raw: 10, actual: 40, completedDaysAgo: 3, notes: "ingested from external tracker" },
			{ id: "rce-base-2", raw: 10, actual: 40, completedDaysAgo: 2, notes: "ingested from external tracker" },
		]);

		const correction = getReferenceClassToolTaskCorrection("bugfix");
		expect(correction.n).toBe(5);
		expect(correction.counts).toEqual({ total: 5, gitDerived: 0, verified: 5, autoWallclock: 0 });
		expect(correction.factor).toBe(2.0);
	});

	it("RCE_CORRECTION_RECENCY_DEFAULT is win60 — the only recency-grid member in band on BOTH the all-pairs and trailing-20% views (issue #42 replay)", () => {
		// Locks in the current default so a future change to the constant is a
		// deliberate, reviewed decision (re-run the rolling replay on the live
		// ledger before changing this — win60 measured 0.833 all-pairs / 1.200
		// trailing-20%, both in the [0.8, 1.2] band; every scheme on the
		// post-correction basis measured 0.505–0.526), not an accidental drift.
		expect(RCE_CORRECTION_RECENCY_DEFAULT).toEqual({ scheme: { kind: "window", windowDays: 60 } });
	});

	it("win60 default shifts the factor toward in-window pairs when enough of them exist (vs unweighted all-history)", () => {
		seedReferenceClassPairs([
			// 3 old pairs (ratio 1.0, ~8 months old — outside the 60d window)
			{ id: "rce-old-1", raw: 10, actual: 10, completedDaysAgo: 242 },
			{ id: "rce-old-2", raw: 10, actual: 10, completedDaysAgo: 241 },
			{ id: "rce-old-3", raw: 10, actual: 10, completedDaysAgo: 240 },
			// 3 recent pairs (ratio 2.0, inside the window)
			{ id: "rce-new-1", raw: 10, actual: 20, completedDaysAgo: 5 },
			{ id: "rce-new-2", raw: 10, actual: 20, completedDaysAgo: 4 },
			{ id: "rce-new-3", raw: 10, actual: 20, completedDaysAgo: 3 },
		]);

		const win60 = getReferenceClassToolTaskCorrection("bugfix"); // the default
		const unweighted = getReferenceClassToolTaskCorrection("bugfix", { scheme: { kind: "none" } });
		// The window holds 3 pairs (>= MIN_RECORDS_PER_FACTOR), so no min-n
		// fallback: the factor is the median of the recent ratio-2.0 pairs only.
		expect(win60.factor).toBeCloseTo(2.0, 1);
		// Unweighted median of [1, 1, 1, 2, 2, 2] = 1.5.
		expect(unweighted.factor).toBeCloseTo(1.5, 1);
		expect(win60.factor).toBeGreaterThan(unweighted.factor);
	});

	it("win60 falls back to all-history when the window itself has fewer than MIN_RECORDS_PER_FACTOR pairs", () => {
		seedReferenceClassPairs([
			// Only old pairs exist; the 60d window around "now" contains none of
			// them (0 < MIN_RECORDS_PER_FACTOR), so the cell falls back to its
			// all-history median.
			{ id: "rce-old-1", raw: 10, actual: 10, completedDaysAgo: 242 },
			{ id: "rce-old-2", raw: 10, actual: 10, completedDaysAgo: 241 },
			{ id: "rce-old-3", raw: 10, actual: 10, completedDaysAgo: 240 },
		]);

		const win60 = getReferenceClassToolTaskCorrection("bugfix");
		const unweighted = getReferenceClassToolTaskCorrection("bugfix", { scheme: { kind: "none" } });
		expect(win60.factor).toBe(unweighted.factor);
		expect(win60.factor).toBeCloseTo(1.0, 1);
	});

	it("exponential decay shifts the factor toward recent pairs (explicit recency override)", () => {
		seedReferenceClassPairs([
			{ id: "rce-old-1", raw: 10, actual: 10, completedDaysAgo: 151 },
			{ id: "rce-old-2", raw: 10, actual: 10, completedDaysAgo: 150 },
			{ id: "rce-new-1", raw: 10, actual: 30, completedDaysAgo: 1 },
		]);

		const unweighted = getReferenceClassToolTaskCorrection("bugfix", { scheme: { kind: "none" } });
		const weighted = getReferenceClassToolTaskCorrection("bugfix", {
			scheme: { kind: "exponential", halfLifeDays: 7 },
			asOf: daysAgo(0),
		});
		expect(unweighted.factor).toBeCloseTo(1.0, 1); // median of [1, 1, 3] = 1
		expect(weighted.factor).toBeGreaterThan(unweighted.factor); // pulled toward the recent ratio-3.0 pair
	});

	it("low-n gate is evaluated on the raw pair count: below MIN_RECORDS_PER_FACTOR there is no learned factor", () => {
		seedReferenceClassPairs([
			{ id: "rce-1", raw: 10, actual: 20, completedDaysAgo: 5 },
			{ id: "rce-2", raw: 10, actual: 20, completedDaysAgo: 4 },
		]);

		const correction = getReferenceClassToolTaskCorrection("bugfix");
		expect(correction.n).toBe(2);
		expect(correction.n).toBeLessThan(MIN_RECORDS_PER_FACTOR);
		// No cell emitted → neutral default; callers gate on n before use.
		expect(correction.factor).toBe(1.0);
	});
});
