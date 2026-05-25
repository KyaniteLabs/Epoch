// ---------------------------------------------------------------------------
// Tests for src/lib/calibration-factors.ts
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import {
	computeTaskTypeCorrectionFactors,
	computeGlobalCorrectionFactor,
	computeToolTaskCorrectionFactors,
	computeComplexityCorrectionFactors,
	isCorrectionEligibleRecord,
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
