import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

describe("rust-promotion-packet CLI", () => {
	it("writes an interim replacement scorecard before long shadow soak", () => {
		const source = readFileSync(
			resolve(REPO_ROOT, "scripts/rust-promotion-packet.ts"),
			"utf8",
		);
		const packageSmokeIndex = source.indexOf("writeJson(packageSmokePath");
		const interimScorecardIndex = source.indexOf(
			"writeInterimReplacementScorecard(replacementScorecardPath",
		);
		const shadowSoakIndex = source.indexOf('"shadow soak evidence"');
		const rollbackIndex = source.indexOf('"rollback rehearsal"');
		const finalScorecardIndex = source.lastIndexOf(
			"writeJson(replacementScorecardPath",
		);

		expect(packageSmokeIndex).toBeGreaterThan(-1);
		expect(interimScorecardIndex).toBeGreaterThan(packageSmokeIndex);
		expect(shadowSoakIndex).toBeGreaterThan(interimScorecardIndex);
		expect(rollbackIndex).toBeGreaterThan(shadowSoakIndex);
		expect(finalScorecardIndex).toBeGreaterThan(rollbackIndex);
	});
});
