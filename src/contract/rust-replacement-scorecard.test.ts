import { describe, expect, it } from "vitest";

import type { ReplacementScorecard } from "./rust-deploy-readiness.js";
import { formatReplacementScorecard } from "./rust-replacement-scorecard.js";

describe("formatReplacementScorecard", () => {
	it("renders the replacement verdict and quantified proof metrics", () => {
		const rendered = formatReplacementScorecard({
			generatedAt: "2026-06-27T00:00:00.000Z",
			decision: "CANARY",
			failingGate: "soak",
			readyToReplace: false,
			functionalCompatibilityPercent: 100,
			replacementGatePassPercent: 90.909090909,
			gatesPassed: 20,
			gatesTotal: 22,
			categories: {
				compatibility: [],
				performance: [],
				reliability: [],
				deploy: [],
			},
			summary: {
				outputParityPercent: 100,
				errorCompatibilityPercent: 100,
				unclassifiedFailures: 0,
				medianLatencyImprovementPercent: 93.2,
				p95LatencyImprovementPercent: 87.1,
				startupImprovementPercent: 12,
				memoryImprovementPercent: 3,
				continuousSoakHours: 1,
				requiredContinuousSoakHours: 72,
			},
		} satisfies ReplacementScorecard);

		expect(rendered).toContain("verdict:                  BLOCKED");
		expect(rendered).toContain("readiness decision:       CANARY");
		expect(rendered).toContain("first blocker:            soak");
		expect(rendered).toContain("functional compatibility: 100.00%");
		expect(rendered).toContain("replacement gates:        20/22 (90.91%)");
		expect(rendered).toContain("median improvement:       93.20%");
		expect(rendered).toContain("continuous soak:          1.0000h/72h");
	});
});
