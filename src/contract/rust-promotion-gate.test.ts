import { describe, expect, it } from "vitest";
import { assessPromotionGate } from "./rust-promotion-gate.js";

const RUST_BINARY_SHA256 =
	"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function runnerSummary(overrides: Record<string, unknown> = {}) {
	return {
		target: "canary",
		targetHoursSource: "default",
		targetReached: true,
		targetSatisfiedBy: "scorer",
		smokeTargetReached: false,
		releaseTag: "candidate-1",
		rustBinarySha256: RUST_BINARY_SHA256,
		readiness: {
			decision: "CANARY",
			failingGate: "compatibility",
			rationale: "Ready for canary.",
		},
		...overrides,
	};
}

describe("assessPromotionGate", () => {
	it("passes when strict scorer reached the canary target", () => {
		const result = assessPromotionGate(runnerSummary(), "canary");

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict scorer reached canary");
	});

	it("blocks smoke target overrides even when the smoke path completed", () => {
		const result = assessPromotionGate(
			runnerSummary({
				targetHoursSource: "override",
				targetReached: false,
				targetSatisfiedBy: null,
				smokeTargetReached: true,
				readiness: {
					decision: "SHADOW",
					failingGate: "soak",
					rationale: "Smoke only.",
				},
			}),
			"canary",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("smoke target override");
	});

	it("blocks target mismatches", () => {
		const result = assessPromotionGate(
			runnerSummary({ target: "canary" }),
			"replace",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("not replace");
	});

	it("blocks missing Rust binary identity", () => {
		const result = assessPromotionGate(
			runnerSummary({ rustBinarySha256: null }),
			"canary",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("missing the Rust binary SHA-256");
	});

	it("blocks replacement without a release tag", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				releaseTag: null,
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("release-tagged");
	});

	it("passes replacement when strict scorer and release evidence agree", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				readiness: {
					decision: "REPLACE",
					failingGate: null,
					rationale: "Ready for replacement.",
				},
			}),
			"replace",
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict scorer reached replace");
	});
});
