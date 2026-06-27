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
		const result = assessPromotionGate(runnerSummary(), "canary", {
			currentRustBinarySha256: RUST_BINARY_SHA256,
		});

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

	it("blocks weaker runner summaries for stronger requested targets", () => {
		const result = assessPromotionGate(
			runnerSummary({ target: "canary" }),
			"replace",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("below requested replace");
	});

	it("accepts replacement-target summaries for canary once the strict scorer reaches canary", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				targetReached: false,
				targetSatisfiedBy: null,
				readiness: {
					decision: "CANARY",
					failingGate: "soak",
					rationale: "Ready for canary; still soaking for replacement.",
				},
			}),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict scorer reached canary");
	});

	it("blocks replacement-target summaries for canary until the strict scorer reaches canary", () => {
		const result = assessPromotionGate(
			runnerSummary({
				target: "replace",
				targetReached: false,
				targetSatisfiedBy: null,
				readiness: {
					decision: "SHADOW",
					failingGate: "soak",
					rationale: "Still soaking.",
				},
			}),
			"canary",
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("Readiness decision SHADOW is below CANARY");
	});

	it("blocks missing Rust binary identity", () => {
		const result = assessPromotionGate(
			runnerSummary({ rustBinarySha256: null }),
			"canary",
		);

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("missing the Rust binary SHA-256");
	});

	it("blocks when the current Rust binary does not match soak evidence", () => {
		const result = assessPromotionGate(runnerSummary(), "canary", {
			currentRustBinarySha256:
				"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("does not match soak evidence");
	});

	it("blocks when the current Rust binary hash is unavailable", () => {
		const result = assessPromotionGate(runnerSummary(), "canary", {
			currentRustBinarySha256: null,
		});

		expect(result.ok).toBe(false);
		expect(result.reason).toContain("could not be verified");
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
			{ currentRustBinarySha256: RUST_BINARY_SHA256 },
		);

		expect(result.ok).toBe(true);
		expect(result.reason).toContain("Strict scorer reached replace");
	});
});
